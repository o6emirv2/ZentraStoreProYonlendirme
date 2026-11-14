const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../../core/security');
const { initFirebaseAdmin } = require('../../config/firebaseAdmin');
const { debitBalance, creditBalance } = require('../../core/economyService');

const router = express.Router();
const rooms = new Map();
let ioRef = null;

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BET = 10_000;
const now = () => Date.now();
const safeText = (value = '', max = 80) => String(value || '').trim().replace(/[<>]/g, '').slice(0, max);
const uidOf = (req) => String(req.user?.uid || '').trim();
const roomId = () => `pi_${now()}_${crypto.randomBytes(4).toString('hex')}`;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function clampBet(value) {
  return Math.max(0, Math.min(MAX_BET, Math.trunc(Number(value) || 0)));
}

function maxPlayersFromMode(mode = '') {
  return String(mode || '').includes('4') ? 4 : 2;
}

function createDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const cards = [];
  for (const suit of suits) for (const rank of ranks) cards.push(`${rank}${suit}`);
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

async function readUserProfile(uid = '') {
  const { db } = initFirebaseAdmin();
  if (!db || !uid) return {};
  const snap = await db.collection('users').doc(uid).get().catch(() => null);
  return snap?.exists ? (snap.data() || {}) : {};
}

async function buildPlayer(req) {
  const uid = uidOf(req);
  const profile = await readUserProfile(uid);
  const username = safeText(profile.username || profile.displayName || profile.fullName || req.user?.name || req.user?.email || `Oyuncu-${uid.slice(0, 5)}`, 60);
  return {
    uid,
    name: username,
    username,
    avatar: safeText(profile.avatar || '', 1000),
    selectedFrame: Math.max(0, Math.min(100, Math.floor(Number(profile.selectedFrame || profile.frameLevel || 0) || 0))),
    hand: [],
    connected: true,
    joinedAt: now(),
    lastSeenAt: now(),
    paidBet: false
  };
}

function createRoomShell(req, opts = {}) {
  const maxPlayers = maxPlayersFromMode(opts.mode);
  return {
    id: roomId(),
    roomName: safeText(opts.roomName || `${req.user?.email || 'Oyuncu'} Masası`, 60),
    password: safeText(opts.password || '', 80),
    mode: maxPlayers === 4 ? '4p' : '2p',
    status: 'waiting',
    bet: clampBet(opts.bet),
    pot: 0,
    maxPlayers,
    players: [],
    deck: createDeck(),
    tableCards: [],
    pileOwner: -1,
    turn: 0,
    scores: Array(maxPlayers).fill(0),
    winner: [],
    resultSummary: null,
    lastEvent: null,
    stateVersion: 1,
    createdAt: now(),
    updatedAt: now()
  };
}

function roomHostName(room) {
  return room.players[0]?.username || room.players[0]?.name || 'Bilinmeyen';
}

function winnerUids(room) {
  if (Array.isArray(room.winner) && room.winner.length) return room.winner;
  const maxScore = Math.max(...room.scores.map((score) => Number(score || 0)));
  if (!Number.isFinite(maxScore)) return [];
  return room.scores.map((score, index) => Number(score || 0) === maxScore ? room.players[index]?.uid : '').filter(Boolean);
}

