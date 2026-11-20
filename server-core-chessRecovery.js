'use strict';
const {initFirebaseAdmin}=require('./server-config-firebaseAdmin.js');
const {creditBalance}=require('./server-core-economyService.js');

const MIN_RECOVERY_AGE_MS=3*60*60*1000;
const ROOM_ID=/^ch_\d+_[0-9a-f]{24}$/;

/**
 * After the full Chess game lifetime has elapsed, refund stakes with no durable
 * settlement. We do not infer a winner from missing in-memory game state.
 * Every refund is guarded by the stake document's active→refunded transition.
 */
async function reconcileChessStakes({db=initFirebaseAdmin().db,nowMs=Date.now(),activeRoomIds=new Set(),credit=creditBalance}={}){
 if(!db)throw Object.assign(new Error('DATA_NOT_READY'),{statusCode:503});
 const snap=await db.collection('chessStakes').where('status','==','active').limit(100).get();
 const output={scanned:snap.size||snap.docs.length,refunded:0,pending:0,notDue:0};
 for(const document of snap.docs){
  const stake=document.data()||{};
  if(!ROOM_ID.test(String(stake.roomId||''))||typeof stake.uid!=='string'||
     !Number.isSafeInteger(stake.amount)||stake.amount<1000||stake.amount>10000){
   output.pending++;continue;
  }
  const placedAt=Number(stake.placedAt);
  if(!Number.isFinite(placedAt)||nowMs-placedAt<MIN_RECOVERY_AGE_MS||activeRoomIds.has(stake.roomId)){
   output.notDue++;continue;
  }
  try{
   const refund=await credit({uid:stake.uid,amount:stake.amount,
    reason:'chess-abandoned-recovery-refund',
    idempotencyKey:`chess:recovery:${stake.roomId}:${stake.uid}`,
    metadata:{roomId:stake.roomId,refundOfBet:true,recovered:true}});
   if(refund?.ok)output.refunded++;else output.pending++;
  }catch(error){
   if(error?.message==='CHESS_STAKE_ALREADY_SETTLED')continue;
   output.pending++;
   console.error('[chess:recovery:error]',JSON.stringify({roomId:stake.roomId,code:String(error?.message||error)}));
  }
 }
 return output;
}
module.exports={reconcileChessStakes,MIN_RECOVERY_AGE_MS};
