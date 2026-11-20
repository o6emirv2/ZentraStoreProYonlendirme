'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {SIGNUP_MC,EMAIL_VERIFICATION_MC}=require('./server-core-rewardPolicy.js');

async function checkRewardGuards() {
  assert.equal(SIGNUP_MC,1000);
  assert.equal(EMAIL_VERIFICATION_MC,2000);
  const code=fs.readFileSync(require.resolve('./server-routes-compat.routes.js'),'utf8');
  const start=code.indexOf('async function grantEmailVerifyRewardIfNeeded(');
  const finish=code.indexOf('async function readProfile(',start);
  assert(start>=0 && finish>start,'Verification reward implementation must be present.');
  let profile={balance:SIGNUP_MC,signupBonusClaimed:true,emailVerifyRewardClaimed:false};
  const now=()=>1710000000000;
  const users={
    async get(){return {exists:true,data:()=>({...profile})};}
  };
  const ref={...users};
  const events=[];
  const db={
    collection(name){return {doc(id){if(name==='users' && id==='registered-uid')return ref;return {key:name+'/'+id};}}},
    async runTransaction(run){
      const updates=[];
      const tx={get:async()=>({exists:true,data:()=>({...profile})}),set:(target,patch,opts)=>updates.push({target,patch,opts})};
      const result=await run(tx);
      for(const x of updates){
        if(x.target===ref){
          const patch={...x.patch};
          if(patch.balance?.increment)patch.balance=profile.balance+patch.balance.increment;
          profile={...profile,...patch};
        } else events.push(x);
      }
      return result;
    }
  };
  const admin={firestore:{FieldValue:{increment:amount=>({increment:amount})}}};
  const context={db,admin,EMAIL_VERIFICATION_MC,now,
    emailVerified:req=>req.user?.email_verified===true,
    fb:()=>({db,admin}),
    Object,Error};
  const getReward=vm.runInNewContext(code.slice(start,finish)+'\n grantEmailVerifyRewardIfNeeded;',context);
  const verified={user:{email_verified:true}};
  const unverified={user:{email_verified:false}};
  await getReward(unverified,'registered-uid',{...profile});
  assert.equal(profile.balance,1000,'Email verification must precede reward.');
  const first=await getReward(verified,'registered-uid',{...profile});
  assert.equal(first.balance,3000,'Verified account should receive exactly 2000 MC.');
  assert.equal(profile.emailVerifyRewardClaimed,true);
  const second=await getReward(verified,'registered-uid',{...profile});
  assert.equal(second.balance,3000,'Repeated claims cannot pay twice.');
  assert.equal(events.length,1,'Only one verification audit record is allowed.');
  console.info('PASS: 1,000 MC signup baseline, 2,000 MC verified-only reward, repeated request idempotency.');
}
checkRewardGuards().catch(error=>{console.error(error);process.exitCode=1});
