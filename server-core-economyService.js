'use strict';
const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { applyWagerToProfile } = require('./server-core-progressionService.js');
const { SIGNUP_MC: DEFAULT_BALANCE } = require('./server-core-rewardPolicy.js');

const MAX_TRANSACTION_MC = 1_000_000_000;
const WAGER_REASONS = new Set(['chess-bet', 'pisti-bet', 'crash-bet']);
const CRASH_SETTLEMENT_REASONS = new Set(['crash-cashout','crash-auto-cashout','crash-invite-refund']);
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
  const signature = crypto.createHash('sha256').update(JSON.stringify([uid,safeAmount,reason,reason==='crash-bet'?[metadata?.roundId,metadata?.box,metadata?.autoCashout]:null])).digest('hex');
  const {db} = initFirebaseAdmin();
  if (!db) return {ok:false,error:'DATA_NOT_READY'};
  const idemRef = db.collection('idempotency').doc(id);
  const userRef = db.collection('users').doc(uid);
  const isChessWager = reason==='chess-bet' && typeof metadata?.roomId==='string' && /^ch_\d+_[0-9a-f]{24}$/.test(metadata.roomId);
  const isChessRefund = metadata?.refundOfBet===true && reason.startsWith('chess-') && typeof metadata?.roomId==='string' && /^ch_\d+_[0-9a-f]{24}$/.test(metadata.roomId);
  const chessStakeRef=(isChessWager||isChessRefund) ? db.collection('chessStakes').doc(crypto.createHash('sha256').update(`${uid}:${metadata.roomId}`).digest('hex')):null;
  const chessLegacyRef=isChessRefund ? db.collection('idempotency').doc(crypto.createHash('sha256').update(`${uid}:chess:bet:${metadata.roomId}:${uid}`).digest('hex')):null;
  const isCrashWager = reason === 'crash-bet' && typeof metadata?.roundId === 'string' && [1,2].includes(Number(metadata?.box));
  const isCrashSettlement = CRASH_SETTLEMENT_REASONS.has(reason) && typeof metadata?.roundId === 'string' && [1,2].includes(Number(metadata?.box));
  // A missing or malformed settlement reference must never fall through to an
  // ordinary generic balance mutation, which would bypass the stake ledger.
  if(reason==='chess-bet'&&!isChessWager)return {ok:false,error:'INVALID_CHESS_WAGER'};
  if(reason==='crash-bet'&&!isCrashWager)return {ok:false,error:'INVALID_CRASH_WAGER'};
  if(CRASH_SETTLEMENT_REASONS.has(reason)&&!isCrashSettlement)return {ok:false,error:'INVALID_CRASH_SETTLEMENT'};
  if(metadata?.refundOfBet===true&&reason.startsWith('chess-')&&!isChessRefund)return {ok:false,error:'INVALID_CHESS_REFUND'};
  const crashBetRef = (isCrashWager || isCrashSettlement)
    ? db.collection('crashBets').doc(crypto.createHash('sha256').update(`${uid}:${metadata.roundId}:${metadata.box}`).digest('hex'))
    : null;
  let output;
  await db.runTransaction(async tx => {
    const idem = await tx.get(idemRef);
    if (idem.exists) {
      if (idem.data().signature !== signature) throw Object.assign(new Error('TRANSACTION_KEY_CONFLICT'), {statusCode:409});
      output = {...(idem.data().result || {}), ok:true, duplicate:true};
      return;
    }
    const [user, crashBet, chessStake, chessLegacy] = await Promise.all([
      tx.get(userRef),crashBetRef?tx.get(crashBetRef):Promise.resolve(null),
      chessStakeRef?tx.get(chessStakeRef):Promise.resolve(null),
      chessLegacyRef?tx.get(chessLegacyRef):Promise.resolve(null)]);
    if(isChessWager && chessStake?.exists)throw Object.assign(new Error('CHESS_STAKE_ALREADY_PLACED'),{statusCode:409});
    if(isChessRefund){
      const stake=chessStake?.exists ? chessStake.data() : null;
      if(stake){
        if(stake.status!=='active')throw Object.assign(new Error('CHESS_STAKE_ALREADY_SETTLED'),{statusCode:409});
        if(safeAmount!==Number(stake.amount))throw Object.assign(new Error('INVALID_CHESS_REFUND'),{statusCode:409});
      }else{
        const receipt=chessLegacy?.exists ? chessLegacy.data() : null;
        if(!receipt||receipt.uid!==uid||receipt.result?.amount!==-safeAmount||receipt.result?.reason!=='chess-bet') {
          throw Object.assign(new Error('CHESS_STAKE_MISSING'),{statusCode:409});
        }
      }
    }
    if (isCrashWager && crashBet.exists) throw Object.assign(new Error('BET_ALREADY_PLACED'),{statusCode:409});
    if (isCrashSettlement && (!crashBet.exists || crashBet.data()?.status !== 'active')) throw Object.assign(new Error('BET_ALREADY_SETTLED'),{statusCode:409});
    if (isCrashSettlement) {
      const original = crashBet.data();
      if (reason === 'crash-invite-refund' && safeAmount !== original.amount) throw Object.assign(new Error('INVALID_REFUND_AMOUNT'),{statusCode:409});
      if (reason !== 'crash-invite-refund' && !(safeAmount >= original.amount && safeAmount <= original.amount * 100)) throw Object.assign(new Error('INVALID_CRASH_PAYOUT'),{statusCode:409});
    }
    if (!user.exists) throw Object.assign(new Error('PROFILE_NOT_READY'), {statusCode:409});
    const current = Number(user.data().balance);
    if (!Number.isSafeInteger(current) || current < 0) throw Object.assign(new Error('INVALID_BALANCE'), {statusCode:409});
    const nextBalance = current + safeAmount;
    if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) throw Object.assign(new Error(safeAmount < 0 ? 'INSUFFICIENT_BALANCE' : 'BALANCE_OVERFLOW'), {statusCode:409, balance:current});
    const patch = {balance:nextBalance, updatedAt:Date.now()};
    // Chess entry stakes are escrow: level progression is earned only when a
    // match actually ends. Old stakes can still carry already-applied progress.
    if (WAGER_REASONS.has(reason) && safeAmount < 0 && reason !== 'chess-bet') {
      Object.assign(patch, applyWagerToProfile(user.data(), -safeAmount));
    } else if ((REFUND_REASONS.has(reason) || metadata?.refundOfBet === true) && safeAmount > 0 &&
               !(isChessRefund && chessStake?.exists && chessStake.data()?.progressApplied === false)) {
      Object.assign(patch, applyWagerToProfile(user.data(), -safeAmount));
    }
    tx.set(userRef, patch, {merge:true});
    if(isChessWager)tx.create(chessStakeRef,{uid,roomId:metadata.roomId,amount:-safeAmount,status:'active',progressApplied:false,placedAt:Date.now(),balanceAfter:nextBalance});
    else if(isChessRefund){
      const receipt={status:'refunded',settledAt:Date.now(),balanceAfter:nextBalance,reason};
      if(chessStake?.exists)tx.update(chessStakeRef,receipt);
      else tx.create(chessStakeRef,{...receipt,uid,roomId:metadata.roomId,amount:safeAmount,legacyDebit:true});
    }
    if (isCrashWager) {
      tx.create(crashBetRef,{uid,roundId:metadata.roundId,box:Number(metadata.box),amount:-safeAmount,
        autoCashout:Number(metadata.autoCashout||0),status:'active',placedAt:Date.now(),balanceAfter:nextBalance});
    } else if (isCrashSettlement) {
      tx.update(crashBetRef,{status:reason === 'crash-invite-refund'?'refunded':'cashed',
        settlementReason:reason,settlementAmount:safeAmount,settledAt:Date.now(),balanceAfter:nextBalance});
    }
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
