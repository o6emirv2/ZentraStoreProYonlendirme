const express = require('express');
const { requireAuth } = require('./server-core-security.js');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const router = express.Router();
const REWARDS = Object.freeze([
  { amount: 10000, weight: 40 }, { amount: 20000, weight: 30 }, { amount: 25000, weight: 20 }, { amount: 45000, weight: 15 },
  { amount: 65000, weight: 10 }, { amount: 90000, weight: 5 }, { amount: 120000, weight: 3 }, { amount: 1000000, weight: 2 }
]);
function istanbulDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function pickReward() {
  const total = REWARDS.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * total;
  for (const reward of REWARDS) { roll -= reward.weight; if (roll <= 0) return reward; }
  return REWARDS[0];
}
router.get('/wheel/config', (_req, res) => res.json({ ok: true, resetTimezone: 'Europe/Istanbul', reset: '00:00', rewards: REWARDS.map(r => ({ ...r, probability: r.weight / REWARDS.reduce((n, entry) => n + entry.weight, 0) })) }));
router.post('/wheel/spin', requireAuth, async (req, res, next) => {
  try {
    const { db } = initFirebaseAdmin();
    if (!db) return res.status(503).json({ ok:false, error:'FIREBASE_UNAVAILABLE' });
    const uid = req.user.uid;
    const day = istanbulDayKey();
    const claimRef = db.collection('wheelClaims').doc(`${uid}:${day}`);
    const userRef = db.collection('users').doc(uid);
    const reward = pickReward();
    const index = REWARDS.findIndex((item) => item.amount === reward.amount);
    let balance = 0;
    await db.runTransaction(async (tx) => {
      const [prior, user] = await Promise.all([tx.get(claimRef), tx.get(userRef)]);
      if (prior.exists) throw Object.assign(new Error('WHEEL_ALREADY_CLAIMED_TODAY'), { statusCode:409 });
      const current = Number(user.exists ? user.data()?.balance : 0) || 0;
      balance = current + reward.amount;
      const timestamp = Date.now();
      tx.create(claimRef, { uid, day, reward:reward.amount, at:timestamp });
      tx.set(userRef, { balance, lastSpin:timestamp, lastSpinAt:timestamp, updatedAt:timestamp }, { merge:true });
      tx.create(db.collection('audit').doc(), { uid, amount:reward.amount, reason:'daily-wheel', at:timestamp, balanceAfter:balance });
    });
    const timestamp = Date.now();
    res.json({ ok:true, day, prize:reward.amount, reward:reward.amount, amount:reward.amount, index, lastSpin:timestamp, nextSpinAt:timestamp + 24*3600000, balance });
  } catch (error) { next(error); }
});
module.exports = router;
