const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireAdmin, strictLimiter } = require('../core/security');
const { initFirebaseAdmin } = require('../config/firebaseAdmin');
const { listAdminLogs, addAdminLog } = require('../admin/adminRuntimeLogStore');
const { runSafeFirestoreCleanup } = require('../core/firestoreCleanupService');
const { runtimeStore } = require('../core/runtimeStore');
const { getProgression } = require('../core/progressionService');

const router = express.Router();
const now = () => Date.now();
const safe = (value, max = 300) => String(value || '').trim().slice(0, max).replace(/[<>]/g, '');
const money = (value) => Math.max(-10_000_000, Math.min(10_000_000, Math.trunc(Number(value) || 0)));
const nonNegativeMoney = (value) => Math.max(0, Math.min(10_000_000, Math.trunc(Number(value) || 0)));
const limitNumber = (value, fallback = 50, max = 200) => Math.max(1, Math.min(max, Math.trunc(Number(value) || fallback)));

router.use((req, res, next) => {
  if (!String(req.path || '').startsWith('/admin')) return next('router');
  return requireAuth(req, res, () => requireAdmin(req, res, next));
});

function fb() { return initFirebaseAdmin(); }
function adminActor(req) { return { uid: req.user?.uid || '', email: req.user?.email || '' }; }
function logAdmin(req, event, payload = {}) {
  return addAdminLog(event, { ...payload, actor: adminActor(req), path: req.originalUrl, at: now() });
}
function publicUser(uid, data = {}) {
  const xp = Number(data.accountXp ?? data.xp ?? 0) || 0;
  const progression = getProgression(xp);
  return {
    uid,
    email: data.email || '',
    username: data.username || data.displayName || data.fullName || uid,
    fullName: data.fullName || '',
    balance: Number(data.balance || 0),
    accountXp: progression.currentXp,
    accountLevel: progression.accountLevel,
    accountLevelProgressPct: progression.accountLevelProgressPct,
    selectedFrame: Number(data.selectedFrame || 0) || 0,
    avatar: data.avatar || '',
    banned: !!data.banned,
    banReason: data.banReason || '',
    emailVerified: !!data.emailVerified,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    lastSeen: data.lastSeen || data.lastLogin || null
  };
}
async function listUsers({ search = '', limit = 50 } = {}) {
  const { db } = fb();
  if (!db) return [];
  const rows = new Map();
  const max = limitNumber(limit, 50);
  const rawSearch = safe(search, 120);
  const trimmed = rawSearch.toLowerCase();
  const addDoc = (doc) => {
    if (!doc?.exists) return;
    rows.set(doc.id, publicUser(doc.id, doc.data() || {}));
  };
  try {
    if (trimmed) {
      const direct = await db.collection('users').doc(rawSearch).get().catch(() => null);
      addDoc(direct);
      const exactQueries = [
        db.collection('users').where('email', '==', rawSearch).limit(max),
        db.collection('users').where('username', '==', rawSearch).limit(max),
        db.collection('users').where('usernameLower', '==', trimmed).limit(max)
      ];
      for (const query of exactQueries) {
        const snap = await query.get().catch(() => null);
        snap?.forEach?.(addDoc);
      }
    }
    const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(Math.max(max, trimmed ? 200 : max)).get();
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const text = `${doc.id} ${data.email || ''} ${data.username || ''} ${data.usernameLower || ''} ${data.fullName || ''} ${data.displayName || ''}`.toLowerCase();
      if (!trimmed || text.includes(trimmed)) addDoc(doc);
    });
  } catch (error) {
    logAdmin({ user: {} , originalUrl: 'internal:listUsers' }, 'admin.users.list.error', { message: error.message });
  }
  return [...rows.values()].slice(0, max);
}
async function setUserPatch(uid, patch = {}) {
  const { db } = fb();
  if (!db) return { firestore: false };
  await db.collection('users').doc(uid).set({ ...patch, updatedAt: now() }, { merge: true });
  return { firestore: true };
}
async function incrementBalance(uid, amount, reason, req) {
  const { db, admin } = fb();
  if (!uid || !amount) return { ok: false, error: 'UID_AMOUNT_REQUIRED' };
  const safeAmount = Math.trunc(Number(amount) || 0);
  const key = `admin-economy:${uid}:${crypto.randomUUID()}`;
  if (!db || !admin) {
    logAdmin(req, 'admin.balance.local', { uid, amount: safeAmount, reason, key });
    return { ok: true, firestore: false, amount: safeAmount };
  }
  let nextBalance = 0;
  await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const snap = await tx.get(userRef);
    const current = Math.max(0, Number((snap.exists ? snap.data().balance : 0) || 0));
    if (safeAmount < 0 && current + safeAmount < 0) throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { statusCode: 409, current });
    nextBalance = Math.max(0, current + safeAmount);
    const auditRef = db.collection('audit').doc(key);
    tx.set(userRef, { balance: nextBalance, updatedAt: now() }, { merge: true });
    tx.set(auditRef, { uid, amount: safeAmount, reason, balanceAfter: nextBalance, actor: adminActor(req), type: 'admin-balance', at: now() }, { merge: true });
  });
  logAdmin(req, 'admin.balance.update', { uid, amount: safeAmount, reason, key, balanceAfter: nextBalance });
  return { ok: true, firestore: true, amount: safeAmount, balance: nextBalance };
}

