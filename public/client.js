const socket = io();

// Random id of this tab: lets the server recognize us after a reconnect
const playerId = Math.random().toString(36).slice(2, 10);

let roomCode = new URLSearchParams(location.search).get('room');
let myName = '';
let joined = false;

const statusEl = document.getElementById('status');
const joinScreen = document.getElementById('join-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const nameInput = document.getElementById('name-input');
const joinButton = document.getElementById('join-button');
const joinError = document.getElementById('join-error');
const roomCodeEl = document.getElementById('room-code');
const copyLinkButton = document.getElementById('copy-link');
const playerList = document.getElementById('player-list');

function showScreen(screen) {
  for (const s of [joinScreen, lobbyScreen]) {
    s.hidden = s !== screen;
  }
}

function updateJoinButton() {
  joinButton.textContent = roomCode ? `Join room ${roomCode}` : 'Create room';
}

function joinOrCreate() {
  if (roomCode) {
    socket.emit('join_room', { playerId, name: myName, code: roomCode }, handleResponse);
  } else {
    socket.emit('create_room', { playerId, name: myName }, handleResponse);
  }
}

function handleResponse(res) {
  if (!res.error) return;

  // The room is gone or closed: forget it so the player can create a new one
  joined = false;
  roomCode = null;
  history.replaceState(null, '', location.pathname);
  updateJoinButton();
  joinButton.disabled = false;
  joinError.textContent = res.error;
  showScreen(joinScreen);
}

joinButton.addEventListener('click', () => {
  myName = nameInput.value.trim();
  if (!myName) {
    joinError.textContent = 'Enter your name';
    return;
  }
  joinError.textContent = '';
  joinButton.disabled = true; // a double tap won't send two requests
  joinOrCreate();
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinButton.click();
});

copyLinkButton.addEventListener('click', async () => {
  const link = `${location.origin}/?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    copyLinkButton.textContent = 'Copied!';
    setTimeout(() => {
      copyLinkButton.textContent = 'Copy link';
    }, 1500);
  } catch {
    prompt('Copy the link:', link);
  }
});

socket.on('connect', () => {
  statusEl.textContent = 'Connected';
  // After a reconnect the server sees a new socket, so join the room again
  if (joined) joinOrCreate();
});

socket.on('disconnect', () => {
  statusEl.textContent = 'Disconnected, reconnecting…';
});

socket.on('room_state', (room) => {
  joined = true;
  roomCode = room.code;
  history.replaceState(null, '', `?room=${room.code}`);

  roomCodeEl.textContent = room.code;
  playerList.replaceChildren();
  for (const [id, player] of Object.entries(room.players)) {
    const li = document.createElement('li');
    li.textContent = player.name;
    if (id === room.hostId) li.textContent += ' 👑';
    if (id === playerId) li.textContent += ' (you)';
    playerList.append(li);
  }
  showScreen(lobbyScreen);
});

updateJoinButton();


// Set of words (for one player)

const TEXTS = [
  'Моя сім’я щосуботи п’є чай із м’ятою — така в нас давня традиція.',
  'Кіт сказав: «Я не лінивий, я просто економлю енергію на важливі справи».',
  'Рудий лис перестрибнув через паркан, сів на пеньок і довго думав, навіщо він це зробив.',
];

const textEl = document.getElementById('text');
const inputEl = document.getElementById('input');
const statsEl = document.getElementById('stats');
const restartEl = document.getElementById('restart');

let words = []; // current text words
let wordEls = []; // <span> for each word
let wordIndex = 0; // current word index
let typedChars = 0; // total correctly typed chars 
let startTime = null; // first keypress time

function normalizeChars(str) {
  return str
    .replace(/[\u2018\u2019\u02BC`]/g, "'")            // ‘ ’ ʼ `
    .replace(/[\u2011\u2013\u2014]/g, '-')             // ‑ – —
    .replace(/[\u00AB\u00BB\u201C\u201D\u201E]/g, '"') // « » “ ” „
    .replace(/\u2026/g, '...')                         // …
    .replace(/\u00A0/g, ' ');                          // non-breaking space
}

function normalizeText(str) {
    return normalizeChars(str)
        .replace(/\s+/g, ' ') // collapse whitespace
        .trim();
}

function targetFor(i) {
    return i < words.length - 1 ? words[i] + ' ' : words[i];
}

function speed() {
    const minutes = (Date.now() - startTime) / 60000; 
    return Math.round(typedChars / minutes);
}

function render() {
    wordEls.forEach((el, i) => {
        el.className = i < wordIndex ? 'done' : i === wordIndex ? 'current' : '';
    });
}

function startGame() {
    const text = TEXTS[Math.floor(Math.random() * TEXTS.length)];
    words = normalizeText(text).split(' ');
    wordIndex = 0;
    typedChars = 0;
    startTime = null;

    wordEls = words.map((word) => {
        const span = document.createElement('span');
        span.textContent = word;
        return span;
    });

    textEl.replaceChildren();
    wordEls.forEach((span, i) => {
        if(i > 0) textEl.append(' ');
        textEl.append(span);
    });

    inputEl.value = '';
    inputEl.disabled = false;
    inputEl.classList.remove('error');
    statsEl.textContent = '';
    render();
    inputEl.focus();
}

function finishGame() {
    const seconds = Math.round((Date.now() - startTime) / 1000);
    inputEl.value = '';
    inputEl.disabled = true;
    inputEl.classList.remove('error');
    render();
    statsEl.textContent = `Finished in ${seconds} seconds, speed: ${speed()} chars/min`;
}

inputEl.addEventListener('input', () => {
    if(startTime === null) startTime = Date.now();

    let value = normalizeChars(inputEl.value);
    let wordDone = false;

    while (wordIndex < words.length && value.startsWith(targetFor(wordIndex))) {
        const target = targetFor(wordIndex);
        typedChars += target.length;
        value = value.slice(target.length);
        wordIndex++;
        wordDone = true;
    }

    if(wordIndex === words.length) { 
        finishGame();
        return;
    }

    if(wordDone) {
        inputEl.value = value;
        statsEl.textContent = `Speed: ${speed()} chars/min`;
        render();
    }

    inputEl.classList.toggle('error', !targetFor(wordIndex).startsWith(value));
});

restartEl.addEventListener('click', startGame);

startGame();
