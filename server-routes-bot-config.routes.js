'use strict';
const express=require('express');
const crypto=require('crypto');
const {requireAuth,requireAdmin}=require('./server-core-security.js');
const {initFirebaseAdmin}=require('./server-config-firebaseAdmin.js');
const botPolicy=require('./server-core-botPolicy.js');
const router=express.Router();
router.get('/admin/bot-difficulty',requireAuth,requireAdmin,async(req,res,next)=>{
 try{const {db}=initFirebaseAdmin(); res.json({ok:true,...await botPolicy.loadPolicy(db),levels:botPolicy.LEVELS});}catch(err){next(err);}
});
router.put('/admin/bot-difficulty',requireAuth,requireAdmin,async(req,res,next)=>{
 try{
  const payload=botPolicy.validate(req.body);
  const {db}=initFirebaseAdmin();
  if(!db)return res.status(503).json({ok:false,error:'DATA_NOT_READY'});
  let version=0;
  await db.runTransaction(async tx=>{
    const ref=db.collection('gameConfig').doc('botDifficulty');
    const snap=await tx.get(ref);
    version=Number(snap.data()?.settingsVersion||0)+1;
    const at=Date.now();
    tx.set(ref,{...payload,settingsVersion:version,updatedAt:at,updatedBy:req.user.uid},{merge:true});
    tx.create(db.collection('adminAudit').doc(`bot_${crypto.randomUUID()}`),{action:'BOT_POLICY_CHANGED',actor:req.user.uid,previous:snap.exists?snap.data():null,current:payload,version,at});
  });
  res.json({ok:true,config:payload,version,appliesTo:'NEW_GAMES'});
 }catch(err){if(err.statusCode)return res.status(err.statusCode).json({ok:false,error:err.message});next(err);}
});
module.exports=router;