function resultSummaryFor(room, viewerUid = '') {
  if (room.status !== 'finished') return null;
  const winners = winnerUids(room);
  const draw = winners.length > 1;
  const won = winners.includes(String(viewerUid || ''));
  const amount = Number(room.resultSummary?.amount || 0) || 0;
  if (draw) {
    return {
      gameType: 'pisti',
      resultCode: 'draw',
      settledAt: room.updatedAt,
      outcome: won ? 'draw' : 'loss',
      title: 'BERABERE',
      message: room.bet > 0 ? `Masa berabere bitti. Havuz ${winners.length} oyuncu arasında paylaştırıldı.` : 'Masa berabere bitti.'
    };
  }
  if (won) {
    return {
      gameType: 'pisti',
      resultCode: 'win',
      settledAt: room.updatedAt,
      outcome: 'win',
      title: 'TEBRİKLER',
      message: room.bet > 0 ? `Masayı kazandınız. ${amount.toLocaleString('tr-TR')} MC hesabınıza işlendi.` : 'Masayı kazandınız.'
    };
  }
  return {
    gameType: 'pisti',
    resultCode: 'loss',
    settledAt: room.updatedAt,
    outcome: 'loss',
    title: 'MASAYI KAYBETTİNİZ',
    message: 'Şansınızı tekrar deneyin.'
  };
}

function publicPlayer(player, index, room, viewerUid = '') {
  const isViewer = player.uid === viewerUid;
  const hand = Array.isArray(player.hand) ? player.hand : [];
  return {
    uid: player.uid,
    name: player.name,
    username: player.username || player.name,
    avatar: player.avatar || '',
    selectedFrame: Number(player.selectedFrame || 0) || 0,
    seat: index,
    score: Number(room.scores[index] || 0),
    hand: isViewer ? hand : hand.map(() => 'BACK'),
    handCount: hand.length,
    opponentCardCount: isViewer ? 0 : hand.length,
    connected: player.connected !== false,
    lastSeenAt: player.lastSeenAt || 0
  };
}

function publicRoom(room, viewerUid = '') {
  return {
    id: room.id,
    roomName: room.roomName,
    mode: room.mode,
    status: room.status,
    bet: room.bet,
    pot: room.pot,
    maxPlayers: room.maxPlayers,
    currentPlayers: room.players.length,
    isPrivate: !!room.password,
    hostName: roomHostName(room),
    turn: room.turn,
    tableCards: Array.isArray(room.tableCards) ? room.tableCards : [],
    deckCount: room.deck.length,
    scores: room.scores,
    stateVersion: room.stateVersion,
    updatedAt: room.updatedAt,
    createdAt: room.createdAt,
    winner: winnerUids(room),
    lastEvent: room.lastEvent || null,
    resultSummary: resultSummaryFor(room, viewerUid),
    players: room.players.map((player, index) => publicPlayer(player, index, room, viewerUid))
  };
}

function publicLobbyRoom(room) {
  const view = publicRoom(room, '');
  delete view.tableCards;
  delete view.scores;
  delete view.lastEvent;
  delete view.resultSummary;
  view.players = view.players.map((player) => ({
    uid: player.uid,
    name: player.name,
    username: player.username,
    avatar: player.avatar,
    selectedFrame: player.selectedFrame,
    seat: player.seat,
    handCount: player.handCount,
    connected: player.connected
  }));
  return view;
}

function emitLobby() {
  if (!ioRef) return;
  ioRef.emit('pisti:lobby', { ok: true, rooms: [...rooms.values()].filter((room) => room.status !== 'finished').map(publicLobbyRoom), at: now() });
}

function emitRoom(room) {
  if (!ioRef || !room) return;
  for (const player of room.players) {
    ioRef.to(`pisti:user:${player.uid}`).emit('pisti:update', { ok: true, room: publicRoom(room, player.uid), id: room.id, stateVersion: room.stateVersion, at: now() });
  }
  ioRef.to(`pisti:${room.id}`).emit('pisti:touch', { ok: true, id: room.id, stateVersion: room.stateVersion, updatedAt: room.updatedAt });
}

async function chargePlayer(room, player) {
  if (!room.bet || player.paidBet) return { ok: true };
  const result = await debitBalance({ uid: player.uid, amount: room.bet, reason: 'pisti-bet', idempotencyKey: `pisti:bet:${room.id}:${player.uid}` });
  if (!result?.ok) return result || { ok: false, error: 'BET_DEBIT_FAILED' };
  player.paidBet = true;
  room.pot += room.bet;
  return result;
}