router.get('/admin/summary', async (req, res) => {
  const { db, enabled } = fb();
  let users = 0, banned = 0, totalBalance = 0;
  if (db) {
    try {
      const snap = await db.collection('users').limit(200).get();
      users = snap.size;
      snap.forEach((doc) => { const data = doc.data() || {}; if (data.banned) banned += 1; totalBalance += Number(data.balance || 0); });
    } catch (error) { logAdmin(req, 'admin.summary.error', { message: error.message }); }
  }
  res.json({ ok: true, firebaseEnabled: !!enabled, metrics: { users, banned, totalBalance, runtimeLogs: listAdminLogs().length, runtimeStores: Object.fromEntries(Object.entries(runtimeStore).map(([key, store]) => [key, typeof store.size === 'function' ? store.size() : 0])) }, actor: adminActor(req), at: now() });
});

router.get('/admin/users', async (req, res) => {
  const users = await listUsers({ search: req.query.search, limit: req.query.limit });
  res.json({ ok: true, users, count: users.length, at: now() });
});

router.get('/admin/users/:uid', async (req, res) => {
  const uid = safe(req.params.uid, 160);
  const { db } = fb();
  if (!db) return res.json({ ok: true, user: publicUser(uid, { uid }), firestore: false });
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
  res.json({ ok: true, user: publicUser(uid, snap.data() || {}) });
});

router.post('/admin/users/balance', strictLimiter, async (req, res) => {
  const uid = safe(req.body.uid, 160);
  const amount = money(req.body.amount);
  const reason = safe(req.body.reason || 'admin-adjustment', 120);
  try {
    const result = await incrementBalance(uid, amount, reason, req);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok:false, error:error.message || 'BALANCE_UPDATE_FAILED', current:error.current });
  }
});

router.post('/admin/users/ban', strictLimiter, async (req, res) => {
  const uid = safe(req.body.uid, 160);
  if (!uid) return res.status(400).json({ ok: false, error: 'UID_REQUIRED' });
  const banned = req.body.banned !== false;
  const reason = safe(req.body.reason || (banned ? 'admin-ban' : 'admin-unban'), 220);
  await setUserPatch(uid, { banned, banReason: banned ? reason : '', bannedAt: banned ? now() : null, unbannedAt: banned ? null : now(), banActor: adminActor(req) });
  logAdmin(req, banned ? 'admin.user.ban' : 'admin.user.unban', { uid, reason });
  res.json({ ok: true, uid, banned, reason });
});

router.post('/admin/users/email', strictLimiter, async (req, res) => {
  const uid = safe(req.body.uid, 160);
  const email = safe(req.body.email, 254).toLowerCase();
  if (!uid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, error:'UID_EMAIL_REQUIRED' });
  const { db, auth } = fb();
  if (auth) await auth.updateUser(uid, { email, emailVerified: false });
  if (db) await db.collection('users').doc(uid).set({ email, emailVerified: false, updatedAt: now() }, { merge:true });
  logAdmin(req, 'admin.email.update', { uid, emailMasked: email.replace(/^(.{2}).*(@.*)$/,'$1***$2') });
  res.json({ ok:true, uid, emailSynced: true, authUpdated: !!auth, firestoreUpdated: !!db });
});

