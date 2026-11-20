'use strict';
const crypto = require('node:crypto');
const express = require('express');
const {requireAuth} = require('./server-core-security.js');
const {initFirebaseAdmin} = require('./server-config-firebaseAdmin.js');
const router = express.Router();
// Whole-number weights preserve the requested 80:70:60:15:10:6:1:0.5 ratio.
const REWARDS = Object.freeze([
  {amount:100,weight:160}, {amount:500,weight:140},
  {amount:1500,weight:120}, {amount:2500,weight:30},
  {amount:5000,weight:20}, {amount:15000,weight:12},
  {amount:30000,weight:2}, {amount:50000,weight:1}
].map(entry=>Object.freeze(entry)));
const TOTAL_WEIGHT = REWARDS.reduce((total,item)=>total+item.weight,0);
const dateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'});
function istanbulDayKey(date=new Date()) { return dateFormatter.format(date); }
function nextIstanbulReset(day) {
  const [year,month,date] = day.split('-').map(Number);
  // Turkish civil time is UTC+03:00 year-round.
  return Date.UTC(year,month-1,date+1,0,0,0)-3*3600000;
}
function pickReward() {
  let draw = crypto.randomInt(TOTAL_WEIGHT);
  for (let index=0;index<REWARDS.length;index++) {
    if (draw < REWARDS[index].weight) return {index,...REWARDS[index]};
    draw -= REWARDS[index].weight;
  }
  throw new Error('WHEEL_WEIGHT_CONFIGURATION_INVALID');
}
router.get('/wheel/config', (_req,res) => res.json({ok:true,resetTimezone:'Europe/Istanbul',reset:'00:00',
  rewards:REWARDS.map((entry,index)=>({index,amount:entry.amount,weight:entry.weight/2,probability:entry.weight/TOTAL_WEIGHT}))}));
router.post('/wheel/spin', requireAuth, async (req,res,next) => {
  try {
    if (req.user.email_verified !== true && req.user.emailVerified !== true) return res.status(403).json({ok:false,error:'EMAIL_VERIFICATION_REQUIRED'});
    const {db} = initFirebaseAdmin();
    if (!db) return res.status(503).json({ok:false,error:'DATA_NOT_READY'});
    const uid = req.user.uid;
    const day = istanbulDayKey();
    const requestId = String(req.headers['x-idempotency-key'] || req.body?.requestId || '').trim().slice(0,128);
    const claimRef = db.collection('wheelClaims').doc(`${uid}:${day}`);
    const userRef = db.collection('users').doc(uid);
    let response;
    await db.runTransaction(async tx => {
      const [prior,user] = await Promise.all([tx.get(claimRef),tx.get(userRef)]);
      if (prior.exists) {
        const saved = prior.data();
        if (requestId && saved.requestId === requestId) {
          response = {...saved.response,duplicate:true};
          return;
        }
        throw Object.assign(new Error('WHEEL_ALREADY_CLAIMED_TODAY'),{statusCode:409});
      }
      if (!user.exists) throw Object.assign(new Error('PROFILE_NOT_READY'),{statusCode:409});
      const current = Number(user.data()?.balance);
      if (!Number.isSafeInteger(current) || current < 0) throw Object.assign(new Error('INVALID_BALANCE'),{statusCode:409});
      const reward = pickReward();
      const balance = current + reward.amount;
      if (!Number.isSafeInteger(balance)) throw Object.assign(new Error('BALANCE_OVERFLOW'),{statusCode:409});
      const timestamp = Date.now();
      response = {ok:true,day,prize:reward.amount,reward:reward.amount,amount:reward.amount,index:reward.index,
        lastSpin:timestamp,nextSpinAt:nextIstanbulReset(day),balance};
      tx.create(claimRef,{uid,day,requestId,response,reward:reward.amount,at:timestamp});
      tx.set(userRef,{balance,lastSpin:timestamp,lastSpinAt:timestamp,updatedAt:timestamp},{merge:true});
      tx.create(db.collection('audit').doc(`wheel_${uid}_${day}`),{uid,amount:reward.amount,reason:'daily-wheel',at:timestamp,balanceAfter:balance});
    });
    res.json(response);
  } catch(error) {next(error);}
});
module.exports = router;
// Export read-only policy for isolated tests without allowing client-side selection.
module.exports.REWARDS = REWARDS;
module.exports.TOTAL_WEIGHT = TOTAL_WEIGHT;
module.exports.pickReward = pickReward;
module.exports.istanbulDayKey = istanbulDayKey;
