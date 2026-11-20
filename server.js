const path = require('path');
const express = require('express');
const http = require('http');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');
const env = require('./server-config-env.js');
const { corsOptions } = require('./server-config-cors.js');
const firebase = require('./server-config-firebaseAdmin.js');
const { apiLimiter } = require('./server-core-security.js');
const { routeData } = require('./server-core-smartDataRouter.js');
const { runtimeStore } = require('./server-core-runtimeStore.js');
const {presence} = require('./server-social-socialRuntimeStore.js');
const messages=require('./server-social-messageService.js');
const { runSafeFirestoreCleanup } = require('./server-core-firestoreCleanupService.js');
const { protectAsyncRoutes } = require('./server-core-asyncRoutes.js');
const dataReadiness = require('./server-core-dataReadiness.js');
const { addAdminLog, sanitizeRuntimeLogPayload } = require('./server-admin-adminRuntimeLogStore.js');

process.on('unhandledRejection', (reason) => console.error('[process:unhandledRejection]', reason && reason.stack || reason));
process.on('uncaughtException', (error) => { console.error('[process:uncaughtException]', error && error.stack || error); process.exitCode = 1; server.close(() => process.exit(1)); setTimeout(() => process.exit(1), 5000).unref(); });

const fb = firebase.initFirebaseAdmin();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: env.allowedOrigins, credentials: true } });

