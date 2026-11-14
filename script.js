import { loadFirebaseWebConfig, loadPublicRuntimeConfig } from './public/firebase-runtime.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const DOM = {
  body: document.body,
  topBalance: $('#topBalance'),
  topAvatar: $('#topAvatar'),
  menuAvatar: $('#menuAvatar'),
  profileAvatar: $('#profileAvatar'),
  profileFramePreview: $('#profileFramePreview'),
  menuUsername: $('#menuUsername'),
  menuLevel: $('#menuLevel'),
  profileUsername: $('#profileUsername'),
  profileLevelText: $('#profileLevelText'),
  profileXpBar: $('#profileXpBar'),
  profileXpText: $('#profileXpText'),
  authOnly: $$('[data-auth-only]'),
  guestOnly: $$('[data-guest-only]'),
  drawer: $('#drawer'),
  drawerOpen: $('#drawerOpen'),
  drawerClose: $('#drawerClose'),
  drawerBackdrop: $('#drawerBackdrop'),
  profileMenu: $('#profileMenu'),
  profileMenuBtn: $('#profileMenuBtn'),
  sheet: $('#sheet'),
  sheetBackdrop: $('#sheetBackdrop'),
  sheetClose: $('#sheetClose'),
  sheetTitle: $('#sheetTitle'),
  sheetBody: $('#sheetBody'),
  authTabs: $('#authTabs'),
  gameGrid: $('#gameGrid'),
  gameEmpty: $('#gameEmpty'),
  gameSearch: $('#gameSearch'),
  clearGameSearch: $('#clearGameSearch'),
  leaderboardList: $('#leaderboardList'),
  refreshLeaderboard: $('#refreshLeaderboard'),
  heroTrack: $('#heroTrack'),
  heroDots: $('#heroDots'),
  toastStack: $('#toastStack'),
  logoutBtn: $('#logoutBtn')
};

const STATE = {
  apiBase: '',
  firebase: null,
  auth: null,
  authUser: null,
  profile: null,
  sessionToken: readStore('pm_session_token'),
  currentHero: 0,
  heroTimer: 0,
  gameFilter: 'all',
  gameQuery: '',
  leaderboardTab: 'level',
  leaderboardPayload: null,
  booted: false
};

const HERO_COUNT = 3;
const AUTH_REQUIRED_GAMES = new Set(['crash', 'chess', 'pisti']);

const GAMES = Object.freeze([
  {
    id: 'crash',
    title: 'Crash',
    tag: 'POPÜLER',
    category: 'online',
    auth: true,
    icon: '↗',
    route: './games/crash/',
    glow: 'rgba(27, 198, 255, .48)',
    desc: 'Refleks, zamanlama ve hızlı tur odaklı ücretsiz oyun vitrini.'
  },
  {
    id: 'chess',
    title: 'Satranç',
    tag: 'STRATEJİ',
    category: 'online',
    auth: true,
    icon: '♜',
    route: './games/chess/',
    glow: 'rgba(255, 198, 51, .46)',
    desc: 'Modern lobi, davet ve PvP oda akışıyla satranç deneyimi.'
  },
  {
    id: 'pisti',
    title: 'Pişti',
    tag: 'KART',
    category: 'online',
    auth: true,
    icon: '♠',
    route: './games/pisti/',
    glow: 'rgba(170, 79, 255, .44)',
    desc: 'Hızlı kart takibi ve rekabet hissi veren klasik pişti alanı.'
  },
  {
    id: 'pattern-master',
    title: 'Pattern Master',
    tag: 'KLASİK',
    category: 'classic',
    auth: false,
    icon: '◆',
    route: './games/pattern-master/',
    glow: 'rgba(75, 229, 255, .38)',
    desc: 'Görsel hafıza ve dikkat becerisi için klasik oyun.'
  },
  {
    id: 'space-pro',
    title: 'Space Pro',
    tag: 'ARCADE',
    category: 'classic',
    auth: false,
    icon: '⊖',
    route: './games/space-pro/',
    glow: 'rgba(73, 103, 255, .44)',
    desc: 'Akıcı, hafif ve mobil uyumlu uzay arcade oyunu.'
  },
  {
    id: 'snake-pro',
    title: 'Snake Pro',
    tag: 'RETRO',
    category: 'classic',
    auth: false,
    icon: '§',
    route: './games/snake-pro/',
    glow: 'rgba(49, 230, 116, .36)',
    desc: 'Retro hissi koruyan hızlı ve sade snake deneyimi.'
  }
]);