router.get('/admin/payments', async (_req, res) => {
  const { db } = fb();
  const payments = [];
  if (db) {
    try { const snap = await db.collection('payments').orderBy('createdAt', 'desc').limit(50).get(); snap.forEach(d => payments.push({ id: d.id, ...d.data() })); } catch (_) {}
  }
  res.json({ ok: true, payments, count: payments.length });
});

router.get('/admin/promos', async (_req, res) => {
  const { db } = fb();
  const promos = [];
  if (db) { try { const snap = await db.collection('promos').limit(100).get(); snap.forEach(d => promos.push({ id: d.id, ...d.data() })); } catch (_) {} }
  res.json({ ok: true, promos });
});

router.post('/admin/promos', strictLimiter, async (req, res) => {
  const code = safe(req.body.code, 40).toUpperCase();
  const amount = Math.max(1, Math.min(1_000_000, Math.trunc(Number(req.body.amount) || 0)));
  const maxClaims = Math.max(1, Math.min(100000, Math.trunc(Number(req.body.maxClaims) || 1)));
  if (!code || !amount) return res.status(400).json({ ok:false, error:'PROMO_CODE_AMOUNT_REQUIRED' });
  const { db } = fb();
  const promo = { code, amount, maxClaims, active: req.body.active !== false, createdAt: now(), actor: adminActor(req) };
  if (db) await Promise.all([db.collection('promos').doc(code).set(promo, { merge: true }), db.collection('promoCodes').doc(code).set(promo, { merge: true })]);
  logAdmin(req, 'admin.promo.save', { code, amount, maxClaims });
  res.json({ ok: true, promo, firestore: !!db });
});

router.get('/admin/notifications', (_req, res) => {
  res.json({ ok: true, notifications: [], receiptPolicyDays: 30, persistentReceipts: true });
});

router.post('/admin/notifications/send', strictLimiter, (req, res) => {
  const notification = { id: `admin_${Date.now()}`, title: safe(req.body.title || 'PlayMatrix', 80), message: safe(req.body.message, 300), audience: safe(req.body.audience || 'all', 40), at: now(), actor: adminActor(req) };
  runtimeStore.temporary.set(`adminNotification:${notification.id}`, notification, 24 * 3600000);
  logAdmin(req, 'admin.notification.send', notification);
  res.json({ ok: true, notification });
});

router.get('/admin/games', (_req, res) => {
  res.json({ ok: true, games: [
    { slug:'crash', title:'Crash', status:'online', backend:'/server/games/crash/index.js', data:'in-memory-rounds-risk-table' },
    { slug:'chess', title:'Satranç', status:'online', backend:'/server/games/chess/index.js', data:'room-state-move-validation' },
    { slug:'pisti', title:'Pişti', status:'online', backend:'/server/games/pisti/index.js', data:'room-card-validation' },
    { slug:'pattern-master', title:'Pattern Master', status:'online', backend:'/server/games/pattern-master/index.js', data:'score-xp-validation' },
    { slug:'space-pro', title:'Space Pro', status:'online', backend:'/server/games/space-pro/index.js', data:'score-xp-validation' },
    { slug:'snake-pro', title:'Snake Pro', status:'online', backend:'/server/games/snake-pro/index.js', data:'score-xp-validation' }
  ] });
});



async function resolveUserIdentifier(identifier = '') {
  const raw = safe(identifier, 160);
  if (!raw) return { ok: false, error: 'IDENTIFIER_REQUIRED' };
  const { db } = fb();
  if (!db) return { ok: false, error: 'FIRESTORE_DISABLED' };

  const direct = await db.collection('users').doc(raw).get().catch(() => null);
  if (direct?.exists) return { ok: true, uid: direct.id, user: publicUser(direct.id, direct.data() || {}), match: 'uid' };

  const lower = raw.toLowerCase();
  const candidates = [];
  const pushSnap = async (query, match) => {
    try {
      const snap = await query.limit(2).get();
      snap.forEach((doc) => candidates.push({ uid: doc.id, data: doc.data() || {}, match }));
    } catch (_) {}
  };
  if (lower.includes('@')) {
    await pushSnap(db.collection('users').where('email', '==', lower), 'email');
  }
  await pushSnap(db.collection('users').where('username', '==', raw), 'username');
  await pushSnap(db.collection('users').where('displayName', '==', raw), 'displayName');

  const unique = new Map();
  candidates.forEach((item) => { if (!unique.has(item.uid)) unique.set(item.uid, item); });
  const matches = [...unique.values()];
  if (matches.length === 1) {
    const item = matches[0];
    return { ok: true, uid: item.uid, user: publicUser(item.uid, item.data), match: item.match };
  }
  if (matches.length > 1) return { ok: false, error: 'MULTIPLE_USERS_MATCH', matches: matches.map((item) => ({ uid: item.uid, username: item.data.username || '', email: item.data.email || '', match: item.match })) };
  return { ok: false, error: 'USER_NOT_FOUND' };
}

