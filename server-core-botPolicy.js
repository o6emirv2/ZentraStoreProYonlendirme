'use strict';
const LEVELS=Object.freeze(['easy','normal','hard','expert']);
const DEFAULT=Object.freeze({chess:'normal',pisti:'normal'});
function validate(input={}) {
  const chess=String(input.chess||'').toLowerCase();
  const pisti=String(input.pisti||'').toLowerCase();
  if(!LEVELS.includes(chess)||!LEVELS.includes(pisti)) throw Object.assign(new Error('BOT_DIFFICULTY_INVALID'),{statusCode:400});
  return {chess,pisti};
}
async function loadPolicy(db) {
  if(!db)throw Object.assign(new Error('DATA_NOT_READY'),{statusCode:503});
  const snap=await db.collection('gameConfig').doc('botDifficulty').get();
  const data=snap.exists?snap.data():{};
  const config={chess:LEVELS.includes(data.chess)?data.chess:DEFAULT.chess,pisti:LEVELS.includes(data.pisti)?data.pisti:DEFAULT.pisti};
  return {config,version:Number(data.settingsVersion||0)};
}
module.exports={LEVELS,DEFAULT,validate,loadPolicy};
