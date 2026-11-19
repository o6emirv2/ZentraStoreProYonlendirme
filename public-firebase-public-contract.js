export const PM_CURRENT_FIREBASE_PROJECT_ID = 'playmatrix-13da1';

export const PM_CURRENT_FIREBASE_PUBLIC_CONFIG = Object.freeze({
  apiKey: 'AIzaSyBtwFnAEmTMzNT7ekrAAkfH0SG3VfajW4Y',
  authDomain: 'playmatrix-13da1.firebaseapp.com',
  projectId: PM_CURRENT_FIREBASE_PROJECT_ID,
  storageBucket: 'playmatrix-13da1.firebasestorage.app',
  messagingSenderId: '249202046436',
  appId: '1:249202046436:web:c700f8dc64318cd92a83f1',
  measurementId: 'G-9ZQGDSF9ZX'
});

export function cloneCurrentFirebasePublicConfig() {
  return { ...PM_CURRENT_FIREBASE_PUBLIC_CONFIG };
}

export function normalizeFirebaseWebConfig(config = null) {
  if (!config || typeof config !== 'object') return null;
  const clean = {
    apiKey: String(config.apiKey || '').trim(),
    authDomain: String(config.authDomain || '').trim(),
    projectId: String(config.projectId || '').trim(),
    storageBucket: String(config.storageBucket || '').trim(),
    messagingSenderId: String(config.messagingSenderId || '').trim(),
    appId: String(config.appId || '').trim(),
    measurementId: String(config.measurementId || '').trim()
  };
  return clean.apiKey && clean.authDomain && clean.projectId && clean.appId ? clean : null;
}

export function matchesCurrentFirebasePublicConfig(config = null) {
  const normalized = normalizeFirebaseWebConfig(config);
  if (!normalized) return false;
  return Object.entries(PM_CURRENT_FIREBASE_PUBLIC_CONFIG).every(([key, expected]) => String(normalized[key] || '').trim() === expected);
}