app.disable('x-powered-by');
// Render terminates HTTPS at one trusted reverse proxy; required for accurate IP rate limiting.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
function resolveGameScopeFromPath(value = '') {
  const pathValue = String(value || '').toLowerCase();
  if (pathValue.includes('/chess') || pathValue.includes('/satranc') || pathValue.includes('/satranç')) return 'chess';
  if (pathValue.includes('/crash')) return 'crash';
  if (pathValue.includes('/social') || pathValue.includes('/chat') || pathValue.includes('/friends') || pathValue.includes('/wheel') || pathValue.includes('/promo') || pathValue.includes('/bonus') || pathValue.includes('/support') || pathValue.includes('/profile') || pathValue.includes('/leaderboard') || pathValue === '/' || pathValue.includes('/index.html')) return 'home';
  return 'system';
}
function isExpectedClientOrApiStatus(statusCode = 0) {
  const status = Number(statusCode || 0);
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 422 || status === 429;
}
function shouldRecordApiIssue(req, statusCode) {
  const status = Number(statusCode || 0);
  if (status >= 500) return true;
  const scope = resolveGameScopeFromPath(req.originalUrl || req.url || '');
  const pathValue = String(req.originalUrl || req.url || '').toLowerCase();
  if (scope === 'crash' || scope === 'chess') return status >= 400;
  if (scope !== 'home') return false;
  if (isExpectedClientOrApiStatus(status)) return false;
  return pathValue.includes('/api/social') || pathValue.includes('/api/chat') || pathValue.includes('/api/wheel') || pathValue.includes('/api/promo') || pathValue.includes('/api/support') || pathValue.includes('/api/leaderboard');
}
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400 && shouldRecordApiIssue(req, res.statusCode)) {
      const game = resolveGameScopeFromPath(req.originalUrl || req.url);
      const status = Number(res.statusCode || 0);
      const row = {
        id:`api_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        scope: status >= 500 ? 'api.error' : 'api.warning',
        area: game === 'system' ? 'Sunucu' : game === 'home' ? 'AnaSayfa Backend' : `${game === 'chess' ? 'Satranç' : 'Crash'} Backend`,
        game,
        method: req.method,
        path: req.originalUrl || req.url,
        status,
        ms: Date.now() - startedAt,
        requestId: req.headers['x-request-id'] || null,
        message:`${req.method} ${req.originalUrl || req.url} ${status}`,
        error:`${req.method} ${req.originalUrl || req.url} ${status}`,
        reason: status >= 500 ? 'Sunucu tarafında beklenmeyen hata oluştu.' : 'Oyun API isteği backend tarafından reddedildi.',
        solution: status >= 500 ? 'Render logu ve ilgili oyun backend route kontrol edilmeli.' : 'İstek parametreleri, auth durumu ve oyun stateVersion uyumu kontrol edilmeli.',
        createdAt:Date.now(),
        severity:status >= 500 ? 'error' : 'warning'
      };
      runtimeStore.errors.set(row.id, row, 24*3600000);
      addAdminLog('api.issue', { ...row, level: row.severity, source: row.area, category: row.scope, code: 'SERVER_ROUTE_ERROR' });
      const tag = status >= 500 ? '[api:error]' : '[api:warning]';
      const log = status >= 500 ? console.error : console.warn;
      log(tag, JSON.stringify({ method: row.method, path: row.path, status: row.status, ms: row.ms, requestId: row.requestId, game: row.game }));
    }
  });
  next();
});
app.use(apiLimiter);
// Serve only explicit public assets. The source root also contains server internals,
// so serving the directory unconditionally would leak dependencies and source files.
const staticPublic = express.static(__dirname, {
  dotfiles: 'deny',
  extensions: ['html'],
  maxAge: env.nodeEnv === 'production' ? '1h' : 0,
  redirect: false
});
const allowedPublicAsset = /^\/(?:$|index\.html$|script\.js$|style\.css$|favicon\.ico$|apple-touch-icon\.png$|site\.webmanifest$|(?:games|public)-[a-zA-Z0-9._-]+\.(?:js|css|html|json|png|jpg|jpeg|svg|webp|gif|ico)$|admin\/[a-zA-Z0-9._-]+\.(?:js|css|html)$)/i;
app.use((req, res, next) => {
  // Deny direct access to source, package metadata, environment and dependencies.
  if (!allowedPublicAsset.test(req.path)) return next();
  return staticPublic(req, res, next);
});

function healthPayload() { const status=dataReadiness.readiness(); return { ok:true, service:'playmatrix', env:env.nodeEnv, firebaseEnabled: !!fb.enabled, dataReady:status.ready, readiness:fb.enabled && status.ready ? 'ready' : 'degraded', time:Date.now() }; }
app.get('/healthz', (_req,res)=>res.json(healthPayload()));
app.get('/api/healthz', (_req,res)=>res.json(healthPayload()));

app.use('/api', protectAsyncRoutes(require('./server-routes-content.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-auth.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-user.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-admin.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-economy.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-notification.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-social.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-email.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-wheel.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-bot-config.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-promo.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-support.routes.js')));
app.use('/api', protectAsyncRoutes(require('./server-routes-compat.routes.js')));

const crashGame = require('./server-games-crash-index.js');
const chessGame = require('./server-games-chess-index.js');
const pistiGame = require('./server-games-pisti-index.js');
app.use(['/api/games/crash','/api/crash'], protectAsyncRoutes(crashGame.router));
app.use(['/api/games/chess','/api/chess'], protectAsyncRoutes(chessGame.router));
app.use(['/api/games/pisti','/api/pisti-online'], protectAsyncRoutes(pistiGame.router));
app.use(['/api/games/snake-pro','/api/games/snake'], protectAsyncRoutes(require('./server-games-snake-pro-index.js').router));
app.use(['/api/games/space-pro','/api/games/space'], protectAsyncRoutes(require('./server-games-space-pro-index.js').router));

async function captureClientError(req, res) {
  const payload = { ...(req.body || {}), path: req.body?.path || req.headers.referer || '', userAgent: req.headers['user-agent'] || '', at: Date.now() };
  const game = String(payload.game || resolveGameScopeFromPath(`${payload.path || ''} ${payload.source || ''} ${payload.scope || ''} ${payload.endpoint || ''}`)).toLowerCase();
  const sourceText = `${payload.path || ''} ${payload.source || ''} ${payload.scope || ''} ${payload.endpoint || ''}`.toLowerCase();
  const isSupportedScope = game === 'chess' || game === 'crash' || game === 'home' || sourceText.includes('/games/chess') || sourceText.includes('/api/chess') || sourceText.includes('/games/crash') || sourceText.includes('/api/crash') || sourceText.includes('crash-app') || sourceText.includes('satranc') || sourceText.includes('/api/social') || sourceText.includes('/api/chat') || sourceText.includes('/api/wheel') || sourceText.includes('/api/promo') || sourceText.includes('/api/support') || sourceText.includes('legacy-home') || sourceText.includes('script.js') || sourceText.includes('/index.html') || sourceText.includes('anasayfa');
  if (!isSupportedScope) return res.status(202).json({ ok:true, discarded:'unsupported-scope' });
  const normalizedGame = game === 'crash' || sourceText.includes('crash') ? 'crash' : (game === 'chess' || sourceText.includes('chess') || sourceText.includes('satranc')) ? 'chess' : 'home';
  const message = String(payload.message || payload.error || '').trim();
  const code = message.toUpperCase();
  const scope = String(payload.scope || payload.type || 'client.error');
  const status = Number(payload.status || 0) || 0;
  const expectedCodes = new Set(['STATE_VERSION_MISMATCH','ROOM_NOT_FOUND','ROOM_CLOSED','CASHOUT_NOT_AVAILABLE','CASHOUT_TOO_LATE','BET_ALREADY_LOST','BET_REFUNDED','REFUND_IN_PROGRESS','AUTO_CASHOUT_MISSED','AUTH_REQUIRED','UNAUTHENTICATED','USER_CANCELLED']);
  const isHomeDataContractIssue = normalizedGame === 'home' && /undefined|schema|contract|policy|chat|socket|route|wheel|promo|support|frame|avatar|leaderboard|notification|modal/i.test(`${message} ${scope} ${sourceText}`);
  const isHomeNetworkOrApiIssue = normalizedGame === 'home' && (/load failed|failed to fetch|networkerror|abort|timeout|500|internal/i.test(message) || status >= 500 || /api|fetch|legacy-home|script\.js/i.test(sourceText));
  if (!isHomeDataContractIssue && !isHomeNetworkOrApiIssue && (expectedCodes.has(code) || (status >= 400 && status < 500))) {
    return res.status(202).json({ ok:true, discarded:'expected-flow' });
  }
  const dedupeKey = `clientIssue:${normalizedGame}:${scope}:${message.slice(0,120)}:${String(payload.source || payload.endpoint || '').slice(-80)}:${payload.line || ''}`;
  if (runtimeStore.temporary.get(dedupeKey)) return res.status(202).json({ ok:true, deduped:true });
  runtimeStore.temporary.set(dedupeKey, true, 10 * 60 * 1000);
  const row = {
    ...payload,
    id:`client_${normalizedGame}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    game: normalizedGame,
    scope,
    area: normalizedGame === 'chess' ? 'Satranç Frontend' : normalizedGame === 'crash' ? 'Crash Frontend' : 'AnaSayfa Frontend',
    error: String(payload.message || payload.error || 'Frontend hata kaydı').slice(0, 400),
    reason: String(payload.reason || `Kaynak: ${String(payload.source || payload.endpoint || 'bilinmiyor').slice(0, 180)}${payload.line ? `:${payload.line}` : ''}`).slice(0, 400),
    solution: String(payload.solution || 'İlgili oyun script dosyası, socket ACK akışı ve backend API cevabı gerçek hata detayıyla kontrol edilmeli.').slice(0, 400),
    createdAt: Date.now(),
    severity: payload.severity || 'error'
  };
  runtimeStore.errors.set(row.id, row, 24*3600000);
  const clientLogCode = normalizedGame === 'chess'
    ? 'CHESS_CLIENT_ERROR'
    : normalizedGame === 'crash'
      ? 'CRASH_CLIENT_ERROR'
      : 'HOME_CLIENT_ERROR';
  addAdminLog('client.runtime.error', {
    ...row,
    level: row.severity,
    source: row.area,
    category: row.scope,
    code: clientLogCode,
    message: row.error,
    safeContext: sanitizeRuntimeLogPayload({
      game: row.game,
      scope: row.scope,
      path: row.path,
      source: row.source,
      line: row.line,
      endpoint: row.endpoint,
      status: row.status,
      userAgent: row.userAgent
    })
  });
  console.error('[client:runtime:error]', JSON.stringify({ game: row.game, scope: row.scope, message: row.error, path: String(row.path || '').slice(0, 180), source: String(row.source || '').slice(0, 180), line: row.line || null }));
  res.status(202).json({ ok:true, stored:'runtime' });
}
app.post('/api/client/error', captureClientError);
app.post('/api/client-errors', captureClientError);

