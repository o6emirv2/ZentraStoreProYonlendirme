'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Module=require('node:module');
const {inMemoryFirestore}=require('./tests-firestoreMock.cjs');
const {runtimeStore}=require('./server-core-runtimeStore.js');
function load(name,db){
 const filename=path.join(__dirname,name),module={exports:{}};
 const requireLocal=id=>{
  if(id.includes('firebaseAdmin'))return {initFirebaseAdmin:()=>({db})};
  if(id.includes('runtimeStore'))return {runtimeStore};
  if(id.includes('economyService'))return {creditBalance:async()=>{throw Error('CREDIT_MUST_BE_INJECTED_FOR_UNIT_TEST');}};
  return require(id.startsWith('.')?path.join(__dirname,id):id);
 };
 const wrapper=vm.runInNewContext(Module.wrap(fs.readFileSync(filename,'utf8')),{Date,process,console,Buffer,Number,Math},{filename});
 wrapper(module.exports,requireLocal,module,filename,__dirname);
 return module.exports;
}
async function sessions(){
 const {db,state}=inMemoryFirestore(),s=load('server-core-sessionService.js',db);
 const uid='session_user_001';
 const issued=await s.issue({uid,email:'a@b.example',ttlMs:120000});
 assert.match(issued.token,/^[a-f0-9]{64}$/);
 assert.equal((await s.lookup(issued.token)).uid,uid);
 assert(![...state.keys()].some(x=>x.includes(issued.token)),'Raw session token must not be the persisted doc ID');
 assert.match(s.cookie(issued.token,120),/HttpOnly/);
 await s.revoke(issued.token);
 assert.equal(await s.lookup(issued.token),null);
 assert.equal(await s.lookup('invalid'),null);
 await assert.rejects(s.issue({uid,ttlMs:999*86400000}),e=>e.message==='INVALID_SESSION_TTL');
 console.log('PASS: durable sessions hashed at rest, revocation, TTL validation, cookies.');
}
async function invites(){
 const {db,state}=inMemoryFirestore();
 const s=load('server-social-gameInviteService.js',db);
 const host='host_U1234',target='target_U1234',stranger='random_U1234';
 for(const uid of [host,target,stranger])state.set(`users/${uid}`,{uid,balance:1000});
 const roomId='pi_123e4567-e89b-42d3-a456-426614174000';
 await assert.rejects(s.send({hostUid:host,targetUid:target,gameKey:'pisti',roomId}),e=>e.message==='INVITE_REQUIRES_FRIENDSHIP');
 state.set(`friendships/${[host,target].sort().join('_')}`,{status:'accepted'});
 const invite=await s.send({hostUid:host,targetUid:target,gameKey:'pisti',roomId,verifyRoom:async()=>{}});
 assert.equal((await s.inbox(target)).length,1);
 await assert.rejects(s.respond({uid:stranger,inviteId:invite.id,response:'accepted'}),e=>e.message==='INVITE_FORBIDDEN');
 const [a,b]=await Promise.all([s.respond({uid:target,inviteId:invite.id,response:'accepted'}),s.respond({uid:target,inviteId:invite.id,response:'accepted'})]);
 assert.equal(a.status,'accepted');assert.equal(b.duplicate,true);
 assert.equal((await s.inbox(target)).length,0);
 assert.equal(state.get(`gameInvites/${invite.id}`).status,'accepted');
 await assert.rejects(s.send({hostUid:host,targetUid:target,gameKey:'pattern-master',roomId}),e=>e.message==='UNSUPPORTED_INVITE_GAME');
 console.log('PASS: persistent invitations, friendship requirement, authorization, duplicate responses, retired game rejection.');
}
async function atomicRunOnce(){
 const {db,state}=inMemoryFirestore();const s=load('server-core-idempotencyService.js',db);
 let counter=0;
 const work=()=>s.runOnce({key:'unique:user:action',db,execute:async()=>{counter++;return {counter};}});
 const results=await Promise.all(Array.from({length:20},work));
 assert.equal(counter,1);
 assert.equal(results.filter(r=>r.duplicate).length,19);
 assert.equal([...state.keys()].filter(x=>x.startsWith('idempotency/')).length,1);
 await assert.rejects(s.runOnce({key:'key',db:null,execute:async()=>({ok:true})}),e=>e.statusCode===503);
 console.log('PASS: 20 concurrent idempotent operations execute exactly once.');
}
async function crashLedger(){
 const {db,state}=inMemoryFirestore(),eco=load('server-core-economyService.js',db);
 const uid='crash_user_A1',roundId='cr_round_123',box=1;
 state.set(`users/${uid}`,{balance:10000,accountLevel:4,accountLevelProgressPct:0});
 const meta={roundId,box,autoCashout:2};
 assert.equal((await eco.debitBalance({uid,amount:1000,reason:'crash-bet',idempotencyKey:'missing-metadata'})).error,'INVALID_CRASH_WAGER');
 assert.equal((await eco.creditBalance({uid,amount:999999,reason:'crash-cashout',idempotencyKey:'missing-bet'})).error,'INVALID_CRASH_SETTLEMENT');
 const wager=await eco.debitBalance({uid,amount:1000,reason:'crash-bet',idempotencyKey:'crash:bet:once',metadata:meta});
 assert.equal(wager.balance,9000);
 assert.equal([...state.keys()].filter(x=>x.startsWith('crashBets/')).length,1);
 assert.equal((await eco.debitBalance({uid,amount:1000,reason:'crash-bet',idempotencyKey:'crash:bet:once',metadata:meta})).duplicate,true);
 await assert.rejects(eco.debitBalance({uid,amount:1000,reason:'crash-bet',idempotencyKey:'crash:bet:once',metadata:{...meta,autoCashout:3}}),e=>e.message==='TRANSACTION_KEY_CONFLICT');
 const paid=await eco.creditBalance({uid,amount:2000,reason:'crash-cashout',idempotencyKey:'crash:cashout:once',metadata:{roundId,box}});
 assert.equal(paid.balance,11000);
 await assert.rejects(eco.creditBalance({uid,amount:1000,reason:'crash-invite-refund',idempotencyKey:'crash:refund:once',metadata:{roundId,box}}),e=>e.message==='BET_ALREADY_SETTLED');
 assert.equal(state.get(`users/${uid}`).balance,11000);
 const wager2=await eco.debitBalance({uid,amount:1500,reason:'crash-bet',idempotencyKey:'crash:bet:two',metadata:{roundId,box:2}});
 assert.equal(wager2.balance,9500);
 await assert.rejects(eco.creditBalance({uid,amount:1400,reason:'crash-invite-refund',idempotencyKey:'crash:refund:two',metadata:{roundId,box:2}}),e=>e.message==='INVALID_REFUND_AMOUNT');
 const refund=await eco.creditBalance({uid,amount:1500,reason:'crash-invite-refund',idempotencyKey:'crash:refund:two',metadata:{roundId,box:2}});
 assert.equal(refund.balance,11000);
 assert.equal([...state.values()].filter(x=>x.status==='refunded').length,1);
 console.log('PASS: Crash wager and payout ledger atomically prevents double settlement, incorrect refunds and wager parameter replay.');
}
async function chessAtomicSettlement(){
 const crypto=require('node:crypto');
 const {db,state}=inMemoryFirestore();
 const eco=load('server-core-economyService.js',db);
 const settlement=load('server-core-chessSettlement.js',db);
 const a='chess_player_alpha',b='chess_player_beta',roomId='ch_123456789_aaaaaaaaaaaaaaaaaaaaaaaa';
 for(const uid of [a,b])state.set(`users/${uid}`,{uid,balance:10000,accountLevel:5,accountLevelProgressPct:0});
 for(const uid of [a,b])assert.equal((await eco.debitBalance({uid,amount:1000,reason:'chess-bet',
  idempotencyKey:`chess:bet:${roomId}:${uid}`,metadata:{roomId,mode:'bet'}})).ok,true);
 const settle=()=>settlement.settleChessWagers({roomId,players:[a,b],bet:1000,winnerUid:a,draw:false,result:'checkmate'});
 const [x,y]=await Promise.all([settle(),settle()]);
 assert.equal(x.ok,true);assert.equal(y.ok,true);
 assert.equal([x,y].filter(v=>v.duplicate===true).length,1);
 assert.equal(state.get(`users/${a}`).balance,11000);
 assert.equal(state.get(`users/${b}`).balance,9000);
 assert.equal(state.get(`users/${a}`).progressionSpentMc,1000);
 assert.equal(state.get(`users/${b}`).progressionSpentMc,1000);
 assert.equal([...state.keys()].filter(k=>k.startsWith('chessSettlements/')).length,1);
 await assert.rejects(settlement.settleChessWagers({roomId,players:[a,b],bet:1000,winnerUid:b,draw:false}),e=>e.message==='CHESS_SETTLEMENT_CONFLICT');
 await assert.rejects(eco.creditBalance({uid:a,amount:1000,reason:'chess-room-refund',idempotencyKey:'second-refund',metadata:{roomId,refundOfBet:true}}),e=>e.message==='CHESS_STAKE_ALREADY_SETTLED');
 // Draw must restore only the partial wager amount's level progress.
 const room2='ch_123456790_bbbbbbbbbbbbbbbbbbbbbbbb';
 for(const uid of [a,b])await eco.debitBalance({uid,amount:1000,reason:'chess-bet',idempotencyKey:`chess:bet:${room2}:${uid}`,metadata:{roomId:room2,mode:'bet'}});
 const before=state.get(`users/${a}`).progressionSpentMc;
 await settlement.settleChessWagers({roomId:room2,players:[a,b],bet:1000,draw:true,result:'draw'});
 assert.equal(state.get(`users/${a}`).progressionSpentMc,before+500);
 // Backwards-compatible match created before the stake subledger existed.
 const room3='ch_123456791_cccccccccccccccccccccccc';
 for(const uid of [a,b]){
  await eco.debitBalance({uid,amount:1000,reason:'chess-bet',idempotencyKey:`chess:bet:${room3}:${uid}`,metadata:{roomId:room3,mode:'bet'}});
  state.delete('chessStakes/'+crypto.createHash('sha256').update(`${uid}:${room3}`).digest('hex'));
 }
 assert.equal((await settlement.settleChessWagers({roomId:room3,players:[a,b],bet:1000,winnerUid:b,result:'checkmate'})).ok,true);
 const room4='ch_123456792_dddddddddddddddddddddddd';
 await eco.debitBalance({uid:a,amount:1000,reason:'chess-bet',idempotencyKey:`chess:bet:${room4}:${a}`,metadata:{roomId:room4,mode:'bet'}});
 const beforeRefundLevel=state.get(`users/${a}`).progressionSpentMc;
 const first=await eco.creditBalance({uid:a,amount:1000,reason:'chess-waiting-room-refund',idempotencyKey:`chess-room-refund:${room4}:${a}`,metadata:{roomId:room4,refundOfBet:true}});
 assert.equal(first.ok,true);
 assert.equal(state.get(`users/${a}`).progressionSpentMc,beforeRefundLevel);
 await assert.rejects(eco.creditBalance({uid:a,amount:1000,reason:'chess-waiting-room-refund',idempotencyKey:'another-refund-key',metadata:{roomId:room4,refundOfBet:true}}),e=>e.message==='CHESS_STAKE_ALREADY_SETTLED');
 const recovery=load('server-core-chessRecovery.js',db);
 const room5='ch_123456793_eeeeeeeeeeeeeeeeeeeeeeee';
 await eco.debitBalance({uid:a,amount:1000,reason:'chess-bet',idempotencyKey:`chess:bet:${room5}:${a}`,metadata:{roomId:room5,mode:'bet'}});
 const stakeKey='chessStakes/'+crypto.createHash('sha256').update(`${a}:${room5}`).digest('hex');
 state.set(stakeKey,{...state.get(stakeKey),placedAt:Date.now()-recovery.MIN_RECOVERY_AGE_MS-10000});
 const balanceBefore=state.get(`users/${a}`).balance;
 const skipped=await recovery.reconcileChessStakes({db,nowMs:Date.now(),activeRoomIds:new Set([room5]),credit:eco.creditBalance});
 assert.equal(skipped.refunded,0);
 assert.equal(state.get(`users/${a}`).balance,balanceBefore);
 const recovered=await recovery.reconcileChessStakes({db,nowMs:Date.now(),activeRoomIds:new Set(),credit:eco.creditBalance});
 assert.equal(recovered.refunded,1);
 assert.equal(state.get(`users/${a}`).balance,balanceBefore+1000);
 assert.equal((await recovery.reconcileChessStakes({db,nowMs:Date.now(),credit:eco.creditBalance})).refunded,0);
 console.log('PASS: Chess two-player settlement is atomic, concurrent-idempotent, draw progression correct, legacy stakes verified and refunds single-use.');
}
(async()=>{await sessions();await invites();await atomicRunOnce();await crashLedger();await chessAtomicSettlement();})().catch(err=>{console.error(err);process.exitCode=1;});
