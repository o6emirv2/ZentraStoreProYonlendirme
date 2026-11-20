'use strict';
const {getProgression, baseState, PROGRESSION_VERSION} = require('./server-core-progressionService.js');
const LEGACY_FIELDS = ['vip','vipTier','rp','seasonRp','seasonScore','selectedFrameLegacy'];
async function migrateUserProfile(uid, profile = {}, db = null) {
  const baseline = baseState(profile);
  const isMigrated = profile.accountProgressionVersion === PROGRESSION_VERSION;
  const patch = isMigrated ? {} : {
    progressionBaseLevel: baseline.level,
    progressionBaseTicks: baseline.ticks,
    progressionSpentMc: Number.isSafeInteger(profile.progressionSpentMc) ? profile.progressionSpentMc : 0,
    ...getProgression(profile)
  };
  if (db && Object.keys(patch).length) await db.collection('users').doc(uid).set(patch, {merge:true});
  return {...profile,...patch};
}
module.exports = {LEGACY_FIELDS,migrateUserProfile};