const SHEETS = Object.freeze({
  market: {
    title: 'Market',
    html: `<div class="pm-panel-note">Market alanı geçici olarak kapalıdır. Ürünler stoklandığında ve sistem aktif edildiğinde MC ile kullanılabilir olacaktır.</div>`
  },
  support: {
    title: 'Canlı Destek',
    html: `<form class="pm-form" data-form="support"><p class="pm-muted-text">Destek talebin gerçek backend destek endpointine gönderilir.</p><label class="pm-field"><span>☏</span><input name="subject" placeholder="Konu" required maxlength="80" /></label><label class="pm-field"><span>✎</span><textarea name="message" placeholder="Mesajını yaz" required maxlength="800"></textarea></label><button class="pm-submit" type="submit">Destek Talebi Gönder</button></form>`
  },
  promo: {
    title: 'Promosyon Kodu',
    html: `<form class="pm-form" data-form="promo"><p class="pm-muted-text">Promosyon kodu sadece gerçek backend onayıyla işlenir.</p><label class="pm-field"><span>🎁</span><input name="code" placeholder="Promosyon kodu" autocomplete="off" required maxlength="64" /></label><button class="pm-submit gold" type="submit">Promosyonu Kullan</button></form>`
  },
  wheel: {
    title: 'Günlük Çark',
    html: `<div class="pm-panel-note">Günlük çark sonucu backend tarafından üretilir. Aynı gün tekrar kullanım backend tarafından engellenir.</div><form class="pm-form" data-form="wheel"><button class="pm-submit gold" type="submit">Çarkı Çevir</button></form>`
  },
  invite: {
    title: 'Davet Et ve Kazan',
    html: `<div class="pm-panel-note" id="inviteInfo">Davet bağlantısı hazırlanıyor.</div><div class="pm-copy-box"><code id="inviteLink">—</code><button class="pm-btn" type="button" id="copyInvite">Kopyala</button></div>`
  },
  social: {
    title: 'Sosyal Merkez',
    html: `<div class="pm-panel-note" id="socialSummary">Sosyal merkez verileri yükleniyor.</div>`
  }
});

function readStore(key) {
  try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
}

