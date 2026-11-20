'use strict';
const crypto=require('node:crypto');
const BONUS_MC=2000;
const CODE_RE=/^PM[A-F0-9]{10}$/;
const codeForUid=uid=>'PM'+crypto.createHash('sha256').update('playmatrix-referral-v2:'+uid).digest('hex').slice(0,10).toUpperCase();
const fail=(code,statusCode=400)=>Object.assign(new Error(code),{statusCode});
async function referralLink(db, uid, baseUrl) {
 if(!db) throw fail('DATA_NOT_READY',503);
 const code=codeForUid(uid),ref=db.collection('referralCodes').doc(code);
 await db.runTransaction(async tx=>{
  const snap=await tx.get(ref);
  if(snap.exists&&snap.data()?.uid!==uid)throw fail('REFERRAL_CODE_CONFLICT',409);
  if(!snap.exists)tx.create(ref,{uid,code,createdAt:Date.now()});
 });
 return {code,link:`${String(baseUrl).replace(/\/$/,'')}/?ref=${code}`};
}
async function bind(db, invitedUid, code) {
 if(!db)throw fail('DATA_NOT_READY',503);
 const normalized=String(code||'').trim().toUpperCase();
 if(!CODE_RE.test(normalized))throw fail('INVALID_REFERRAL_CODE');
 const codeRef=db.collection('referralCodes').doc(normalized);
 const binding=db.collection('referralBindings').doc(invitedUid);
 const invited=db.collection('users').doc(invitedUid);
 let out;
 await db.runTransaction(async tx=>{
  const [codeSnap, prior, userSnap]=await Promise.all([tx.get(codeRef),tx.get(binding),tx.get(invited)]);
  if(!userSnap.exists)throw fail('PROFILE_NOT_READY',409);
  if(!codeSnap.exists)throw fail('INVALID_REFERRAL_CODE',404);
  const inviter=String(codeSnap.data()?.uid||'');
  if(!inviter||inviter===invitedUid)throw fail('SELF_REFERRAL_FORBIDDEN',409);
  if(prior.exists){
    if(prior.data()?.code!==normalized) throw fail('REFERRAL_ALREADY_BOUND',409);
    out={ok:true,alreadyBound:true,awarded:prior.data()?.awarded===true};return;
  }
  const createdAt=Number(userSnap.data()?.createdAt||0);
  if(!createdAt||createdAt>Date.now()||Date.now()-createdAt>24*3600000)throw fail('REFERRAL_BINDING_WINDOW_CLOSED',409);
  tx.create(binding,{invitedUid,inviterUid:inviter,code:normalized,awarded:false,boundAt:Date.now()});
  out={ok:true,bound:true,awarded:false};
 });
 return out;
}
async function claim(db, invitedUid, emailVerified) {
 if(!db)throw fail('DATA_NOT_READY',503);
 if(!emailVerified)throw fail('EMAIL_VERIFICATION_REQUIRED',403);
 const bindingRef=db.collection('referralBindings').doc(invitedUid);
 const invitedRef=db.collection('users').doc(invitedUid);
 let result;
 await db.runTransaction(async tx=>{
  const [binding,user]=await Promise.all([tx.get(bindingRef),tx.get(invitedRef)]);
  if(!binding.exists)throw fail('REFERRAL_NOT_BOUND',409);
  if(binding.data().awarded){result={ok:true,duplicate:true,amount:BONUS_MC,referrerAmount:BONUS_MC};return;}
  if(!user.exists)throw fail('PROFILE_NOT_READY',409);
  const inviterUid=String(binding.data()?.inviterUid||'');
  if(!inviterUid||inviterUid===invitedUid)throw fail('SELF_REFERRAL_FORBIDDEN',409);
  const inviterRef=db.collection('users').doc(inviterUid);
  const inviter=await tx.get(inviterRef);
  if(!inviter.exists)throw fail('INVITER_NOT_FOUND',409);
  const oldA=Number(user.data().balance),oldB=Number(inviter.data().balance);
  if(!Number.isSafeInteger(oldA)||!Number.isSafeInteger(oldB)||oldA<0||oldB<0)throw fail('INVALID_BALANCE',409);
  const nextA=oldA+BONUS_MC,nextB=oldB+BONUS_MC;
  if(!Number.isSafeInteger(nextA)||!Number.isSafeInteger(nextB))throw fail('BALANCE_OVERFLOW',409);
  const at=Date.now();
  tx.update(invitedRef,{balance:nextA,updatedAt:at});
  tx.update(inviterRef,{balance:nextB,updatedAt:at});
  tx.update(bindingRef,{awarded:true,awardedAt:at});
  tx.create(db.collection('audit').doc(`referral_invited_${invitedUid}`),{uid:invitedUid,amount:BONUS_MC,reason:'referral-invited',referrerUid:inviterUid,at,balanceAfter:nextA});
  tx.create(db.collection('audit').doc(`referral_inviter_${invitedUid}`),{uid:inviterUid,amount:BONUS_MC,reason:'referral-inviter',invitedUid,at,balanceAfter:nextB});
  result={ok:true,amount:BONUS_MC,referrerAmount:BONUS_MC,balance:nextA};
 });
 return result;
}
module.exports={BONUS_MC,CODE_RE,codeForUid,referralLink,bind,claim};