async function collectUserDocs(limit = 5000) {
  const { db } = fb();
  if (!db) return { ok: false, error: 'FIRESTORE_DISABLED', docs: [] };
  const snap = await db.collection('users').limit(Math.max(1, Math.min(5000, Number(limit) || 5000))).get();
  return { ok: true, docs: snap.docs || [] };
}

async function writeUserBatch(updates = []) {
  const { db } = fb();
  if (!db) return { ok: false, error: 'FIRESTORE_DISABLED', affected: 0 };
  let affected = 0;
  for (let i = 0; i < updates.length; i += 450) {
    const batch = db.batch();
    updates.slice(i, i + 450).forEach(({ ref, patch }) => { batch.set(ref, { ...patch, updatedAt: now() }, { merge: true }); affected += 1; });
    await batch.commit();
  }
  return { ok: true, affected };
}

function resetPatchForFields(fields = []) {
  const allowed = new Set(Array.isArray(fields) ? fields : []);
  const patch = {};
  if (allowed.has('balance')) patch.balance = 0;
  if (allowed.has('accountLevel')) patch.accountLevel = 1;
  if (allowed.has('accountXp')) { patch.accountXp = 0; patch.xp = 0; }
  if (allowed.has('monthlyActiveScore')) patch.monthlyActiveScore = 0;
  if (allowed.has('activityScore')) patch.activityScore = 0;
  if (allowed.has('selectedFrame')) patch.selectedFrame = 0;
  return patch;
}

function normalizeMaintenancePayload(body = {}) {
  const keys = ['crash', 'chess', 'pisti', 'classic', 'pattern-master', 'space-pro', 'snake-pro'];
  const out = {};
  keys.forEach((key) => { out[key] = !!body[key]; });
  return out;
}

function currentMaintenance() {
  const stored = runtimeStore.temporary.get('admin:maintenance');
  const games = stored?.games || stored || {};
  return {
    crash: !!games.crash,
    chess: !!games.chess,
    pisti: !!games.pisti,
    classic: !!games.classic,
    'pattern-master': !!games['pattern-master'],
    'space-pro': !!games['space-pro'],
    'snake-pro': !!games['snake-pro']
  };
}

async function rewardAllUsers({ amount, reason, req, limit = 5000 }) {
  const { db, admin } = fb();
  if (!db || !admin) return { ok: false, error: 'FIRESTORE_DISABLED', affected: 0 };
  const docs = (await collectUserDocs(limit)).docs;
  let affected = 0;
  for (let i = 0; i < docs.length; i += 240) {
    const batch = db.batch();
    docs.slice(i, i + 240).forEach((doc) => {
      const auditRef = db.collection('audit').doc(`admin_reward_all_${doc.id}_${crypto.randomUUID()}`);
      batch.set(doc.ref, { balance: admin.firestore.FieldValue.increment(amount), updatedAt: now() }, { merge: true });
      batch.set(auditRef, { uid: doc.id, amount, reason, type: 'admin-reward-all', actor: adminActor(req), at: now() }, { merge: true });
      affected += 1;
    });
    await batch.commit();
  }
  return { ok: true, affected, amount };
}

