const rateLimit = require('express-rate-limit');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const env = require('../config/env');
const { runtimeStore } = require('../core/runtimeStore');
const apiLimiter = rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

function isAdminRequest(req) {
  return String(req.originalUrl || req.url || '').includes('/admin');
}
function restrictionTarget(req) {
  const url = String(req.originalUrl || req.url || '').toLowerCase();
  if (url.includes('/api/games') || url.includes('/api/crash') || url.includes('/api/chess') || url.includes('/api/pisti-online')) return 'games_mute';
  if (url.includes('/api/chat/direct') || url.includes('/api/friends')) return 'dm_mute';
  if (url.includes('/api/chat') || url.includes('/api/social') || url.includes('/api/support')) return 'global_chat_mute';
  return '';
}
async function readRestrictionSnapshot(uid) {
  const cacheKey = `restriction:${uid}`;
  const cached = runtimeStore.temporary.get(cacheKey);
  if (cached) return cached;
  const { db } = initFirebaseAdmin();
  if (!db || !uid) return {};
  const snap = await db.collection('users').doc(uid).get().catch(() => null);
  const data = snap?.exists ? (snap.data() || {}) : {};
  const compact = {
    banned: !!data.banned,
    gameRestricted: !!data.gameRestricted,
    gameRestrictedUntil: Number(data.gameRestrictedUntil || 0),
    globalChatMuted: !!data.globalChatMuted,
    globalChatMutedUntil: Number(data.globalChatMutedUntil || 0),
    dmMuted: !!data.dmMuted,
    dmMutedUntil: Number(data.dmMutedUntil || 0),
    restrictions: data.restrictions || {}
  };
  runtimeStore.temporary.set(cacheKey, compact, 60000);
  return compact;
}
async function finalizeAuth(req, res, next, user) {
  req.user = user;
  if (isAdminRequest(req)) return next();
  const uid = String(user?.uid || '');
  const restrictions = await readRestrictionSnapshot(uid).catch(() => ({}));
  if (restrictions.banned) return res.status(403).json({ ok:false, error:'USER_BANNED' });
  const target = restrictionTarget(req);
  const active = restrictions.restrictions?.[target];
  const notExpired = !active?.expiresAt || Number(active.expiresAt || 0) > Date.now();
  const flagActive = (flag, until) => !!flag && (!Number(until || 0) || Number(until || 0) > Date.now());
  if ((target === 'games_mute' && flagActive(restrictions.gameRestricted, restrictions.gameRestrictedUntil)) || (target === 'global_chat_mute' && flagActive(restrictions.globalChatMuted, restrictions.globalChatMutedUntil)) || (target === 'dm_mute' && flagActive(restrictions.dmMuted, restrictions.dmMutedUntil)) || (active?.active && notExpired)) {
    return res.status(403).json({ ok:false, error:'USER_RESTRICTED', restriction:target || 'restricted' });
  }
  return next();
}
async function requireAuth(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const { auth } = initFirebaseAdmin();
    if (auth && token) return finalizeAuth(req, res, next, await auth.verifyIdToken(token));
    const cookieToken = String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('pm_session='));
    const sessionToken = String(req.headers['x-session-token'] || req.headers['X-Session-Token'] || (cookieToken ? decodeURIComponent(cookieToken.slice('pm_session='.length)) : '') || '').trim();
    if (sessionToken) {
      const session = runtimeStore.temporary.get(`session:${sessionToken}`);
      if (session?.uid) return finalizeAuth(req, res, next, { uid: String(session.uid), email: String(session.email || ''), sessionSource: String(session.sessionSource || 'runtime-session'), sessionId: String(session.sessionId || '') });
    }
    const devUid = req.headers['x-playmatrix-user'] || req.body?.uid || req.query?.uid;
    if (process.env.NODE_ENV !== 'production' && devUid) return finalizeAuth(req, res, next, { uid: String(devUid), email: 'local@playmatrix.test' });
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  } catch (error) { return res.status(401).json({ ok: false, error: 'AUTH_INVALID' }); }
}
function requireAdmin(req, res, next) {
  const uid = req.user?.uid || req.headers['x-admin-uid'];
  const email = req.user?.email || req.headers['x-admin-email'];
  if (env.adminUids.includes(String(uid)) || env.adminEmails.includes(String(email))) return next();
  return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED' });
}
module.exports = { apiLimiter, strictLimiter, requireAuth, requireAdmin };
