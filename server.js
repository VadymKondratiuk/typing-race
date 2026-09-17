const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const deleteTimers = {}; // kept outside rooms: timers can't be sent over a socket

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I and O, easy to read aloud
const EMPTY_ROOM_TTL = 5 * 60 * 1000; // an empty room waits 5 minutes before deletion

const COUNTDOWN_SECONDS = 3;

// Same normalization as on the client: players get text that can be typed as is
function normalizeChars(str) {
  return str
    .replace(/[\u2018\u2019\u02BC`]/g, "'")            // ‘ ’ ʼ `
    .replace(/[\u2011\u2013\u2014]/g, '-')             // ‑ – —
    .replace(/[\u00AB\u00BB\u201C\u201D\u201E]/g, '"') // « » “ ” „
    .replace(/\u2026/g, '...')                         // …
    .replace(/\u00A0/g, ' ');                          // non-breaking space
}

function normalizeText(str) {
  return normalizeChars(str).replace(/\s+/g, ' ').trim();
}

const TEXTS = require('./texts.json').map(normalizeText);

function createRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    }
  } while (rooms[code]);
  return code;
}

function cleanName(name) {
  return String(name ?? '').trim().slice(0, 20);
}

// Send the full room state to everyone in the room
function sendRoomState(code) {
  io.to(code).emit('room_state', { code, ...rooms[code] });
}

function addPlayer(socket, code, playerId, name) {
  const room = rooms[code];

  if (room.players[playerId]) {
    // The same player came back with a new connection
    room.players[playerId].socketId = socket.id;
  } else {
    room.players[playerId] = {
      name,
      socketId: socket.id,
      progress: 0,
      finishedAt: null,
      speed: null,
    };
  }
  if (!room.players[room.hostId]) room.hostId = playerId;

  socket.data.roomCode = code;
  socket.data.playerId = playerId;
  socket.join(code);

  clearTimeout(deleteTimers[code]);
  delete deleteTimers[code];
}

io.on('connection', (socket) => {
  socket.on('create_room', (data, callback) => {
    const name = cleanName(data?.name);
    if (!name) return callback({ error: 'Enter your name' });
    if (socket.data.roomCode) return callback({ error: 'You are already in a room' });

    const code = createRoomCode();
    rooms[code] = {
      hostId: null, // addPlayer makes the creator the host
      status: 'lobby',
      text: '',
      startedAt: null,
      players: {},
    };
    addPlayer(socket, code, data.playerId, name);
    console.log(`${name} created room ${code}`);

    callback({});
    sendRoomState(code);
  });

  socket.on('join_room', (data, callback) => {
    const name = cleanName(data?.name);
    const code = String(data?.code ?? '').toUpperCase();
    const room = rooms[code];

    if (!name) return callback({ error: 'Enter your name' });
    if (socket.data.roomCode) return callback({ error: 'You are already in a room' });
    if (!room) return callback({ error: 'Room not found' });
    if (room.status !== 'lobby' && !room.players[data.playerId]) {
      return callback({ error: 'The race has already started' });
    }

    addPlayer(socket, code, data.playerId, name);
    console.log(`${name} joined room ${code}`);

    callback({});
    sendRoomState(code);
  });

  socket.on('start_race', () => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];

    // Only the host can start, and only from the lobby
    if (!room || room.hostId !== playerId || room.status !== 'lobby') return;

    room.status = 'countdown';
    room.countdown = COUNTDOWN_SECONDS;
    room.text = TEXTS[Math.floor(Math.random() * TEXTS.length)];
    room.startedAt = null;
    for (const player of Object.values(room.players)) {
      player.progress = 0;
      player.finishedAt = null;
      player.speed = null;
    }
    console.log(`Race started in room ${roomCode}`);
    sendRoomState(roomCode);

    const timer = setInterval(() => {
      room.countdown--;
      if (room.countdown === 0) {
        clearInterval(timer);
        room.status = 'racing';
        room.startedAt = Date.now();
      }
      sendRoomState(roomCode);
    }, 1000);
  });

  socket.on('progress', (data) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    const player = room?.players[playerId];
    if (!player || room.status !== 'racing') return;

    // A whole number that only grows and can't go past the end of the text
    const progress = data?.progress;
    if (!Number.isInteger(progress) || progress <= player.progress || progress > room.text.length) {
      return;
    }

    player.progress = progress;
    sendRoomState(roomCode);
  });

  socket.on('disconnect', () => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    const player = room?.players[playerId];

    // Not in a room, or this player has already reconnected with a new socket
    if (!player || player.socketId !== socket.id) return;

    if (room.status === 'lobby') {
      delete room.players[playerId];
      console.log(`${player.name} left room ${roomCode}`);
    } else {
      // During a race keep the player and their progress: they may come back
      player.socketId = null;
      console.log(`${player.name} disconnected during a race in room ${roomCode}`);
    }

    const onlineIds = Object.keys(room.players).filter((id) => room.players[id].socketId);
    if (onlineIds.length === 0) {
      deleteTimers[roomCode] = setTimeout(() => {
        delete rooms[roomCode];
        delete deleteTimers[roomCode];
      }, EMPTY_ROOM_TTL);
      return;
    }

    if (!room.players[room.hostId]) room.hostId = onlineIds[0];
    sendRoomState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});