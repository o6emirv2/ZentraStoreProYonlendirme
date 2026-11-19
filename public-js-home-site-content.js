const BASE = String(window.__PM_RUNTIME?.apiBase || window.__PLAYMATRIX_API_URL__ || window.location.origin).replace(/\/+$/, '');
const TARGETS = Object.freeze({ heroTitle:'pmHeroTitle', heroDescription:'pmHeroDescription', gamesTitle:'pmGamesTitle', gamesSubtitle:'pmGamesSubtitle', announcement:'pmSiteAnnouncement' });
function paintGameCatalog(content) {
  const grid = document.getElementById('gamesGrid');
  if (!grid) return;
  grid.querySelectorAll('.game-card').forEach(card => {
    const key = (card.dataset.staticCard || Object.keys(content.gameTitles || {}).find(name => card.classList.contains(`game-card--${name}`)) || '').trim();
    if (!key) return;
    const heading = card.querySelector('.game-title');
    const description = card.querySelector('.game-desc');
    if (heading && content.gameTitles?.[key] && heading.textContent !== content.gameTitles[key]) heading.textContent = content.gameTitles[key];
    if (description && content.gameDescriptions?.[key] && description.textContent !== content.gameDescriptions[key]) description.textContent = content.gameDescriptions[key];
  });
}
export async function installSiteContent() {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`${BASE}/api/site/content`, { cache:'no-store', signal:controller.signal });
    if (!response.ok) return;
    const data = await response.json();
    if (!data?.ok || !data.content) return;
    paintGameCatalog(data.content);
    const grid = document.getElementById('gamesGrid');
    if (grid) {
      const observer = new MutationObserver(() => paintGameCatalog(data.content));
      observer.observe(grid, { childList:true, subtree:true });
    }
    for (const [key, id] of Object.entries(TARGETS)) {
      const node = document.getElementById(id);
      if (node && typeof data.content[key] === 'string') node.textContent = data.content[key];
    }
  } catch (_) { /* Built-in text remains available when API is offline. */ }
  finally { window.clearTimeout(timer); }
}
