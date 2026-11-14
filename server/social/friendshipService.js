function cleanUid(value = '') { return String(value || '').trim().slice(0, 160); }
function pairId(a, b) { return [cleanUid(a), cleanUid(b)].sort().join('_'); }
function publicFriendship(id, data = {}, uid = '') {
  const members = Array.isArray(data.members) ? data.members.map(cleanUid).filter(Boolean) : [];
  const peerUid = members.find((item) => item !== uid) || cleanUid(data.fromUid) || cleanUid(data.toUid) || '';
  return { id, peerUid, uid: peerUid, members, fromUid: cleanUid(data.fromUid), toUid: cleanUid(data.toUid), status: String(data.status || 'pending'), createdAt: Number(data.createdAt || 0), updatedAt: Number(data.updatedAt || 0), acceptedAt: Number(data.acceptedAt || 0) };
}
async function listFriends(db, uid) {
  const safeUid = cleanUid(uid);
  if (!db || !safeUid) return [];
  const snap = await db.collection('friendships').where('members', 'array-contains', safeUid).limit(200).get();
  return snap.docs.map((doc) => publicFriendship(doc.id, doc.data() || {}, safeUid));
}
async function listFriendBuckets(db, uid) {
  const safeUid = cleanUid(uid);
  const all = await listFriends(db, safeUid);
  const accepted = all.filter((item) => item.status === 'accepted');
  const incoming = all.filter((item) => item.status === 'pending' && item.toUid === safeUid);
  const outgoing = all.filter((item) => item.status === 'pending' && item.fromUid === safeUid);
  return { accepted, incoming, outgoing };
}
async function requestFriend(db, fromUid, toUid) {
  const from = cleanUid(fromUid);
  const to = cleanUid(toUid);
  if (!from || !to || from === to) return { ok: false, error: 'INVALID_TARGET' };
  const id = pairId(from, to);
  const now = Date.now();
  if (!db) return { ok: true, memoryOnly: true, request: { id, fromUid: from, toUid: to, status: 'pending', updatedAt: now } };
  const ref = db.collection('friendships').doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() || {}) : {};
    if (current.status === 'accepted') return;
    tx.set(ref, { members: [from, to].sort(), fromUid: from, toUid: to, status: 'pending', createdAt: current.createdAt || now, updatedAt: now }, { merge: true });
  });
  const fresh = await ref.get();
  return { ok: true, request: publicFriendship(id, fresh.data() || {}, from) };
}
async function respondFriend(db, uid, peerUid, accept = false) {
  const safeUid = cleanUid(uid);
  const peer = cleanUid(peerUid);
  if (!safeUid || !peer || safeUid === peer) return { ok: false, error: 'INVALID_TARGET' };
  const id = pairId(safeUid, peer);
  const now = Date.now();
  if (!db) return { ok: true, memoryOnly: true, status: accept ? 'accepted' : 'declined' };
  const ref = db.collection('friendships').doc(id);
  let result = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) { result = { ok: false, error: 'REQUEST_NOT_FOUND' }; return; }
    const data = snap.data() || {};
    if (data.status === 'accepted' && accept) { result = { ok: true, friendship: publicFriendship(id, data, safeUid) }; return; }
    if (data.toUid !== safeUid && data.fromUid !== safeUid) { result = { ok: false, error: 'NOT_ALLOWED' }; return; }
    if (!accept) { tx.delete(ref); result = { ok: true, removed: true }; return; }
    tx.set(ref, { status: 'accepted', acceptedAt: now, updatedAt: now }, { merge: true });
    result = { ok: true, friendship: publicFriendship(id, { ...data, status: 'accepted', acceptedAt: now, updatedAt: now }, safeUid) };
  });
  return result || { ok: true };
}
async function removeFriend(db, uid, peerUid) {
  const safeUid = cleanUid(uid);
  const peer = cleanUid(peerUid);
  if (!safeUid || !peer || safeUid === peer) return { ok: false, error: 'INVALID_TARGET' };
  const id = pairId(safeUid, peer);
  if (!db) return { ok: true, memoryOnly: true, removed: true };
  await db.collection('friendships').doc(id).delete().catch(() => null);
  return { ok: true, removed: true };
}
module.exports = { listFriends, listFriendBuckets, requestFriend, respondFriend, removeFriend };
