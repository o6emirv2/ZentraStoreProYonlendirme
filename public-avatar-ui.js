/* PlayMatrix avatar-only rendering. */
(() => {
  'use strict';
  const FALLBACK_AVATAR = '/public-assets-avatars-system-fallback.svg';
  function safeAvatarUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw || /[<>\x00-\x1f]/.test(raw)) return FALLBACK_AVATAR;
    if (/^\/public-assets-(?:avatars|images)-[a-z\d_-]+\.(svg|png|webp|jpg|jpeg)$/i.test(raw)) return raw;
    const registry = window.PMAvatarRegistry;
    if (registry?.avatars?.includes(raw)) return raw;
    if (raw.startsWith('data:image/svg+xml,')) return raw;
    return FALLBACK_AVATAR;
  }
  function createNode({ avatarUrl, sizePx = 48, wrapperClass = 'pm-avatar', imageClass = 'pm-avatar-img', extraClass = '', alt = 'Oyuncu' } = {}) {
    const host = document.createElement('span');
    host.className = `${wrapperClass} ${extraClass}`.trim();
    host.classList.add('pm-avatar-picture');
    host.style.setProperty('--pm-avatar-size', `${Math.max(24, Math.min(180, Number(sizePx) || 48))}px`);
    const img = document.createElement('img');
    img.src = safeAvatarUrl(avatarUrl);
    img.alt = alt;
    img.className = imageClass;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { if (!img.src.endsWith(FALLBACK_AVATAR)) img.src = FALLBACK_AVATAR; }, { once: true });
    host.append(img);
    return host;
  }
  function buildHTML(options = {}) {
    const div = document.createElement('div');
    div.append(createNode(options));
    return div.innerHTML;
  }
  function mount(host, options = {}) {
    if (!host) return null;
    const node = createNode(options);
    host.replaceChildren(node);
    return node;
  }
  window.PMAvatar = Object.freeze({ FALLBACK_AVATAR, safeAvatarUrl, createNode, renderAvatarNode: createNode, buildHTML, mount });
})();
