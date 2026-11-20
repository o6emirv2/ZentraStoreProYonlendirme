'use strict';
const {initFirebaseAdmin}=require('./server-config-firebaseAdmin.js');
const err=(code,statusCode=400)=>Object.assign(new Error(code),{statusCode});
const validUid=v=>typeof v==='string' && /^[a-zA-Z0-9_-]{6,128}$/.test(v);
const pair=(a,b)=>[a,b].sort().join('_');
function requireDb(){const {db}=initFirebaseAdmin();if(!db)throw err('DATA_NOT_READY',503);return db;}
async function resolveTarget(db,payload={}){
 const uid=String(payload.targetUid||payload.toUid||'').trim();
 if(uid){if(!validUid(uid))throw err('INVALID_TARGET_UID');return uid;}
 const target=String(payload.target||'').trim().toLowerCase();
 if(!/^[a-z0-9_.-]{3,32}$/.test(target))throw err('INVALID_FRIEND_TARGET');
 const snap=await db.collection('users').where('usernameLower','==',target).limit(1).get();
 if(snap.empty)throw err('USER_NOT_FOUND',404);
 return snap.docs[0].id;
}
async function listFriends(db,uid){
 if(!db)throw err('DATA_NOT_READY',503);
 const snap=await db.collection('friendships').where('members','array-contains',uid).limit(200).get();
 const rows=await Promise.all(snap.docs.map(async(doc)=>{
   const f=doc.data()||{},peerUid=(f.members||[]).find(u=>u!==uid);
   if(!peerUid)return null;
   const peer=await db.collection('users').doc(peerUid).get();
   const profile=peer.exists?peer.data():{};
   return {friendshipId:doc.id,uid:peerUid,username:profile.username||profile.displayName||`Oyuncu-${peerUid.slice(0,6)}`,avatar:profile.avatar||'',status:f.status,requesterUid:f.fromUid,recipientUid:f.toUid,requestedAt:f.createdAt||0,updatedAt:f.updatedAt||0};
 }));
 return rows.filter(Boolean);
}
async function requestFriend(db,fromUid,toUid){
 if(!db)throw err('DATA_NOT_READY',503);
 if(!validUid(fromUid)||!validUid(toUid))throw err('INVALID_TARGET_UID');
 if(fromUid===toUid)throw err('SELF_FRIEND_REQUEST',409);
 const ref=db.collection('friendships').doc(pair(fromUid,toUid));
 const other=db.collection('users').doc(toUid);
 let result={ok:true};
 await db.runTransaction(async tx=>{
   const [row,user]=await Promise.all([tx.get(ref),tx.get(other)]);
   if(!user.exists)throw err('USER_NOT_FOUND',404);
   if(row.exists){
     const data=row.data();
     if(data.status==='accepted'){result={ok:true,alreadyFriends:true};return;}
     if(data.fromUid===fromUid){result={ok:true,duplicate:true};return;}
     // Opposite-direction request: accept without creating a second relation.
     tx.update(ref,{status:'accepted',updatedAt:Date.now()});result={ok:true,accepted:true};return;
   }
   const now=Date.now();
   tx.create(ref,{members:[fromUid,toUid].sort(),fromUid,toUid,status:'pending',createdAt:now,updatedAt:now});
   result={ok:true,created:true};
 });
 return result;
}
async function respond(db,uid,id,action){
 if(!db)throw err('DATA_NOT_READY',503);
 if(!['accept','decline'].includes(action))throw err('INVALID_FRIEND_ACTION');
 const ref=db.collection('friendships').doc(String(id||''));
 let out;
 await db.runTransaction(async tx=>{
  const doc=await tx.get(ref);
  if(!doc.exists)throw err('FRIEND_REQUEST_NOT_FOUND',404);
  const row=doc.data();
  if(row.toUid!==uid||row.status!=='pending')throw err('FRIEND_REQUEST_FORBIDDEN',403);
  if(action==='accept')tx.update(ref,{status:'accepted',updatedAt:Date.now()});
  else tx.delete(ref);
  out={ok:true,status:action==='accept'?'accepted':'removed'};
 });
 return out;
}
async function remove(db,uid,id,targetUid=''){
 if(!db)throw err('DATA_NOT_READY',503);
 const key=String(id||'')||(targetUid?pair(uid,String(targetUid)):'');
 if(!key)throw err('FRIENDSHIP_REQUIRED');
 const ref=db.collection('friendships').doc(key);
 await db.runTransaction(async tx=>{
  const snap=await tx.get(ref);
  if(!snap.exists)return;
  if(!(snap.data().members||[]).includes(uid))throw err('FRIENDSHIP_FORBIDDEN',403);
  tx.delete(ref);
 });
 return {ok:true};
}
async function listForUi(uid){
 const rows=await listFriends(requireDb(),uid);
 const lists={accepted:[],incoming:[],outgoing:[]};
 for(const row of rows){ if(row.status==='accepted')lists.accepted.push(row);else if(row.recipientUid===uid)lists.incoming.push(row);else lists.outgoing.push(row); }
 return {ok:true,lists,counts:{accepted:lists.accepted.length,incoming:lists.incoming.length,outgoing:lists.outgoing.length,online:0}};
}
module.exports={requireDb,resolveTarget,listFriends,requestFriend,respond,remove,listForUi};
