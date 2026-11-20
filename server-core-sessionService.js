'use strict';
const crypto=require('node:crypto');
const {initFirebaseAdmin}=require('./server-config-firebaseAdmin.js');
const SESSION_MAX_MS=30*86400000;
const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
const valid=token=>typeof token==='string'&&/^[a-f0-9]{64}$/i.test(token);
function getDb(){const {db}=initFirebaseAdmin();if(!db)throw Object.assign(new Error('DATA_NOT_READY'),{statusCode:503});return db;}
async function issue({uid,email='',sessionSource='user',ttlMs=SESSION_MAX_MS}) {
 if(typeof uid!=='string'||!/^[\w-]{6,128}$/.test(uid))throw Object.assign(new Error('INVALID_SESSION_USER'),{statusCode:401});
 if(!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>SESSION_MAX_MS)throw Object.assign(new Error('INVALID_SESSION_TTL'),{statusCode:400});
 const token=crypto.randomBytes(32).toString('hex'),sessionId=crypto.randomUUID(),at=Date.now();
 const row={uid,email:String(email).slice(0,256),sessionSource,sessionId,createdAt:at,expiresAt:at+ttlMs,ttlAt:new Date(at+ttlMs)};
 await getDb().collection('appSessions').doc(hash(token)).create(row);
 return {token,sessionId,expiresAt:row.expiresAt};
}
async function lookup(token) {
 if(!valid(token))return null;
 // Always consult the durable document. The memory cache is never authority for revocation.
 const doc=await getDb().collection('appSessions').doc(hash(token)).get();
 if(!doc.exists)return null;
 const row=doc.data()||{};
 if(!row.uid||!Number.isFinite(row.expiresAt)||Date.now()>=row.expiresAt)return null;
 return {uid:row.uid,email:row.email||'',sessionSource:row.sessionSource||'user',sessionId:row.sessionId||'',expiresAt:row.expiresAt};
}
async function revoke(token) {
 if(!valid(token))return false;
 await getDb().collection('appSessions').doc(hash(token)).delete();
 return true;
}
function cookie(token,maxAgeSec){
 const secure=process.env.NODE_ENV==='production'?'; Secure':'';
 return `pm_session=${token || ''}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAgeSec}`;
}
function tokenFromRequest(req) {
 const header=String(req.headers['x-session-token']||'').trim();
 if(header)return header;
 const raw=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pm_session='));
 if(!raw)return '';
 try{return decodeURIComponent(raw.slice(11));}catch{return '';}
}
module.exports={issue,lookup,revoke,cookie,tokenFromRequest};
