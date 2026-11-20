'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Module=require('node:module');
const path=require('node:path');
const {inMemoryFirestore}=require('./tests-firestoreMock.cjs');
function loadPisti(db){
 const filename=path.join(__dirname,'server-games-pisti-index.js'),source=fs.readFileSync(filename,'utf8'),handlers=new Map();
 const router={get:(path,...fns)=>handlers.set(`GET ${path}`,fns),post:(path,...fns)=>handlers.set(`POST ${path}`,fns)};
 const fakeRequire=name=>name==='express'?{Router:()=>router}:
  name.includes('server-core-security')?{requireAuth:(_req,_res,next)=>next()}:
  name.includes('server-config-firebaseAdmin')?{initFirebaseAdmin:()=>({db})}:
  require(name.startsWith('.')?path.join(__dirname,name):name);
 const mod={exports:{}};
 const wrapper=vm.runInNewContext(Module.wrap(source),{Buffer,Date,Math,Number,process,console,setInterval,clearInterval},{filename});
 wrapper(mod.exports,fakeRequire,mod,filename,__dirname);
 async function call(method,url,{uid='player_12345678',body={},params={}}={}){
  let route=method+' '+url;
  if(!handlers.has(route)&&url.startsWith('/state/')){route=method+' /state/:roomId';params.roomId=url.split('/').at(-1);}
  const fns=handlers.get(route);assert(fns,`route missing ${route}`);
  const req={user:{uid,name:uid,email:uid+'@example.test'},body,params,query:{}};
  const answer={statusCode:200};const res={status(code){answer.statusCode=code;return this},json(data){Object.assign(answer,data);return this}};
  let error;
  for(const fn of fns){
   await fn(req,res,e=>{error=e});
   if(error)break;
  }
  if(error)return {ok:false,statusCode:error.statusCode||500,error:error.message};
  return answer;
 }
 return {call,handlers,internals:mod.exports._internals};
}
(async()=>{
 const {db,state}=inMemoryFirestore(),p1='player_AAAA1111',p2='player_BBBB2222',poor='player_POOR1234';
 state.set(`users/${p1}`,{balance:5000,accountLevel:10,accountLevelProgressPct:0});
 state.set(`users/${p2}`,{balance:5000,accountLevel:31,accountLevelProgressPct:0});
 state.set(`users/${poor}`,{balance:500,accountLevel:1,accountLevelProgressPct:0});
 const {call}=loadPisti(db);
 const invalid=await call('POST','/create-private',{uid:p1,body:{requestId:'req_BET_999',mode:'2',bet:999}});
 assert.equal(invalid.statusCode,400);assert.equal([...state.keys()].filter(k=>k.startsWith('pistiRooms/')).length,0);
 const noFunds=await call('POST','/create-private',{uid:p1,body:{requestId:'req_BET_6000',mode:'2',bet:6000}});
 assert.equal(noFunds.statusCode,409);
 assert.equal(state.get(`users/${p1}`).balance,5000);
 const insufficient=await call('POST','/create-private',{uid:poor,body:{requestId:'req_Poor_AAA',mode:'2',bet:1000}});
 assert.equal(insufficient.statusCode,409);assert.equal(state.get(`users/${poor}`).balance,500);
 assert.equal([...state.keys()].filter(x=>x.startsWith('pistiRooms/')).length,0);
 const reqBody={requestId:'req_room_A',mode:'2',bet:1000,roomName:'Gece Masası',password:'secret1'};
 const [start,duplicate]=await Promise.all([call('POST','/create-private',{uid:p1,body:reqBody}),call('POST','/create-private',{uid:p1,body:reqBody})]);
 assert.equal(start.ok,true);assert.equal(duplicate.ok,true);assert.equal(start.room.id,duplicate.room.id);
 assert.equal(state.get(`users/${p1}`).balance,4000);assert.equal(state.get(`users/${p1}`).accountLevelProgressPct,0,'waiting rooms must not increase progression');
 assert.equal([...state.keys()].filter(k=>k.startsWith('pistiRooms/')).length,1);
 const room=start.room.id;
 const lobby=await call('GET','/lobby',{uid:p2});assert.equal(lobby.rooms.length,1);
 const badPass=await call('POST','/join',{uid:p2,body:{roomId:room,password:'wrong'}});assert.equal(badPass.statusCode,403);
 const join=await call('POST','/join',{uid:p2,body:{roomId:room,password:'secret1'}});
 assert.equal(join.ok,true);assert.equal(join.room.status,'playing');
 const anotherJoin=await call('POST','/join',{uid:p2,body:{roomId:room,password:'secret1'}});
 assert.equal(anotherJoin.ok,true);assert.equal(state.get(`users/${p2}`).balance,4000);
 let stateResp=await call('GET',`/state/${room}`,{uid:p1});assert.equal(stateResp.room.status,'playing');
 const outsider=await call('GET',`/state/${room}`,{uid:'player_CCCC3333'});assert.equal(outsider.statusCode,403);
 let moves=0;const startBetSum=state.get(`users/${p1}`).balance+state.get(`users/${p2}`).balance;
 while(stateResp.room.status!=='finished' && moves<52){
  const r=stateResp.room,turnUid=r.players[r.turn].uid;
  const own=await call('GET',`/state/${room}`,{uid:turnUid});
  const token=own.room.players[own.room.turn].hand[0];
  assert(token,`missing card at move ${moves}`);
  const response=await call('POST','/play',{uid:turnUid,body:{roomId:room,cardToken:token,expectedStateVersion:own.room.stateVersion}});
  assert.equal(response.ok,true,`failed at ${moves}: ${JSON.stringify(response)}`);
  stateResp=response;moves++;
 }
 assert.equal(stateResp.room.status,'finished');assert.equal(moves,48);
 const sums=state.get(`users/${p1}`).balance+state.get(`users/${p2}`).balance;
 assert.equal(sums,startBetSum+2000,'pot must be fully distributed once');
 assert.equal(state.get(`users/${p1}`).accountLevelProgressPct,5,'completed wager must progress level');
 assert.equal(state.get(`users/${p2}`).accountLevelProgressPct,2.5,'level 31 uses half speed');
 const replay=await call('POST','/play',{uid:p2,body:{roomId:room,cardToken:'AS',expectedStateVersion:1}});
 assert.equal(replay.statusCode,409);assert.equal(state.get(`users/${p1}`).balance+state.get(`users/${p2}`).balance,sums);
 const audits=[...state.keys()].filter(k=>k.startsWith('audit/pisti_'));
 assert.equal(audits.filter(k=>k.includes('bet')).length,2);
 assert(audits.filter(k=>k.includes('settle')).length>=1);
 const fresh=loadPisti(db);
 const afterRestart=await fresh.call('GET',`/state/${room}`,{uid:p1});
 assert.equal(afterRestart.room.status,'finished');
 assert.equal(afterRestart.room.stateVersion,stateResp.room.stateVersion);
 console.log(`PASS: Pişti persistent room, 48-move game, escrow/settlement, concurrent create replay, password, balance, restart, unauthorized state, idempotent finish (${audits.length} ledger entries).`);
 const second=inMemoryFirestore();
 const fourUids=['member_1AAA','member_2BBB','member_3CCC','member_4DDD'];
 for(const user of fourUids)second.state.set(`users/${user}`,{balance:10000,accountLevel:20,accountLevelProgressPct:0});
 const api=loadPisti(second.db);
 const canceled=await api.call('POST','/create-private',{uid:fourUids[0],body:{requestId:'req_cancelled',mode:'2',bet:3000,roomName:'İptal Masası'}});
 assert.equal(canceled.ok,true);assert.equal(second.state.get(`users/${fourUids[0]}`).balance,7000);
 await api.call('POST','/leave',{uid:fourUids[0],body:{roomId:canceled.room.id}});
 assert.equal(second.state.get(`users/${fourUids[0]}`).balance,10000);
 assert.equal(second.state.get(`users/${fourUids[0]}`).accountLevelProgressPct,0);
 const four=await api.call('POST','/create-private',{uid:fourUids[0],body:{requestId:'req_fourplayer',mode:'4',bet:1000,roomName:'Dörtlü Masa'}});
 assert.equal(four.ok,true);
 for(const user of fourUids.slice(1)){
  const added=await api.call('POST','/join',{uid:user,body:{roomId:four.room.id}});
  assert.equal(added.ok,true);
 }
 let round=await api.call('GET',`/state/${four.room.id}`,{uid:fourUids[0]}),count=0;
 while(round.room.status!=='finished'&&count<52){
  const player=round.room.players[round.room.turn].uid;
  const own=await api.call('GET',`/state/${four.room.id}`,{uid:player});
  const card=own.room.players[own.room.turn].hand[0];
  round=await api.call('POST','/play',{uid:player,body:{roomId:four.room.id,cardToken:card,expectedStateVersion:own.room.stateVersion}});
  assert.equal(round.ok,true);count++;
 }
 assert.equal(round.room.status,'finished');assert.equal(count,48);
 assert.equal(fourUids.reduce((sum,id)=>sum+second.state.get(`users/${id}`).balance,0),40000);
 for(const user of fourUids)assert.equal(second.state.get(`users/${user}`).accountLevelProgressPct,5);
 console.log('PASS: Pişti 4-player full match, team pot preservation, waiting-room refund, no premature level gain and insufficient-balance rejection.');
})().catch(err=>{console.error(err);process.exitCode=1;});
