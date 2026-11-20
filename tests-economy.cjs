'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const root = __dirname;

function loadEconomy({ db, admin } = {}) {
  const filename = path.join(root,'server-core-economyService.js');
  const source = fs.readFileSync(filename,'utf8');
  const cache = new Map();
  const runtimeStore = {temporary:{get:key=>cache.get(key),set:(key,val)=>cache.set(key,val)}};
  const mod = {exports:{}};
  const fakeRequire = name => name.includes('firebaseAdmin') ? {initFirebaseAdmin:()=>({db,admin})} : name.includes('runtimeStore') ? {runtimeStore} : name.includes('rewardPolicy') ? {SIGNUP_MC:1000} : require(name);
  // Run wrapper under a controlled require() without exposing live credentials.
  const wrapper=vm.runInNewContext(Module.wrap(source),{console,Buffer,Date,Number,Math,process},{filename});
  wrapper(mod.exports,fakeRequire,mod,filename,root);
  return mod.exports;
}
function makeData() {
  const maps={users:new Map(),idempotency:new Map(),audit:new Map()};
  const db={
    collection(name){return {doc(id){return {id,ref:null,async get(){return snap(name,id)},collectionName:name}}}},
    async runTransaction(fn){
      const writes=[];
      const tx={get:async ref=>snap(ref.collectionName,ref.id),set:(ref,value,{merge=false}={})=>writes.push({name:ref.collectionName,id:ref.id,value,merge})};
      const result=await fn(tx);
      for(const {name,id,value,merge} of writes)maps[name].set(id,merge?{...(maps[name].get(id)||{}),...value}:value);
      return result;
    }
  };
  function snap(name,id){const value=maps[name].get(id);return {exists:!!value,data:()=>value};}
  return {db,maps};
}
async function testEconomy() {
  const {db,maps}=makeData();maps.users.set('a',{balance:1000});
  const e=loadEconomy({db,admin:{firestore:{}}});
  assert.equal(await e.readBalance('a'),1000);
  let r=await e.debitBalance({uid:'a',amount:900,idempotencyKey:'round-1',reason:'crash-bet'});
  assert.equal(r.balance,100);assert.equal(maps.users.get('a').balance,100);
  r=await e.debitBalance({uid:'a',amount:900,idempotencyKey:'round-1',reason:'crash-bet'});
  assert.equal(r.duplicate,true);assert.equal(await e.readBalance('a'),100);
  await assert.rejects(e.debitBalance({uid:'a',amount:200,reason:'crash-bet'}),err=>err.message==='INSUFFICIENT_BALANCE');
  assert.equal(await e.readBalance('a'),100);
  r=await e.creditBalance({uid:'a',amount:2000,idempotencyKey:'verify-a',reason:'email-verified-reward'});
  assert.equal(r.balance,2100);assert.equal(await e.readBalance('a'),2100);
  await assert.rejects(e.readBalance('unknown'),err=>err.message==='PROFILE_NOT_READY');
  await assert.rejects(e.debitBalance({uid:'unknown',amount:100,reason:'crash-bet'}),err=>err.message==='PROFILE_NOT_READY');
  assert.equal((await e.mutateBalance({uid:'a',amount:'not-a-number'})).error,'INVALID_AMOUNT');
  const eNoDb=loadEconomy({db:null,admin:null});
  await assert.rejects(eNoDb.readBalance('a'),err=>err.message==='DATA_NOT_READY');
  assert.equal((await eNoDb.creditBalance({uid:'a',amount:100})).error,'DATA_NOT_READY');
  console.log('PASS: MC debit, credit, insufficient balance, persistence, duplicate settlement, missing profile and missing database.');
}
async function testAsyncGuard() {
  const {protectAsyncRoutes}=require('./server-core-asyncRoutes.js');
  let called=0;
  const router=function(){};
  router.stack=[{route:{stack:[{handle:async()=>{throw new Error('database unavailable')}}]}}];
  protectAsyncRoutes(router);
  await new Promise((resolve,reject)=>router.stack[0].route.stack[0].handle({}, {}, err=>{if(err.message==='database unavailable'){called++;resolve();}else reject(err)}));
  protectAsyncRoutes(router);
  assert.equal(called,1);
  console.log('PASS: async Express 4 handlers forward failed promises to error middleware.');
}
async function testReadiness() {
  const {isDataUnavailable,publicError,verifyDataReady,readiness}=require('./server-core-dataReadiness.js');
  assert(isDataUnavailable({code:5,message:'5 NOT_FOUND'}));
  assert.equal(publicError({code:5}).statusCode,503);
  assert.equal(await verifyDataReady({collection:()=>({limit:()=>({get:async()=>({docs:[]})})})},{force:true}),true);
  assert.equal(readiness().ready,true);
  console.log('PASS: Firestore readiness distinguishes SDK initialization from actual database access.');
}
(async()=>{await testEconomy();await testAsyncGuard();await testReadiness();})().catch(err=>{console.error(err);process.exitCode=1});
