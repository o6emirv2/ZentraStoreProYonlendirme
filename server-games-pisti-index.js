const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('./server-core-security.js');
const { debitBalance, creditBalance } = require('./server-core-economyService.js');
const router = express.Router();
const rooms = new Map();
// Prevent simultaneous requests from mutating the same in-memory game room.
const roomLocks = new Set();
async function inRoomLock(roomId, res, action) {
  if (roomLocks.has(roomId)) return res.status(409).json({ok:false,error:'ROOM_BUSY'});
  roomLocks.add(roomId);
  try { return await action(); } finally { roomLocks.delete(roomId); }
}
const now=()=>Date.now();
function uid(req){return String(req.user?.uid||'');} function uname(req){return String(req.user?.email||req.user?.name||`Oyuncu-${uid(req).slice(0,5)}`);} function rid(){return `pi_${now()}_${crypto.randomBytes(3).toString('hex')}`;}
function clampBet(v){ return Math.max(0, Math.min(10000, Math.trunc(Number(v)||0))); }
function deck(){ const suits=['S','H','D','C'], ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K']; const d=[]; for(const s of suits) for(const r of ranks) d.push(`${r}${s}`); for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]];} return d; }
function sanitizeRoom(r, forUid=''){ return { id:r.id, roomName:r.roomName, mode:r.mode, status:r.status, bet:r.bet, pot:r.pot, maxPlayers:r.maxPlayers, currentPlayers:r.players.length, isPrivate:!!r.password, hostName:r.players[0]?.name||'Bilinmeyen', turn:r.turn, tableCards:r.tableCards, deckCount:r.deck.length, scores:r.scores, stateVersion:r.stateVersion, lastEvent:r.lastEvent||null, players:r.players.map((p,i)=>({ uid:p.uid, name:p.name, seat:i, score:r.scores[i]||0, hand:p.uid===forUid?p.hand:p.hand.map(()=>'?'), handCount:p.hand.length, connected:true })) }; }
async function charge(req,r){ if(!r.bet) return {ok:true}; return debitBalance({uid:uid(req),amount:r.bet,reason:'pisti-bet',idempotencyKey:`pisti:bet:${r.id}:${uid(req)}`}); }
function create(req, opts={}){ const maxPlayers=String(opts.mode||'2').includes('4')?4:2; const b=clampBet(opts.bet); const r={id:rid(),roomName:String(opts.roomName||`${uname(req)} Masası`).slice(0,60),password:String(opts.password||''),mode:maxPlayers===4?'4p':'2p',status:'waiting',bet:b,pot:0,maxPlayers,players:[{uid:uid(req),name:uname(req),hand:[]}],deck:deck(),tableCards:[],pileOwner:-1,turn:0,scores:Array(maxPlayers).fill(0),stateVersion:1,createdAt:now(),updatedAt:now()}; rooms.set(r.id,r); return r; }
function dealIfReady(r){ if(r.status==='playing') return; if(r.players.length<r.maxPlayers) return; r.status='playing'; for(const p of r.players) p.hand=r.deck.splice(0,4); r.tableCards=r.deck.splice(0,4); r.turn=0; r.stateVersion++; }
async function payout(r){ if(!r.bet) return null; const max=Math.max(...r.scores); const winners=r.scores.map((s,i)=>s===max?i:-1).filter(i=>i>=0); if(winners.length===0) return null; const share=Math.floor(r.pot/winners.length); const out=[]; for(const i of winners){ const p=r.players[i]; if(p) out.push(await creditBalance({uid:p.uid,amount:share,reason:'pisti-win',idempotencyKey:`pisti:win:${r.id}:${p.uid}`})); } return out; }
router.get('/lobby', (_req,res)=>res.json({ok:true,rooms:[...rooms.values()].filter(r=>r.status!=='finished').map(r=>sanitizeRoom(r))}));
router.post('/play-open', requireAuth, async (req,res)=>{
  const bet=clampBet(req.body.bet);
  let r=[...rooms.values()].find(x=>!x.password&&x.status==='waiting'&&x.bet===bet&&x.players.length<x.maxPlayers);
  const created=!r;
  if(created)r=create(req,req.body);
  return inRoomLock(r.id,res,async()=>{
  const isHost=created && r.players[0]?.uid===uid(req);
  if(isHost || !r.players.some(p=>p.uid===uid(req))){
    const c=await charge(req,r);
    if(!c.ok){if(created)rooms.delete(r.id);return res.status(409).json(c);}
    if(!isHost)r.players.push({uid:uid(req),name:uname(req),hand:[]});
    r.pot+=r.bet;
  }
  dealIfReady(r);
  return res.json({ok:true,room:sanitizeRoom(r,uid(req))});
  });
});
router.post('/create-private', requireAuth, async (req,res)=>{ const r=create(req,req.body); const c=await charge(req,r); if(!c.ok){rooms.delete(r.id);return res.status(409).json(c);} r.pot+=r.bet; res.json({ok:true,room:sanitizeRoom(r,uid(req)),balance:c.balance}); });
router.post('/join', requireAuth, async (req,res)=>{ const r=rooms.get(String(req.body.roomId)); if(!r) return res.status(404).json({ok:false,error:'ROOM_NOT_FOUND'}); return inRoomLock(r.id,res,async()=>{ if(r.status!=='waiting')return res.status(409).json({ok:false,error:'ROOM_NOT_WAITING'}); if(r.password&&String(req.body.password||'')!==r.password) return res.status(403).json({ok:false,error:'ROOM_PASSWORD_REQUIRED'}); if(!r.players.some(p=>p.uid===uid(req))){ if(r.players.length>=r.maxPlayers) return res.status(409).json({ok:false,error:'ROOM_FULL'}); const c=await charge(req,r); if(!c.ok) return res.status(409).json(c); r.players.push({uid:uid(req),name:uname(req),hand:[]}); r.pot+=r.bet; } dealIfReady(r); return res.json({ok:true,room:sanitizeRoom(r,uid(req))}); }); });
router.get('/state/:roomId', requireAuth, (req,res)=>{ const r=rooms.get(String(req.params.roomId)); if(!r) return res.status(404).json({ok:false,error:'ROOM_NOT_FOUND'}); res.json({ok:true,room:sanitizeRoom(r,uid(req))}); });
router.post('/ping', requireAuth, (req,res)=>{ const r=rooms.get(String(req.body.roomId)); if(!r) return res.status(404).json({ok:false,error:'ROOM_NOT_FOUND'}); r.updatedAt=now(); res.json({ok:true,room:sanitizeRoom(r,uid(req))}); });
router.post('/play', requireAuth, async (req,res)=>{ const r=rooms.get(String(req.body.roomId)); if(!r) return res.status(404).json({ok:false,error:'ROOM_NOT_FOUND'}); return inRoomLock(r.id,res,async()=>{ if(r.status!=='playing') return res.status(409).json({ok:false,error:'ROOM_NOT_PLAYING'}); const idx=r.players.findIndex(p=>p.uid===uid(req)); if(idx!==r.turn) return res.status(409).json({ok:false,error:'NOT_YOUR_TURN'}); const cardToken=String(req.body.cardToken||''); const hand=r.players[idx].hand; const cardIndex=hand.indexOf(cardToken); if(cardIndex<0) return res.status(400).json({ok:false,error:'CARD_NOT_IN_HAND'}); hand.splice(cardIndex,1); r.tableCards.push(cardToken); const topBefore=r.tableCards.length>1?r.tableCards[r.tableCards.length-2]:''; const rank=cardToken.replace(/[SHDC]$/,''); const topRank=topBefore.replace(/[SHDC]$/,''); if(topBefore&&(rank===topRank||rank==='J')){ const gained=r.tableCards.length; r.scores[idx]+=gained; r.tableCards=[]; r.pileOwner=idx; r.lastEvent={type:gained===2?'pisti':'take',seat:idx,points:gained,at:now()}; }
 if(r.players.every(p=>p.hand.length===0)){ if(r.deck.length>=r.players.length*4){ for(const p of r.players) p.hand=r.deck.splice(0,4); } else { r.status='finished'; if(r.pileOwner>=0) r.scores[r.pileOwner]+=r.tableCards.length; r.tableCards=[]; await payout(r); } }
 r.turn=(r.turn+1)%r.players.length; r.stateVersion++; r.updatedAt=now(); return res.json({ok:true,room:sanitizeRoom(r,uid(req))}); }); });
router.post('/leave',requireAuth,async(req,res)=>{
  const r=rooms.get(String(req.body.roomId));
  if(!r)return res.json({ok:true});
  return inRoomLock(r.id,res,async()=>{
  const idx=r.players.findIndex(p=>p.uid===uid(req));
  if(idx<0)return res.status(403).json({ok:false,error:'NOT_IN_ROOM'});
  if(r.status==='playing'&&r.bet){
    const winners=r.players.filter(p=>p.uid!==uid(req));
    const share=winners.length?Math.floor(r.pot/winners.length):0;
    for(const player of winners)await creditBalance({uid:player.uid,amount:share,reason:'pisti-opponent-left',idempotencyKey:`pisti:left:${r.id}:${player.uid}`});
    r.status='finished';
  }else if(r.status==='waiting'){
    if(r.bet){
      const refund=await creditBalance({uid:uid(req),amount:r.bet,reason:'pisti-cancel-refund',idempotencyKey:`pisti:cancel:${r.id}:${uid(req)}`});
      if(!refund.ok)return res.status(409).json(refund);
      r.pot=Math.max(0,r.pot-r.bet);
    }
    r.players.splice(idx,1);
    if(!r.players.length)rooms.delete(r.id);
  }
  return res.json({ok:true});
  });
});
function installSocket(io){ io.on('connection',socket=>{ socket.on('pisti:join',roomId=>socket.join(`pisti:${roomId}`)); socket.on('pisti:leave',roomId=>socket.leave(`pisti:${roomId}`)); }); }
setInterval(async()=>{
  const cutoff=now()-2*60*60*1000;
  for(const [roomId,room] of rooms){
    if(room.updatedAt>=cutoff || roomLocks.has(roomId)) continue;
    if(room.status==='finished'){rooms.delete(roomId);continue;}
    await inRoomLock(roomId,{status:()=>({json:()=>null})},async()=>{
      if(!room.bet){rooms.delete(roomId);return;}
      // Refund all interrupted games rather than silently discarding paid MC.
      for(const player of room.players){
        const refund=await creditBalance({uid:player.uid,amount:room.bet,reason:'pisti-cancel-refund',idempotencyKey:`pisti:timeout:${roomId}:${player.uid}`})
          .catch(error=>({ok:false,error:error.message}));
        if(!refund.ok){ console.warn('[pisti:expired-room:refund-pending]',JSON.stringify({roomId,uid:player.uid,error:refund.error}));return; }
      }
      room.status='finished';rooms.delete(roomId);
    });
  }
},60000).unref();
module.exports={router, installSocket, _rooms:rooms};