router.get('/admin/matrix/dashboard', async (req, res) => {
  const { db } = fb();
  let userCount = 0, deletedCount = 0, mutedCount = 0, totalBalance = 0, dailyMcSpend = 0, dailyMcInflow = 0, dailyMcOutflow = 0, openRoomCount = 0;
  if (db) {
    try {
      const snap = await db.collection('users').limit(1000).get();
      userCount = snap.size;
      snap.forEach((doc) => {
        const d = doc.data() || {};
        totalBalance += Math.max(0, Number(d.balance || 0));
        if (d.deleted || d.deletedAt) deletedCount += 1;
        if (d.muted || d.banned || d.restrictions || d.gameRestricted || d.globalChatMuted || d.dmMuted) mutedCount += 1;
      });
    } catch (error) { logAdmin(req, 'admin.matrix.dashboard.users.error', { message: error.message }); }
    try {
      const since = now() - 24 * 3600000;
      const audit = await db.collection('audit').where('at', '>=', since).limit(800).get();
      audit.forEach((doc) => {
        const d = doc.data() || {};
        const amount = Number(d.amount || 0) || 0;
        dailyMcSpend += Math.abs(amount);
        if (amount < 0) dailyMcInflow += Math.abs(amount);
        if (amount > 0) dailyMcOutflow += amount;
      });
    } catch (error) { logAdmin(req, 'admin.matrix.dashboard.audit.error', { message: error.message }); }
  }
  try {
    openRoomCount = runtimeStore.rooms.size()
      + runtimeStore.gameInvites.size()
      + runtimeStore.temporary.values().filter((x) => x && typeof x === 'object' && /room|match/i.test(String(x.id || x.type || x.roomId || ''))).length;
  } catch (_) { openRoomCount = 0; }
  res.json({ ok:true, metrics:{ userCount, dailyMcSpend, totalLoss:dailyMcOutflow, totalProfit:dailyMcInflow, totalBalance, openRoomCount, deletedCount, mutedCount }, maintenance:currentMaintenance(), at:now() });
});

router.get('/admin/matrix/promos', async (_req, res) => { const { db } = fb(); const items = []; if (db) { try { const snap = await db.collection('promos').limit(100).get(); snap.forEach(d => { const x = d.data() || {}; items.push({ id:d.id, code:x.code || d.id, amount:x.amount || 0, limitLeft:Math.max(0, Number(x.maxClaims || x.usageLimit || 0) - Number(x.claimedCount || 0)), expiresAt:x.expiresAt || 0 }); }); } catch (_) {} } res.json({ ok:true, items }); });

router.get('/admin/matrix/issues', (_req, res) => {
  const all = runtimeStore.errors.values().sort((a,b)=>(b.createdAt || b.at || 0) - (a.createdAt || a.at || 0)).slice(0,120);
  const GAME_AREAS = new Set(['home', 'crash', 'chess', 'pisti', 'snake-pro', 'space-pro', 'pattern-master']);
  const gameTitle = (game) => ({ home: 'AnaSayfa', crash: 'Crash', chess: 'Satranç', pisti: 'Pişti', 'snake-pro': 'Snake Pro', 'space-pro': 'Space Pro', 'pattern-master': 'Pattern Master' }[String(game || '').toLowerCase()] || 'Sistem');
  const resolveIssueSolution = (x = {}, game = '', message = '', scope = '') => {
    const text = `${message} ${scope} ${x.path || ''} ${x.endpoint || ''} ${x.source || ''}`.toLowerCase();
    if (game === 'home' && text.includes('oturum bulunamadı')) return 'AnaSayfa private widget oturum hazır olmadan çalışmamalı; auth state hazır değilse giriş gerekli görünümü gösterilmeli.';
    if (game === 'home' && (text.includes('http_405') || Number(x.status || 0) === 405)) return 'Client endpoint methodu ve API base fallback sırası kontrol edilmeli; eski cache/script kaynağı temizlenmeli.';
    if (game === 'home' && text.includes('network-request-failed')) return 'Firebase Auth network erişimi, authorized domain ve cihaz bağlantısı kontrol edilmeli.';
    if (game === 'crash') return 'Crash API route, risk/round state, bet/cashout transaction ve client payload birlikte kontrol edilmeli.';
    if (game === 'chess') return 'Satranç room stateVersion, socket ACK, hamle payload ve backend oda durumu birlikte kontrol edilmeli.';
    if (game === 'pisti') return 'Pişti lobby/state/socket, masa lifecycle, oyuncu schema ve ekonomi transaction akışı birlikte kontrol edilmeli.';
    if (['snake-pro', 'space-pro', 'pattern-master'].includes(game)) return 'Klasik oyun start/submit runId sözleşmesi, skor sınırı, XP sonucu ve frontend endpoint akışı birlikte kontrol edilmeli.';
    return 'Sistem kaydı kaynak, endpoint, status ve güvenli stack bilgisiyle ayrıca incelenmeli.';
  };
  const normalizeIssue = (x = {}) => {
    const game = String(x.game || '').toLowerCase();
    const message = String(x.message || x.error || x.reason || JSON.stringify(x.details || x.payload || {})).slice(0, 360) || 'Kayıt';
    const path = String(x.path || x.endpoint || '').slice(0, 180);
    const scope = String(x.scope || x.event || 'runtime').slice(0, 100);
    return { createdAt: x.createdAt || x.at || Date.now(), game: game || 'system', scope, area: x.area || gameTitle(game), error: x.error || message, reason: x.reason || (x.status ? `HTTP ${x.status} / ${scope}${path ? ` / ${path}` : ''}` : scope), solution: x.solution || resolveIssueSolution(x, game, message, scope), message, path, status: x.status || '', severity: x.severity || 'info', title: `${gameTitle(game)} = ${scope}`, body: `${message}${path ? ` • ${path}` : ''}` };
  };
  const normalized = all.map(normalizeIssue);
  const gameIssues = normalized.filter(x => GAME_AREAS.has(String(x.game || '').toLowerCase())).slice(0, 60);
  const systemIssues = normalized.filter(x => !GAME_AREAS.has(String(x.game || '').toLowerCase())).slice(0, 30);
  res.json({ ok:true, games:gameIssues, systems:systemIssues, recentErrors:normalized.slice(0, 70) });
});

