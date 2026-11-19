import { bootHomeApplication } from '/public-js-home-app.js';

const PM_GAME_ROUTES = Object.freeze({
  crash: '/games-crash-index.html', chess: '/games-chess-index.html', satranc: '/games-chess-index.html', pisti: '/games-pisti-index.html',
  pattern: '/games-pattern-master-index.html', patternmaster: '/games-pattern-master-index.html', space: '/games-space-pro-index.html', spacepro: '/games-space-pro-index.html',
  snake: '/games-snake-pro-index.html', snakepro: '/games-snake-pro-index.html'
});

window.__PLAYMATRIX_ROUTES__ = PM_GAME_ROUTES;
window.__PLAYMATRIX_API_BASE__ = window.__PLAYMATRIX_API_BASE__ || window.location.origin;

function reportHomeIssue(scope, error, extra = {}) {
  try {
    if (typeof window.__PM_REPORT_CLIENT_ERROR__ === 'function') {
      window.__PM_REPORT_CLIENT_ERROR__(scope, error, { source: 'script.js', game: 'home', ...extra });
    }
  } catch (_) {}
}


bootHomeApplication().catch((error) => {
  console.error('[PlayMatrix] Home application boot failed', error);
  reportHomeIssue('home.boot', error, { type: 'boot', severity: 'error', path: location.pathname });
});
