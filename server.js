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

  socket.on('disconnect', () => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    const player = room?.players[playerId];

    // Not in a room, or this player has already reconnected with a new socket
    if (!player || player.socketId !== socket.id) return;

    delete room.players[playerId];
    console.log(`${player.name} left room ${roomCode}`);

    const ids = Object.keys(room.players);
    if (ids.length === 0) {
      deleteTimers[roomCode] = setTimeout(() => {
        delete rooms[roomCode];
        delete deleteTimers[roomCode];
      }, EMPTY_ROOM_TTL);
      return;
    }

    if (room.hostId === playerId) room.hostId = ids[0];
    sendRoomState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});