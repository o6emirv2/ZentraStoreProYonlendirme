// Client-side display contract. The server exclusively computes MC spending progression.
export const ACCOUNT_LEVEL_CAP = 100;
export const ACCOUNT_PROGRESSION_VERSION = 'playmatrix-mc-spend-v2';
export const ACCOUNT_LEVEL_CURVE_MODE = 'MC_WAGER_TICKS';
export const ACCOUNT_LEVEL_TICKS = 40000;
export function getAccountLevelProgress(profile = {}) {
  const data = profile && typeof profile === 'object' ? profile : {};
  const server = data.progression && typeof data.progression === 'object' ? data.progression : {};
  const rawLevel = Number(server.level ?? data.accountLevel ?? data.level ?? 1);
  const accountLevel = Number.isFinite(rawLevel) ? Math.max(1,Math.min(ACCOUNT_LEVEL_CAP,Math.floor(rawLevel))) : 1;
  const percent = Number(server.progressPercent ?? server.accountLevelProgressPct ?? data.accountLevelProgressPct ?? data.progressPercent ?? 0);
  const accountLevelProgressPct = accountLevel === ACCOUNT_LEVEL_CAP ? 100 : Math.max(0,Math.min(100,Number.isFinite(percent)?percent:0));
  return {accountLevel,level:accountLevel,accountLevelProgressPct,progressPercent:accountLevelProgressPct,
    accountProgressionVersion:ACCOUNT_PROGRESSION_VERSION,accountLevelCurveMode:ACCOUNT_LEVEL_CURVE_MODE};
}
export const PMProgressionPolicy = Object.freeze({ACCOUNT_LEVEL_CAP,ACCOUNT_PROGRESSION_VERSION,ACCOUNT_LEVEL_CURVE_MODE,ACCOUNT_LEVEL_TICKS,getAccountLevelProgress});
