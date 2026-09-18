const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
// Timers are kept outside rooms: they can't be sent over a socket
const deleteTimers = {};
const raceTimers = {};
const textDecks = {}; // texts each room hasn't played yet (outside rooms, so players can't peek)

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I and O, easy to read aloud
const EMPTY_ROOM_TTL = 5 * 60 * 1000; // an empty room waits 5 minutes before deletion
const COUNTDOWN_SECONDS = 3;
const RACE_TIME_LIMIT = 2 * 60 * 1000; // a race ends after 2 minutes even if not everyone finished
const PLAYER_COLORS = 8; // how many player colors style.css defines

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

const LANGUAGES = ['en', 'uk']; // texts/<code>.json, the first one is the default
const TEXTS = Object.fromEntries(
  LANGUAGES.map((lang) => [lang, require(`./texts/${lang}.json`).map(normalizeText)]),
);

// Texts come in random order and don't repeat until the room has played them all.
// Every language has its own deck, so switching doesn't cut a deck short.
function nextText(code, lang) {
  const decks = (textDecks[code] ??= {});
  if (!decks[lang]?.length) {
    const deck = TEXTS[lang].map((_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    decks[lang] = deck;
  }
  return TEXTS[lang][decks[lang].pop()];
}

// The first color nobody in the room has yet
function freeColor(room) {
  const used = Object.values(room.players).map((p) => p.color);
  for (let i = 0; i < PLAYER_COLORS; i++) {
    if (!used.includes(i)) return i;
  }
  return Object.keys(room.players).length % PLAYER_COLORS;
}

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
      color: freeColor(room),
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

// Everyone who is still connected has finished
function everyoneFinished(room) {
  return Object.values(room.players).every((p) => p.finishedAt || !p.socketId);
}

function endRace(code) {
  const room = rooms[code];
  if (!room || room.status !== 'racing') return;

  clearTimeout(raceTimers[code]);
  delete raceTimers[code];

  // Finished players in the order they finished, then the rest by progress
  const players = Object.values(room.players).sort((a, b) => {
    if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
    if (a.finishedAt) return -1;
    if (b.finishedAt) return 1;
    return b.progress - a.progress;
  });

  room.results = players.map((p) => ({
    name: p.name,
    color: p.color,
    seconds: p.finishedAt ? Math.round((p.finishedAt - room.startedAt) / 100) / 10 : null,
    speed: p.speed,
    percent: Math.round((p.progress / room.text.length) * 100),
  }));

  room.status = 'lobby';
  room.text = '';
  room.startedAt = null;
  console.log(`Race finished in room ${code}`);

  // Players who dropped out during the race leave the room now
  for (const [id, player] of Object.entries(room.players)) {
    if (!player.socketId) delete room.players[id];
  }

  const ids = Object.keys(room.players);
  if (ids.length === 0) return; // nobody is left, the room is already waiting for deletion
  if (!room.players[room.hostId]) room.hostId = ids[0];
  sendRoomState(code);
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
      language: LANGUAGES[0], // the host can change it in the lobby
      text: '',
      startedAt: null,
      results: [], // table of the last race
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
      return callback({ error: 'A race is going on in this room. Try again when it ends', retry: true });
    }

    addPlayer(socket, code, data.playerId, name);
    console.log(`${name} joined room ${code}`);

    callback({});
    sendRoomState(code);
  });

  socket.on('set_language', (data) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    const language = data?.language;

    // Only the host can change the language, and only from the lobby
    if (!room || room.hostId !== playerId || room.status !== 'lobby') return;
    if (!LANGUAGES.includes(language) || language === room.language) return;

    room.language = language;
    console.log(`Room ${roomCode} switched texts to ${language}`);
    sendRoomState(roomCode);
  });

  socket.on('start_race', () => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];

    // Only the host can start, and only from the lobby
    if (!room || room.hostId !== playerId || room.status !== 'lobby') return;

    room.status = 'countdown';
    room.countdown = COUNTDOWN_SECONDS;
    room.text = nextText(roomCode, room.language);
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
        raceTimers[roomCode] = setTimeout(() => endRace(roomCode), RACE_TIME_LIMIT);
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
    if (progress === room.text.length) {
      // The server measures the time itself, so the rules are the same for everyone
      player.finishedAt = Date.now();
      const minutes = (player.finishedAt - room.startedAt) / 60000;
      player.speed = Math.round(room.text.length / minutes);
    }

    if (everyoneFinished(room)) endRace(roomCode);
    else sendRoomState(roomCode);
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
        delete textDecks[roomCode];
      }, EMPTY_ROOM_TTL);
      return;
    }

    if (!room.players[room.hostId]) room.hostId = onlineIds[0];

    // Everyone who is still here may have already finished
    if (room.status === 'racing' && everyoneFinished(room)) endRace(roomCode);
    else sendRoomState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
