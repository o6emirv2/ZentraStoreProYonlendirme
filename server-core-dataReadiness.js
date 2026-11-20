'use strict';
// Never treat SDK initialization alone as proof that a usable database exists.
const state = { checked: false, ready: false, problem: null, checkedAt: 0 };
let inFlight = null;
function isDataUnavailable(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message || '').toUpperCase();
  return code === '5' || code === 'NOT_FOUND' || code === '14' || code === 'UNAVAILABLE' || code === '7' || code === 'PERMISSION_DENIED' || code === '16' || message.includes('DATABASE (DEFAULT) DOES NOT EXIST') || message.includes('DATABASE_NOT_FOUND');
}
function publicError(error) {
  if (isDataUnavailable(error) || error?.message === 'DATA_NOT_READY') return Object.assign(new Error('DATA_NOT_READY'),{statusCode:503,code:'DATA_NOT_READY'});
  return error;
}
function diagnose(error, area='database') {
  state.checked=true;
  state.ready=false;
  const code=String(error?.code ?? '').toUpperCase();
  state.problem = code === '5' || code === 'NOT_FOUND' ? 'DATABASE_NOT_FOUND' : code === '7' ? 'DATABASE_PERMISSION_DENIED' : 'DATABASE_UNAVAILABLE';
  state.checkedAt=Date.now();
  if (state.problem !== lastLoggedProblem) {
    console.warn(`[data:readiness] ${area}: ${state.problem}. Check the project ID, Firestore database name, database creation, API activation and service account permissions.`);
    lastLoggedProblem=state.problem;
  }
}
let lastLoggedProblem=null;
async function verifyDataReady(db,{force=false}={}) {
  if (!db) { diagnose({code:'UNAVAILABLE'},'startup'); return false; }
  const age=Date.now()-state.checkedAt;
  if (!force && state.checked && age<30_000) return state.ready;
  if (inFlight) return inFlight;
  inFlight=(async()=>{
    try {
      await db.collection('users').limit(1).get();
      state.checked=true;state.ready=true;state.problem=null;state.checkedAt=Date.now();lastLoggedProblem=null;
      return true;
    } catch(error) {
      diagnose(error,'startup');return false;
    } finally {inFlight=null;}
  })();
  return inFlight;
}
function readiness(){ return Object.freeze({checked:state.checked,ready:state.ready,problem:state.problem}); }
module.exports={isDataUnavailable,publicError,diagnose,verifyDataReady,readiness};
