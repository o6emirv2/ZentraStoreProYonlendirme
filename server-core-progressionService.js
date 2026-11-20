'use strict';

// Integer ticks prevent floating-point drift: 40,000 ticks = one level.
// Levels 1-30: 1 MC = 2 ticks; levels 31-99: 1 MC = 1 tick.
const MAX_LEVEL = 100;
const TICKS_PER_LEVEL = 40000;
const PROGRESSION_VERSION = 'playmatrix-mc-spend-v2';
const LEVEL_LOW_WAGER_MC = 20000;
const LEVEL_HIGH_WAGER_MC = 40000;

function integer(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
function boundedLevel(value) {
  return Math.max(1, Math.min(MAX_LEVEL, integer(value, 1)));
}
function baseState(profile = {}) {
  const old = profile && typeof profile === 'object' ? profile : {};
  const level = boundedLevel(old.progressionBaseLevel ?? old.accountLevel ?? old.level ?? old.progression?.level ?? 1);
  const savedTicks = old.progressionBaseTicks ?? old.accountLevelProgressTicks;
  const priorPercent = Number(old.accountLevelProgressPct ?? old.progressPercent ?? old.progression?.progressPercent ?? 0);
  const ticks = savedTicks === undefined || savedTicks === null
    ? Math.round(Math.max(0, Math.min(99.9975, Number.isFinite(priorPercent) ? priorPercent : 0)) * 400)
    : integer(savedTicks);
  return { level, ticks: level === MAX_LEVEL ? TICKS_PER_LEVEL : Math.min(TICKS_PER_LEVEL - 1, ticks) };
}
function advance(base, amount) {
  let level = boundedLevel(base.level);
  let ticks = Math.min(TICKS_PER_LEVEL, integer(base.ticks));
  let remaining = integer(amount);
  while (remaining && level < MAX_LEVEL) {
    const rate = level <= 30 ? 2 : 1;
    const needed = Math.ceil((TICKS_PER_LEVEL - ticks) / rate);
    const spending = Math.min(needed, remaining);
    ticks += spending * rate;
    remaining -= spending;
    if (ticks >= TICKS_PER_LEVEL) { level++; ticks = level === MAX_LEVEL ? TICKS_PER_LEVEL : ticks - TICKS_PER_LEVEL; }
  }
  if (level === MAX_LEVEL) ticks = TICKS_PER_LEVEL;
  return { level, ticks };
}
function getProgression(profile = {}) {
  const data = typeof profile === 'object' && profile !== null ? profile : {};
  const base = baseState(data);
  const spent = integer(data.progressionSpentMc);
  const result = advance(base, spent);
  const progressPercent = result.ticks / 400;
  return {
    level: result.level, accountLevel: result.level, progressTicks: result.ticks,
    accountLevelProgressTicks: result.ticks, progressPercent, accountLevelProgressPct: progressPercent,
    accountSpentMc: spent, progressionSpentMc: spent,
    isMaxLevel: result.level === MAX_LEVEL,
    version: PROGRESSION_VERSION, accountProgressionVersion: PROGRESSION_VERSION,
    curveMode: 'MC_WAGER_TICKS', accountLevelCurveMode: 'MC_WAGER_TICKS'
  };
}
function applyWagerToProfile(profile = {}, deltaMc = 0) {
  if (!Number.isSafeInteger(deltaMc)) throw new RangeError('INVALID_WAGER_DELTA');
  const base = baseState(profile);
  const spent = integer(profile.progressionSpentMc);
  const total = spent + deltaMc;
  if (!Number.isSafeInteger(total)) throw new RangeError('WAGER_TOTAL_OVERFLOW');
  // Historical refunds cannot reduce the preserved pre-migration baseline.
  const nextSpent = Math.max(0, total);
  const progression = getProgression({ progressionBaseLevel:base.level, progressionBaseTicks:base.ticks, progressionSpentMc:nextSpent });
  return {
    progressionBaseLevel: base.level, progressionBaseTicks: base.ticks,
    progressionSpentMc: nextSpent,
    accountLevel: progression.level, level: progression.level,
    accountLevelProgressTicks: progression.progressTicks,
    accountLevelProgressPct: progression.progressPercent,
    progressPercent: progression.progressPercent,
    accountProgressionVersion: PROGRESSION_VERSION,
    accountLevelCurveMode: 'MC_WAGER_TICKS', progression
  };
}
module.exports = { MAX_LEVEL, TICKS_PER_LEVEL, PROGRESSION_VERSION, LEVEL_LOW_WAGER_MC, LEVEL_HIGH_WAGER_MC, baseState, advance, getProgression, applyWagerToProfile };