async function addPlayer(req, room) {
  const existing = room.players.find((player) => player.uid === uidOf(req));
  if (existing) {
    existing.connected = true;
    existing.lastSeenAt = now();
    return { ok: true, player: existing, alreadyJoined: true };
  }
  if (room.players.length >= room.maxPlayers) return { ok: false, status: 409, error: 'ROOM_FULL' };
  const player = await buildPlayer(req);
  const charged = await chargePlayer(room, player);
  if (!charged.ok) return { ...charged, status: 409 };
  room.players.push(player);
  room.updatedAt = now();
  room.stateVersion += 1;
  return { ok: true, player, balance: charged.balance };
}

function dealIfReady(room) {
  if (room.status === 'playing' || room.status === 'finished') return;
  if (room.players.length < room.maxPlayers) return;
  room.status = 'playing';
  for (const player of room.players) player.hand = room.deck.splice(0, 4);
  room.tableCards = room.deck.splice(0, 4);
  room.turn = 0;
  room.updatedAt = now();
  room.stateVersion += 1;
  room.lastEvent = { type: 'deal', ts: now(), at: now() };
}

async function settleRoom(room) {
  if (room.status !== 'finished') return;
  const winners = winnerUids(room);
  const amount = room.bet > 0 && winners.length > 0 ? Math.floor(room.pot / winners.length) : 0;
  if (amount > 0) {
    for (const winnerUid of winners) {
      await creditBalance({ uid: winnerUid, amount, reason: 'pisti-win', idempotencyKey: `pisti:win:${room.id}:${winnerUid}` }).catch(() => null);
    }
  }
  room.resultSummary = { amount, winners, settledAt: now() };
}

async function finishRoom(room, reason = 'finished') {
  if (room.status === 'finished') return;
  if (room.pileOwner >= 0 && room.tableCards.length) room.scores[room.pileOwner] += room.tableCards.length;
  room.tableCards = [];
  room.status = 'finished';
  room.finishReason = reason;
  room.winner = winnerUids(room);
  room.updatedAt = now();
  room.stateVersion += 1;
  await settleRoom(room);
}

router.get('/lobby', (_req, res) => {
  res.json({ ok: true, rooms: [...rooms.values()].filter((room) => room.status !== 'finished').map(publicLobbyRoom), at: now() });
});

router.post('/play-open', requireAuth, asyncRoute(async (req, res) => {
  const bet = clampBet(req.body?.bet);
  const maxPlayers = maxPlayersFromMode(req.body?.mode);
  let room = [...rooms.values()].find((item) => !item.password && item.status === 'waiting' && item.bet === bet && item.maxPlayers === maxPlayers && item.players.length < item.maxPlayers);
  if (!room) {
    room = createRoomShell(req, { ...req.body, bet });
    rooms.set(room.id, room);
  }
  const joined = await addPlayer(req, room);
  if (!joined.ok) {
    if (!room.players.length) rooms.delete(room.id);
    return res.status(joined.status || 409).json(joined);
  }
  dealIfReady(room);
  emitRoom(room);
  emitLobby();
  res.json({ ok: true, room: publicRoom(room, uidOf(req)), balance: joined.balance });
}));

router.post('/create-private', requireAuth, asyncRoute(async (req, res) => {
  const room = createRoomShell(req, req.body || {});
  rooms.set(room.id, room);
  const joined = await addPlayer(req, room);
  if (!joined.ok) {
    rooms.delete(room.id);
    return res.status(joined.status || 409).json(joined);
  }
  emitLobby();
  res.json({ ok: true, room: publicRoom(room, uidOf(req)), balance: joined.balance });
}));

