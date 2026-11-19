const rateLimit = require('express-rate-limit');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const env = require('./server-config-env.js');
const { runtimeStore } = require('./server-core-runtimeStore.js');
const apiLimiter = rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
async function enforceModeration(req, res, next) {
  try {
    const uid = req.user?.uid;
    const {db} = initFirebaseAdmin();
    if (!uid || !db) return next();
    let row = runtimeStore.temporary.get(`moderation:${uid}`);
    if (!row) {
      const snapshot = await db.collection('users').doc(uid).get();
      row = snapshot.exists ? (snapshot.data() || {}) : {};
      runtimeStore.temporary.set(`moderation:${uid}`,row,15000);
    }
    if (row.banned) return res.status(403).json({ok:false,error:'ACCOUNT_BANNED'});
    const route = String(req.originalUrl || req.url || '').toLowerCase();
    const type = route.includes('/games/') || route.includes('/chess') || route.includes('/crash') || route.includes('/pisti') || route.includes('/classic/') ? 'games_mute' : route.includes('/chat/direct') ? 'dm_mute' : route.includes('/chat/') || route.includes('/social/') ? 'global_chat_mute' : '';
    const rule = row.restrictions?.[type];
    if (type && rule?.enabled && (!rule.until || Number(rule.until) > Date.now())) return res.status(403).json({ok:false,error:'ACCOUNT_RESTRICTED',scope:type,until:rule.until});
    return next();
  } catch (error) { return next(error); }
}
async function requireAuth(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const { auth } = initFirebaseAdmin();
    if (auth && token) { req.user = await auth.verifyIdToken(token); return enforceModeration(req, res, next); }
    const cookieToken = String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('pm_session='));
    const sessionToken = String(req.headers['x-session-token'] || req.headers['X-Session-Token'] || (cookieToken ? decodeURIComponent(cookieToken.slice('pm_session='.length)) : '') || '').trim();
    if (sessionToken) {
      const session = runtimeStore.temporary.get(`session:${sessionToken}`);
      if (session?.uid) { req.user = { uid: String(session.uid), email: String(session.email || ''), sessionSource: String(session.sessionSource || 'runtime-session'), sessionId: String(session.sessionId || '') }; return enforceModeration(req, res, next); }
    }
    const devUid = req.headers['x-playmatrix-user'] || req.body?.uid || req.query?.uid;
    if (process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_AUTH === '1' && devUid) { req.user = { uid: String(devUid), email: 'local@playmatrix.test' }; return enforceModeration(req, res, next); }
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  } catch (error) { return res.status(401).json({ ok: false, error: 'AUTH_INVALID' }); }
}
function requireAdmin(req, res, next) {
  const uid = req.user?.uid;
  const email = req.user?.email;
  if (env.adminUids.includes(String(uid)) || env.adminEmails.includes(String(email))) return next();
  return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED' });
}
module.exports = { apiLimiter, strictLimiter, requireAuth, requireAdmin };
