'use strict';
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('./server-core-security.js');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');

const LIMITS = Object.freeze({
  'space-pro': Object.freeze({ maxScore: 200000, minDurationMs: 2500 }),
  'snake-pro': Object.freeze({ maxScore: 100000, minDurationMs: 1800 })
});
const MAX_RUN_MS = 6 * 3600000;
function domainError(code, statusCode = 400) {
  const error = new Error(code);
  error.statusCode = statusCode;
  return error;
}
function validateScore(game, score, durationMs) {
  const config = LIMITS[game];
  if (!config) throw domainError('GAME_REMOVED', 410);
  const rawScore = Number(score);
  if (!Number.isSafeInteger(rawScore) || rawScore < 0 || rawScore > config.maxScore) throw domainError('INVALID_SCORE');
  const elapsed = Number(durationMs);
  if (!Number.isFinite(elapsed) || elapsed < config.minDurationMs || elapsed > MAX_RUN_MS) throw domainError('INVALID_RUN_DURATION');
  // Client-side arcade scores are untrusted. Never credit MC or levels for them.
  return { score: rawScore, durationMs: Math.trunc(elapsed), unverifiedClientScore: true };
}
function createClassicRouter(game) {
  if (!LIMITS[game]) throw domainError('GAME_REMOVED', 410);
  const router = express.Router();
  router.post('/start', requireAuth, async (req, res) => {
    const uid = String(req.user?.uid || '');
    const { db } = initFirebaseAdmin();
    if (!uid) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (!db) return res.status(503).json({ ok: false, error: 'DATA_NOT_READY' });
    const runId = `${game}_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    await db.collection('classicGameRuns').doc(runId).create({ uid, game, status: 'started', startedAt, expiresAt: startedAt + MAX_RUN_MS });
    return res.status(201).json({ ok: true, game, runId, startedAt });
  });
  router.post('/submit', requireAuth, async (req, res) => {
    const { db } = initFirebaseAdmin();
    const uid = String(req.user?.uid || '');
    if (!uid) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    if (!db) return res.status(503).json({ ok: false, error: 'DATA_NOT_READY' });
    const runId = String(req.body?.runId || '').trim();
    if (!new RegExp(`^${game}_[0-9a-f-]{36}$`, 'i').test(runId)) return res.status(400).json({ ok: false, error: 'INVALID_RUN_ID' });
    const runRef = db.collection('classicGameRuns').doc(runId);
    const now = Date.now();
    let result;
    try {
      result = await db.runTransaction(async tx => {
        const snapshot = await tx.get(runRef);
        if (!snapshot.exists) throw domainError('RUN_NOT_FOUND', 404);
        const run = snapshot.data();
        if (run.uid !== uid || run.game !== game) throw domainError('FORBIDDEN', 403);
        if (run.status === 'finished') return { ...run.result, duplicate: true };
        if (run.status !== 'started' || now > run.startedAt + MAX_RUN_MS) throw domainError('RUN_EXPIRED', 409);
        const calc = validateScore(game, req.body?.score, now - run.startedAt);
        const result = { game, runId, ...calc, savedAt: now };
        tx.update(runRef, { status: 'finished', finishedAt: now, result });
        return result;
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ ok: false, error: error.message });
      throw error;
    }
    return res.json({ ok: true, ...result });
  });
  return router;
}
module.exports = { createClassicRouter, validateScore };
