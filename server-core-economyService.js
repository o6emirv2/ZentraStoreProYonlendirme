'use strict';
const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { applyWagerToProfile } = require('./server-core-progressionService.js');
const { SIGNUP_MC: DEFAULT_BALANCE } = require('./server-core-rewardPolicy.js');

const MAX_TRANSACTION_MC = 1_000_000_000;
const WAGER_REASONS = new Set(['chess-bet', 'pisti-bet', 'crash-bet']);
const REFUND_REASONS = new Set([
  'chess-draw-half-refund', 'chess-waiting-room-refund',
  'crash-invite-refund', 'pisti-cancel-refund'
]);
function clampAmount(value, {min=-MAX_TRANSACTION_MC, max=MAX_TRANSACTION_MC} = {}) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.max(min, Math.min(max, n)) : 0;
}
function validateAmount(value) {
  if (value === '' || value === null || value === undefined) return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && n !== 0 && Math.abs(n) <= MAX_TRANSACTION_MC;
}
async function readBalance(uid) {
  const {db} = initFirebaseAdmin();
  if (!db) throw Object.assign(new Error('DATA_NOT_READY'), {statusCode:503});
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) throw Object.assign(new Error('PROFILE_NOT_READY'), {statusCode:409});
  const balance = Number(snapshot.data().balance);
  if (!Number.isSafeInteger(balance) || balance < 0) throw Object.assign(new Error('INVALID_BALANCE'), {statusCode:409});
  return balance;
}
async function mutateBalance({uid, amount, reason='economy', idempotencyKey='', metadata={}}) {
  if (!uid || typeof uid !== 'string') return {ok:false,error:'UID_REQUIRED'};
  if (!validateAmount(amount)) return {ok:false,error:'INVALID_AMOUNT'};
  const safeAmount = Number(amount);
  const key = String(idempotencyKey || crypto.randomUUID());
  if (key.length > 200) return {ok:false,error:'INVALID_TRANSACTION_KEY'};
  // Scope idempotency to the account; conflicting requests cannot share a settlement.
  const id = crypto.createHash('sha256').update(`${uid}:${key}`).digest('hex');
  const signature = crypto.createHash('sha256').update(JSON.stringify([uid,safeAmount,reason])).digest('hex');
  const {db} = initFirebaseAdmin();
  if (!db) return {ok:false,error:'DATA_NOT_READY'};
  const idemRef = db.collection('idempotency').doc(id);
  const userRef = db.collection('users').doc(uid);
  let output;
  await db.runTransaction(async tx => {
    const idem = await tx.get(idemRef);
    if (idem.exists) {
      if (idem.data().signature !== signature) throw Object.assign(new Error('TRANSACTION_KEY_CONFLICT'), {statusCode:409});
      output = {...(idem.data().result || {}), ok:true, duplicate:true};
      return;
    }
    const user = await tx.get(userRef);
    if (!user.exists) throw Object.assign(new Error('PROFILE_NOT_READY'), {statusCode:409});
    const current = Number(user.data().balance);
    if (!Number.isSafeInteger(current) || current < 0) throw Object.assign(new Error('INVALID_BALANCE'), {statusCode:409});
    const nextBalance = current + safeAmount;
    if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) throw Object.assign(new Error(safeAmount < 0 ? 'INSUFFICIENT_BALANCE' : 'BALANCE_OVERFLOW'), {statusCode:409, balance:current});
    const patch = {balance:nextBalance, updatedAt:Date.now()};
    if (WAGER_REASONS.has(reason) && safeAmount < 0) Object.assign(patch, applyWagerToProfile(user.data(), -safeAmount));
    else if ((REFUND_REASONS.has(reason) || metadata?.refundOfBet === true) && safeAmount > 0) Object.assign(patch, applyWagerToProfile(user.data(), -safeAmount));
    tx.set(userRef, patch, {merge:true});
    const auditId = `economy_${crypto.randomUUID()}`;
    tx.set(db.collection('audit').doc(auditId), {uid,amount:safeAmount,reason,balanceAfter:nextBalance,metadata,at:Date.now(),idempotencyId:id}, {merge:false});
    output = {ok:true,uid,amount:safeAmount,balance:nextBalance,reason,auditId};
    tx.set(idemRef, {key,id,signature,uid,createdAt:Date.now(),result:output}, {merge:false});
  });
  return output;
}
async function debitBalance(options) {
  if (!validateAmount(options.amount) || Number(options.amount) < 0) return {ok:false,error:'INVALID_AMOUNT'};
  return mutateBalance({...options,amount:-Number(options.amount)});
}
async function creditBalance(options) {
  if (!validateAmount(options.amount) || Number(options.amount) < 0) return {ok:false,error:'INVALID_AMOUNT'};
  return mutateBalance({...options,amount:Number(options.amount)});
}
module.exports = {DEFAULT_BALANCE, readBalance, mutateBalance, debitBalance, creditBalance, clampAmount};
