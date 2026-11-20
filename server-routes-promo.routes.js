const express = require('express');
const { requireAuth, requireAdmin } = require('./server-core-security.js');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const router = express.Router();
const normalizeCode = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
router.post('/admin/promo', requireAuth, requireAdmin, async (req, res) => {
  const code = normalizeCode(req.body.code);
  const amount = Math.max(0, Math.trunc(Number(req.body.amount) || 0));
  if (!code || !amount) return res.status(400).json({ ok:false, error:'CODE_AMOUNT_REQUIRED' });
  const payload = { code, amount, active: req.body.active !== false, maxClaims: Math.max(1, Math.trunc(Number(req.body.maxClaims) || 1)), createdBy: req.user.uid, updatedAt: Date.now() };
  const { db } = initFirebaseAdmin();
  if (!db) return res.status(503).json({ok:false,error:'FIREBASE_UNAVAILABLE'});
  await Promise.all([db.collection('promoCodes').doc(code).set(payload, { merge: true }), db.collection('promos').doc(code).set(payload, { merge: true })]);
  res.json({ ok:true, promo: payload });
});
router.post('/promo/claim', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.uid;
    const code = normalizeCode(req.body?.code);
    if (!code) return res.status(400).json({ ok:false, error:'CODE_REQUIRED' });
    const { db } = initFirebaseAdmin();
    if (!db) return res.status(503).json({ ok:false, error:'FIREBASE_UNAVAILABLE' });
    const promoRef = db.collection('promoCodes').doc(code);
    const oldRef = db.collection('promos').doc(code);
    const claimRef = db.collection('promoClaims').doc(`${code}:${uid}`);
    const userRef = db.collection('users').doc(uid);
    let amount = 0;
    let balance = 0;
    await db.runTransaction(async (tx) => {
      const [current, legacy, claim, user] = await Promise.all([tx.get(promoRef), tx.get(oldRef), tx.get(claimRef), tx.get(userRef)]);
      const profile = current.exists ? current.data() : (legacy.exists ? legacy.data() : null);
      if (!profile) throw Object.assign(new Error('PROMO_NOT_FOUND'), { statusCode:404 });
      if (profile.active === false || (profile.expiresAt && Number(profile.expiresAt) < Date.now())) throw Object.assign(new Error('PROMO_INACTIVE'), { statusCode:409 });
      if (claim.exists) throw Object.assign(new Error('PROMO_ALREADY_CLAIMED'), { statusCode:409 });
      const maxClaims = Math.max(1, Number(profile.maxClaims || profile.usageLimit || 1) || 1);
      const count = Math.max(0, Number(profile.claimedCount || 0));
      if (count >= maxClaims) throw Object.assign(new Error('PROMO_LIMIT_REACHED'), { statusCode:409 });
      amount = Math.max(0, Math.trunc(Number(profile.amount) || 0));
      if (!amount || amount > 10000000) throw Object.assign(new Error('PROMO_AMOUNT_INVALID'), { statusCode:422 });
      balance = Math.max(0, Number(user.exists ? user.data().balance : 0) || 0) + amount;
      const t = Date.now();
      tx.create(claimRef, { uid, code, amount, at:t });
      tx.set(userRef, { balance, updatedAt:t }, { merge:true });
      const patch = { ...profile, claimedCount:count + 1, updatedAt:t };
      tx.set(promoRef, patch, { merge:true });
      if (legacy.exists) tx.set(oldRef, patch, { merge:true });
      tx.create(db.collection('audit').doc(), { uid, code, amount, reason:'promo', at:t, balanceAfter:balance });
    });
    return res.json({ ok:true, code, amount, balance });
  } catch (error) { return next(error); }
});
module.exports = router;
