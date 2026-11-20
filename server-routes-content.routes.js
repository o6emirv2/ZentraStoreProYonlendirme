'use strict';
const express = require('express');
const { requireAuth, requireAdmin, strictLimiter } = require('./server-core-security.js');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { addAdminLog } = require('./server-admin-adminRuntimeLogStore.js');
const router = express.Router();
const DEFAULT_CONTENT = Object.freeze({
  heroTitle: 'Oyunların Yeni Merkezi',
  heroDescription: 'PlayMatrix, gerçek para işlemi içermeyen ücretsiz rekabet, strateji ve beceri oyunlarını tek bir platformda sunar.',
  gamesTitle: 'Oyun Vitrini',
  gamesSubtitle: 'Strateji, refleks ve beceri oyunlarını tek bir yerde keşfet.',
  announcement: 'Yeni üyeliğe 1.000 MC, e-posta doğrulamasına 2.000 MC.',
  gameTitles: { crash:'Crash', chess:'Satranç', pisti:'Pişti', space:'Space Pro', snake:'Snake Pro' },
  gameDescriptions: { crash:'Zamanlama ve refleks oyunu.', chess:'Strateji ve planlamada kendini geliştir.', pisti:'Kart takibi ve çevrimiçi oyun.', space:'Uzayda hayatta kalma mücadelesi.', snake:'Klasik yılan oyununu yeniden keşfet.' }
});
const LIMITS = Object.freeze({ heroTitle: 90, heroDescription: 420, gamesTitle: 70, gamesSubtitle: 220, announcement: 180 });
const GAME_KEYS = Object.freeze(['crash','chess','pisti','space','snake']);
const sanitizeText = (value, fallback, max) => typeof value === 'string' ? (value.trim().replace(/[\u0000-\u001f<>]/g, '').slice(0,max) || fallback) : fallback;
const clean = (values = {}) => ({
  ...Object.fromEntries(Object.entries(LIMITS).map(([key,max]) => [key, sanitizeText(values[key], DEFAULT_CONTENT[key], max)])),
  gameTitles: Object.fromEntries(GAME_KEYS.map(key => [key, sanitizeText(values.gameTitles?.[key], DEFAULT_CONTENT.gameTitles[key], 50)])),
  gameDescriptions: Object.fromEntries(GAME_KEYS.map(key => [key, sanitizeText(values.gameDescriptions?.[key], DEFAULT_CONTENT.gameDescriptions[key], 230)]))
});
router.get('/site/content', async (_req, res, next) => {
  try {
    const { db } = initFirebaseAdmin();
    if (!db) return res.json({ ok:true, content:DEFAULT_CONTENT, persisted:false });
    const snapshot = await db.collection('siteConfig').doc('home').get();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok:true, content:clean(snapshot.exists ? snapshot.data() : DEFAULT_CONTENT), persisted:!!snapshot.exists });
  } catch (error) { next(error); }
});
router.put('/admin/site/content', requireAuth, requireAdmin, strictLimiter, async (req, res, next) => {
  try {
    const { db } = initFirebaseAdmin();
    if (!db) return res.status(503).json({ ok:false, error:'FIREBASE_UNAVAILABLE' });
    const content = clean(req.body || {});
    const record = { ...content, updatedAt:Date.now(), updatedBy:req.user.uid };
    await db.collection('siteConfig').doc('home').set(record, { merge:true });
    addAdminLog('admin.site.content.update', { actor:req.user.uid, at:record.updatedAt });
    res.json({ ok:true, content, updatedAt:record.updatedAt });
  } catch (error) { next(error); }
});
module.exports = router;
