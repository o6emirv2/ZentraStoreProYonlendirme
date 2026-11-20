'use strict';
const crypto = require('node:crypto');
const {initFirebaseAdmin} = require('./server-config-firebaseAdmin.js');
const bad = (code, statusCode=400) => Object.assign(new Error(code),{statusCode});
const goodUid = uid => typeof uid === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(uid);
const threadId = (a,b) => crypto.createHash('sha256').update(JSON.stringify([a,b].sort())).digest('hex');
const getDb=()=>{const {db}=initFirebaseAdmin();if(!db)throw bad('DATA_NOT_READY',503);return db;};
const DM_RETENTION_MS=14*86400000;
const LOBBY_RETENTION_MS=7*86400000;
const cleanText = (text, max=500) => String(text ?? '').trim().replace(/[<>]/g,'').slice(0,max);
function ensureIds(a,b){if(!goodUid(a)||!goodUid(b)||a===b)throw bad('INVALID_DM_TARGET');}
async function isBlocked(db,a,b){
 const [first,second]=await Promise.all([db.collection('userBlocks').doc(a).collection('targets').doc(b).get(),db.collection('userBlocks').doc(b).collection('targets').doc(a).get()]);
 return first.exists||second.exists;
}
async function setBlocked(uid, targetUid, blocked){
 ensureIds(uid,targetUid); const db=getDb(),ref=db.collection('userBlocks').doc(uid).collection('targets').doc(targetUid);
 if(blocked)await ref.set({createdAt:Date.now()});else await ref.delete();
 return {ok:true,blocked};
}
async function sendDm(fromUid,toUid,rawText,clientTempId=''){
 ensureIds(fromUid,toUid);
 const text=cleanText(rawText);if(!text)throw bad('EMPTY_MESSAGE');
 const db=getDb();
 const peer=await db.collection('users').doc(toUid).get();if(!peer.exists)throw bad('USER_NOT_FOUND',404);
 if(await isBlocked(db,fromUid,toUid))throw bad('DM_BLOCKED',403);
 const thread=db.collection('dmThreads').doc(threadId(fromUid,toUid));
 const clientKey=String(clientTempId||'').trim();
 const id=clientKey&&clientKey.length<=100?crypto.createHash('sha256').update(`${fromUid}:${clientKey}`).digest('hex'):crypto.randomUUID();
 const ref=thread.collection('messages').doc(id);
 let result;
 await db.runTransaction(async tx=>{
  const prior=await tx.get(ref);
  if(prior.exists){
    const row=prior.data(); if(row.fromUid!==fromUid||row.toUid!==toUid||row.text!==text)throw bad('MESSAGE_ID_CONFLICT',409);
    result={id,...row};return;
  }
  const at=Date.now(),row={id,fromUid,byUid:fromUid,toUid,targetUid:toUid,text,message:text,at,clientTempId:clientKey,expiresAt:new Date(at+DM_RETENTION_MS)};
  tx.create(ref,row);
  tx.set(thread,{participants:[fromUid,toUid].sort(),lastAt:at,lastMessage:text,lastFromUid:fromUid},{merge:true});
  result=row;
 });
 return result;
}
async function history(uid,peerUid){
 ensureIds(uid,peerUid);
 const db=getDb();
 const snap=await db.collection('dmThreads').doc(threadId(uid,peerUid)).collection('messages').orderBy('at','desc').limit(100).get();
 return snap.docs.map(d=>({id:d.id,...d.data()})).filter(row=>Number(row.at||0)>=Date.now()-DM_RETENTION_MS).reverse();
}
async function inbox(uid){
 if(!goodUid(uid))throw bad('AUTH_REQUIRED',401);
 const db=getDb(); const snap=await db.collection('dmThreads').where('participants','array-contains',uid).limit(100).get();
 return snap.docs.map(d=>{
  const row=d.data()||{},peerUid=(row.participants||[]).find(x=>x!==uid)||'';
  return {peerUid,uid:peerUid,username:`Oyuncu ${peerUid.slice(0,6)}`,lastMessage:row.lastMessage||'',lastAt:row.lastAt||0,unread:0};
 }).filter(row=>row.lastAt>=Date.now()-DM_RETENTION_MS).sort((a,b)=>b.lastAt-a.lastAt);
}
async function sendLobby(uid,rawText,username='Oyuncu'){
 if(!goodUid(uid))throw bad('AUTH_REQUIRED',401);
 const text=cleanText(rawText,280);if(!text)throw bad('EMPTY_MESSAGE');
 const db=getDb(),id=crypto.randomUUID(),at=Date.now();
 const msg={id,uid,username:cleanText(username,60)||'Oyuncu',text,message:text,at,scope:'tr',expiresAt:new Date(at+LOBBY_RETENTION_MS)};
 await db.collection('lobbyMessages').doc(id).create(msg);
 return msg;
}
async function lobbyHistory(){
 const db=getDb();const snap=await db.collection('lobbyMessages').orderBy('at','desc').limit(100).get();
 return snap.docs.map(d=>({id:d.id,...d.data()})).filter(row=>Number(row.at||0)>=Date.now()-LOBBY_RETENTION_MS).reverse();
}
module.exports={sendDm,history,inbox,sendLobby,lobbyHistory,setBlocked,threadId,goodUid};
