const express = require('express');
const crypto = require('crypto');
const env = require('./server-config-env.js');
const { requireAuth, requireAdmin, strictLimiter } = require('./server-core-security.js');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { runtimeStore } = require('./server-core-runtimeStore.js');
const {presence} = require('./server-social-socialRuntimeStore.js');
const { getProgression } = require('./server-core-progressionService.js');
const friendships=require('./server-social-friendshipService.js');
const referrals=require('./server-core-referralService.js');
const messages=require('./server-social-messageService.js');
const { runOnce } = require('./server-core-idempotencyService.js');
const { SIGNUP_MC, EMAIL_VERIFICATION_MC } = require('./server-core-rewardPolicy.js');
const router = express.Router();

const DEFAULT_AVATAR = 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%20128%20128%27%3E%3Crect%20width%3D%27128%27%20height%3D%27128%27%20rx%3D%2728%27%20fill%3D%27%23111827%27%2F%3E%3Ccircle%20cx%3D%2764%27%20cy%3D%2750%27%20r%3D%2724%27%20fill%3D%27%23f59e0b%27%2F%3E%3Cpath%20d%3D%27M26%20108c8-18%2024-28%2038-28s30%2010%2038%2028%27%20fill%3D%27%23fbbf24%27%2F%3E%3Ctext%20x%3D%2764%27%20y%3D%27118%27%20text-anchor%3D%27middle%27%20font-family%3D%27Arial%27%20font-size%3D%2716%27%20font-weight%3D%27700%27%20fill%3D%27%23fff%27%3EPM%3C%2Ftext%3E%3C%2Fsvg%3E';
const now = () => Date.now();
const s = (v, max = 200) => String(v || '').trim().slice(0, max);
const sanitizeText = (v, max = 500) => s(v, max).replace(/[<>]/g, '');
const uidOf = (req) => s(req.user?.uid || req.headers['x-playmatrix-user'] || req.body?.uid || req.query?.uid || '', 160);

