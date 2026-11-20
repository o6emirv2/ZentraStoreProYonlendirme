'use strict';
const express = require('express');
const crypto = require('node:crypto');
const {wager} = require('./server-core-gamePolicy.js');
const {requireAuth} = require('./server-core-security.js');
const {initFirebaseAdmin} = require('./server-config-firebaseAdmin.js');
const {applyWagerToProfile} = require('./server-core-progressionService.js');
const router = express.Router();
const now = () => Date.now();
const fail = (code,statusCode=400) => Object.assign(new Error(code),{statusCode});
const collection = 'pistiRooms';
let io = null;
function uid(req){const id=String(req.user?.uid||'');if(!/^[\w-]{6,128}$/.test(id))throw fail('AUTH_REQUIRED',401);return id;}
function name(req){return String(req.user?.name||req.user?.email?.split('@')[0]||`Oyuncu-${uid(req).slice(0,6)}`).slice(0,40);}
function getDb(){const {db}=initFirebaseAdmin();if(!db)throw fail('DATA_NOT_READY',503);return db;}
function requestId(req){const raw=String(req.body?.requestId||'').trim();if(!/^[\w-]{8,100}$/.test(raw))throw fail('REQUEST_ID_REQUIRED');return raw;}
function roomId(req){const raw=String(req.params.roomId||req.body?.roomId||'');if(!/^pi_[0-9a-f-]{36}$/.test(raw))throw fail('INVALID_ROOM_ID');return raw;}
function roomRef(db,id){return db.collection(collection).doc(id);}
function pickDeck(){
 const deck=[];for(const suit of ['S','H','D','C'])for(const rank of ['A','2','3','4','5','6','7','8','9','10','J','Q','K'])deck.push(rank+suit);
 for(let i=deck.length-1;i>0;i--){const j=crypto.randomInt(i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
 return deck;
}
function createRoom(req,id){
 const maxPlayers=String(req.body.mode||'2').includes('4')?4:2;
 const bet=wager('pisti',req.body.bet);
 const pass=String(req.body.password||'');
 if(pass.length>0&&pass.length<5)throw fail('ROOM_PASSWORD_TOO_SHORT');
 if(pass.length>100)throw fail('ROOM_PASSWORD_TOO_LONG');
 const salt=pass?crypto.randomBytes(16).toString('hex'):'';
 const hash=pass?crypto.scryptSync(pass,salt,32).toString('hex'):'';
 return {id,roomName:String(req.body.roomName||`${name(req)} Masası`).trim().slice(0,60)||'Pişti Masası',
 mode:maxPlayers===4?'4p':'2p',status:'waiting',bet,maxPlayers,pot:bet,
 passwordSalt:salt,passwordHash:hash,
 players:[{uid:uid(req),name:name(req),hand:[]}],deck:pickDeck(),tableCards:[],pileOwner:-1,
 scores:Array(maxPlayers).fill(0),capturedCounts:Array(maxPlayers).fill(0),turn:0,
 stateVersion:1,createdAt:now(),updatedAt:now(),lastEvent:null};
}
function publicRoom(room,viewer=''){
 return {id:room.id,roomName:room.roomName,mode:room.mode,status:room.status,bet:room.bet,pot:room.pot,
  maxPlayers:room.maxPlayers,currentPlayers:room.players.length,isPrivate:!!room.passwordHash,
  hostName:room.players[0]?.name||'Bilinmeyen',turn:room.turn,tableCards:room.tableCards,
  deckCount:room.deck.length,scores:room.scores,stateVersion:room.stateVersion,lastEvent:room.lastEvent||null,
  players:room.players.map((p,i)=>({uid:p.uid,name:p.name,seat:i,score:room.scores[i]||0,
   hand:p.uid===viewer?p.hand:p.hand.map(()=>'?'),handCount:p.hand.length,connected:true}))};
}
function validRoomPassword(room,submitted){
 if(!room.passwordHash)return true;
 const calculated=crypto.scryptSync(String(submitted||''),room.passwordSalt,32);
 const stored=Buffer.from(room.passwordHash,'hex');
 return calculated.length===stored.length&&crypto.timingSafeEqual(calculated,stored);
}
function applyDebit(tx,db,userRef,userDoc,playerUid,bet,id){
 if(!userDoc.exists)throw fail('PROFILE_NOT_READY',409);
 const profile=userDoc.data()||{},before=Number(profile.balance);
 if(!Number.isSafeInteger(before)||before<0)throw fail('INVALID_BALANCE',409);
 if(before<bet)throw fail('INSUFFICIENT_BALANCE',409);
 const after=before-bet,at=now(),reason='pisti-bet';
 const idem=`pisti:bet:${id}:${playerUid}`;
 const idemId=crypto.createHash('sha256').update(`${playerUid}:${idem}`).digest('hex');
 const signature=crypto.createHash('sha256').update(JSON.stringify([playerUid,-bet,reason])).digest('hex');
 // Reserve the stake immediately; apply level progression only when the game is completed.
 tx.update(userRef,{balance:after,updatedAt:at});
 tx.create(db.collection('idempotency').doc(idemId),{key:idem,id:idemId,signature,uid:playerUid,createdAt:at,result:{ok:true,uid:playerUid,amount:-bet,balance:after,reason}});
 tx.create(db.collection('audit').doc(`pisti_bet_${id}_${playerUid}`),{uid:playerUid,amount:-bet,reason,balanceAfter:after,at,roomId:id,idempotencyId:idemId});
 return after;
}
function awards(room){
 if(!room.players.length)return [];
 if(room.maxPlayers===4&&room.players.length===4){
  const side1=room.scores[0]+room.scores[2],side2=room.scores[1]+room.scores[3];
  return side1===side2?[...room.players]:side1>side2?[room.players[0],room.players[2]]:[room.players[1],room.players[3]];
 }
 const largest=Math.max(...room.scores.slice(0,room.players.length));
 return room.players.filter((_,i)=>room.scores[i]===largest);
}
function splitPot(room,winners){
 const count=winners.length;if(!count)throw fail('SETTLEMENT_EMPTY',409);
 const share=Math.floor(room.pot/count),rem=room.pot%count;
 return winners.map((p,i)=>({uid:p.uid,amount:share+(i<rem?1:0)}));
}
async function settleInTransaction(tx,db,room,payouts,reason){
 // A completed game grants progression to *all* participants; winnings are not additional wager spend.
 const prizes=new Map(payouts.map(x=>[x.uid,x.amount]));
 const refs=room.players.map(p=>db.collection('users').doc(p.uid));
 const accounts=await Promise.all(refs.map(ref=>tx.get(ref)));
 const at=now();
 for(let i=0;i<room.players.length;i++){
  const player=room.players[i],doc=accounts[i];if(!doc.exists)throw fail('PROFILE_NOT_READY',409);
  const old=Number(doc.data().balance),credit=prizes.get(player.uid)||0;
  if(!Number.isSafeInteger(old)||old<0||!Number.isSafeInteger(old+credit))throw fail('INVALID_BALANCE',409);
  tx.update(refs[i],{balance:old+credit,updatedAt:at,...applyWagerToProfile(doc.data(),room.bet)});
  if(!credit)continue;
  tx.create(db.collection('audit').doc(`pisti_settle_${room.id}_${player.uid}`),{uid:player.uid,amount:credit,reason,roomId:room.id,balanceAfter:old+credit,at});
  const idem=`pisti:settle:${room.id}:${player.uid}`;
  const idemId=crypto.createHash('sha256').update(`${player.uid}:${idem}`).digest('hex');
  tx.create(db.collection('idempotency').doc(idemId),{key:idem,uid:player.uid,createdAt:at,result:{ok:true,amount:credit,balance:old+credit,reason}});
 }
 room.status='finished';room.finishedAt=at;room.updatedAt=at;
}
function dealIfReady(room){
 if(room.status!=='waiting'||room.players.length<room.maxPlayers)return;
 room.status='playing';for(const player of room.players)player.hand=room.deck.splice(0,4);
 room.tableCards=room.deck.splice(0,4);room.turn=0;room.stateVersion++;
}
async function createTransaction(req){
 const db=getDb(),playerUid=uid(req),key=requestId(req),id='pi_'+crypto.randomUUID();
 const idemRef=db.collection('pistiCreateRequests').doc(crypto.createHash('sha256').update(`${playerUid}:${key}`).digest('hex'));
 const result=await db.runTransaction(async tx=>{
  const prior=await tx.get(idemRef);
  const requestSignature=crypto.createHash('sha256').update(JSON.stringify([req.body.mode,req.body.bet,req.body.roomName||'',req.body.password||''])).digest('hex');
  if(prior.exists){
    if(prior.data().requestSignature!==requestSignature)throw fail('REQUEST_ID_CONFLICT',409);
    const roomDoc=await tx.get(roomRef(db,prior.data().roomId));
    if(!roomDoc.exists)throw fail('ROOM_NOT_FOUND',404);
    return roomDoc.data();
  }
  const room=createRoom(req,id);
  const userRef=db.collection('users').doc(playerUid),userDoc=await tx.get(userRef);
  applyDebit(tx,db,userRef,userDoc,playerUid,room.bet,id);
  tx.create(roomRef(db,id),room);
  tx.create(idemRef,{roomId:id,uid:playerUid,requestId:key,requestSignature,at:now()});
  return room;
 });
 return result;
}
async function joinTransaction(req,id){
 const db=getDb(),playerUid=uid(req),ref=roomRef(db,id);
 return db.runTransaction(async tx=>{
  const snap=await tx.get(ref);if(!snap.exists)throw fail('ROOM_NOT_FOUND',404);
  const room=snap.data();
  if(room.players.some(player=>player.uid===playerUid))return room;
  if(room.status!=='waiting')throw fail('ROOM_NOT_WAITING',409);
  if(!validRoomPassword(room,req.body.password))throw fail('ROOM_PASSWORD_REQUIRED',403);
  if(room.players.length>=room.maxPlayers)throw fail('ROOM_FULL',409);
  const userRef=db.collection('users').doc(playerUid),userDoc=await tx.get(userRef);
  applyDebit(tx,db,userRef,userDoc,playerUid,room.bet,id);
  room.players.push({uid:playerUid,name:name(req),hand:[]});room.pot+=room.bet;
  dealIfReady(room);room.updatedAt=now();room.stateVersion++;
  tx.update(ref,room);
  return room;
 });
}
function cardPoints(cards){return cards.reduce((sum,card)=>sum+(card[0]==='A'?1:0)+(card[0]==='J'?1:0)+(card==='2C'?2:0)+(card==='10D'?3:0),0);}
function scoreCapture(room,index,cards,isPisti,isJack){
 const extra=isPisti?(isJack?20:10):0;
 room.scores[index]+=cardPoints(cards)+extra;
 room.capturedCounts[index]+=cards.length;
 room.lastEvent={type:isPisti?'pisti':'take',seat:index,points:cardPoints(cards)+extra,at:now()};
 room.pileOwner=index;
}
function majorityBonus(room){
 if(room.maxPlayers===4&&room.players.length===4){
  const a=room.capturedCounts[0]+room.capturedCounts[2],b=room.capturedCounts[1]+room.capturedCounts[3];
  if(a>b)room.scores[0]+=3;else if(b>a)room.scores[1]+=3;
 }else{
  const n=room.capturedCounts.slice(0,room.players.length),max=Math.max(...n);
  if(n.filter(v=>v===max).length===1)room.scores[n.indexOf(max)]+=3;
 }
}
function applyMove(room,playerUid,token,expectedStateVersion){
 if(room.status!=='playing')throw fail('ROOM_NOT_PLAYING',409);
 if(!Number.isSafeInteger(expectedStateVersion)||expectedStateVersion!==room.stateVersion)throw fail('STATE_VERSION_MISMATCH',409);
 const turn=room.turn,player=room.players[turn];
 if(!player||player.uid!==playerUid)throw fail('NOT_YOUR_TURN',409);
 const index=player.hand.indexOf(token);if(index<0)throw fail('CARD_NOT_IN_HAND',400);
 const before=room.tableCards.slice(),oldTop=before.at(-1)||'';
 player.hand.splice(index,1);room.tableCards.push(token);
 const rank=token.replace(/[SHDC]$/,'');
 const matched=oldTop&&((rank===oldTop.replace(/[SHDC]$/,''))||rank==='J');
 if(matched){
  const captured=room.tableCards.slice(),isPisti=before.length===1 && (rank===oldTop.replace(/[SHDC]$/,''));
  scoreCapture(room,turn,captured,isPisti,rank==='J');room.tableCards=[];
 }
 if(room.players.every(p=>p.hand.length===0)){
  if(room.deck.length>=room.players.length*4)for(const p of room.players)p.hand=room.deck.splice(0,4);
  else{
   if(room.pileOwner>=0&&room.tableCards.length)scoreCapture(room,room.pileOwner,room.tableCards,false,false);
   room.tableCards=[];majorityBonus(room);room.status='settling';
  }
 }
 room.turn=(turn+1)%room.players.length;room.stateVersion++;room.updatedAt=now();
 return room;
}
async function doPlay(req){
 const db=getDb(),id=roomId(req),playerUid=uid(req),token=String(req.body.cardToken||'');
 return db.runTransaction(async tx=>{
  const ref=roomRef(db,id),snap=await tx.get(ref);if(!snap.exists)throw fail('ROOM_NOT_FOUND',404);
  const room=applyMove(snap.data(),playerUid,token,Number(req.body.expectedStateVersion));
  if(room.status==='settling')await settleInTransaction(tx,db,room,splitPot(room,awards(room)),'pisti-win');
  tx.update(ref,room);
  return room;
 });
}
async function doLeave(req){
 const db=getDb(),id=roomId(req),user=uid(req);
 return db.runTransaction(async tx=>{
  const ref=roomRef(db,id),doc=await tx.get(ref);if(!doc.exists)return null;
  const room=doc.data();
  const index=room.players.findIndex(p=>p.uid===user);if(index<0)throw fail('NOT_IN_ROOM',403);
  if(room.status==='finished')return room;
  if(room.status==='waiting'){
   const self=db.collection('users').doc(user),snap=await tx.get(self);
   if(!snap.exists)throw fail('PROFILE_NOT_READY',409);
   const balance=Number(snap.data().balance);
   if(!Number.isSafeInteger(balance)||balance<0||!Number.isSafeInteger(balance+room.bet))throw fail('INVALID_BALANCE',409);
   const at=now(),reason='pisti-cancel-refund';
   tx.update(self,{balance:balance+room.bet,updatedAt:at});
   tx.create(db.collection('audit').doc(`pisti_refund_${room.id}_${user}`),{uid:user,amount:room.bet,reason,roomId:room.id,balanceAfter:balance+room.bet,at});
   const idem=`pisti:cancel:${room.id}:${user}`,idemId=crypto.createHash('sha256').update(`${user}:${idem}`).digest('hex');
   tx.create(db.collection('idempotency').doc(idemId),{key:idem,uid:user,createdAt:at,result:{ok:true,amount:room.bet,balance:balance+room.bet,reason}});
   room.players.splice(index,1);room.pot-=room.bet;
   if(!room.players.length)room.status='finished';
  }else if(room.status==='playing'){
   const others=room.players.filter(p=>p.uid!==user);
   if(!others.length)throw fail('NO_OPPONENT',409);
   await settleInTransaction(tx,db,room,splitPot(room,others),'pisti-opponent-left');
  }
  room.updatedAt=now();room.stateVersion++;tx.update(ref,room);return room;
 });
}
async function emitRoom(room){if(!room||!io)return;io.to(`pisti:${room.id}`).emit('pisti:update',{id:room.id,roomId:room.id,roomVersion:room.stateVersion,status:room.status});}
function respond(res,next,action,viewer,options={}){return Promise.resolve().then(action).then(room=>{
 if(room)emitRoom(room);
 res.status(options.status||200).json({ok:true,...(room?{room:publicRoom(room,viewer)}:{})});
}).catch(next);}
router.get('/lobby',requireAuth,async(req,res,next)=>{
 try{uid(req);const db=getDb(),snap=await db.collection(collection).where('status','in',['waiting','playing']).limit(80).get();
  const rooms=snap.docs.map(doc=>publicRoom(doc.data())).sort((a,b)=>a.status===b.status?0:a.status==='waiting'?-1:1);
  res.json({ok:true,rooms});
 }catch(error){next(error);}
});
router.post('/play-open',requireAuth,async(req,res,next)=>{
 try{
  const db=getDb(),bet=wager('pisti',req.body.bet),mode=String(req.body.mode||'2').includes('4')?'4p':'2p';
  const snap=await db.collection(collection).where('status','==','waiting').limit(60).get();
  const target=snap.docs.map(doc=>doc.data()).find(r=>!r.passwordHash&&r.bet===bet&&r.mode===mode&&r.players.length<r.maxPlayers&&!r.players.some(p=>p.uid===uid(req)));
  const room=target?await joinTransaction(req,target.id):await createTransaction(req);
  emitRoom(room);res.json({ok:true,room:publicRoom(room,uid(req))});
 }catch(error){next(error);}
});
router.post('/create-private',requireAuth,(req,res,next)=>respond(res,next,()=>createTransaction(req),uid(req)));
router.post('/join',requireAuth,(req,res,next)=>respond(res,next,()=>joinTransaction(req,roomId(req)),uid(req)));
router.get('/state/:roomId',requireAuth,async(req,res,next)=>{
 try{const db=getDb(),doc=await roomRef(db,roomId(req)).get();if(!doc.exists)throw fail('ROOM_NOT_FOUND',404);
  const room=doc.data(),user=uid(req);if(!room.players.some(p=>p.uid===user))throw fail('NOT_IN_ROOM',403);
  res.json({ok:true,room:publicRoom(room,user)});
 }catch(error){next(error);}
});
router.post('/ping',requireAuth,async(req,res,next)=>{
 try{const db=getDb(),ref=roomRef(db,roomId(req)),user=uid(req);
  const room=await db.runTransaction(async tx=>{const doc=await tx.get(ref);if(!doc.exists)throw fail('ROOM_NOT_FOUND',404);
    const room=doc.data();if(!room.players.some(p=>p.uid===user))throw fail('NOT_IN_ROOM',403);
    if(room.status!=='finished'){room.updatedAt=now();tx.update(ref,{updatedAt:room.updatedAt});}
    return room;
  });res.json({ok:true,room:publicRoom(room,user)});
 }catch(error){next(error);}
});
router.post('/play',requireAuth,(req,res,next)=>respond(res,next,()=>doPlay(req),uid(req)));
router.post('/leave',requireAuth,(req,res,next)=>respond(res,next,()=>doLeave(req),uid(req)));
async function expireRooms(){
 const db=getDb(),cutoff=now()-2*60*60*1000;
 const snap=await db.collection(collection).where('updatedAt','<',cutoff).limit(20).get();
 for(const doc of snap.docs){
  try{await db.runTransaction(async tx=>{
   const ref=roomRef(db,doc.id),current=await tx.get(ref);if(!current.exists)return;
   const room=current.data();if(!['waiting','playing'].includes(room.status)||room.updatedAt>=cutoff)return;
   const refs=room.players.map(p=>db.collection('users').doc(p.uid));
   const docs=await Promise.all(refs.map(ref=>tx.get(ref)));
   for(let i=0;i<docs.length;i++){
    if(!docs[i].exists)throw fail('PROFILE_NOT_READY',409);
    const user=docs[i].data(),balance=Number(user.balance);
    if(!Number.isSafeInteger(balance)||balance<0||!Number.isSafeInteger(balance+room.bet))throw fail('INVALID_BALANCE',409);
    const player=room.players[i];tx.update(refs[i],{balance:balance+room.bet,updatedAt:now()});
    tx.create(db.collection('audit').doc(`pisti_expire_${room.id}_${player.uid}`),{uid:player.uid,amount:room.bet,reason:'pisti-cancel-refund',roomId:room.id,at:now(),balanceAfter:balance+room.bet});
   }
   room.status='finished';room.lastEvent={type:'cancel',at:now()};room.updatedAt=now();room.stateVersion++;
   tx.update(ref,room);
  });}catch(error){console.error('[pisti:expiry:pending]',JSON.stringify({roomId:doc.id,code:String(error.message||error).slice(0,80)}));}
 }
}
function installSocket(nextIo){
 io=nextIo;
 io.on('connection',socket=>{
  socket.on('pisti:join',async id=>{
   try{
    if(!/^pi_[0-9a-f-]{36}$/.test(String(id||'')))return;
    const {auth}=initFirebaseAdmin(),token=String(socket.handshake?.auth?.token||'');
    if(!auth||!token)return;
    const user=await auth.verifyIdToken(token);
    const doc=await roomRef(getDb(),String(id)).get();
    if(doc.exists&&doc.data().players.some(p=>p.uid===user.uid))socket.join(`pisti:${id}`);
   }catch(error){socket.emit('pisti:error',{ok:false,error:'AUTH_REQUIRED'});}
  });
  socket.on('pisti:leave',id=>socket.leave(`pisti:${String(id||'').slice(0,120)}`));
 });
}
setInterval(()=>expireRooms().catch(error=>console.error('[pisti:cleanup]',String(error.message||error).slice(0,100))),60000).unref();
module.exports={router,installSocket,_internals:{pickDeck,cardPoints,applyMove,publicRoom,createRoom,awards,splitPot}};
