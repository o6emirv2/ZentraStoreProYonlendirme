import { initPlayMatrixOnlineCore } from '/public-pm-online-core.js';

initPlayMatrixOnlineCore().catch(error => {
  console.warn('[PlayMatrix] Classic game sign-in initialization unsuccessful', { code: error?.code || 'AUTH_INIT_FAILED' });
});