const gamePages = Object.freeze({
  'crash': 'crash', 'chess': 'chess', 'satranc': 'chess', 'satranç': 'chess',
  'pisti': 'pisti', 'pişti': 'pisti', 'snake': 'snake-pro', 'snakepro': 'snake-pro', 'snake-pro': 'snake-pro',
  'space': 'space-pro', 'spacepro': 'space-pro', 'space-pro': 'space-pro'
});
function sendGamePage(slug, res, next) {
  const safeSlug = gamePages[String(slug || '').toLowerCase()] || '';
  if (!safeSlug) return next();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.sendFile(path.join(__dirname, `games-${safeSlug}-index.html`));
}
app.get('/games/:slug', (req, res, next) => sendGamePage(req.params.slug, res, next));
app.get('/games/:slug/', (req, res, next) => sendGamePage(req.params.slug, res, next));
const legacyGameAliases = Object.freeze({
  '/Online Oyunlar/Crash.html': '/games/crash', '/Online Oyunlar/Crash': '/games/crash', '/Online%20Oyunlar/Crash.html': '/games/crash', '/Crash.html': '/games/crash', '/crash': '/games/crash',
  '/Online Oyunlar/Pisti.html': '/games/pisti', '/Online Oyunlar/Pisti': '/games/pisti', '/Online%20Oyunlar/Pisti.html': '/games/pisti', '/Pisti.html': '/games/pisti', '/pisti': '/games/pisti',
  '/Online Oyunlar/Satranc.html': '/games/chess', '/Online Oyunlar/Satranc': '/games/chess', '/Online%20Oyunlar/Satranc.html': '/games/chess', '/Satranc.html': '/games/chess', '/satranc': '/games/chess',
  '/Klasik Oyunlar/SnakePro.html': '/games/snake-pro', '/Klasik Oyunlar/SnakePro': '/games/snake-pro', '/Klasik%20Oyunlar/SnakePro.html': '/games/snake-pro', '/games/snake': '/games/snake-pro',
  '/Klasik Oyunlar/SpacePro.html': '/games/space-pro', '/Klasik Oyunlar/SpacePro': '/games/space-pro', '/Klasik%20Oyunlar/SpacePro.html': '/games/space-pro', '/games/space': '/games/space-pro'
});
for (const [from, to] of Object.entries(legacyGameAliases)) app.get(from, (_req, res) => res.redirect(302, to));

