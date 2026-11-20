'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Module=require('node:module');
const crypto=require('node:crypto');
const {wager,hundredths,validateCrashPlan,BET_LIMITS}=require('./server-core-gamePolicy.js');
const {validate:validateBots}=require('./server-core-botPolicy.js');
const referrals=require('./server-core-referralService.js');

const {inMemoryFirestore}=require('./tests-firestoreMock.cjs');

function loadWithDb(file,db){
 const filename=path.join(__dirname,file),source=fs.readFileSync(filename,'utf8');
 const mod={exports:{}};
 const fakeRequire=name=>name.includes('firebaseAdmin')?{initFirebaseAdmin:()=>({db})}:require(name.startsWith('.')?path.join(__dirname,name):name);
 const wrapper=vm.runInNewContext(Module.wrap(source),{console,Buffer,Date,Math,Number,process},{filename});
 wrapper(mod.exports,fakeRequire,mod,filename,__dirname);
 return mod.exports;
}
function testPolicies(){
 assert.deepEqual(BET_LIMITS,{crash:{min:10,max:5000},chess:{min:1000,max:10000},pisti:{min:1000,max:10000}});
 for(const [game,min,max] of [['crash',10,5000],['chess',1000,10000],['pisti',1000,10000]]){
  assert.equal(wager(game,min),min);assert.equal(wager(game,max),max);
  for(const v of [min-1,max+1,0,-1,1.5,'NaN',null,undefined])assert.throws(()=>wager(game,v));
 }
 assert.equal(hundredths('1.05'),105);assert.equal(hundredths('100.00'),10000);
 for(const v of ['1.04','100.01','1.049','0','-10',true])assert.throws(()=>hundredths(v));
 assert.equal(validateCrashPlan(Array(100).fill('1.05')).length,100);
 assert.throws(()=>validateCrashPlan(Array(99).fill('1.05')));
 assert.deepEqual(validateBots({chess:'expert',pisti:'normal'}),{chess:'expert',pisti:'normal'});
 assert.throws(()=>validateBots({chess:'impossible',pisti:'easy'}));
 console.log('PASS: Crash, Chess, Pişti bet boundaries; hundredth multiplier; 100 planned rounds; bot policies.');
}
async function testReferrals(){
 const {db,state}=inMemoryFirestore();const inviter='inviter_UID_X',invited='invited_UID_Y';
 state.set(`users/${inviter}`,{balance:1000,createdAt:Date.now()});state.set(`users/${invited}`,{balance:1000,createdAt:Date.now()});
 const link=await referrals.referralLink(db,inviter,'https://example.com');assert.equal(link.code,referrals.codeForUid(inviter));
 assert.equal((await referrals.bind(db,invited,link.code)).bound,true);
 const [r1,r2]=await Promise.all([referrals.claim(db,invited,true),referrals.claim(db,invited,true)]);
 assert.equal(r1.ok,true);assert.equal(r2.duplicate,true);
 assert.equal(state.get(`users/${inviter}`).balance,3000);assert.equal(state.get(`users/${invited}`).balance,3000);
 assert.equal([...state.keys()].filter(x=>x.startsWith('audit/referral_')).length,2);
 await assert.rejects(referrals.bind(db,inviter,link.code),e=>e.message==='SELF_REFERRAL_FORBIDDEN');
 console.log('PASS: atomic referral 2,000+2,000 MC, self-referral guard, concurrent replay idempotency.');
}
async function testSocial(){
 const {db,state}=inMemoryFirestore();const u='member_1234',v='member_5678',z='member_9999';
 for(const x of [u,v,z])state.set(`users/${x}`,{balance:1000,username:x});
 const msg=loadWithDb('server-social-messageService.js',db);
 const same=await Promise.all([msg.sendDm(u,v,'Merhaba','idem-1'),msg.sendDm(u,v,'Merhaba','idem-1')]);
 assert.equal(same[0].id,same[1].id);
 assert.equal((await msg.history(u,v)).length,1);
 assert.equal((await msg.history(v,u)).length,1);
 assert.equal((await msg.inbox(u))[0].peerUid,v);
 assert.equal((await msg.lobbyHistory()).length,0);
 assert.equal((await msg.sendLobby(u,'Türkiye sohbeti')).scope,'tr');
 assert.equal((await msg.lobbyHistory()).length,1);
 await assert.rejects(msg.history(z,'invalid/uid'),e=>e.message==='INVALID_DM_TARGET');
 await msg.setBlocked(v,u,true);
 await assert.rejects(msg.sendDm(u,v,'Engellenmiş mesaj','idem-2'),e=>e.message==='DM_BLOCKED');
 await msg.setBlocked(v,u,false);
 assert.equal((await msg.sendDm(u,v,'Tekrar açıldı','idem-2')).text,'Tekrar açıldı');
 const friends=loadWithDb('server-social-friendshipService.js',db);
 assert.equal((await friends.requestFriend(db,u,v)).created,true);
 assert.equal((await friends.requestFriend(db,u,v)).duplicate,true);
 const rows=await friends.listFriends(db,v);
 assert.equal(rows.length,1);
 await friends.respond(db,v,rows[0].friendshipId,'accept');
 assert.equal((await friends.listForUi(u)).counts.accepted,1);
 await friends.remove(db,u,rows[0].friendshipId);
 assert.equal((await friends.listFriends(db,v)).length,0);
 console.log('PASS: Firestore-backed DM and lobby messages, idempotent send, participant query, block, friendship workflow.');
}
(async()=>{testPolicies();await testReferrals();await testSocial()})().catch(error=>{console.error(error);process.exitCode=1});