const CHAT_POLICY = Object.freeze({
  memoryOnly: false,
  lobbyDays: 7,
  directDays: 14,
  lobbyLabel: 'Global 7 Gün',
  directLabel: 'DM 14 Gün',
  summaryLabel: 'Global 7 Gün · DM 14 Gün',
  manualDeleteLabel: 'Kullanıcı tarafından silindi',
  cleanupLabel: 'Saklama süresi dolduğu için temizlendi',
  lobbyDisclosure: 'Yerel sohbet mesajları hesabınıza bağlı olarak saklanır.',
  directDisclosure: 'Özel mesajlar hesabınıza bağlı olarak saklanır.',
  tombstoneDisclosure: 'Silinen mesajların içeriği boş gösterilir; manuel silme ve süre temizliği ayrı etiketlenir.',
  editWindowHours: 24,
  editWindowLabel: 'Özel mesajlar ilk 24 saat içinde düzenlenebilir.',
  transparencyNote: 'Mesajların saklanması ve silinmesi hesap güvenliği kurallarına tabidir.'
});
const fb = () => initFirebaseAdmin();
function emailVerified(req) { return req.user?.email_verified === true || req.user?.emailVerified === true; }
function addProgression(profile) {
  const progression = getProgression(profile);
  return {
    ...profile,
    accountLevel: progression.level, level: progression.level,
    accountLevelProgressPct: progression.progressPercent,
    progressPercent: progression.progressPercent,
    accountProgressionVersion: progression.version,
    accountLevelCurveMode: progression.curveMode,
    progression
  };
}
function defaultProfile(req, uid, seed = {}) {
  const email = s(req.user?.email || req.user?.firebase?.identities?.email?.[0] || seed.email || '', 160);
  const username = s(seed.username || req.user?.name || (email ? email.split('@')[0] : `Oyuncu-${String(uid).slice(0,5)}`), 32);
  return addProgression({ uid, email, username, fullName: seed.fullName || username, displayName: username, avatar: seed.avatar || DEFAULT_AVATAR, balance: Number(seed.balance ?? SIGNUP_MC) || 0, signupBonusClaimed: true, accountLevel: 1, accountLevelProgressTicks: 0, monthlyActiveScore: 0, totalRounds: 0, createdAt: now(), lastLogin: now(), lastSeen: now(), gameStats: { total: { rounds: 0, wins: 0, losses: 0, winRatePct: 0 }, chess: {}, pisti: {}, crash: {}, classic: {} } });
}
async function grantEmailVerifyRewardIfNeeded(req, uid, profile = {}) {
  if (!uid || !emailVerified(req) || profile.emailVerifyRewardClaimed) return profile;
  const { db, admin } = fb();
  if (!db || !admin) return profile;
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : {};
    if (current.emailVerifyRewardClaimed) return;
    if (!snap.exists) throw Object.assign(new Error('PROFILE_NOT_READY'),{statusCode:409});
    tx.set(ref, { emailVerified: true, emailVerifyRewardClaimed: true, emailVerifyRewardAt: now(), balance: admin.firestore.FieldValue.increment(EMAIL_VERIFICATION_MC), updatedAt: now() }, { merge: true });
    tx.set(db.collection('audit').doc(`email_verify_${uid}`), { uid, amount: EMAIL_VERIFICATION_MC, reason: 'email-verified-reward', at: now() }, { merge: true });
  });
  const fresh = await ref.get().catch(() => null);
  return fresh?.exists ? { ...profile, ...fresh.data(), uid } : { ...profile, emailVerified: true, emailVerifyRewardClaimed: true };
}
async function readProfile(req, uid = uidOf(req), seed = {}) {
  if (!uid) throw Object.assign(new Error('AUTH_REQUIRED'), {statusCode:401});
  const safeUid = uid;
  let profile = defaultProfile(req, safeUid, seed);
  const { db } = fb();
  if (!db && uid) throw Object.assign(new Error('DATA_NOT_READY'),{statusCode:503});
  if (db && uid) {
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    if (snap.exists) profile = { ...profile, ...snap.data(), uid };
    else {
      try { await ref.create(profile); }
      catch (error) {
        if (error.code !== 6 && error.code !== 'already-exists') throw error;
        const latest=await ref.get();
        if (!latest.exists) throw Object.assign(new Error('PROFILE_NOT_READY'),{statusCode:409});
        profile={...profile,...latest.data(),uid};
      }
    }
  }
  // Account balance is exclusively persisted. Never substitute stale process-local MC.
  const memoryStats = runtimeStore.temporary.get(`gameStats:${safeUid}`);
  if (memoryStats && typeof memoryStats === 'object') {
    profile.gameStats = { ...(profile.gameStats || {}), ...memoryStats, total: { ...((profile.gameStats || {}).total || {}), ...(memoryStats.total || {}) } };
    profile.totalRounds = Number(profile.gameStats.total?.rounds || profile.totalRounds || 0);
  }
  profile = await grantEmailVerifyRewardIfNeeded(req, uid, profile);
  return addProgression(profile);
}
async function writeProfile(uid, patch) { const { db } = fb(); if (db && uid) await db.collection('users').doc(uid).set({ ...patch, updatedAt: now() }, { merge: true }); }
function runtimePayload() { return { ok: true, runtime: { version: 8, environment: env.nodeEnv, publicBaseUrl: env.publicBaseUrl, canonicalOrigin: env.canonicalOrigin, apiBase: env.publicApiBase || env.publicBackendOrigin, expectedFirebaseProjectId: env.firebase.publicConfig.projectId, firebase: env.firebase.publicConfig, firebaseReady: true, source: 'render-env-contract' }, apiBase: env.publicApiBase || env.publicBackendOrigin, canonicalOrigin: env.canonicalOrigin, firebase: env.firebase.publicConfig }; }
async function leaderboardProfiles() { const { db } = fb(); if (!db) return []; try { const snap = await db.collection('users').limit(500).get(); return snap.docs.map(d => ({ uid: d.id, ...d.data() })); } catch { return []; } }
function lbItems(list, metric) {
  return list.map((raw,i)=>{
    const p=addProgression(raw);
    const wins=Number(p.gameStats?.total?.wins||0);
    const balance=Number(p.balance||0);
    return {uid:p.uid||'',username:p.username||p.displayName||'Oyuncu',avatar:p.avatar||DEFAULT_AVATAR,balance,mc:balance,
      stats:{totalWins:wins},accountLevel:p.accountLevel,accountLevelProgressPct:p.accountLevelProgressPct,
      monthlyActiveScore:Number(p.monthlyActiveScore||0),
      leaderboard:{rank:i+1,metricKey:metric==='activity'?'monthlyActiveScore':'accountLevel',
      metricLabel:metric==='activity'?'Aylık Aktiflik':'Hesap Seviyesi',
      metricValue:metric==='activity'?Number(p.monthlyActiveScore||0):p.accountLevel}};
  });
}
function gameProfileFromReq(req, fallbackName = 'Oyuncu') { const u = req.__pmProfile || {}; return { uid: uidOf(req), username: u.username || u.displayName || fallbackName, avatar: u.avatar || DEFAULT_AVATAR,  }; }
async function attachProfile(req, _res, next) { try { req.__pmProfile = await readProfile(req, uidOf(req)); } catch (_) { req.__pmProfile = defaultProfile(req, uidOf(req)); } next(); }

