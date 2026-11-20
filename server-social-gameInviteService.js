'use strict';
const crypto=require('node:crypto');
const {initFirebaseAdmin}=require('./server-config-firebaseAdmin.js');
const goodUid = uid => typeof uid === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(uid);
const ALLOWED_GAMES=new Set(['chess','pisti']);
const TTL_MS=90_000;
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function getDb(){const {db}=initFirebaseAdmin();if(!db)throw fail('DATA_NOT_READY',503);return db;}
function validateRoom(gameKey,roomId){
 if(gameKey==='pisti' && /^pi_[0-9a-f-]{36}$/.test(roomId))return;
 if(gameKey==='chess' && /^ch_\d+_[0-9a-f]{24}$/.test(roomId))return;
 throw fail('INVALID_GAME_ROOM');
}
function friendDoc(a,b){return [a,b].sort().join('_');}
async function send({hostUid,targetUid,gameKey,gameName,roomId,verifyRoom}){
 if(!goodUid(hostUid)||!goodUid(targetUid)||hostUid===targetUid)throw fail('INVALID_INVITE_PARTICIPANTS');
 if(!ALLOWED_GAMES.has(gameKey))throw fail('UNSUPPORTED_INVITE_GAME');
 validateRoom(gameKey,roomId);
 const db=getDb();
 const [peer,relationship]=await Promise.all([
  db.collection('users').doc(targetUid).get(),
  db.collection('friendships').doc(friendDoc(hostUid,targetUid)).get()
 ]);
 if(!peer.exists)throw fail('USER_NOT_FOUND',404);
 if(!relationship.exists||relationship.data().status!=='accepted')throw fail('INVITE_REQUIRES_FRIENDSHIP',403);
 if(typeof verifyRoom==='function')await verifyRoom(db,{hostUid,roomId,gameKey});
 const at=Date.now(),id=`invite_${crypto.randomUUID()}`;
 const row={id,inviteId:id,hostUid,targetUid,gameKey,gameName:String(gameName||gameKey).slice(0,80),roomId,status:'pending',at,expiresAt:at+TTL_MS,ttlAt:new Date(at+TTL_MS)};
 await db.collection('gameInvites').doc(id).create(row);
 return row;
}
async function respond({uid,inviteId,response}){
 if(!goodUid(uid)||typeof inviteId!=='string'||!/^invite_[0-9a-f-]{36}$/.test(inviteId))throw fail('INVITE_NOT_FOUND',404);
 if(!['accepted','rejected'].includes(response))throw fail('INVALID_INVITE_RESPONSE');
 const db=getDb(),ref=db.collection('gameInvites').doc(inviteId);
 return db.runTransaction(async tx=>{
  const snap=await tx.get(ref);if(!snap.exists)throw fail('INVITE_NOT_FOUND',404);
  const row=snap.data();
  if(row.targetUid!==uid)throw fail('INVITE_FORBIDDEN',403);
  if(row.status!=='pending')return row.status===response?{...row,response,duplicate:true}:Promise.reject(fail('INVITE_ALREADY_HANDLED',409));
  if(Number(row.expiresAt||0)<=Date.now())throw fail('INVITE_EXPIRED',410);
  const update={status:response,response,respondedAt:Date.now(),guestUid:uid};
  tx.update(ref,update);
  return {...row,...update};
 });
}
async function inbox(uid){
 if(!goodUid(uid))throw fail('AUTH_REQUIRED',401);
 const snap=await getDb().collection('gameInvites').where('targetUid','==',uid).limit(40).get();
 return snap.docs.map(d=>d.data()).filter(r=>r.status==='pending'&&r.expiresAt>Date.now()).sort((a,b)=>b.at-a.at);
}
module.exports={send,respond,inbox,validateRoom,ALLOWED_GAMES};
