const express = require('express');
const {requireAuth} = require('./server-core-security.js');
const {initFirebaseAdmin} = require('./server-config-firebaseAdmin.js');
const {migrateUserProfile} = require('./server-core-legacyMigrationService.js');
const {getProgression} = require('./server-core-progressionService.js');
const {DEFAULT_BALANCE} = require('./server-core-economyService.js');
const router = express.Router();
router.get('/user/me', requireAuth, async (req,res)=>{
  const {db}=initFirebaseAdmin();
  if (!db) return res.status(503).json({ok:false,error:'DATA_NOT_READY'});
  const ref=db.collection('users').doc(req.user.uid);
  const seed={uid:req.user.uid,email:req.user.email||'',balance:DEFAULT_BALANCE,signupBonusClaimed:true,accountLevel:1,accountLevelProgressTicks:0};
  let snap=await ref.get();
  if (!snap.exists) {
    try {await ref.create({...seed,createdAt:Date.now()});}
    catch(error) {if (error.code!==6&&error.code!=='already-exists') throw error;}
    snap=await ref.get();
  }
  if(!snap.exists) throw Object.assign(new Error('PROFILE_NOT_READY'),{statusCode:409});
  const profile=await migrateUserProfile(req.user.uid,{...seed,...snap.data()},db);
  const progression=getProgression(profile);
  res.json({ok:true,profile:{...profile,accountLevel:progression.level,level:progression.level,progressPercent:progression.progressPercent,accountLevelProgressPct:progression.progressPercent,progression}});
});
router.post('/user/avatar', requireAuth,async(req,res)=>{
  const avatar=String(req.body.avatar||'').slice(0,1000);
  const {db}=initFirebaseAdmin();
  if(!db)return res.status(503).json({ok:false,error:'DATA_NOT_READY'});
  await db.collection('users').doc(req.user.uid).set({avatar,updatedAt:Date.now()},{merge:true});
  res.json({ok:true,avatar});
});
module.exports=router;
