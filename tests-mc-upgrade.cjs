'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Module=require('node:module');
const path=require('node:path');
const {getProgression,applyWagerToProfile}=require('./server-core-progressionService.js');
function testProgress() {
  let p={accountLevel:10,accountLevelProgressPct:0};
  p=applyWagerToProfile(p,1000);
  assert.equal(getProgression(p).progressPercent,5);
  p=applyWagerToProfile(p,500);
  assert.equal(getProgression(p).progressPercent,7.5);
  p=applyWagerToProfile(p,-500);
  assert.equal(getProgression(p).progressPercent,5);
  p=applyWagerToProfile({accountLevel:30,accountLevelProgressPct:99},1000);
  assert.equal(p.accountLevel,31);
  assert.equal(p.progressPercent,2);
  p=applyWagerToProfile({accountLevel:31,accountLevelProgressPct:0},250);
  assert.equal(p.progressPercent,0.625);
  p=applyWagerToProfile({accountLevel:9,accountLevelProgressPct:95},21000);
  assert.equal(p.accountLevel,11);
  assert.equal(p.progressPercent,0);
  p=applyWagerToProfile({accountLevel:99,accountLevelProgressPct:99.99},50000);
  assert.equal(p.accountLevel,100);
  assert.equal(p.progressPercent,100);
  assert.equal(getProgression({accountLevel:54,accountLevelProgressPct:37}).level,54);
  console.log('PASS: MC wager levels, partial MC, 30→31 boundary, overflows, refunds, level cap and old-level preservation.');
}
function loadMockEconomy(db){
  const filename=path.join(__dirname,'server-core-economyService.js');
  const code=fs.readFileSync(filename,'utf8');
  const mod={exports:{}};
  const fakeRequire=name=>name.includes('firebaseAdmin')?{initFirebaseAdmin:()=>({db})}:require(name.startsWith('.')?path.join(__dirname,name):name);
  const wrapper=vm.runInNewContext(Module.wrap(code),{console,Buffer,Date,Number,Math,process},{filename});
  wrapper(mod.exports,fakeRequire,mod,filename,__dirname);
  return mod.exports;
}
function memoryDB(){
  const maps=new Map();
  const col=name=>{if(!maps.has(name))maps.set(name,new Map());return maps.get(name)};
  const ref=(name,id)=>({name,id,get:async()=>snapshot(name,id)});
  const snapshot=(name,id)=>{const data=col(name).get(id);return {exists:data!==undefined,data:()=>data}};
  const db={collection:name=>({doc:id=>ref(name,id)}),
    async runTransaction(fn){
      const writes=[];
      const tx={get:async o=>snapshot(o.name,o.id),set:(o,value,opts={})=>writes.push([o,value,opts]),
        create:(o,value)=>writes.push([o,value,{create:true}])};
      const result=await fn(tx);
      for(const [o,value,opts] of writes){
        if(opts.create&&col(o.name).has(o.id))throw Error('ALREADY_EXISTS');
        col(o.name).set(o.id,opts.merge?{...(col(o.name).get(o.id)||{}),...value}:value);
      }
      return result;
    }
  };
  return {db,maps,col};
}
async function testEconomy() {
  const memory=memoryDB();memory.col('users').set('a',{balance:10000,accountLevel:30,accountLevelProgressPct:99});
  const eco=loadMockEconomy(memory.db);
  const spend=await eco.debitBalance({uid:'a',amount:1000,reason:'crash-bet',idempotencyKey:'round-a'});
  assert.equal(spend.balance,9000);
  assert.equal(memory.col('users').get('a').accountLevel,31);
  assert.equal(memory.col('users').get('a').accountLevelProgressPct,2);
  const again=await eco.debitBalance({uid:'a',amount:1000,reason:'crash-bet',idempotencyKey:'round-a'});
  assert.equal(again.duplicate,true);
  assert.equal(memory.col('users').get('a').balance,9000);
  await assert.rejects(eco.debitBalance({uid:'a',amount:2000,reason:'crash-bet',idempotencyKey:'round-a'}),/TRANSACTION_KEY_CONFLICT/);
  const reversal=await eco.creditBalance({uid:'a',amount:1000,reason:'crash-invite-refund',idempotencyKey:'refund-a'});
  assert.equal(reversal.balance,10000);
  assert.equal(memory.col('users').get('a').accountLevel,30);
  assert.equal(memory.col('users').get('a').accountLevelProgressPct,99);
  assert.equal(memory.col('users').get('a').progressionSpentMc,0);
  assert.equal(memory.col('audit').size,2);
  assert.equal((await eco.creditBalance({uid:'a',amount:1.3,reason:'test'})).error,'INVALID_AMOUNT');
  assert.equal((await eco.creditBalance({uid:'a',amount:1e11,reason:'test'})).error,'INVALID_AMOUNT');
  assert.equal((await eco.debitBalance({uid:'a',amount:-5,reason:'test'})).error,'INVALID_AMOUNT');
  console.log('PASS: debit/progression atomicity, exact duplicate replay, key conflict, ledger audit and wager reversal.');
}
function loadWheel(db){
  const filename=path.join(__dirname,'server-routes-wheel.routes.js');
  const mod={exports:{}};
  const handlers=new Map();
  const router={get:(url,...fn)=>handlers.set('GET '+url,fn),post:(url,...fn)=>handlers.set('POST '+url,fn)};
  const fakeRequire=name=>name==='express'?{Router:()=>router}:
    name.includes('server-core-security')?{requireAuth:(_req,_res,next)=>next()}:
    name.includes('firebaseAdmin')?{initFirebaseAdmin:()=>({db})}:require(name);
  const wrapper=vm.runInNewContext(Module.wrap(fs.readFileSync(filename,'utf8')),{console,Buffer,Date,Math,Number,Intl,process},{filename});
  wrapper(mod.exports,fakeRequire,mod,filename,__dirname);
  async function call(method,url,{user={},body={},headers={}}={}) {
    const steps=handlers.get(method+' '+url);
    if(!steps)throw Error('NO_HANDLER');
    let response={statusCode:200};
    const res={status(code){response.statusCode=code;return this},json(data){response={...response,...data};return this}};
    for(const fn of steps){
      if(fn.length===3&&fn===steps[0]&&steps.length>1){await new Promise((resolve,reject)=>fn({user,body,headers},res,err=>err?reject(err):resolve()));continue;}
      let routedError;
      await fn({user,body,headers},res,err=>{routedError=err});
      if(routedError)response={...response,statusCode:routedError.statusCode||500,error:routedError.message};
    }
    return response;
  }
  return {call,...mod.exports};
}
async function testWheel(){
  const memory=memoryDB();memory.col('users').set('u',{balance:1000});
  const wheel=loadWheel(memory.db);
  assert.deepEqual(Array.from(wheel.REWARDS,x=>x.amount),[100,500,1500,2500,5000,15000,30000,50000]);
  assert.equal(wheel.TOTAL_WEIGHT,485);
  assert.equal(wheel.REWARDS.reduce((n,r)=>n+r.weight,0),wheel.TOTAL_WEIGHT);
  const config=await wheel.call('GET','/wheel/config');
  assert(Math.abs(Array.from(config.rewards,r=>r.probability).reduce((a,b)=>a+b,0)-1)<1e-12);
  const denied=await wheel.call('POST','/wheel/spin',{user:{uid:'u',email_verified:false}});
  assert.equal(denied.statusCode,403);
  assert.equal(memory.col('users').get('u').balance,1000);
  const user={uid:'u',email_verified:true};
  const first=await wheel.call('POST','/wheel/spin',{user,body:{requestId:'example-transaction'}});
  assert.equal(first.ok,true);
  assert.equal(first.balance,1000+first.reward);
  assert.equal(memory.col('audit').size,1);
  const retry=await wheel.call('POST','/wheel/spin',{user,body:{requestId:'example-transaction'}});
  assert.equal(retry.duplicate,true);
  assert.equal(retry.reward,first.reward);
  assert.equal(memory.col('audit').size,1);
  const again=await wheel.call('POST','/wheel/spin',{user,body:{requestId:'different'}});
  assert.equal(again.statusCode,409);
  assert.equal(memory.col('audit').size,1);
  const results=new Map(wheel.REWARDS.map(r=>[r.amount,0]));
  // Randomness smoke: every configured reward appears in a sufficiently large sample.
  for(let i=0;i<25000;i++){
    const reward=wheel.pickReward();results.set(reward.amount,results.get(reward.amount)+1);
  }
  assert([...results.values()].every(n=>n>0));
  console.log('PASS: 8 weighted wheel prizes, exact odds, email verification, per-day claim, duplicate replay, ledger and random rewards.');
}
(async()=>{testProgress();await testEconomy();await testWheel()})().catch(e=>{console.error(e);process.exitCode=1});