function matrixSecret() {
  return [process.env.ADMIN_PANEL_SECOND_FACTOR_HASH_HEX || '', process.env.ADMIN_PANEL_SECOND_FACTOR_SALT_HEX || '', process.env.ADMIN_PANEL_THIRD_FACTOR_NAME || '', process.env.ADMIN_UIDS || '', process.env.ADMIN_EMAILS || '', process.env.FIREBASE_PROJECT_ID || '', 'playmatrix_admin_matrix_v2'].join('|');
}
function b64(v=''){ return Buffer.from(String(v),'utf8').toString('base64url'); }
function unb64(v=''){ try { return Buffer.from(String(v),'base64url').toString('utf8'); } catch { return ''; } }
function signMatrix(payload={}){ const body=b64(JSON.stringify(payload)); const sig=crypto.createHmac('sha256', matrixSecret()).update(body).digest('base64url'); return `${body}.${sig}`; }
function verifyMatrixToken(token='') { const raw=String(token||'').trim(); const i=raw.lastIndexOf('.'); if(i<=0)return null; const body=raw.slice(0,i), sig=raw.slice(i+1); const expected=crypto.createHmac('sha256', matrixSecret()).update(body).digest('base64url'); const a=Buffer.from(sig), b=Buffer.from(expected); if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return null; try{return JSON.parse(unb64(body));}catch{return null;} }
function issueStep(req, stage=1, prev='') { return signMatrix({ typ:'pm_admin_step', stage, uid: uidOf(req), email: String(req.user?.email || '').toLowerCase(), prev:s(prev,200), at:now(), exp:now()+7*60*1000, nonce:crypto.randomBytes(8).toString('hex') }); }
function verifyStep(token, stage) { const payload=verifyMatrixToken(token); if(!payload||payload.typ!=='pm_admin_step') return {ok:false,error:'INVALID_STEP_TOKEN'}; if(Number(payload.stage)!==Number(stage)) return {ok:false,error:'STEP_MISMATCH'}; if(Number(payload.exp||0)<now()) return {ok:false,error:'STEP_EXPIRED'}; return {ok:true,payload}; }
function candidateSecondFactorHashes(password='', saltHex='') { const pwd=Buffer.from(String(password||''),'utf8'); const salt=/^[0-9a-f]+$/i.test(String(saltHex||'')) && String(saltHex||'').length%2===0 ? Buffer.from(String(saltHex||''),'hex') : Buffer.from(String(saltHex||''),'utf8'); const saltText=String(saltHex||''); return Array.from(new Set([crypto.createHash('sha256').update(Buffer.concat([salt,pwd])).digest('hex'), crypto.createHash('sha256').update(Buffer.concat([pwd,salt])).digest('hex'), crypto.createHash('sha256').update(`${saltText}${String(password||'')}`).digest('hex'), crypto.createHash('sha256').update(`${String(password||'')}${saltText}`).digest('hex'), crypto.createHmac('sha256',salt).update(pwd).digest('hex')])); }
function safeEqual(a='',b='') { const x=String(a||'').toLowerCase(), y=String(b||'').toLowerCase(); if(!x||!y||x.length!==y.length)return false; return crypto.timingSafeEqual(Buffer.from(x),Buffer.from(y)); }
function verifySecondFactor(password='') { const raw=String(process.env.ADMIN_PANEL_SECOND_FACTOR||''); if(raw && password===raw)return true; const hash=String(process.env.ADMIN_PANEL_SECOND_FACTOR_HASH_HEX||'').toLowerCase(); const salt=String(process.env.ADMIN_PANEL_SECOND_FACTOR_SALT_HEX||''); if(!hash)return false; return candidateSecondFactorHashes(password,salt).some(h=>safeEqual(h,hash)); }
function verifyThirdFactor(name='') { const expected=String(process.env.ADMIN_PANEL_THIRD_FACTOR_NAME||''); const input=String(name||''); if(!expected||!input)return false; const a=Buffer.from(input.normalize('NFKC')), b=Buffer.from(expected.normalize('NFKC')); return a.length===b.length && crypto.timingSafeEqual(a,b); }
function issueClientKey(req) { return signMatrix({ typ:'pm_admin_client_key', uid:uidOf(req), email:String(req.user?.email||'').toLowerCase(), at:now(), exp:now()+12*3600000, nonce:crypto.randomBytes(8).toString('hex') }); }
function verifyClientKey(key='') { const p=verifyMatrixToken(key); return !!(p&&p.typ==='pm_admin_client_key'&&Number(p.exp||0)>now()); }
function primaryAdmin(){ return { uid: env.adminUids[0] || '', email: env.adminEmails[0] || '' }; }
function isConfiguredAdmin(email='', uid=''){ const e=String(email||'').trim().toLowerCase(); const u=String(uid||'').trim(); return (!!e && env.adminEmails.includes(e)) || (!!u && env.adminUids.includes(u)); }
function compareHex(a='',b=''){ const x=String(a||'').toLowerCase(), y=String(b||'').toLowerCase(); if(!x||!y||x.length!==y.length)return false; return crypto.timingSafeEqual(Buffer.from(x),Buffer.from(y)); }
function verifySecondFactor(password=''){ const raw=String(process.env.ADMIN_PANEL_SECOND_FACTOR||''); if(raw && String(password||'')===raw)return true; const stored=String(process.env.ADMIN_PANEL_SECOND_FACTOR_HASH_HEX||'').toLowerCase(); const saltHex=String(process.env.ADMIN_PANEL_SECOND_FACTOR_SALT_HEX||''); if(!stored)return false; const pwd=Buffer.from(String(password||''),'utf8'); const salt=/^[0-9a-f]+$/i.test(saltHex)&&saltHex.length%2===0?Buffer.from(saltHex,'hex'):Buffer.from(saltHex,'utf8'); const candidates=Array.from(new Set([crypto.createHash('sha256').update(Buffer.concat([salt,pwd])).digest('hex'),crypto.createHash('sha256').update(Buffer.concat([pwd,salt])).digest('hex'),crypto.createHash('sha256').update(`${saltHex}${String(password||'')}`).digest('hex'),crypto.createHash('sha256').update(`${String(password||'')}${saltHex}`).digest('hex'),crypto.createHmac('sha256',salt).update(pwd).digest('hex')])); return candidates.some(x=>compareHex(x,stored)); }
function verifyThirdFactor(name=''){ const expected=String(process.env.ADMIN_PANEL_THIRD_FACTOR_NAME||'').trim(); const value=String(name||'').trim(); if(!expected||!value)return false; const a=Buffer.from(value.normalize('NFKC')); const b=Buffer.from(expected.normalize('NFKC')); return a.length===b.length && crypto.timingSafeEqual(a,b); }
function issueClientKey(payload={}){ return signMatrix({ typ:'pm_admin_client_key', ...payload, issuedAt:now(), expiresAt:now()+12*3600000, nonce:crypto.randomBytes(10).toString('hex') }); }
function verifyClientKey(key=''){ const payload=verifyMatrixToken(key); if(!payload||payload.typ!=='pm_admin_client_key')return {ok:false,code:'INVALID_CLIENT_KEY'}; if(Number(payload.expiresAt||0)<now())return {ok:false,code:'CLIENT_KEY_EXPIRED'}; return {ok:true,payload}; }
function adminContext(uid='',email=''){ return { isAdmin:true, uid, email, role:'owner', roles:['owner'], permissions:['admin.read','users.read','users.write','rewards.write','rewards.read','system.read','moderation.write'], source:'env', resolutionChain:['env:ADMIN_EMAILS','env:ADMIN_UIDS'] }; }
function sessionFromReq(req){ const token=String(req.headers['x-session-token']||'').trim(); if(!token)return null; const session=runtimeStore.temporary.get(`session:${token}`); return session?.uid?{token,...session}:null; }
router.get('/auth/admin/matrix/identity',(req,res)=>{ const session=sessionFromReq(req); if(session&&isConfiguredAdmin(session.email,session.uid))return res.json({ok:true,authenticated:true,admin:true,user:{uid:session.uid,email:session.email},adminContext:adminContext(session.uid,session.email)}); const primary=primaryAdmin(); if(!primary.email)return res.status(401).json({ok:false,authenticated:false,admin:false,user:null,error:'ADMIN_ENV_MISSING'}); return res.json({ok:true,authenticated:false,admin:true,user:primary,adminContext:adminContext(primary.uid,primary.email),manualFallback:true}); });
router.post('/auth/admin/matrix/step-email',requireAuth,requireAdmin,strictLimiter,(req,res)=>{ const primary=primaryAdmin(); const email=String(req.user.email||'').trim().toLowerCase(); const uid=String(req.user.uid||''); if(!email||!isConfiguredAdmin(email,uid))return res.status(401).json({ok:false,error:'Yönetici e-postası yetkili listede değil.'}); res.json({ok:true,boundToSession:true,manualFallback:false,email,ticket:signMatrix({typ:'pm_admin_step',uid,email,stage:2,issuedAt:now(),expiresAt:now()+7*60000,nonce:crypto.randomBytes(12).toString('hex')}),admin:adminContext(uid,email)}); });
router.post('/auth/admin/matrix/step-password',requireAuth,requireAdmin,strictLimiter,(req,res)=>{ const payload=verifyMatrixToken(req.body?.ticket||''); if(!payload||payload.typ!=='pm_admin_step'||Number(payload.stage)!==2||Number(payload.expiresAt||0)<now())return res.status(401).json({ok:false,error:'Güvenlik oturumu geçersiz.'}); if(!verifySecondFactor(req.body?.password||''))return res.status(403).json({ok:false,error:'Güvenlik şifresi doğrulanamadı.'}); res.json({ok:true,ticket:signMatrix({...payload,stage:3,prev:'identity+password',issuedAt:now(),expiresAt:now()+7*60000})}); });
router.post('/auth/admin/matrix/step-name',requireAuth,requireAdmin,strictLimiter,(req,res)=>{ const payload=verifyMatrixToken(req.body?.ticket||''); if(!payload||payload.typ!=='pm_admin_step'||Number(payload.stage)!==3||Number(payload.expiresAt||0)<now())return res.status(401).json({ok:false,error:'Güvenlik oturumu geçersiz.'}); if(!verifyThirdFactor(req.body?.adminName||req.body?.name||''))return res.status(403).json({ok:false,error:'Son güvenlik doğrulaması başarısız oldu.'}); if(!isConfiguredAdmin(payload.email,payload.uid)||payload.uid!==req.user.uid)return res.status(403).json({ok:false,error:'Yönetici yetkisi doğrulanamadı.'}); const sessionToken=crypto.randomBytes(32).toString('hex'); const sessionId=crypto.randomBytes(12).toString('hex'); runtimeStore.temporary.set(`session:${sessionToken}`,{uid:payload.uid,email:payload.email,sessionSource:'admin_matrix',sessionId,at:now()},12*3600000); const clientKey=issueClientKey({uid:payload.uid,email:payload.email,sessionId}); res.setHeader('Set-Cookie',`pm_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`); res.json({ok:true,redirectTo:'/admin/admin.html',sessionToken,clientKey,admin:adminContext(payload.uid,payload.email)}); });
router.get('/auth/admin/matrix/status',(req,res)=>{ const session=sessionFromReq(req); if(!session||!isConfiguredAdmin(session.email,session.uid))return res.status(401).json({ok:false,authenticated:false,redirectTo:'/admin/index.html',error:'Yönetici oturumu bulunamadı.'}); const keyState=verifyClientKey(req.headers['x-admin-client-key']||''); if(!keyState.ok)return res.status(403).json({ok:false,authenticated:true,redirectTo:'/admin/index.html',code:keyState.code,error:'Yönetici güvenlik anahtarı doğrulanamadı.'}); res.json({ok:true,authenticated:true,user:{uid:session.uid,email:session.email},admin:adminContext(session.uid,session.email),clientKey:issueClientKey({uid:session.uid,email:session.email,sessionId:session.sessionId||''})}); });
router.post('/auth/admin/bootstrap', requireAuth, strictLimiter, (req,res)=>{ const uid=String(req.user?.uid||''); const email=String(req.user?.email||'').trim().toLowerCase(); if(!isConfiguredAdmin(email,uid))return res.status(403).json({ok:false,error:'ADMIN_REQUIRED'}); const sessionToken=crypto.randomBytes(32).toString('hex'); const sessionId=crypto.randomBytes(12).toString('hex'); runtimeStore.temporary.set(`session:${sessionToken}`,{uid,email,sessionSource:'firebase_admin_bootstrap',sessionId,at:now()},12*3600000); const clientKey=issueClientKey({uid,email,sessionId}); res.setHeader('Set-Cookie',`pm_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`); res.json({ok:true,authenticated:true,sessionToken,clientKey,admin:adminContext(uid,email)}); });
router.post('/auth/admin/matrix/logout',(req,res)=>{ const token=String(req.headers['x-session-token']||'').trim(); if(token)runtimeStore.temporary.delete(`session:${token}`); res.setHeader('Set-Cookie','pm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({ok:true}); });

router.get('/healthz', (_req, res) => res.json({ ok: true, service: 'playmatrix-api', at: now() }));
router.post('/auth/resolve-login', strictLimiter, async (req, res) => { const id = s(req.body?.identifier || req.body?.email || req.body?.username, 160); if (!id) return res.status(400).json({ ok: false, error: 'IDENTIFIER_REQUIRED' }); if (id.includes('@')) return res.json({ ok: true, email: id.toLowerCase() }); const { db } = fb(); if (!db) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' }); const q = await db.collection('users').where('usernameLower', '==', id.toLowerCase()).limit(1).get(); if (q.empty || !q.docs[0].data().email) return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' }); res.json({ ok: true, email: q.docs[0].data().email }); });
router.post('/auth/session/create', requireAuth, async (req, res) => { const token = crypto.randomBytes(32).toString('hex'); const uid = uidOf(req); runtimeStore.temporary.set(`session:${token}`, { uid, email: req.user?.email || '', at: now() }, 30 * 86400000); const user = await readProfile(req, uid, { email: req.user?.email || '' }); res.json({ ok: true, sessionToken: token, session: { token, expiresAt: now() + 30 * 86400000 }, user }); });
router.post('/auth/session/logout', (req, res) => { const token = s(req.headers['x-session-token'] || req.body?.sessionToken, 100); if (token) runtimeStore.temporary.delete(`session:${token}`); res.json({ ok: true }); });
router.get('/auth/session/status', (req, res) => { const token = s(req.headers['x-session-token'] || req.query?.sessionToken, 100); res.json({ ok: true, active: !!(token && runtimeStore.temporary.get(`session:${token}`)) }); });
router.get('/me', requireAuth, async (req, res) => res.json({ ok: true, user: await readProfile(req) }));
router.post('/me/activity/heartbeat', requireAuth, async (req, res) => { const uid = uidOf(req); runtimeStore.presence.set(uid, { uid, status: 'online', activity: s(req.body?.activity, 40), at: now() }, 180000); res.json({ ok: true, at: now() }); });
router.post('/me/showcase', requireAuth, async (req, res) => { const uid = uidOf(req); const showcase = { title: s(req.body?.title, 60), bio: sanitizeText(req.body?.bio || '', 180), updatedAt: now() }; await writeProfile(uid, { showcase }); res.json({ ok: true, showcase }); });
router.get('/leaderboard', async (_req,res)=>{
  const profiles=await leaderboardProfiles();
  const byLevel=[...profiles].sort((a,b)=>{
    const x=getProgression(a),y=getProgression(b);
    return y.level-x.level || y.progressPercent-x.progressPercent;
  });
  const byActivity=[...profiles].sort((a,b)=>Number(b.monthlyActiveScore||0)-Number(a.monthlyActiveScore||0));
  res.json({ok:true,generatedAt:now(),tabs:{
    level:{label:'En Yüksek Hesap Seviyesi',metricKey:'accountLevel',items:lbItems(byLevel.slice(0,25),'level')},
    activity:{label:'En Çok Aktif Oyuncular',metricKey:'monthlyActiveScore',items:lbItems(byActivity.slice(0,25),'activity')}
  }});
});
router.get('/check-username', requireAuth, async (req, res) => { const username = s(req.query.username, 32); if (username.length < 3) return res.json({ ok: true, available: false }); const { db } = fb(); if (!db) return res.json({ ok: true, available: true }); const snap = await db.collection('users').where('usernameLower', '==', username.toLowerCase()).limit(1).get(); res.json({ ok: true, available: snap.empty }); });
router.post('/profile/update', requireAuth, async (req, res) => { const uid = uidOf(req); const patch = { fullName: s(req.body?.fullName, 80), username: s(req.body?.username, 32), avatar: s(req.body?.avatar, 1000) }; if (patch.username) patch.usernameLower = patch.username.toLowerCase(); Object.keys(patch).forEach(k => { if (patch[k] === '') delete patch[k]; }); await writeProfile(uid, patch); res.json({ ok: true, user: await readProfile(req, uid) }); });

router.get('/notifications', requireAuth, (_req, res) => res.json({ ok: true, items: [], unread: 0, summary: { total: 0, unread: 0 } }));
router.post('/notifications/read', requireAuth, (_req, res) => res.json({ ok: true }));
router.post('/notifications/read-all', requireAuth, (_req, res) => res.json({ ok: true }));
router.post('/bonus/claim', requireAuth, (_req,res) => res.status(410).json({ ok:false, error:'USE_PROMO_CLAIM' }));
router.get('/referral/link',requireAuth,async(req,res,next)=>{
 try{const {db}=fb();res.json({ok:true,...await referrals.referralLink(db,uidOf(req),env.publicBaseUrl)});}catch(err){next(err);}
});
router.post('/referral/bind',requireAuth,async(req,res,next)=>{
 try{const {db}=fb();res.json(await referrals.bind(db,uidOf(req),req.body?.code));}
 catch(err){if(err.statusCode)return res.status(err.statusCode).json({ok:false,error:err.message});next(err);}
});
router.post('/referral/claim',requireAuth,async(req,res,next)=>{
 try{const {db}=fb();res.json(await referrals.claim(db,uidOf(req),emailVerified(req)));}
 catch(err){if(err.statusCode)return res.status(err.statusCode).json({ok:false,error:err.message});next(err);}
});


router.post('/support/receipt', requireAuth, (req, res) => { const id = `support_${crypto.randomUUID()}`; const msg = { id, uid: uidOf(req), email: s(req.user?.email || '', 160), subject: sanitizeText(req.body?.subject || 'Destek', 120), source: sanitizeText(req.body?.source || req.headers.referer || 'home', 160), urgency: sanitizeText(req.body?.urgency || req.body?.priority || 'normal', 40), text: sanitizeText(req.body?.text || req.body?.message || req.body?.note || '', 1000), status: 'open', at: now() }; runtimeStore.support.set(id, msg, 24 * 3600000); console.info('[support:message]', JSON.stringify({ id, uid: msg.uid, source: msg.source, urgency: msg.urgency })); res.json({ ok: true, id, status: 'open', message: msg }); });
router.post('/support/callback', requireAuth, (_req, res) => res.json({ ok: true }));
const friendRoute=fn=>async(req,res,next)=>{try{res.json(await fn(req));}catch(error){if(error.statusCode)return res.status(error.statusCode).json({ok:false,error:error.message});next(error);}};
router.get('/friends/list',requireAuth,friendRoute(req=>friendships.listForUi(uidOf(req))));
router.post('/friends/request',requireAuth,friendRoute(async(req)=>{
 const db=friendships.requireDb();
 const target=await friendships.resolveTarget(db,req.body||{});
 return friendships.requestFriend(db,uidOf(req),target);
}));
router.post('/friends/respond',requireAuth,friendRoute(req=>friendships.respond(friendships.requireDb(),uidOf(req),req.body.friendshipId,req.body.action)));
router.post('/friends/remove',requireAuth,friendRoute(req=>friendships.remove(friendships.requireDb(),uidOf(req),req.body.friendshipId,req.body.targetUid)));
router.get('/social-center/summary', requireAuth, async (req, res) => { const uid = uidOf(req); const online = presence.values().filter(x => Number(x?.at || 0) > Date.now() - 180000).length; let accepted = 0; let incoming = 0; try { const { db } = fb(); if (db && uid) { const snap = await db.collection('friendships').where('members','array-contains',uid).limit(100).get(); snap.docs.forEach((doc) => { const data = doc.data() || {}; if (data.status === 'accepted') accepted += 1; else if (data.toUid === uid && data.status === 'pending') incoming += 1; }); } } catch (_) {} const notificationCount = runtimeStore.notifications.values().filter(x => x && typeof x === 'object' && (!x.userId || x.userId === uid) && (!x.uid || x.uid === uid) && (!x.targetUid || x.targetUid === uid)).length; res.json({ ok: true, me: await readProfile(req), chatPolicy: CHAT_POLICY, counts: { friends: accepted, incoming, notifications: notificationCount, online }, features: { globalChat: true, localChat: true, dm: true, presence: 'memory' } }); });
router.get('/activity-pass', requireAuth, (_req, res) => res.json({ ok: true, active: true, claimable: false }));
router.post('/activity-pass/claim', requireAuth, (_req, res) => res.json({ ok: true, claimed: false }));
router.get('/chat/settings', requireAuth, (req, res) => res.json({ ok: true, mine: {}, theirs: {}, targetUid: s(req.query.targetUid, 128), policy: CHAT_POLICY }));
router.get('/chat/direct/list', requireAuth, async (req,res,next)=>{try{res.json({ok:true,items:await messages.inbox(uidOf(req))});}catch(error){next(error);}});
router.get('/chat/direct/history', requireAuth, async (req,res,next)=>{try{const items=await messages.history(uidOf(req),s(req.query.targetUid||req.query.peerUid,128));res.json({ok:true,items,messages:items,nextCursor:'',policy:CHAT_POLICY});}catch(error){next(error);}});
router.get('/chat/direct/unread-summary', requireAuth, (_req,res)=>res.json({ok:true,byPeer:{},total:0}));
// Unsupported mutations never claim to have edited or deleted a message.
['edit','delete','archive','unarchive'].forEach(a=>router.post(`/chat/direct/${a}`,requireAuth,(_req,res)=>res.status(501).json({ok:false,error:'MESSAGE_ACTION_NOT_AVAILABLE'})));
router.post('/chat/block',requireAuth,async(req,res,next)=>{try{res.json(await messages.setBlocked(uidOf(req),s(req.body.targetUid||req.body.peerUid,128),true));}catch(e){next(e);}});
router.post('/chat/unblock',requireAuth,async(req,res,next)=>{try{res.json(await messages.setBlocked(uidOf(req),s(req.body.targetUid||req.body.peerUid,128),false));}catch(e){next(e);}});
['mute','unmute','report'].forEach(a=>router.post(`/chat/${a}`,requireAuth,(_req,res)=>res.status(501).json({ok:false,error:'MESSAGE_ACTION_NOT_AVAILABLE'})));

router.get('/chat/policy', requireAuth, (_req, res) => res.json({ ok: true, policy: CHAT_POLICY }));
router.get('/support/meta', requireAuth, (_req, res) => res.json({ ok: true, categories: ['Hesap', 'Oyun', 'Ödeme', 'Teknik'], channels: ['ticket', 'callback'], memoryOnlyLogs: true }));
router.post('/support/tickets', requireAuth, (req, res) => { const id = `ticket_${crypto.randomUUID()}`; const ticket = { id, uid: uidOf(req), subject: sanitizeText(req.body?.subject || 'Destek', 120), message: sanitizeText(req.body?.message || req.body?.note || '', 1000), status: 'open', at: now() }; runtimeStore.temporary.set(id, ticket, 14 * 86400000); console.info('[support:ticket]', JSON.stringify({ id, uid: ticket.uid, subject: ticket.subject })); res.status(201).json({ ok: true, ticket }); });
router.get('/support/tickets', requireAuth, (req, res) => { const uid = uidOf(req); const tickets = runtimeStore.temporary.values().filter(x => x && x.id && String(x.id).startsWith('ticket_') && x.uid === uid); res.json({ ok: true, items: tickets }); });
router.get('/rewards/center', requireAuth, (req, res) => res.json({ ok: true, dailyWheel: true, promo: true, emailVerifyReward: EMAIL_VERIFICATION_MC, signupReward: SIGNUP_MC, notifications: { receiptDays: 30 }, claimable: [] }));
router.get('/rewards/catalog', requireAuth, (_req, res) => res.json({ ok: true, items: [{ id: 'signup', title: 'Kayıt Ödülü', amount: SIGNUP_MC }, { id: 'email-verify', title: 'E-posta Onay Ödülü', amount: EMAIL_VERIFICATION_MC }, { id: 'daily-wheel', title: 'Günlük Çark' }, { id: 'promo', title: 'Promo Kod' }] }));
router.get('/matches/history', requireAuth, (_req, res) => res.json({ ok: true, items: [], nextCursor: '' }));
router.get('/achievements', requireAuth, (_req, res) => res.json({ ok: true, items: [] }));
router.get('/missions', requireAuth, (_req, res) => res.json({ ok: true, items: [] }));
router.get('/platform/control', requireAuth, (_req, res) => res.json({ ok: true, maintenance: false, gamesEnabled: true }));
router.get('/me/live-session', requireAuth, (req, res) => res.json({ ok: true, session: runtimeStore.presence.get(uidOf(req)) || null }));
router.get('/me/match-history', requireAuth, (_req, res) => res.json({ ok: true, items: [] }));
router.post('/classic/submit', requireAuth, async (req, res) => { const game = s(req.body?.game || req.body?.gameType || 'classic', 40); const score = Math.max(0, Math.floor(Number(req.body?.score) || 0)); const uid = uidOf(req); const runId = s(req.body?.runId || `${game}_${now()}`, 120); const { db } = fb(); const result = await runOnce({ key: `classic:${game}:${uid}:${runId}`, db, execute: async () => ({ game, score, reward: 0 }) }); res.json({ ok: true, game, score, ...result }); });
router.post('/update', requireAuth, async (req, res) => { const uid = uidOf(req); const patch = { fullName: s(req.body?.fullName, 80), username: s(req.body?.username, 32), avatar: s(req.body?.avatar, 1000) }; if (patch.username) patch.usernameLower = patch.username.toLowerCase(); Object.keys(patch).forEach(k => { if (patch[k] === '') delete patch[k]; }); await writeProfile(uid, patch); res.json({ ok: true, user: await readProfile(req, uid) }); });
router.post('/email/update/request-code', requireAuth, (_req, res) => res.status(501).json({ ok:false, error:'USE_FIREBASE_EMAIL_VERIFICATION' }));
router.post('/email/update/verify-code', requireAuth, (_req, res) => res.status(501).json({ ok:false, error:'USE_FIREBASE_EMAIL_VERIFICATION' }));

module.exports = router;
