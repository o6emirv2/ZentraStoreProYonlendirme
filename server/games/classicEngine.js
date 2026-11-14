const express = require('express');
const crypto = require('crypto');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { runtimeStore } = require('../core/runtimeStore');
const { getProgression, normalizeXpBigInt } = require('../core/progressionService');

function readSessionToken(req) {
  const headerToken = String(req.headers['x-session-token'] || req.headers['X-Session-Token'] || '').trim();
  if (headerToken) return headerToken;
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)pm_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function optionalAuth(req, _res, next) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const sessionToken = readSessionToken(req);
  const session = sessionToken ? runtimeStore.temporary.get(`session:${sessionToken}`) : null;
  if (session?.uid) {
    req.user = { uid: String(session.uid), email: session.email || '', sessionSource: 'pm_session' };
    return next();
  }
  const { auth } = initFirebaseAdmin();
  if (!auth || !bearer) return next();
  auth.verifyIdToken(bearer).then((user) => { req.user = user; next(); }).catch(() => next());
}
function gameConfig(game) {
  const map = {
    'pattern-master': { maxScore: 25000, minDurationMs: 1500, xpPerPoint: 1, maxXpPerRun: 25000 },
    'space-pro': { maxScore: 200000, minDurationMs: 2500, xpPerPoint: 0.25, maxXpPerRun: 50000 },
    'snake-pro': { maxScore: 100000, minDurationMs: 1800, xpPerPoint: 0.5, maxXpPerRun: 35000 }
  };
  return map[game] || map['pattern-master'];
}
function calculateXp(game, score, durationMs) {
  const cfg = gameConfig(game);
  const safeScore = Math.max(0, Math.min(cfg.maxScore, Math.trunc(Number(score) || 0)));
  const safeDuration = Math.max(0, Math.trunc(Number(durationMs) || 0));
  const impossible = safeScore > cfg.maxScore || safeDuration < cfg.minDurationMs || safeScore / Math.max(1, safeDuration / 1000) > cfg.maxScore / 20;
  const xp = impossible ? 0 : Math.min(cfg.maxXpPerRun, Math.floor(safeScore * cfg.xpPerPoint));
  return { score: safeScore, durationMs: safeDuration, xp, suspicious: impossible };
}
function createClassicRouter(game) {
  const router = express.Router();
  router.post('/start', optionalAuth, (req, res) => {
    const runId = `${game}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    runtimeStore.temporary.set(`classic:${runId}`, { game, uid: req.user?.uid || '', startedAt: Date.now(), finished: false }, 6 * 3600000);
    res.json({ ok: true, game, runId, startedAt: Date.now() });
  });
  router.post('/submit', optionalAuth, async (req, res) => {
    const runId = String(req.body.runId || '').trim();
    if (!runId) return res.status(400).json({ ok: false, error: 'RUN_ID_REQUIRED' });
    const existing = runtimeStore.temporary.get(`classic:done:${runId}`);
    if (existing) return res.json({ ok: true, duplicate: true, ...existing });
    const run = runtimeStore.temporary.get(`classic:${runId}`);
    const uid = req.user?.uid ? String(req.user.uid) : '';
    if (!run || run.game !== game || run.finished) return res.status(409).json({ ok: false, error: 'RUN_NOT_ACTIVE' });
    if (run.uid && uid && run.uid !== uid) return res.status(403).json({ ok: false, error: 'RUN_OWNER_MISMATCH' });
    const backendDurationMs = Math.max(0, Date.now() - Number(run.startedAt || Date.now()));
    const calc = calculateXp(game, req.body.score, backendDurationMs);
    let progression = getProgression(0);
    if (uid && calc.xp > 0) {
      const { db, admin } = initFirebaseAdmin();
      if (db && admin) {
        const userRef = db.collection('users').doc(uid);
        const runRef = db.collection('classicGameRuns').doc(runId);
        await db.runTransaction(async (tx) => {
          const runSnap = await tx.get(runRef);
          if (runSnap.exists) {
            const data = runSnap.data() || {};
            progression = getProgression(data.progression?.xp || 0);
            return;
          }
          const snap = await tx.get(userRef);
          const current = normalizeXpBigInt(snap.exists ? (snap.data().xp ?? snap.data().accountXp ?? 0) : 0);
          const next = current + BigInt(calc.xp);
          progression = getProgression(next);
          tx.set(userRef, { xp: next.toString(), accountXp: next.toString(), accountLevel: progression.level, accountLevelProgressPct: progression.progressPercent, updatedAt: Date.now() }, { merge: true });
          tx.set(runRef, { uid, game, score: calc.score, durationMs: calc.durationMs, xp: calc.xp, suspicious: calc.suspicious, progression, at: Date.now() }, { merge: false });
        });
      } else {
        const key = `xp:${uid}`;
        const current = normalizeXpBigInt(runtimeStore.temporary.get(key) || 0);
        const next = current + BigInt(calc.xp);
        runtimeStore.temporary.set(key, next.toString(), 30 * 86400000);
        progression = getProgression(next);
      }
    }
    const result = { game, runId, score: calc.score, durationMs: calc.durationMs, xpAwarded: uid && calc.xp > 0 ? calc.xp : 0, levelPoints: uid && calc.xp > 0 ? calc.xp : 0, suspicious: calc.suspicious, progression, authRequiredForXp: !uid }; 
    runtimeStore.temporary.set(`classic:done:${runId}`, result, 30 * 86400000);
    runtimeStore.temporary.set(`classic:${runId}`, { ...run, finished: true, finishedAt: Date.now() }, 30 * 86400000);
    res.json({ ok: true, ...result });
  });
  return router;
}
module.exports = { createClassicRouter, calculateXp };
