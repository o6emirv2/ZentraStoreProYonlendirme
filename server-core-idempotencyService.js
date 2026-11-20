'use strict';
const crypto = require('node:crypto');

// Generic once-only operations must be recorded and executed in the SAME transaction.
// A process-local lock or a read-followed-by-write is not safe across Render instances.
async function runOnce({key, db, collection='idempotency', ttlMs=30*86400000, execute}) {
  if (typeof key !== 'string' || !key.trim() || key.length > 400) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  if (!db || typeof db.runTransaction !== 'function') {
    throw Object.assign(new Error('DATA_NOT_READY'), {statusCode:503});
  }
  const id = crypto.createHash('sha256').update(key).digest('hex');
  const ref = db.collection(collection).doc(id);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      if (existing.data().key !== key) throw Object.assign(new Error('TRANSACTION_KEY_CONFLICT'),{statusCode:409});
      return {ok:true, duplicate:true, stored:true, result:existing.data().result || {}};
    }
    // execute() MUST be a deterministic, side-effect-free calculation. External writes
    // belong in this transaction, not inside execute().
    const result = execute ? await execute() : {};
    const at = Date.now();
    tx.create(ref, {key, createdAt:at, expiresAt:new Date(at+ttlMs), result:result || {}});
    return {ok:true, duplicate:false, result:result || {}};
  });
}
module.exports = {runOnce};