const CHAT_POLICY = Object.freeze({
  memoryOnly: false,
  lobbyDays: 7,
  directDays: 14,
  lobbyLabel: 'Global 7 Gün',
  directLabel: 'DM 14 Gün',
  summaryLabel: 'Global 7 Gün · DM 14 Gün',
  manualDeleteLabel: 'Kullanıcı tarafından silindi',
  cleanupLabel: 'Saklama süresi dolduğu için temizlendi',
  lobbyDisclosure: 'Yerel sohbet mesajları kalıcı kaydedilir.',
  directDisclosure: 'Özel mesajlar kalıcı kaydedilir.',
  tombstoneDisclosure: 'Silinen mesaj içerikleri boş gösterilir; manuel silme ve süre temizliği ayrı etiketlenir.',
  transparencyNote: 'Mesaj geçmişi oturum doğrulamasıyla korunur.'
});
function sanitizeSocketText(value = '', max = 500) { return String(value || '').trim().replace(/[<>]/g, '').slice(0, max); }
async function authenticateSocket(socket) {
  if (socket.data?.pmUid) return socket.data;
  const token = String(socket.handshake?.auth?.token || socket.handshake?.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return socket.data || {};
  try {
    const latest = firebase.initFirebaseAdmin();
    if (!latest.auth) return socket.data || {};
    const decoded = await latest.auth.verifyIdToken(token);
    socket.data.pmUid = String(decoded.uid || '');
    socket.data.pmEmail = String(decoded.email || '');
    if (socket.data.pmUid) socket.join(`user:${socket.data.pmUid}`);
  } catch (error) {
    socket.emit('pm:auth_error', { ok:false, error:'BAD_TOKEN' });
  }
  return socket.data || {};
}
function emitCallback(done, payload) { if (typeof done === 'function') { try { done(payload); } catch (_) {} } }
io.on('connection', socket => {
  runtimeStore.presence.set(socket.id, { socketId: socket.id, at: Date.now() });
  authenticateSocket(socket).catch(() => null);
  socket.on('presence:update', async data => { const ctx = await authenticateSocket(socket); const uid = ctx.pmUid || ''; if (!uid) return; const row = { socketId: socket.id, ...data, uid, at: Date.now() }; runtimeStore.presence.set(socket.id, row); if (uid) presence.set(uid, row); io.emit('social:presence_update', row); });
  socket.on('social:set_presence', async data => { const ctx = await authenticateSocket(socket); const uid = ctx.pmUid || ''; if (!uid) return; const row = { socketId: socket.id, ...data, uid, at: Date.now() }; runtimeStore.presence.set(socket.id, row); if (uid) presence.set(uid, row); io.emit('social:presence_update', row); });
  socket.on('chat:lobby_load_history',async (_data,done)=>{
    try{const ctx=await authenticateSocket(socket);if(!ctx.pmUid)throw Object.assign(new Error('AUTH_REQUIRED'),{statusCode:401});const result={ok:true,policy:CHAT_POLICY,messages:await messages.lobbyHistory()};socket.emit('chat:lobby_history',result);emitCallback(done,result);}
    catch(error){emitCallback(done,{ok:false,error:error.message||'CHAT_UNAVAILABLE'});}
  });
  socket.on('chat:lobby_send',async(data={},done)=>{
    try{
      const ctx=await authenticateSocket(socket);if(!ctx.pmUid)throw Object.assign(new Error('AUTH_REQUIRED'),{statusCode:401});
      const msg=await messages.sendLobby(ctx.pmUid,data.message||data.text,ctx.pmEmail?.split('@')[0]||'Oyuncu');
      io.emit('chat:lobby_new',msg);emitCallback(done,{ok:true,message:msg,policy:CHAT_POLICY});
    }catch(error){const result={ok:false,error:error.message||'CHAT_UNAVAILABLE'};socket.emit('chat:lobby_error',result);emitCallback(done,result);}
  });
  socket.on('chat:dm_load_history',async(data={},done)=>{
    try{const ctx=await authenticateSocket(socket);if(!ctx.pmUid)throw Object.assign(new Error('AUTH_REQUIRED'),{statusCode:401});
      const targetUid=sanitizeSocketText(data.targetUid||data.peerUid||'',160),history=await messages.history(ctx.pmUid,targetUid);
      const result={ok:true,targetUid,peerUid:targetUid,messages:history,policy:CHAT_POLICY};socket.emit('chat:dm_history',result);emitCallback(done,result);
    }catch(error){emitCallback(done,{ok:false,error:error.message||'CHAT_UNAVAILABLE'});}
  });
  socket.on('chat:dm_send',async(data={},done)=>{
    try{const ctx=await authenticateSocket(socket);if(!ctx.pmUid)throw Object.assign(new Error('AUTH_REQUIRED'),{statusCode:401});
      const toUid=sanitizeSocketText(data.toUid||data.targetUid||'',160);
      const msg=await messages.sendDm(ctx.pmUid,toUid,data.message||data.text,data.clientTempId);
      socket.emit('chat:dm_success',{ok:true,targetUid:toUid,clientTempId:data.clientTempId,message:msg});
      socket.emit('chat:dm_new',msg);io.to(`user:${toUid}`).emit('chat:dm_new',msg);
      emitCallback(done,{ok:true,message:msg});
    }catch(error){const result={ok:false,error:error.message||'CHAT_UNAVAILABLE'};socket.emit('chat:dm_error',result);emitCallback(done,result);}
  });
  socket.on('chat:typing', async (data = {}) => { const ctx = await authenticateSocket(socket); const fromUid = ctx.pmUid || ''; const toUid = sanitizeSocketText(data.toUid || data.targetUid || '', 160); if (fromUid && toUid) io.to(`user:${toUid}`).emit('chat:typing_status', { fromUid, isTyping: !!data.isTyping, at:Date.now() }); });
  socket.on('game:invite_send', async (data = {}, done) => { const ctx = await authenticateSocket(socket); const hostUid = ctx.pmUid || ''; const targetUid = sanitizeSocketText(data.targetUid || '', 160); if (!hostUid || !targetUid) { const out = { ok:false, error:'INVITE_INVALID_PAYLOAD', message:'Davet için hedef kullanıcı gerekli.' }; socket.emit('game:invite_error', out); return emitCallback(done, out); } const inviteId=`invite_${crypto.randomUUID()}`; const invite = { id:inviteId, inviteId, hostUid, targetUid, roomId:sanitizeSocketText(data.roomId || '', 160), gameKey:sanitizeSocketText(data.gameKey || data.gameCode || 'chess', 40), gameName:sanitizeSocketText(data.gameName || 'Oyun Daveti', 80), at:Date.now() }; runtimeStore.gameInvites.set(invite.id, invite, 90 * 1000); io.to(`user:${targetUid}`).emit('game:invite_receive', invite); socket.emit('game:invite_success', invite); emitCallback(done, { ok:true, ...invite }); });
  socket.on('game:invite_response',async (data={},done)=>{
    const ctx=await authenticateSocket(socket);
    const uid=ctx.pmUid||'';
    const inviteId=String(data.inviteId||'');
    const invite=runtimeStore.gameInvites.get(inviteId);
    if(!uid||!invite||invite.targetUid!==uid)return emitCallback(done,{ok:false,error:'INVITE_NOT_FOUND'});
    if(!['accepted','rejected'].includes(String(data.response)))return emitCallback(done,{ok:false,error:'INVALID_INVITE_RESPONSE'});
    runtimeStore.gameInvites.delete(inviteId);
    const out={...invite,response:data.response,guestUid:uid,at:Date.now()};
    io.to(`user:${invite.hostUid}`).emit('game:invite_response',out);
    emitCallback(done,{ok:true,...out});
  });
  socket.on('game:matchmake_join', data => socket.emit('game:matchmake_joined', { ok:true, queued:false, gameType:data?.gameType || data?.game || 'unknown', message:'HTTP lobby active' }));
  socket.on('game:matchmake_leave', () => socket.emit('game:matchmake_left', { ok:true }));
  socket.on('client:error', data => {
    const safePayload = sanitizeRuntimeLogPayload({ ...(data || {}), socketId: socket.id, source: data?.source || data?.page || 'client', category: data?.type || 'CLIENT_ERROR' });
    const id = `socket_${Date.now()}_${socket.id}`;
    const row = { id, ...safePayload, at: Date.now(), message: safePayload.message || safePayload.error || 'Client runtime error' };
    runtimeStore.errors.set(id, row, 24*3600000);
    addAdminLog('client.error', { ...row, level: 'warning' });
    console.warn('[socket:client:error]', JSON.stringify({ socketId: socket.id, source: row.source, category: row.category, message: row.message }));
  });
  socket.on('matchmaking:join', data => socket.emit('matchmaking:status', { ok:true, queued:false, game:data?.game || 'unknown', message:'HTTP lobby active' }));
  socket.on('matchmaking:leave', () => socket.emit('matchmaking:left', { ok:true }));
  socket.on('disconnect', () => { const uid = socket.data?.pmUid; runtimeStore.presence.delete(socket.id); if (uid) presence.delete(uid); });
});
if (typeof crashGame.installSocket === 'function') crashGame.installSocket(io);
chessGame.installSocket?.(io);
pistiGame.installSocket?.(io);

setInterval(()=>{ Object.values(runtimeStore).forEach(store => store.prune && store.prune()); }, 60_000).unref();

(async () => {
  const latest = firebase.initFirebaseAdmin();
  const available = await dataReadiness.verifyDataReady(latest.db);
  if (!available) return;
  // Destructive maintenance must never run merely because the web service restarted.
  if (process.env.FIRESTORE_CLEANUP_ENABLED !== '1') return;
  try {
    const dryRun = process.env.FIRESTORE_CLEANUP_DRY_RUN !== '0';
    const report = await runSafeFirestoreCleanup({ db: latest.db, dryRun, limit: 100 });
    console.info('[data:cleanup]', JSON.stringify({ ...report, legacyFields: Array.isArray(report.legacyFields) ? report.legacyFields.length : 0 }));
  } catch (error) {
    dataReadiness.diagnose(error, 'cleanup');
  }
})();

app.use((req,res)=>res.status(404).json({ ok:false, error:'NOT_FOUND' }));
app.use((error, req, res, _next) => {
  const dataIssue = dataReadiness.isDataUnavailable(error) || error?.message === 'DATA_NOT_READY';
  const status = dataIssue ? 503 : (Number(error?.statusCode || 500) || 500);
  const code = dataIssue ? 'DATA_NOT_READY' : status === 409 && error?.message === 'INSUFFICIENT_BALANCE' ? 'INSUFFICIENT_BALANCE' : status >= 500 ? 'INTERNAL_ERROR' : String(error?.message || 'REQUEST_REJECTED');
  if (dataIssue) {
    dataReadiness.diagnose(error, 'request');
  } else if (status >= 500) {
    const scope=resolveGameScopeFromPath(req.originalUrl || req.url);
    const row={id:`api_${Date.now()}_${Math.random().toString(36).slice(2)}`,scope:'server.error',game:scope,message:String(error?.message||'Internal error').slice(0,400),stack:String(error?.stack||'').slice(0,1600),method:req.method,path:req.originalUrl||req.url,status,createdAt:Date.now(),severity:'error'};
    runtimeStore.errors.set(row.id,row,24*3600000);
    console.error('[api:error]',JSON.stringify({code,path:row.path,method:row.method,status,game:row.game,message:row.message}));
  }
  if (res.headersSent) return;
  return res.status(status).json({ok:false,error:code,message: dataIssue ? 'İşlemin şu anda tamamlanamıyor. Lütfen biraz sonra yeniden dene.' : undefined});
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) server.listen(port, () => console.log(`[playmatrix] listening on ${port}`));
module.exports = { app, server, io };