router.post('/admin/matrix/reset-nuclear', strictLimiter, async (req, res) => {
  const confirmText = String(req.body?.confirmText || '').toUpperCase();
  if (confirmText !== 'ONAYLIYORUM') return res.status(400).json({ ok:false, error:'CONFIRM_REQUIRED' });
  const fields = Array.isArray(req.body?.fields) ? req.body.fields.map((x) => safe(x, 80)) : [];
  const patch = resetPatchForFields(fields);
  if (!Object.keys(patch).length) return res.status(400).json({ ok:false, error:'NO_VALID_FIELDS' });
  const { db } = fb();
  if (!db) return res.status(503).json({ ok:false, error:'FIRESTORE_DISABLED' });
  const docs = (await collectUserDocs(5000)).docs;
  const result = await writeUserBatch(docs.map((doc) => ({ ref: doc.ref, patch })));
  logAdmin(req, 'admin.matrix.reset.applied', { fields, affected: result.affected });
  res.json({ ok:true, dryRun:false, affected: result.affected, fields });
});

router.get('/admin/matrix/maintenance', (_req, res) => res.json({ ok:true, maintenance:currentMaintenance() }));
router.patch('/admin/matrix/maintenance', strictLimiter, async (req, res) => {
  const games = normalizeMaintenancePayload(req.body || {});
  const payload = { games, at:now(), actor:adminActor(req) };
  runtimeStore.temporary.set('admin:maintenance', payload, 30*86400000);
  const { db } = fb();
  if (db) await db.collection('gameConfig').doc('maintenance').set(payload, { merge:true }).catch((error) => logAdmin(req, 'admin.matrix.maintenance.persist.error', { message:error.message }));
  logAdmin(req, 'admin.matrix.maintenance', { games });
  res.json({ ok:true, maintenance:games });
});

