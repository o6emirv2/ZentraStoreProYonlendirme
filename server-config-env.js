const toInt = (value, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.floor(n) : fallback; };
const split = (value) => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'production',
  logLevel: process.env.LOG_LEVEL || 'info',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://playmatrix.com.tr',
  canonicalOrigin: process.env.CANONICAL_ORIGIN || 'https://playmatrix.com.tr',
  publicBackendOrigin: process.env.PUBLIC_BACKEND_ORIGIN || 'https://zentrastoreproyonlendirme.onrender.com',
  publicApiBase: process.env.PUBLIC_API_BASE || 'https://zentrastoreproyonlendirme.onrender.com',
  allowedOrigins: split(process.env.ALLOWED_ORIGINS || 'https://playmatrix.com.tr,https://www.playmatrix.com.tr,https://zentrastoreproyonlendirme.onrender.com,https://playmatrix-13da1.web.app,https://playmatrix-13da1.firebaseapp.com'),
  firebase: {
    databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.PUBLIC_FIREBASE_PROJECT_ID || 'playmatrix-13da1',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || process.env.PUBLIC_FIREBASE_STORAGE_BUCKET || 'playmatrix-13da1.firebasestorage.app',
    serviceAccount: process.env.FIREBASE_KEY || '',
    publicConfig: {
      apiKey: process.env.PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_WEB_API_KEY || '',
      authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN || 'playmatrix-13da1.firebaseapp.com',
      projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'playmatrix-13da1',
      storageBucket: process.env.PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || 'playmatrix-13da1.firebasestorage.app',
      messagingSenderId: process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID || '249202046436',
      appId: process.env.PUBLIC_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID || '1:249202046436:web:c700f8dc64318cd92a83f1',
      measurementId: process.env.PUBLIC_FIREBASE_MEASUREMENT_ID || process.env.FIREBASE_MEASUREMENT_ID || 'G-9ZQGDSF9ZX'
    }
  },
  adminEmails: split(process.env.ADMIN_EMAILS),
  adminUids: split(process.env.ADMIN_UIDS),
  security: {
    adminHealthSurfaceEnabled: process.env.ADMIN_HEALTH_SURFACE_ENABLED === '1',
    cspReportOnly: process.env.SECURITY_CSP_REPORT_ONLY !== '0',
    cspStrict: process.env.SECURITY_CSP_STRICT === '1'
  },
  ttl: {
    lobbyChatMs: toInt(process.env.LOBBY_CHAT_RETENTION_DAYS, 7) * 86400000,
    directChatMs: toInt(process.env.DIRECT_CHAT_RETENTION_DAYS, 14) * 86400000,
    matchQueueMs: toInt(process.env.MATCH_QUEUE_TTL_MS, 120000),
    gameInviteMs: toInt(process.env.GAME_INVITE_TTL_MS, 90000),
    socketConnectionMs: toInt(process.env.SOCKET_CONNECTION_TTL_MS, 180000),
    notificationReceiptMs: 30 * 86400000
  }
});
module.exports = env;
