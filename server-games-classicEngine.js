const express = require('express');
const crypto = require('crypto');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { runtimeStore } = require('./server-core-runtimeStore.js');

function optionalAuth(req, _res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const { auth } = initFirebaseAdmin();
  if (!auth || !token) return next();
  auth.verifyIdToken(token).then((user) => { req.user = user; next(); }).catch(() => next());
}
function gameConfig(game) {
  const map = {
    'pattern-master': { maxScore: 25000, minDurationMs: 1500 },
    'space-pro': { maxScore: 200000, minDurationMs: 2500 },
    'snake-pro': { maxScore: 100000, minDurationMs: 1800 }
  };
  return map[game] || map['pattern-master'];
}
function validateScore(game, score, durationMs) {
  const cfg = gameConfig(game);
  const safeScore = Math.max(0, Math.min(cfg.maxScore, Math.trunc(Number(score) || 0)));
  const safeDuration = Math.max(0, Math.trunc(Number(durationMs) || 0));
  const impossible = safeScore > cfg.maxScore || safeDuration < cfg.minDurationMs || safeScore / Math.max(1, safeDuration / 1000) > cfg.maxScore / 20;
  return { score: safeScore, durationMs: safeDuration, suspicious: impossible };
}
function createClassicRouter(game) {
  const router = express.Router();
  router.post('/start', optionalAuth, (req, res) => {
    const runId = `${game}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    runtimeStore.temporary.set(`classic:${runId}`, { game, uid: req.user?.uid || '', startedAt: Date.now(), finished: false }, 6 * 3600000);
    res.json({ ok: true, game, runId, startedAt: Date.now() });
  });
  router.post('/submit', optionalAuth, async (req, res) => {
    const runId = String(req.body.runId || `${game}_legacy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
    const existing = runtimeStore.temporary.get(`classic:done:${runId}`);
    if (existing) return res.json({ ok: true, duplicate: true, ...existing });
    const calc = validateScore(game, req.body.score, req.body.durationMs);
    const uid = req.user?.uid || '';
    const { db } = initFirebaseAdmin();
    if (db && uid) {
      const runRef = db.collection('classicGameRuns').doc(runId);
      await db.runTransaction(async tx => {
        if ((await tx.get(runRef)).exists) return;
        tx.create(runRef, { uid, game, score: calc.score, durationMs: calc.durationMs, suspicious: calc.suspicious, at: Date.now() });
      });
    }
    const result = { game, runId, score: calc.score, durationMs: calc.durationMs, suspicious: calc.suspicious };
    runtimeStore.temporary.set(`classic:done:${runId}`, result, 30 * 86400000);
    res.json({ ok: true, ...result });
  });
  return router;
}
module.exports = { createClassicRouter, validateScore };