router.post('/join', requireAuth, asyncRoute(async (req, res) => {
  const room = rooms.get(String(req.body?.roomId || ''));
  if (!room) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  if (room.password && safeText(req.body?.password || '', 80) !== room.password) return res.status(403).json({ ok: false, error: 'ROOM_PASSWORD_REQUIRED' });
  if (room.status === 'finished') return res.status(409).json({ ok: false, error: 'ROOM_FINISHED' });
  const joined = await addPlayer(req, room);
  if (!joined.ok) return res.status(joined.status || 409).json(joined);
  dealIfReady(room);
  emitRoom(room);
  emitLobby();
  res.json({ ok: true, room: publicRoom(room, uidOf(req)), balance: joined.balance });
}));

router.get('/state/:roomId', requireAuth, (req, res) => {
  const room = rooms.get(String(req.params.roomId || ''));
  if (!room) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  if (!room.players.some((player) => player.uid === uidOf(req))) return res.status(403).json({ ok: false, error: 'NOT_IN_ROOM' });
  res.json({ ok: true, room: publicRoom(room, uidOf(req)) });
});

router.post('/ping', requireAuth, (req, res) => {
  const room = rooms.get(String(req.body?.roomId || ''));
  if (!room) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  const player = room.players.find((item) => item.uid === uidOf(req));
  if (!player) return res.status(403).json({ ok: false, error: 'NOT_IN_ROOM' });
  player.connected = true;
  player.lastSeenAt = now();
  room.updatedAt = now();
  res.json({ ok: true, room: publicRoom(room, uidOf(req)) });
});

router.post('/play', requireAuth, asyncRoute(async (req, res) => {
  const room = rooms.get(String(req.body?.roomId || ''));
  if (!room) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
  if (room.status !== 'playing') return res.status(409).json({ ok: false, error: 'ROOM_NOT_PLAYING', room: publicRoom(room, uidOf(req)) });
  const playerIndex = room.players.findIndex((player) => player.uid === uidOf(req));
  if (playerIndex < 0) return res.status(403).json({ ok: false, error: 'NOT_IN_ROOM' });
  if (playerIndex !== room.turn) return res.status(409).json({ ok: false, error: 'NOT_YOUR_TURN', room: publicRoom(room, uidOf(req)) });
  const expectedStateVersion = Math.trunc(Number(req.body?.expectedStateVersion) || 0);
  if (expectedStateVersion && expectedStateVersion !== room.stateVersion) {
    return res.status(409).json({ ok: false, error: 'STATE_VERSION_MISMATCH', room: publicRoom(room, uidOf(req)) });
  }
  const token = safeText(req.body?.cardToken || '', 20);
  const hand = room.players[playerIndex].hand;
  const cardIndex = token ? hand.indexOf(token) : Math.trunc(Number(req.body?.cardIndex) || -1);
  if (cardIndex < 0 || cardIndex >= hand.length) return res.status(400).json({ ok: false, error: 'CARD_NOT_IN_HAND', room: publicRoom(room, uidOf(req)) });
  const cardToken = hand.splice(cardIndex, 1)[0];
  const tableBefore = room.tableCards.slice();
  room.tableCards.push(cardToken);
  const previousTop = tableBefore[tableBefore.length - 1] || '';
  const rank = cardToken.replace(/[SHDC]$/i, '');
  const previousRank = previousTop.replace(/[SHDC]$/i, '');
  if (previousTop && (rank === previousRank || rank === 'J')) {
    const gained = room.tableCards.length;
    room.scores[playerIndex] += gained;
    room.tableCards = [];
    room.pileOwner = playerIndex;
    room.lastEvent = { type: gained === 2 ? 'pisti' : 'capture', uid: uidOf(req), seat: playerIndex, points: gained, card: cardToken, tableBefore, ts: now(), at: now() };
  } else {
    room.lastEvent = { type: 'play', uid: uidOf(req), seat: playerIndex, card: cardToken, ts: now(), at: now() };
  }
  if (room.players.every((player) => !player.hand.length)) {
    if (room.deck.length >= room.players.length * 4) {
      for (const player of room.players) player.hand = room.deck.splice(0, 4);
      room.lastEvent = { type: 'deal', ts: now(), at: now() };
    } else {
      await finishRoom(room, 'deck-empty');
    }
  }
  if (room.status !== 'finished') room.turn = (room.turn + 1) % room.players.length;
  room.updatedAt = now();
  room.stateVersion += 1;
  emitRoom(room);
  emitLobby();
  res.json({ ok: true, room: publicRoom(room, uidOf(req)) });
}));

