const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

const rooms = new Map();
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

app.get("/", (_req, res) => res.send("Tap Race multiplayer server is running."));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
}
function updateRoom(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("room-update", { code, players: publicPlayers(room) });
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) rooms.delete(code);
  else {
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    updateRoom(code);
  }
}
io.on("connection", socket => {
  socket.on("create-room", (_data, cb) => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { code, hostId: socket.id, players: new Map(), started: false, taps: new Map() };
    room.players.set(socket.id, { id: socket.id, name: `Player 1` });
    rooms.set(code, room);
    socket.join(code); socket.data.roomCode = code;
    cb?.({ ok: true, code, playerId: socket.id });
    updateRoom(code);
  });

  socket.on("join-room", ({ code } = {}, cb) => {
    const room = rooms.get(String(code || ""));
    if (!room) return cb?.({ ok: false, error: "Room not found. Check the code." });
    if (room.started) return cb?.({ ok: false, error: "That race has already started." });
    if (room.players.size >= MAX_PLAYERS) return cb?.({ ok: false, error: "That room is full (4 players maximum)." });
    leaveRoom(socket);
    const name = `Player ${room.players.size + 1}`;
    room.players.set(socket.id, { id: socket.id, name });
    socket.join(room.code); socket.data.roomCode = room.code;
    cb?.({ ok: true, code: room.code, playerId: socket.id });
    updateRoom(room.code);
  });

  socket.on("start-race", ({ code } = {}, cb) => {
    const room = rooms.get(String(code || ""));
    if (!room || socket.id !== room.hostId) return cb?.({ ok: false, error: "Only the room host can start." });
    if (room.started) return cb?.({ ok: false, error: "The race has already started." });
    room.started = true;
    room.taps = new Map([...room.players.keys()].map(id => [id, 0]));
    room.startedAt = Date.now() + 3500;
    io.to(room.code).emit("race-start", { players: publicPlayers(room), startsAt: room.startedAt });
    cb?.({ ok: true });
  });

  socket.on("player-tap", ({ code } = {}) => {
    const room = rooms.get(String(code || ""));
    if (!room || !room.started || !room.taps.has(socket.id)) return;
    const n = Math.min(300, (room.taps.get(socket.id) || 0) + 1);
    room.taps.set(socket.id, n);
    io.to(room.code).emit("race-state", { players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, taps: room.taps.get(p.id) || 0
    })) });
    if (n >= 300) finishIfDone(room);
  });

  socket.on("player-finish", ({ code } = {}) => {
    const room = rooms.get(String(code || ""));
    if (!room || !room.started || !room.taps.has(socket.id)) return;
    room.taps.set(socket.id, 300);
    finishIfDone(room);
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

function finishIfDone(room) {
  if (![...room.taps.values()].every(n => n >= 300)) return;
  const results = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, taps: room.taps.get(p.id) || 0
  }));
  // Finish order is approximated by server receipt of the 300th tap in a future version.
  results.sort((a, b) => b.taps - a.taps);
  io.to(room.code).emit("race-finished", { results });
  rooms.delete(room.code);
}

server.listen(PORT, () => console.log(`Tap Race server listening on ${PORT}`));