function writeStore(key, value) {
  try {
    if (value === null || value === undefined || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (_) {}
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function clamp(num, min = 0, max = 100) {
  const n = Number(num);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('tr-TR').format(Math.max(0, Math.floor(n)));
}

function safeText(value, fallback = '—') {
  const raw = String(value ?? '').trim();
  return raw || fallback;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `pm-toast ${type}`;
  el.textContent = message;
  DOM.toastStack.appendChild(el);
  window.setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translate3d(0, 10px, 0)';
    window.setTimeout(() => el.remove(), 250);
  }, 3200);
}

function report(scope, error, extra = {}) {
  try {
    if (typeof window.__PM_REPORT_CLIENT_ERROR__ === 'function') {
      window.__PM_REPORT_CLIENT_ERROR__(scope, error, { game: 'home', source: 'script.js', ...extra });
    }
  } catch (_) {}
}

async function initRuntime() {
  try {
    const runtime = await loadPublicRuntimeConfig({ required: false, timeoutMs: 2800 });
    STATE.apiBase = String(runtime?.apiBase || window.__PLAYMATRIX_API_URL__ || window.__PM_RUNTIME?.apiBase || '').replace(/\/+$/, '');
  } catch (error) {
    STATE.apiBase = String(window.__PLAYMATRIX_API_URL__ || window.__PM_RUNTIME?.apiBase || '').replace(/\/+$/, '');
    report('home.runtime_config', error, { severity: 'warning' });
  }
  if (!STATE.apiBase && window.__PM_API__?.getApiBaseSync) STATE.apiBase = window.__PM_API__.getApiBaseSync();
  if (!STATE.apiBase) STATE.apiBase = window.location.origin;
}

function apiUrl(path) {
  const clean = String(path || '').startsWith('/') ? path : `/${path}`;
  if (window.__PM_API__?.buildUrl) return window.__PM_API__.buildUrl(clean);
  const base = String(STATE.apiBase || window.location.origin).replace(/\/+$/, '');
  return `${base}${clean}`;
}

async function getIdToken(force = false) {
  try {
    if (!STATE.auth?.currentUser) return '';
    return await STATE.auth.currentUser.getIdToken(force);
  } catch (error) {
    report('home.auth_token', error, { severity: 'warning' });
    return '';
  }
}

async function apiJson(path, options = {}, auth = false) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (auth) {
    const token = await getIdToken(false);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (STATE.sessionToken) headers.set('X-Session-Token', STATE.sessionToken);
  }
  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: 'omit',
    cache: options.cache || 'no-store'
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const err = new Error(payload?.error || payload?.message || `HTTP_${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function initFirebase() {
  try {
    const config = await loadFirebaseWebConfig({ required: false, timeoutMs: 2800, scope: 'home' });
    if (!config) return;
    const [appMod, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')
    ]);
    const app = appMod.getApps().length ? appMod.getApps()[0] : appMod.initializeApp(config);
    const auth = authMod.getAuth(app);
    STATE.firebase = { ...appMod, ...authMod, app };
    STATE.auth = auth;
    authMod.onAuthStateChanged(auth, handleAuthStateChange);
  } catch (error) {
    report('home.firebase_init', error, { severity: 'error' });
    updateAuthUi(false);
  }
}

function getProfilePayload(payload) {
  return payload?.user || payload?.profile || payload?.data || payload?.me || null;
}

async function createBackendSession() {
  if (!STATE.auth?.currentUser) return null;
  try {
    const payload = await apiJson('/api/auth/session/create', { method: 'POST' }, true);
    const token = payload?.sessionToken || payload?.session?.token || '';
    if (token) {
      STATE.sessionToken = token;
      writeStore('pm_session_token', token);
    }
    return payload?.user || null;
  } catch (error) {
    report('home.session_create', error, { severity: 'warning' });
    return null;
  }
}

async function fetchProfile() {
  if (!STATE.auth?.currentUser) return null;
  try {
    const payload = await apiJson('/api/me', {}, true);
    return getProfilePayload(payload);
  } catch (error) {
    try {
      const payload = await apiJson('/api/user/me', {}, true);
      return getProfilePayload(payload);
    } catch (error2) {
      report('home.profile_fetch', error2, { severity: 'warning' });
      return null;
    }
  }
}

async function handleAuthStateChange(user) {
  STATE.authUser = user || null;
  if (!user) {
    STATE.profile = null;
    STATE.sessionToken = '';
    writeStore('pm_session_token', '');
    updateAuthUi(false);
    renderProfile();
    await loadLeaderboard();
    return;
  }
  updateAuthUi(true);
  let profile = await fetchProfile();
  if (!profile) profile = await createBackendSession();
  STATE.profile = profile || {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
    photoURL: user.photoURL || ''
  };
  renderProfile();
  heartbeat();
  await loadLeaderboard();
}

function updateAuthUi(isAuthed) {
  DOM.authOnly.forEach((node) => { node.hidden = !isAuthed; });
  DOM.guestOnly.forEach((node) => { node.hidden = isAuthed; });
  DOM.body.dataset.auth = isAuthed ? '1' : '0';
  renderGames();
}

function profileName(profile = STATE.profile) {
  return safeText(profile?.username || profile?.displayName || profile?.fullName || STATE.authUser?.displayName || STATE.authUser?.email?.split('@')[0], 'Oyuncu');
}

function profileAvatar(profile = STATE.profile) {
  return profile?.avatar || profile?.photoURL || STATE.authUser?.photoURL || './public/assets/avatars/system/fallback.svg';
}

function renderProfile() {
  const profile = STATE.profile || null;
  const authed = !!STATE.authUser;
  if (!authed) {
    DOM.topBalance.textContent = '—';
    [DOM.topAvatar, DOM.menuAvatar, DOM.profileAvatar].forEach((img) => { if (img) img.src = './public/assets/avatars/system/fallback.svg'; });
    return;
  }

  const progression = profile?.progression || {};
  const level = Number(profile?.accountLevel || profile?.level || progression.level || 1) || 1;
  const pct = clamp(profile?.progressPercent ?? profile?.accountLevelProgressPct ?? progression.progressPercent ?? 0);
  const balance = profile?.balance ?? profile?.mc ?? profile?.statistics?.balance;
  const name = profileName(profile);
  const avatar = profileAvatar(profile);
  const xpInto = progression.xpIntoLevel ?? profile?.xpIntoLevel ?? profile?.accountXp ?? profile?.xp;
  const xpNext = progression.xpToNextLevel ?? progression.nextLevelXp ?? profile?.nextLevelXp;

  DOM.topBalance.textContent = formatNumber(balance);
  [DOM.topAvatar, DOM.menuAvatar, DOM.profileAvatar].forEach((img) => { if (img) img.src = avatar; });
  DOM.menuUsername.textContent = name;
  DOM.menuLevel.textContent = `Seviye ${level}`;
  DOM.profileUsername.textContent = name;
  DOM.profileLevelText.textContent = `Seviye ${level}`;
  DOM.profileXpBar.style.width = `${pct}%`;
  DOM.profileXpText.textContent = Number.isFinite(Number(xpInto)) || Number.isFinite(Number(xpNext))
    ? `${formatNumber(xpInto || 0)} / ${formatNumber(xpNext || 0)} XP · ${pct.toFixed(1)}%`
    : `${pct.toFixed(1)}% ilerleme`;

  const frame = Math.max(0, Math.min(100, Math.floor(Number(profile?.selectedFrame || profile?.frame || 0))));
  if (DOM.profileFramePreview) {
    DOM.profileFramePreview.style.setProperty('--frame-image', frame > 0 ? `url("./public/assets/frames/frame-${frame}.png")` : 'none');
    DOM.profileFramePreview.dataset.frame = frame ? String(frame) : '0';
  }
}

function renderGames() {
  const query = STATE.gameQuery.trim().toLowerCase();
  const filter = STATE.gameFilter;
  const authed = !!STATE.authUser;
  const filtered = GAMES.filter((game) => {
    if (filter === 'online' && game.category !== 'online') return false;
    if (filter === 'classic' && game.category !== 'classic') return false;
    if (filter === 'auth' && !game.auth) return false;
    if (query) {
      const haystack = `${game.title} ${game.desc} ${game.tag}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  DOM.gameGrid.innerHTML = filtered.map((game) => {
    const locked = game.auth && !authed;
    const title = game.title.replace(' ', '<br>');
    return `<button class="pm-game-card" type="button" data-game="${game.id}" style="--game-glow:${game.glow}">
      <span class="pm-game-tag">${escapeHtml(game.tag)}</span>
      <span class="pm-game-icon">${escapeHtml(game.icon)}</span>
      <strong class="pm-game-title">${title}</strong>
      <span class="pm-game-desc">${escapeHtml(game.desc)}</span>
      <span class="pm-game-foot"><span class="pm-game-state">${locked ? 'Giriş gerekli' : 'Anında açılır'}</span><span class="pm-play-btn">Oyna</span></span>
    </button>`;
  }).join('');
  DOM.gameEmpty.hidden = filtered.length > 0;
}

function openGame(id) {
  const game = GAMES.find((item) => item.id === id);
  if (!game) return;
  if (game.auth && !STATE.authUser) {
    toast(`${game.title} için giriş yapmalısın.`, 'error');
    openSheet('login');
    return;
  }
  window.location.href = game.route;
}

function setGameFilter(filter) {
  STATE.gameFilter = filter || 'all';
  $$('.pm-filter-row [data-filter]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.filter === STATE.gameFilter));
  renderGames();
  scrollToId('games');
}

function isSyntheticLeaderboardItem(item) {
  const uid = String(item?.uid || '').toLowerCase();
  const name = String(item?.username || item?.displayName || '').toLowerCase();
  const xp = Number(item?.accountXp || item?.xp || item?.leaderboard?.metricValue || 0) || 0;
  const activity = Number(item?.monthlyActiveScore || 0) || 0;
  return uid.startsWith('guest_') || (uid === 'playmatrix' && name === 'playmatrix' && xp === 0 && activity === 0);
}

async function loadLeaderboard() {
  DOM.leaderboardList.innerHTML = '<div class="pm-state-row">Liderlik verileri yükleniyor.</div>';
  try {
    const payload = await apiJson('/api/leaderboard', {}, false);
    STATE.leaderboardPayload = payload;
    renderLeaderboard();
  } catch (error) {
    STATE.leaderboardPayload = null;
    DOM.leaderboardList.innerHTML = '<div class="pm-state-row">Liderlik verisi şu anda alınamadı.</div>';
    report('home.leaderboard_fetch', error, { severity: 'warning' });
  }
}

function renderLeaderboard() {
  const tab = STATE.leaderboardTab;
  const itemsRaw = STATE.leaderboardPayload?.tabs?.[tab]?.items || STATE.leaderboardPayload?.items || [];
  const items = itemsRaw.filter((item) => !isSyntheticLeaderboardItem(item)).slice(0, 5);
  if (!items.length) {
    DOM.leaderboardList.innerHTML = '<div class="pm-state-row">Gerçek liderlik verisi henüz bulunmuyor.</div>';
    return;
  }
  DOM.leaderboardList.innerHTML = items.map((item, index) => {
    const progression = item?.progression || {};
    const name = safeText(item.username || item.displayName || item.fullName, 'Oyuncu');
    const level = Number(item.accountLevel || item.level || progression.level || 1) || 1;
    const avatar = item.avatar || item.photoURL || './public/assets/avatars/system/fallback.svg';
    const score = tab === 'activity'
      ? `${formatNumber(item.monthlyActiveScore || item.leaderboard?.metricValue || 0)} Aktivite`
      : `${formatNumber(item.accountXp || item.xp || item.leaderboard?.metricValue || 0)} XP`;
    return `<div class="pm-lb-row">
      <span class="pm-lb-rank">${index + 1}</span>
      <span class="pm-lb-avatar"><img src="${escapeHtml(avatar)}" alt="" loading="lazy" /></span>
      <span class="pm-lb-copy"><strong>${escapeHtml(name)}</strong><span>Seviye ${formatNumber(level)}</span></span>
      <strong class="pm-lb-score">${escapeHtml(score)}</strong>
    </div>`;
  }).join('');
}

function setupHero() {
  DOM.heroDots.innerHTML = Array.from({ length: HERO_COUNT }, (_, i) => `<button type="button" aria-label="${i + 1}. görsel" data-hero-dot="${i}"></button>`).join('');
  setHero(0);
  clearInterval(STATE.heroTimer);
  STATE.heroTimer = window.setInterval(() => setHero((STATE.currentHero + 1) % HERO_COUNT), 5500);
}

function setHero(index) {
  STATE.currentHero = (Number(index) || 0 + HERO_COUNT) % HERO_COUNT;
  DOM.heroTrack.style.transform = `translate3d(${-STATE.currentHero * (100 / HERO_COUNT)}%,0,0)`;
  $$('[data-hero-dot]').forEach((btn) => btn.classList.toggle('is-active', Number(btn.dataset.heroDot) === STATE.currentHero));
}

function openDrawer() {
  DOM.drawer.classList.add('is-open');
  DOM.drawer.setAttribute('aria-hidden', 'false');
  lockBody(true);
}

function closeDrawer() {
  DOM.drawer.classList.remove('is-open');
  DOM.drawer.setAttribute('aria-hidden', 'true');
  lockBody(false);
}

function toggleProfileMenu(force = null) {
  const open = force === null ? !DOM.profileMenu.classList.contains('is-open') : !!force;
  DOM.profileMenu.classList.toggle('is-open', open);
  DOM.profileMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function lockBody(lock) {
  const anyOpen = lock || DOM.sheet.classList.contains('is-open') || DOM.drawer.classList.contains('is-open');
  DOM.body.classList.toggle('pm-lock', anyOpen);
}

function openSheet(type = 'login') {
  toggleProfileMenu(false);
  closeDrawer();
  const authType = ['login', 'register', 'forgot'].includes(type) ? type : '';
  DOM.authTabs.hidden = !authType;
  if (authType) {
    $$('#authTabs [data-auth-tab]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.authTab === type));
    renderAuthSheet(type);
  } else if (type === 'profile') {
    renderProfileSheet();
  } else {
    const sheet = SHEETS[type] || SHEETS.market;
    DOM.sheetTitle.textContent = sheet.title;
    DOM.sheetBody.innerHTML = sheet.html;
    afterStaticSheet(type);
  }
  DOM.sheet.classList.add('is-open');
  DOM.sheet.setAttribute('aria-hidden', 'false');
  lockBody(true);
  const first = DOM.sheetBody.querySelector('input, textarea, button');
  window.setTimeout(() => first?.focus?.({ preventScroll: true }), 80);
}

function closeSheet() {
  DOM.sheet.classList.remove('is-open');
  DOM.sheet.setAttribute('aria-hidden', 'true');
  lockBody(false);
}

function renderAuthSheet(type) {
  const templates = {
    login: {
      title: 'Giriş Yap',
      html: `<form class="pm-form" data-form="login"><label class="pm-field"><span>✉</span><input name="identifier" placeholder="E-posta veya Kullanıcı Adı" autocomplete="username" required /></label><label class="pm-field"><span>▣</span><input name="password" placeholder="Şifre" type="password" autocomplete="current-password" required minlength="6" /><button type="button" data-toggle-password>◉</button></label><div class="pm-form-row"><label class="pm-check"><input type="checkbox" name="remember" />Beni Hatırla</label><button class="pm-link" type="button" data-open-sheet="forgot">Şifrenizi mi unuttunuz?</button></div><button class="pm-submit" type="submit">Giriş Yap</button><p class="pm-muted-text">Hesabınız yok mu? <button class="pm-link" type="button" data-open-sheet="register">Kayıt Ol</button></p></form>`
    },
    register: {
      title: 'Kayıt Ol',
      html: `<form class="pm-form" data-form="register"><label class="pm-field"><span>♙</span><input name="fullName" placeholder="İsim Soyisim" autocomplete="name" maxlength="80" /></label><label class="pm-field"><span>@</span><input name="username" placeholder="Kullanıcı adı" autocomplete="username" required minlength="3" maxlength="32" /></label><label class="pm-field"><span>✉</span><input name="email" type="email" placeholder="E-posta adresi" autocomplete="email" required /></label><label class="pm-field"><span>▣</span><input name="password" placeholder="Şifre" type="password" autocomplete="new-password" required minlength="6" /><button type="button" data-toggle-password>◉</button></label><button class="pm-submit gold" type="submit">Hesap Oluştur</button><p class="pm-muted-text">Kayıt ödülü ve doğrulama işlemleri backend tarafından doğrulanır.</p></form>`
    },
    forgot: {
      title: 'Şifremi Unuttum',
      html: `<form class="pm-form" data-form="forgot"><p class="pm-muted-text">E-posta adresini veya kullanıcı adını gir. Sıfırlama bağlantısı Firebase üzerinden gönderilir.</p><label class="pm-field"><span>✉</span><input name="identifier" placeholder="E-posta veya Kullanıcı Adı" autocomplete="username" required /></label><button class="pm-submit" type="submit">Şifre Sıfırlama Gönder</button><button class="pm-link" type="button" data-open-sheet="login">Önceki adıma geri dön</button></form>`
    }
  };
  const tpl = templates[type] || templates.login;
  DOM.sheetTitle.textContent = tpl.title;
  DOM.sheetBody.innerHTML = tpl.html;
}

function renderProfileSheet() {
  DOM.authTabs.hidden = true;
  const profile = STATE.profile || {};
  const level = Number(profile?.accountLevel || profile?.level || profile?.progression?.level || 1) || 1;
  DOM.sheetTitle.textContent = 'Profilim';
  DOM.sheetBody.innerHTML = `<form class="pm-form" data-form="profile"><div class="pm-panel-note">Bakiye, seviye, avatar ve çerçeve gerçek profil modelinden okunur. Kaydetme işlemi backend profil endpointine gönderilir.</div><label class="pm-field"><span>♙</span><input name="fullName" placeholder="İsim Soyisim" value="${escapeHtml(profile.fullName || '')}" maxlength="80" /></label><label class="pm-field"><span>@</span><input name="username" placeholder="Kullanıcı adı" value="${escapeHtml(profile.username || '')}" minlength="3" maxlength="32" /></label><label class="pm-field"><span>✉</span><input readonly value="${escapeHtml(STATE.authUser?.email || profile.email || '')}" /></label><div class="pm-panel-note">Hesap Seviyesi: <b>${formatNumber(level)}</b><br>MC Bakiye: <b>${formatNumber(profile.balance ?? profile.mc)}</b></div><button class="pm-submit" type="submit">Profili Kaydet</button><button class="pm-submit gold" type="button" id="sendVerifyMail">Doğrulama Maili Gönder</button></form>`;
}

async function resolveLoginEmail(identifier) {
  const raw = String(identifier || '').trim();
  if (raw.includes('@')) return raw.toLowerCase();
  const payload = await apiJson('/api/auth/resolve-login', {
    method: 'POST',
    body: JSON.stringify({ identifier: raw })
  }, false);
  return payload.email;
}

async function handleFormSubmit(form) {
  const kind = form.dataset.form;
  const data = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('[type="submit"]');
  const oldText = submit?.textContent || '';
  if (submit) { submit.disabled = true; submit.textContent = 'İşleniyor...'; }
  try {
    if (kind === 'login') {
      if (!STATE.firebase || !STATE.auth) throw new Error('Firebase hazır değil.');
      const email = await resolveLoginEmail(data.identifier);
      await STATE.firebase.signInWithEmailAndPassword(STATE.auth, email, String(data.password || ''));
      await createBackendSession();
      closeSheet();
      toast('Giriş başarılı.', 'success');
      return;
    }
    if (kind === 'register') {
      if (!STATE.firebase || !STATE.auth) throw new Error('Firebase hazır değil.');
      const email = String(data.email || '').trim().toLowerCase();
      const username = String(data.username || '').trim();
      const cred = await STATE.firebase.createUserWithEmailAndPassword(STATE.auth, email, String(data.password || ''));
      if (data.fullName || username) {
        try { await STATE.firebase.updateProfile(cred.user, { displayName: username || data.fullName || '' }); } catch (_) {}
      }
      await createBackendSession();
      await apiJson('/api/profile/update', {
        method: 'POST',
        body: JSON.stringify({ username, fullName: data.fullName || '', avatar: '', selectedFrame: 0 })
      }, true).catch((error) => report('home.register_profile_update', error, { severity: 'warning' }));
      try { await STATE.firebase.sendEmailVerification(cred.user); } catch (_) {}
      STATE.profile = await fetchProfile();
      renderProfile();
      closeSheet();
      toast('Kayıt tamamlandı. Doğrulama e-postası gönderildi.', 'success');
      return;
    }
    if (kind === 'forgot') {
      if (!STATE.firebase || !STATE.auth) throw new Error('Firebase hazır değil.');
      const email = await resolveLoginEmail(data.identifier);
      await STATE.firebase.sendPasswordResetEmail(STATE.auth, email);
      toast('Şifre sıfırlama bağlantısı gönderildi.', 'success');
      openSheet('login');
      return;
    }
    if (kind === 'profile') {
      await apiJson('/api/profile/update', {
        method: 'POST',
        body: JSON.stringify({ fullName: data.fullName || '', username: data.username || '' })
      }, true);
      STATE.profile = await fetchProfile();
      renderProfile();
      toast('Profil güncellendi.', 'success');
      return;
    }
    if (kind === 'promo') {
      if (!STATE.authUser) { openSheet('login'); return; }
      const payload = await apiJson('/api/promo/claim', { method: 'POST', body: JSON.stringify({ code: data.code }) }, true);
      STATE.profile = payload.user || await fetchProfile();
      renderProfile();
      toast(`${formatNumber(payload.amount || 0)} MC promosyon işlendi.`, 'success');
      return;
    }
    if (kind === 'wheel') {
      if (!STATE.authUser) { openSheet('login'); return; }
      const payload = await apiJson('/api/wheel/spin', { method: 'POST', body: JSON.stringify({}) }, true);
      STATE.profile = payload.user || await fetchProfile();
      renderProfile();
      toast(`${formatNumber(payload.amount || payload.prize || 0)} MC çark ödülü işlendi.`, 'success');
      return;
    }
    if (kind === 'support') {
      if (!STATE.authUser) { openSheet('login'); return; }
      await apiJson('/api/support/message', { method: 'POST', body: JSON.stringify({ subject: data.subject, message: data.message, text: data.message, source: 'home' }) }, true);
      toast('Destek talebi gönderildi.', 'success');
      closeSheet();
    }
  } catch (error) {
    toast(humanError(error), 'error');
    report(`home.form.${kind}`, error, { severity: 'warning' });
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = oldText; }
  }
}

function humanError(error) {
  const code = String(error?.code || error?.message || '').replace(/^Firebase:\s*/i, '');
  if (/auth\/invalid-credential|auth\/wrong-password|auth\/user-not-found/i.test(code)) return 'Giriş bilgileri hatalı.';
  if (/auth\/email-already-in-use/i.test(code)) return 'Bu e-posta zaten kayıtlı.';
  if (/auth\/weak-password/i.test(code)) return 'Şifre en az 6 karakter olmalıdır.';
  if (/AUTH_REQUIRED|401/i.test(code)) return 'Bu işlem için giriş yapmalısın.';
  if (/DAILY_WHEEL_LOCKED|429/i.test(code)) return 'Günlük çark hakkı bugün kullanılmış.';
  return code.slice(0, 160) || 'İşlem tamamlanamadı.';
}

function afterStaticSheet(type) {
  if (type === 'invite') loadInviteLink();
  if (type === 'social') loadSocialSummary();
}

async function loadInviteLink() {
  if (!STATE.authUser) { $('#inviteInfo').textContent = 'Davet bağlantısı için giriş yapmalısın.'; return; }
  try {
    const payload = await apiJson('/api/referral/link', {}, true);
    $('#inviteInfo').textContent = 'Davet bağlantın gerçek backend tarafından üretildi.';
    $('#inviteLink').textContent = payload.link || payload.code || '—';
  } catch (error) {
    $('#inviteInfo').textContent = 'Davet bağlantısı şu anda alınamadı.';
    report('home.invite_link', error, { severity: 'warning' });
  }
}

async function loadSocialSummary() {
  if (!STATE.authUser) { $('#socialSummary').textContent = 'Sosyal merkez için giriş yapmalısın.'; return; }
  try {
    const payload = await apiJson('/api/social-center/summary', {}, true);
    const counts = payload.counts || {};
    $('#socialSummary').innerHTML = `Arkadaş: <b>${formatNumber(counts.friends || 0)}</b><br>Bekleyen istek: <b>${formatNumber(counts.incoming || 0)}</b><br>Çevrimiçi: <b>${formatNumber(counts.online || 0)}</b><br><br>Global sohbet 7 gün, DM 14 gün saklama politikasıyla çalışır.`;
  } catch (error) {
    $('#socialSummary').textContent = 'Sosyal merkez verisi şu anda alınamadı.';
    report('home.social_summary', error, { severity: 'warning' });
  }
}

async function heartbeat() {
  if (!STATE.authUser) return;
  try { await apiJson('/api/me/activity/heartbeat', { method: 'POST', body: JSON.stringify({ activity: 'home' }) }, true); } catch (_) {}
}

async function logout() {
  try {
    if (STATE.sessionToken) await apiJson('/api/auth/session/logout', { method: 'POST', body: JSON.stringify({ sessionToken: STATE.sessionToken }) }, false).catch(() => null);
    STATE.sessionToken = '';
    writeStore('pm_session_token', '');
    if (STATE.firebase && STATE.auth) await STATE.firebase.signOut(STATE.auth);
    toggleProfileMenu(false);
    toast('Güvenli çıkış yapıldı.', 'success');
  } catch (error) {
    toast('Çıkış tamamlanamadı.', 'error');
    report('home.logout', error, { severity: 'warning' });
  }
}

function scrollToId(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function installEvents() {
  DOM.drawerOpen?.addEventListener('click', openDrawer);
  DOM.drawerClose?.addEventListener('click', closeDrawer);
  DOM.drawerBackdrop?.addEventListener('click', closeDrawer);
  DOM.sheetClose?.addEventListener('click', closeSheet);
  DOM.sheetBackdrop?.addEventListener('click', closeSheet);
  DOM.profileMenuBtn?.addEventListener('click', (event) => { event.stopPropagation(); toggleProfileMenu(); });
  DOM.logoutBtn?.addEventListener('click', logout);
  DOM.refreshLeaderboard?.addEventListener('click', loadLeaderboard);
  DOM.clearGameSearch?.addEventListener('click', () => { DOM.gameSearch.value = ''; STATE.gameQuery = ''; setGameFilter('all'); });
  DOM.gameSearch?.addEventListener('input', (event) => { STATE.gameQuery = event.target.value || ''; renderGames(); });

  document.addEventListener('click', (event) => {
    const target = event.target;
    const openSheetBtn = target.closest?.('[data-open-sheet]');
    if (openSheetBtn) {
      event.preventDefault();
      openSheet(openSheetBtn.dataset.openSheet);
      return;
    }
    const authTab = target.closest?.('[data-auth-tab]');
    if (authTab) {
      event.preventDefault();
      openSheet(authTab.dataset.authTab);
      return;
    }
    const gameBtn = target.closest?.('[data-game]');
    if (gameBtn) {
      event.preventDefault();
      openGame(gameBtn.dataset.game);
      return;
    }
    const filterBtn = target.closest?.('.pm-filter-row [data-filter], .pm-live-tabs [data-filter]');
    if (filterBtn) {
      event.preventDefault();
      setGameFilter(filterBtn.dataset.filter);
      return;
    }
    const lbBtn = target.closest?.('[data-lb]');
    if (lbBtn) {
      event.preventDefault();
      STATE.leaderboardTab = lbBtn.dataset.lb;
      $$('[data-lb]').forEach((btn) => btn.classList.toggle('is-active', btn === lbBtn));
      renderLeaderboard();
      return;
    }
    const scrollBtn = target.closest?.('[data-scroll-target]');
    if (scrollBtn) {
      event.preventDefault();
      closeDrawer();
      scrollToId(scrollBtn.dataset.scrollTarget);
      return;
    }
    const togglePassword = target.closest?.('[data-toggle-password]');
    if (togglePassword) {
      event.preventDefault();
      const input = togglePassword.parentElement?.querySelector('input');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
      return;
    }
    if (target.id === 'sendVerifyMail') {
      event.preventDefault();
      sendVerificationMail();
      return;
    }
    if (target.id === 'copyInvite') {
      event.preventDefault();
      const text = $('#inviteLink')?.textContent || '';
      navigator.clipboard?.writeText(text).then(() => toast('Davet bağlantısı kopyalandı.', 'success')).catch(() => toast('Kopyalama desteklenmiyor.', 'error'));
      return;
    }
    if (!target.closest?.('#profileMenu') && !target.closest?.('#profileMenuBtn')) toggleProfileMenu(false);
  }, { passive: false });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('[data-form]');
    if (!form) return;
    event.preventDefault();
    handleFormSubmit(form);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeSheet(); closeDrawer(); toggleProfileMenu(false); }
  });

  window.addEventListener('scroll', updateBottomActive, { passive: true });
  installMobileGuards();
}

async function sendVerificationMail() {
  try {
    if (!STATE.firebase || !STATE.auth?.currentUser) throw new Error('AUTH_REQUIRED');
    await STATE.firebase.sendEmailVerification(STATE.auth.currentUser);
    toast('Doğrulama e-postası gönderildi.', 'success');
  } catch (error) {
    toast(humanError(error), 'error');
    report('home.email_verification', error, { severity: 'warning' });
  }
}

function updateBottomActive() {
  const ids = ['home', 'games', 'leaderboard'];
  let active = 'home';
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.getBoundingClientRect().top < 180) active = id;
  }
  $$('.pm-bottom-nav [data-scroll-target]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.scrollTarget === active));
}

function installMobileGuards() {
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (event) => {
    const target = event.target;
    if (target?.closest?.('input, textarea, select')) return;
    const now = Date.now();
    if (now - lastTouchEnd <= 330) event.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
  document.addEventListener('contextmenu', (event) => {
    if (!event.target?.closest?.('input, textarea, .pm-copy-box code')) event.preventDefault();
  });
}

async function boot() {
  if (STATE.booted) return;
  STATE.booted = true;
  setupHero();
  renderGames();
  installEvents();
  await initRuntime();
  await initFirebase();
  if (!STATE.auth) {
    updateAuthUi(false);
    await loadLeaderboard();
  }
}

boot().catch((error) => {
  report('home.boot', error, { severity: 'error' });
  toast('AnaSayfa başlatılamadı.', 'error');
});