router.post('/leave', requireAuth, asyncRoute(async (req, res) => {
  const room = rooms.get(String(req.body?.roomId || ''));
  if (!room) return res.json({ ok: true });
  const playerIndex = room.players.findIndex((player) => player.uid === uidOf(req));
  if (playerIndex < 0) return res.json({ ok: true });
  if (room.status === 'playing') {
    room.players.splice(playerIndex, 1);
    if (room.players.length) {
      room.winner = room.players.map((player) => player.uid);
      room.status = 'finished';
      room.finishReason = 'leave';
      room.updatedAt = now();
      room.stateVersion += 1;
      await settleRoom(room);
      emitRoom(room);
    } else {
      rooms.delete(room.id);
    }
  } else {
    room.players.splice(playerIndex, 1);
    if (!room.players.length) rooms.delete(room.id);
    else {
      room.updatedAt = now();
      room.stateVersion += 1;
      emitRoom(room);
    }
  }
  emitLobby();
  res.json({ ok: true });
}));

async function authenticatePistiSocket(socket) {
  try {
    if (socket.data?.pistiUid) return true;
    const token = String(socket.handshake?.auth?.token || '').trim();
    if (!token) return false;
    const { auth } = initFirebaseAdmin();
    if (!auth) return false;
    const decoded = await auth.verifyIdToken(token);
    socket.data.pistiUid = String(decoded.uid || '');
    if (socket.data.pistiUid) socket.join(`pisti:user:${socket.data.pistiUid}`);
    return !!socket.data.pistiUid;
  } catch (_) {
    socket.data.pistiUid = '';
    socket.emit('pisti:auth_error', { ok: false, error: 'INVALID_AUTH_TOKEN' });
    return false;
  }
}

function installSocket(io) {
  ioRef = io;
  io.on('connection', (socket) => {
    socket.on('pisti:lobby:subscribe', (_payload, ack) => {
      socket.join('pisti:lobby');
      const payload = { ok: true, rooms: [...rooms.values()].filter((room) => room.status !== 'finished').map(publicLobbyRoom), at: now() };
      if (typeof ack === 'function') ack(payload);
      socket.emit('pisti:lobby', payload);
    });
    socket.on('pisti:join', async (id, ack) => {
      if (!(await authenticatePistiSocket(socket))) {
        if (typeof ack === 'function') ack({ ok: false, error: 'AUTH_REQUIRED' });
        return;
      }
      const room = rooms.get(String(id || ''));
      if (!room || !room.players.some((player) => player.uid === socket.data.pistiUid)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'NOT_IN_ROOM' });
        return;
      }
      socket.join(`pisti:${room.id}`);
      socket.join(`pisti:user:${socket.data.pistiUid}`);
      const payload = { ok: true, room: publicRoom(room, socket.data.pistiUid) };
      if (typeof ack === 'function') ack(payload);
      socket.emit('pisti:update', { ...payload, id: room.id, stateVersion: room.stateVersion, at: now() });
    });
    socket.on('pisti:leave', async (id, ack) => {
      if (await authenticatePistiSocket(socket)) socket.leave(`pisti:${String(id || '')}`);
      if (typeof ack === 'function') ack({ ok: true });
    });
  });
}

setInterval(() => {
  const cutoff = now() - ROOM_TTL_MS;
  for (const [key, room] of rooms) {
    if (room.updatedAt < cutoff) rooms.delete(key);
  }
  emitLobby();
}, 60_000).unref();

module.exports = { router, installSocket, _rooms: rooms };
