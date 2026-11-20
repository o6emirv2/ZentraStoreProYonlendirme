'use strict';
// The backend is the sole authority for wager and outcome policy.
const BET_LIMITS = Object.freeze({crash:Object.freeze({min:10,max:5000}),chess:Object.freeze({min:1000,max:10000}),pisti:Object.freeze({min:1000,max:10000})});
const CRASH_MIN_HUNDREDTHS = 105;
const CRASH_MAX_HUNDREDTHS = 10000;
function wager(game, value) {
  const limits=BET_LIMITS[game];
  if (!limits) throw Object.assign(new Error('INVALID_GAME'),{statusCode:400});
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') throw Object.assign(new Error('INVALID_BET_AMOUNT'),{statusCode:400});
  const n=Number(value);
  if (!Number.isSafeInteger(n)) throw Object.assign(new Error('INVALID_BET_AMOUNT'),{statusCode:400});
  if (n < limits.min || n > limits.max) throw Object.assign(new Error('BET_LIMIT_OUT_OF_RANGE'),{statusCode:400,limits});
  return n;
}
function hundredths(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') throw Object.assign(new Error('INVALID_CRASH_MULTIPLIER'),{statusCode:400});
  const raw=String(value).trim();
  if (!/^(?:\d{1,3})(?:\.\d{1,2})?$/.test(raw)) throw Object.assign(new Error('INVALID_CRASH_MULTIPLIER'),{statusCode:400});
  const v=Number(raw);
  if (!Number.isFinite(v) || v < CRASH_MIN_HUNDREDTHS/100 || v > CRASH_MAX_HUNDREDTHS/100) throw Object.assign(new Error('CRASH_MULTIPLIER_OUT_OF_RANGE'),{statusCode:400});
  return Math.round(v*100);
}
function validateCrashPlan(input) {
  if (!Array.isArray(input) || input.length !== 100) throw Object.assign(new Error('CRASH_PLAN_REQUIRES_100_ENTRIES'),{statusCode:400});
  return input.map(hundredths);
}
module.exports={BET_LIMITS,CRASH_MIN_HUNDREDTHS,CRASH_MAX_HUNDREDTHS,wager,hundredths,validateCrashPlan};