router.post('/admin/matrix/restrict-user', strictLimiter, async (req, res) => {
  const confirmText = String(req.body?.confirmText || '').toUpperCase();
  if (confirmText !== 'ONAYLIYORUM') return res.status(400).json({ ok:false, error:'CONFIRM_REQUIRED' });
  const resolved = await resolveUserIdentifier(req.body?.identifier || '');
  if (!resolved.ok) return res.status(resolved.error === 'MULTIPLE_USERS_MATCH' ? 409 : 404).json(resolved);
  const action = safe(req.body?.action, 80);
  const durationMinutes = Math.max(0, Math.trunc(Number(req.body?.durationMinutes || 0)));
  const expiresAt = durationMinutes > 0 ? now() + durationMinutes * 60000 : 0;
  const reason = safe(req.body?.reason || `admin-${action}`, 220);
  const patch = { restrictions: { ...(resolved.user.restrictions || {}), [action]: { active:true, reason, expiresAt, actor:adminActor(req), at:now() } } };
  if (action === 'ban') Object.assign(patch, { banned:true, banReason:reason, bannedAt:now(), banActor:adminActor(req) });
  if (action === 'games_mute') { patch.gameRestricted = true; patch.gameRestrictedUntil = expiresAt || 0; }
  if (action === 'global_chat_mute') { patch.globalChatMuted = true; patch.globalChatMutedUntil = expiresAt || 0; }
  if (action === 'dm_mute') { patch.dmMuted = true; patch.dmMutedUntil = expiresAt || 0; }
  await setUserPatch(resolved.uid, patch);
  logAdmin(req, 'admin.matrix.restrict-user.applied', { uid: resolved.uid, action, durationMinutes, reason });
  res.json({ ok:true, uid: resolved.uid, match: resolved.match, action, expiresAt });
});

router.post('/admin/matrix/reward-user', strictLimiter, async (req, res) => {
  const confirmText = String(req.body?.confirmText || '').toUpperCase();
  if (confirmText !== 'ONAYLIYORUM') return res.status(400).json({ ok:false, error:'CONFIRM_REQUIRED' });
  const amount = nonNegativeMoney(req.body?.amount);
  if (!amount) return res.status(400).json({ ok:false, error:'AMOUNT_REQUIRED' });
  const resolved = await resolveUserIdentifier(req.body?.identifier || '');
  if (!resolved.ok) return res.status(resolved.error === 'MULTIPLE_USERS_MATCH' ? 409 : 404).json(resolved);
  const result = await incrementBalance(resolved.uid, amount, safe(req.body?.reason || 'admin-matrix-reward',120), req).catch(error => ({ ok:false, error:error.message }));
  res.json({ ok:!!result.ok, uid:resolved.uid, match:resolved.match, result });
});

router.post('/admin/matrix/reward-all', strictLimiter, async (req, res) => {
  const confirmText = String(req.body?.confirmText || '').toUpperCase();
  if (confirmText !== 'ONAYLIYORUM') return res.status(400).json({ ok:false, error:'CONFIRM_REQUIRED' });
  const amount = nonNegativeMoney(req.body?.amount);
  const reason = safe(req.body?.reason || 'admin-matrix-reward-all',160);
  if (!amount) return res.status(400).json({ ok:false, error:'AMOUNT_REQUIRED' });
  const result = await rewardAllUsers({ amount, reason, req, limit: 5000 });
  if (!result.ok) return res.status(503).json(result);
  logAdmin(req, 'admin.matrix.reward-all.applied', { amount, reason, affected:result.affected });
  res.json({ ok:true, dryRun:false, affected:result.affected, amount });
});

router.post('/admin/matrix/promo-codes', strictLimiter, async (req, res) => { const code = safe(req.body.code, 40).toUpperCase(); const amount = nonNegativeMoney(req.body.amount); const usageLimit = Math.max(1, Math.min(100000, Math.trunc(Number(req.body.usageLimit || req.body.maxClaims) || 1))); if (!code || !amount) return res.status(400).json({ ok:false, error:'PROMO_CODE_AMOUNT_REQUIRED' }); const { db } = fb(); const promo = { code, amount, usageLimit, maxClaims:usageLimit, onePerAccount:req.body.onePerAccount !== false, description:safe(req.body.description,200), expiresAt: now() + Math.max(1, Number(req.body.durationHours || 24))*3600000, active:true, createdAt:now(), actor:adminActor(req) }; if (db) await Promise.all([db.collection('promos').doc(code).set(promo, { merge:true }), db.collection('promoCodes').doc(code).set(promo, { merge:true })]); logAdmin(req, 'admin.matrix.promo.create', { code, amount, usageLimit }); res.json({ ok:true, promo }); });

router.get('/admin/runtime-logs', (_req, res) => res.json({ ok:true, logs:listAdminLogs() }));

router.post('/admin/cleanup/firestore', strictLimiter, async (req,res) => {
  const { db } = fb();
  const report = await runSafeFirestoreCleanup({ db, dryRun:req.body?.dryRun !== false });
  logAdmin(req, 'admin.cleanup.firestore', report);
  res.json(report);
});

module.exports = router;
