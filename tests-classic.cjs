'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { inMemoryFirestore } = require('./tests-firestoreMock.cjs');
const { db, state } = inMemoryFirestore();
const routerHandlers = new Map();
const router = { post:(name,...handlers)=>routerHandlers.set(name,handlers) };
const source = fs.readFileSync(path.join(__dirname,'server-games-classicEngine.js'),'utf8');
const fakeRequire = name => name === 'express' ? {Router:()=>router}:
  name === './server-core-security.js' ? {requireAuth:(_r,_s,next)=>next()}:
  name === './server-config-firebaseAdmin.js' ? {initFirebaseAdmin:()=>({db})}:
  require(name);
const mod = {exports:{}};
vm.runInNewContext(Module.wrap(source), {console,Date,Number,Math,RegExp,Buffer}, {filename:'server-games-classicEngine.js'})(mod.exports,fakeRequire,mod,'server-games-classicEngine.js',__dirname);
function assertReject(fn,code){assert.throws(fn,err=>err.message===code)}
assertReject(()=>mod.exports.validateScore('snake-pro',-1,2000),'INVALID_SCORE');
assertReject(()=>mod.exports.validateScore('snake-pro',1e10,2000),'INVALID_SCORE');
assertReject(()=>mod.exports.validateScore('snake-pro',1,1000),'INVALID_RUN_DURATION');
assert.equal(mod.exports.validateScore('snake-pro',100,2500).score,100);
mod.exports.createClassicRouter('snake-pro');
async function call(method,{uid='player_AAAAAAAA',body={}}={}){
 const handlers=routerHandlers.get(method);assert(handlers);
 const req={user:{uid},body};const result={statusCode:200};
 const res={status(code){result.statusCode=code;return this},json(data){Object.assign(result,data);return this}};
 for(const fn of handlers)await fn(req,res,()=>{});
 return result;
}
(async()=>{
 const start=await call('/start');assert.equal(start.statusCode,201);
 const startRec=state.get('classicGameRuns/'+start.runId);assert.equal(startRec.status,'started');
 const spoof=await call('/submit',{body:{runId:'snake-pro_fake',score:500}});assert.equal(spoof.statusCode,400);
 const outsider=await call('/submit',{uid:'outsider_12345678',body:{runId:start.runId,score:10}});assert.equal(outsider.statusCode,403);
 const fakeUid=await call('/submit',{body:{runId:'snake-pro_'+('0'.repeat(36)),score:10}});assert.equal(fakeUid.statusCode,404);
 state.get('classicGameRuns/'+start.runId).startedAt=Date.now()-5000;
 const first=await call('/submit',{body:{runId:start.runId,score:200}});assert.equal(first.ok,true);assert.equal(first.unverifiedClientScore,true);
 const twice=await call('/submit',{body:{runId:start.runId,score:700}});assert.equal(twice.duplicate,true);assert.equal(twice.score,200);
 assert.equal(state.get('classicGameRuns/'+start.runId).status,'finished');
 assert.equal([...state.keys()].filter(x=>x.startsWith('audit/')||x.startsWith('ledger/')).length,0,'untrusted arcade scores do not pay MC');
 console.log('PASS: Classic game auth owner enforcement, persisted start/finish, replay lock, invalid score/run rejection and no untrusted MC payout.');
})().catch(e=>{console.error(e);process.exitCode=1});
