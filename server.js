'use strict';
// Tap Race multiplayer server (Socket.IO). Rooms live in memory.
const http = require('http');
const crypto = require('crypto');

const MAX_PLAYERS = 4;     // one lane each
const D = 300;             // taps to finish (must match the client)
const COUNTDOWN_MS = 4000; // server start time = now + this (3s countdown + 1s of slack for slow phones)
const TICK_MS = 100;       // how often race positions are broadcast
const LOBBY_GRACE_MS = 15000;
const RACE_TIMEOUT_MS = 150000;
const MAX_TAPS_PER_SEC = 25; // anything faster is not a human

function attach(io) {
  const rooms = new Map();
  const noop = () => {};
  const reply = cb => (typeof cb === 'function' ? cb : noop);

  function newCode() {
    for (let i = 0; i < 300; i++) {
      const c = String(1000 + Math.floor(Math.random() * 9000));
      if (!rooms.has(c)) return c;
    }
    return null;
  }

  function cleanName(raw, room) {
    let n = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!n) n = 'Player' + (100 + Math.floor(Math.random() * 900));
    const taken = new Set(room ? room.players.map(p => p.name.toLowerCase()) : []);
    let out = n, k = 2;
    while (taken.has(out.toLowerCase())) { const suf = ' ' + k++; out = n.slice(0, 12 - suf.length) + suf; }
    return out;
  }

  const connectedCount = room => room.players.filter(p => p.connected).length;
  const pub = room => room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected }));

  function openRooms() {
    const list = [];
    for (const r of rooms.values()) {
      if (r.status !== 'lobby' || r.isPrivate) continue;
      const n = connectedCount(r);
      if (n === 0 || r.players.length >= MAX_PLAYERS) continue;
      const host = r.players.find(p => p.id === r.hostId) || r.players[0];
      list.push({ code: r.code, host: host ? host.name : 'Player', players: r.players.length, max: MAX_PLAYERS, created: r.created });
    }
    list.sort((a, b) => a.created - b.created);
    return list.map(({ created, ...rest }) => rest);
  }
  const broadcastRooms = () => io.to('browse').emit('rooms-list', openRooms());
  const emitRoom = room => io.to(room.code).emit('room-update', { code: room.code, status: room.status, hostId: room.hostId, players: pub(room) });

  function fixHost(room) {
    if (room.players.some(p => p.id === room.hostId)) return;
    const next = room.players.find(p => p.connected) || room.players[0];
    room.hostId = next ? next.id : null;
  }

  function deleteRoom(room) {
    clearInterval(room.tick); clearTimeout(room.timeout);
    room.players.forEach(p => clearTimeout(p.timer));
    rooms.delete(room.code);
  }

  function removePlayer(room, p, sock) {
    clearTimeout(p.timer);
    const i = room.players.indexOf(p);
    if (i < 0) return;
    room.players.splice(i, 1);
    if (sock) { sock.leave(room.code); sock.data.code = null; sock.data.pid = null; }
    if (room.players.length === 0) { deleteRoom(room); broadcastRooms(); return; }
    fixHost(room);
    emitRoom(room);
    if (room.status === 'racing') checkRaceDone(room);
    broadcastRooms();
  }

  function leaveCurrent(sock) {
    const room = rooms.get(sock.data.code);
    if (!room) { sock.data.code = null; sock.data.pid = null; return; }
    const p = room.players.find(x => x.id === sock.data.pid);
    if (p) removePlayer(room, p, sock);
    else { sock.leave(room.code); sock.data.code = null; sock.data.pid = null; }
  }

  function attachPlayer(sock, room, name) {
    const p = { id: crypto.randomBytes(8).toString('hex'), sid: sock.id, name: cleanName(name, room), connected: true, taps: 0, finishedAt: null, rank: null, time: null, timer: null };
    room.players.push(p);
    sock.leave('browse');
    sock.join(room.code);
    sock.data.code = room.code;
    sock.data.pid = p.id;
    return p;
  }

  function finishPlayer(room, p) {
    p.finishedAt = Date.now();
    p.rank = ++room.finished;
    p.time = (p.finishedAt - room.startsAt) / 1000;
    io.to(room.code).emit('player-finished', { id: p.id, rank: p.rank, time: p.time });
    checkRaceDone(room);
  }

  function checkRaceDone(room) {
    if (room.status !== 'racing') return;
    if (room.players.every(p => p.finishedAt != null || !p.connected)) endRace(room);
  }

  function endRace(room) {
    if (room.status !== 'racing') return;
    clearInterval(room.tick); clearTimeout(room.timeout);
    const results = room.players.slice().sort((a, b) => {
      if (a.finishedAt != null && b.finishedAt != null) return a.rank - b.rank;
      if (a.finishedAt != null) return -1;
      if (b.finishedAt != null) return 1;
      return b.taps - a.taps;
    }).map(p => ({ id: p.id, name: p.name, taps: p.taps, time: p.finishedAt != null ? p.time : null }));
    io.to(room.code).emit('race-state', { players: room.players.map(p => ({ id: p.id, taps: p.taps })) });
    io.to(room.code).emit('race-finished', { code: room.code, results });
    room.status = 'lobby';
    room.finished = 0;
    room.players.filter(p => !p.connected).forEach(p => { clearTimeout(p.timer); room.players.splice(room.players.indexOf(p), 1); });
    room.players.forEach(p => { p.taps = 0; p.finishedAt = null; p.rank = null; p.time = null; });
    if (room.players.length === 0) { deleteRoom(room); broadcastRooms(); return; }
    fixHost(room);
    emitRoom(room);
    broadcastRooms();
  }

  function getCtx(sock, code) {
    const room = rooms.get(sock.data.code);
    if (!room || (code && String(code) !== room.code)) return {};
    const p = room.players.find(x => x.id === sock.data.pid);
    return { room, p };
  }

  io.on('connection', sock => {
    sock.data = sock.data || {};
    sock.data.code = null; sock.data.pid = null;
    const safe = (fn) => (...args) => { try { fn(...args); } catch (e) { console.error('handler error', e); const cb = args[args.length - 1]; if (typeof cb === 'function') cb({ ok: false, error: 'Server error. Try again.' }); } };

    sock.on('time-sync', safe((_, cb) => reply(cb)({ serverNow: Date.now() })));

    sock.on('browse', safe((_, cb) => { sock.join('browse'); reply(cb)({ ok: true, rooms: openRooms() }); }));
    sock.on('unbrowse', safe(() => sock.leave('browse')));

    sock.on('create-room', safe((data, cb) => {
      data = data || {};
      leaveCurrent(sock);
      const code = newCode();
      if (!code) return reply(cb)({ ok: false, error: 'Server is full. Try again in a minute.' });
      const room = { code, hostId: null, isPrivate: !!data.isPrivate, status: 'lobby', players: [], startsAt: 0, finished: 0, created: Date.now(), tick: null, timeout: null };
      rooms.set(code, room);
      const p = attachPlayer(sock, room, data.name);
      room.hostId = p.id;
      reply(cb)({ ok: true, code, playerId: p.id, name: p.name });
      emitRoom(room);
      broadcastRooms();
    }));

    sock.on('join-room', safe((data, cb) => {
      data = data || {};
      const code = String(data.code || '').trim();
      const room = rooms.get(code);
      if (!room) return reply(cb)({ ok: false, error: 'No game with that code. Check the number.' });
      if (room.status !== 'lobby') return reply(cb)({ ok: false, error: 'That race already started. Wait for the next one.' });
      if (room.players.length >= MAX_PLAYERS) return reply(cb)({ ok: false, error: 'That game is full.' });
      leaveCurrent(sock);
      if (!rooms.has(code)) return reply(cb)({ ok: false, error: 'That game just closed.' });
      const p = attachPlayer(sock, room, data.name);
      reply(cb)({ ok: true, code, playerId: p.id, name: p.name });
      emitRoom(room);
      broadcastRooms();
    }));

    // A phone that lost its connection (screen off, app switch) comes back to its seat.
    sock.on('rejoin', safe((data, cb) => {
      data = data || {};
      const room = rooms.get(String(data.code || ''));
      const p = room && room.players.find(x => x.id === data.playerId);
      if (!room || !p) return reply(cb)({ ok: false });
      clearTimeout(p.timer);
      p.sid = sock.id; p.connected = true;
      sock.leave('browse');
      sock.join(room.code);
      sock.data.code = room.code; sock.data.pid = p.id;
      reply(cb)({ ok: true, status: room.status });
      emitRoom(room);
      broadcastRooms();
    }));

    sock.on('leave-room', safe((_, cb) => { leaveCurrent(sock); reply(cb)({ ok: true }); }));

    sock.on('start-race', safe((data, cb) => {
      const { room, p } = getCtx(sock, data && data.code);
      if (!room || !p) return reply(cb)({ ok: false, error: 'You are not in a room.' });
      if (room.hostId !== p.id) return reply(cb)({ ok: false, error: 'Only the host can start the race.' });
      if (room.status !== 'lobby') return reply(cb)({ ok: false, error: 'The race already started.' });
      room.players.filter(x => !x.connected).forEach(x => { clearTimeout(x.timer); room.players.splice(room.players.indexOf(x), 1); });
      if (room.players.length < 2) return reply(cb)({ ok: false, error: 'You need at least 2 players to race.' });
      room.status = 'racing';
      room.finished = 0;
      room.startsAt = Date.now() + COUNTDOWN_MS;
      room.players.forEach(x => { x.taps = 0; x.finishedAt = null; x.rank = null; x.time = null; });
      io.to('browse').emit('rooms-list', openRooms());
      io.to(room.code).emit('race-start', { code: room.code, players: pub(room), startsAt: room.startsAt, serverNow: Date.now(), taps: D });
      clearInterval(room.tick);
      room.tick = setInterval(() => io.to(room.code).emit('race-state', { players: room.players.map(x => ({ id: x.id, taps: x.taps })) }), TICK_MS);
      room.timeout = setTimeout(() => endRace(room), COUNTDOWN_MS + RACE_TIMEOUT_MS);
      reply(cb)({ ok: true });
    }));

    // The client sends its running tap total, so a dropped packet never loses taps.
    sock.on('player-tap', safe((data) => {
      const { room, p } = getCtx(sock, data && data.code);
      if (!room || !p || room.status !== 'racing' || p.finishedAt != null) return;
      const elapsed = Date.now() - room.startsAt;
      if (elapsed < 0) return; // no taps before GO
      let claimed = Math.floor(Number(data.taps));
      if (!Number.isFinite(claimed)) return;
      claimed = Math.min(claimed, D, Math.floor(elapsed / 1000 * MAX_TAPS_PER_SEC) + 8);
      if (claimed > p.taps) p.taps = claimed;
      if (p.taps >= D) finishPlayer(room, p);
    }));

    sock.on('disconnect', safe(() => {
      const room = rooms.get(sock.data.code);
      if (!room) return;
      const p = room.players.find(x => x.id === sock.data.pid);
      if (!p || p.sid !== sock.id) return;
      p.connected = false;
      emitRoom(room);
      broadcastRooms();
      if (room.status === 'racing') { checkRaceDone(room); return; }
      p.timer = setTimeout(() => { if (!p.connected && rooms.get(room.code) === room) removePlayer(room, p, null); }, LOBBY_GRACE_MS);
    }));
  });

  return { rooms };
}

module.exports = { attach, D, MAX_PLAYERS };

if (require.main === module) {
  const { Server } = require('socket.io');
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Tap Race server is running');
  });
  const io = new Server(httpServer, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 20000 });
  attach(io);
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => console.log('Tap Race server listening on ' + PORT));
}
