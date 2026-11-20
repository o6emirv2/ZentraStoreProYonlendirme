'use strict';
const crypto = require('node:crypto');
const { initFirebaseAdmin } = require('./server-config-firebaseAdmin.js');
const { applyWagerToProfile } = require('./server-core-progressionService.js');

const ROOM_ID = /^ch_\d+_[a-f0-9]{24}$/;
const safeUid = value => typeof value === 'string' && /^[\w:-]{3,180}$/.test(value);
const stakeId = (roomId, uid) => crypto.createHash('sha256').update(`${uid}:${roomId}`).digest('hex');
const oldDebitId = (roomId, uid) => crypto.createHash('sha256').update(`${uid}:chess:bet:${roomId}:${uid}`).digest('hex');

/** Atomically settle both human stakes, both user balances, and immutable audit documents.
 *  A legacy stake is accepted only if an earlier valid debit idempotency receipt exists.
 *  This prevents new code from stranding an already-funded match during a rolling deploy.
 */
async function settleChessWagers({roomId, players, bet, winnerUid = '', draw = false, result = ''}) {
  if (!ROOM_ID.test(String(roomId || '')) || !Number.isSafeInteger(bet) || bet < 1000 || bet > 10000 ||
      !Array.isArray(players) || players.length !== 2 || !players.every(safeUid) || players[0] === players[1] ||
      (!draw && !players.includes(winnerUid)) || (draw && winnerUid)) {
    throw Object.assign(new Error('INVALID_CHESS_SETTLEMENT'), {statusCode:400});
  }
  const {db} = initFirebaseAdmin();
  if(!db)throw Object.assign(new Error('DATA_NOT_READY'),{statusCode:503});
  const settlementRef=db.collection('chessSettlements').doc(roomId);
  const refUser=players.map(uid=>db.collection('users').doc(uid));
  const refStake=players.map(uid=>db.collection('chessStakes').doc(stakeId(roomId,uid)));
  const refLegacy=players.map(uid=>db.collection('idempotency').doc(oldDebitId(roomId,uid)));
  const payouts=players.map(uid=>draw?Math.floor(bet/2):(uid===winnerUid?2*bet:0));
  let resultRecord;
  await db.runTransaction(async tx=>{
    const existing=await tx.get(settlementRef);
    if(existing.exists){
      const data=existing.data()||{};
      if(data.bet!==bet || JSON.stringify(data.players)!==JSON.stringify(players) || data.winnerUid!==winnerUid || data.draw!==draw) {
        throw Object.assign(new Error('CHESS_SETTLEMENT_CONFLICT'),{statusCode:409});
      }
      resultRecord={ok:true,duplicate:true,...data};return;
    }
    const [users,stakes,receipts]=await Promise.all([
      Promise.all(refUser.map(ref=>tx.get(ref))),
      Promise.all(refStake.map(ref=>tx.get(ref))),
      Promise.all(refLegacy.map(ref=>tx.get(ref)))
    ]);
    for(let i=0;i<2;i++){
      if(!users[i].exists)throw Object.assign(new Error('CHESS_ACCOUNT_MISSING'),{statusCode:409});
      const stake=stakes[i].exists?stakes[i].data():null;
      if(stake){
        if(stake.status!=='active'||stake.amount!==bet||stake.uid!==players[i]||stake.roomId!==roomId) {
          throw Object.assign(new Error('CHESS_STAKE_INVALID'),{statusCode:409});
        }
      }else{
        const receipt=receipts[i].exists?receipts[i].data():null;
        if(!receipt||receipt.uid!==players[i]||receipt.result?.amount!==-bet||receipt.result?.reason!=='chess-bet') {
          throw Object.assign(new Error('CHESS_STAKE_MISSING'),{statusCode:409});
        }
      }
      const balance=Number(users[i].data().balance);
      if(!Number.isSafeInteger(balance)||balance<0||!Number.isSafeInteger(balance+payouts[i])){
        throw Object.assign(new Error('INVALID_CHESS_BALANCE'),{statusCode:409});
      }
    }
    const now=Date.now();
    const balances=[];
    for(let i=0;i<2;i++){
      const uid=players[i], amount=payouts[i];
      const balance=Number(users[i].data().balance)+amount;
      balances.push({uid,amount,balance});
      const patch={updatedAt:now};
      if(amount>0)patch.balance=balance;
      const progressionAlreadyApplied=!stakes[i].exists || stakes[i].data()?.progressApplied!==false;
      const eligibleSpend=bet-(draw?amount:0);
      if(!progressionAlreadyApplied){
        // New chess rooms hold a stake first; only a completed match gains level progress.
        Object.assign(patch,applyWagerToProfile(users[i].data(),eligibleSpend));
      }else if(draw && amount>0){
        // Legacy rooms already gained progress at the debit: reverse returned MC.
        Object.assign(patch,applyWagerToProfile(users[i].data(),-amount));
      }
      tx.set(refUser[i],patch,{merge:true});
      if(stakes[i].exists)tx.update(refStake[i],{status:'settled',settlementReason:draw?'draw':'finished',settlementAmount:amount,settledAt:now});
      else tx.create(refStake[i],{uid,roomId,amount:bet,status:'settled',settlementReason:draw?'draw':'finished',settlementAmount:amount,legacyDebit:true,settledAt:now});
      tx.create(db.collection('audit').doc(`chess_settlement_${roomId}_${i}`),{
        uid,roomId,reason:draw?'chess-draw-half-refund':amount?'chess-win':'chess-loss',
        amount,balanceAfter:balance,at:now,settlementId:roomId,game:'chess'
      });
    }
    resultRecord={ok:true,roomId,players,bet,winnerUid,draw,result:String(result).slice(0,80),
      payouts:balances,createdAt:now};
    tx.create(settlementRef,resultRecord);
  });
  return resultRecord;
}
module.exports={settleChessWagers};
