const crypto = require('crypto');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { runtimeStore } = require('./server-core-runtimeStore.js');

const { SIGNUP_MC: DEFAULT_BALANCE } = require('./server-core-rewardPolicy.js');
function clampAmount(value, { min = -1_000_000_000, max = 1_000_000_000 } = {}) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(min, Math.min(max, n));
}
async function readBalance(uid) {
  const { db } = initFirebaseAdmin();
  if (!db) throw Object.assign(new Error('DATA_NOT_READY'),{statusCode:503});
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error('PROFILE_NOT_READY'),{statusCode:409});
  const balance=Number(snap.data().balance);
  if (!Number.isFinite(balance) || balance < 0) throw Object.assign(new Error('INVALID_BALANCE'),{statusCode:409});
  return Math.floor(balance);
}
async function mutateBalance({ uid, amount, reason = 'economy', idempotencyKey = '', metadata = {} }) {
  if (!uid) return { ok: false, error: 'UID_REQUIRED' };
  if (amount === undefined || amount === null || amount === '' || !Number.isFinite(Number(amount))) return {ok:false,error:'INVALID_AMOUNT'};
  const safeAmount = clampAmount(amount);
  if (!safeAmount) return { ok: true, amount: 0, balance: await readBalance(uid), reason };
  if (!Number.isSafeInteger(safeAmount) || Math.abs(safeAmount)>1_000_000_000) return {ok:false,error:'INVALID_AMOUNT'};
  const key = String(idempotencyKey || `${uid}:${reason}:${crypto.randomUUID()}`);
  const idemMemoryKey = `idem:economy:${key}`;
  if (runtimeStore.temporary.get(idemMemoryKey)) return { ok: true, duplicate: true, balance: await readBalance(uid) };
  const { db, admin } = initFirebaseAdmin();
  if (!db || !admin) return { ok: false, error: 'DATA_NOT_READY' };
  const idemRef = db.collection('idempotency').doc(key);
  const userRef = db.collection('users').doc(uid);
  let output = null;
  await db.runTransaction(async (tx) => {
    const idem = await tx.get(idemRef);
    if (idem.exists) { output = { ok: true, duplicate: true, ...(idem.data().result || {}) }; return; }
    const snap = await tx.get(userRef);
    if (!snap.exists) throw Object.assign(new Error('PROFILE_NOT_READY'),{statusCode:409});
    const current=Number(snap.data().balance);
    if (!Number.isSafeInteger(current) || current<0) throw Object.assign(new Error('INVALID_BALANCE'),{statusCode:409});
    if (safeAmount < 0 && current + safeAmount < 0) throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { statusCode: 409, balance: current });
    const balance = Math.max(0, current + safeAmount);
    tx.set(userRef, { balance, updatedAt: Date.now() }, { merge: true });
    const auditId = `economy_${crypto.randomUUID()}`;
    const audit = { uid, amount: safeAmount, reason, balanceAfter: balance, metadata, at: Date.now() };
    tx.set(db.collection('audit').doc(auditId), audit, { merge: false });
    output = { ok: true, uid, amount: safeAmount, balance, reason, auditId };
    tx.set(idemRef, { key, type: 'economy', uid, createdAt: Date.now(), result: output }, { merge: false });
  });
  runtimeStore.temporary.set(idemMemoryKey, true, 3600000);
  return output || { ok: true, duplicate: true, balance: await readBalance(uid) };
}
async function debitBalance(opts) { return mutateBalance({ ...opts, amount: -Math.abs(clampAmount(opts.amount)) }); }
async function creditBalance(opts) { return mutateBalance({ ...opts, amount: Math.abs(clampAmount(opts.amount)) }); }
module.exports = { DEFAULT_BALANCE, readBalance, mutateBalance, debitBalance, creditBalance, clampAmount };
