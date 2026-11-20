'use strict';
const visited = new WeakSet();
function protectAsyncRoutes(router) {
  if (!router || typeof router !== 'function' || visited.has(router)) return router;
  visited.add(router);
  for (const layer of router.stack || []) {
    if (layer.route) {
      for (const routeLayer of layer.route.stack || []) {
        const handle = routeLayer.handle;
        if (typeof handle !== 'function' || handle.__pmAsyncProtected) continue;
        const guarded = function guardedRoute(req, res, next) {
          try {
            const result = handle(req, res, next);
            if (result && typeof result.catch === 'function') return result.catch(next);
            return result;
          } catch (error) { return next(error); }
        };
        guarded.__pmAsyncProtected = true;
        routeLayer.handle = guarded;
      }
    } else if (layer.handle && layer.handle.stack) {
      protectAsyncRoutes(layer.handle);
    }
  }
  return router;
}
module.exports = { protectAsyncRoutes };
