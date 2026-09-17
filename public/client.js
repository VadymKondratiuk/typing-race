const socket = io();

// Random id of this tab: lets the server recognize us after a reconnect
const playerId = Math.random().toString(36).slice(2, 10);

let roomCode = new URLSearchParams(location.search).get('room');
let myName = '';
let joined = false;
let lastStatus = null; // room status from the previous room_state

const statusEl = document.getElementById('status');
const joinScreen = document.getElementById('join-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const raceScreen = document.getElementById('race-screen');
const nameInput = document.getElementById('name-input');
const joinButton = document.getElementById('join-button');
const joinError = document.getElementById('join-error');
const roomCodeEl = document.getElementById('room-code');
const copyLinkButton = document.getElementById('copy-link');
const resultsBox = document.getElementById('results');
const resultsBody = document.getElementById('results-body');
const playerList = document.getElementById('player-list');
const startButton = document.getElementById('start-button');
const waitingText = document.getElementById('waiting-text');
const racePlayers = document.getElementById('race-players');

const lanes = new Map(); // playerId -> lane <li>, reused so the cars move smoothly

function showScreen(screen) {
  for (const s of [joinScreen, lobbyScreen, raceScreen]) {
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
  if (!res.error) {
    // Rejoined during a race: the server may have missed our last words
    if (lastStatus === 'racing') socket.emit('progress', { progress: typedChars });
    return;
  }

  joined = false;
  lastStatus = null;
  if (!res.retry) {
    // The room is gone: forget it so the player can create a new one
    roomCode = null;
    history.replaceState(null, '', location.pathname);
    updateJoinButton();
  }
  joinButton.disabled = false;
  joinError.textContent = res.error;
  showScreen(joinScreen);
}

// A small race car in the player's color (the colors live in style.css)
const CAR_SVG = `<svg viewBox="0 0 36 18" aria-hidden="true">
  <circle class="wheel" cx="10" cy="14.2" r="3.3"/>
  <circle class="wheel" cx="26" cy="14.2" r="3.3"/>
  <path class="body" d="M2 13.5V9c0-1.4.9-2 2.2-2H10l3.4-4.5h9L25.8 7H31c2 0 3 1.3 3 3v3.5z"/>
  <path class="window" d="M14.2 3.9h7.5l2.4 3.1H11.8z"/>
</svg>`;

function createCar(color) {
  const car = document.createElement('span');
  car.className = `car color-${color}`;
  car.innerHTML = CAR_SVG;
  return car;
}

function createTag(text, extraClass = '') {
  const tag = document.createElement('span');
  tag.className = `tag ${extraClass}`.trim();
  tag.textContent = text;
  return tag;
}

function renderResults(results) {
  resultsBox.hidden = results.length === 0;
  resultsBody.replaceChildren();

  results.forEach((r, i) => {
    const finished = r.seconds !== null;
    const tr = document.createElement('tr');
    if (finished && i === 0) tr.className = 'winner';

    const placeCell = document.createElement('td');
    placeCell.textContent = finished ? i + 1 : '—';

    const playerCell = document.createElement('td');
    const player = document.createElement('span');
    player.className = 'player-cell';
    player.append(createCar(r.color), r.name);
    playerCell.append(player);

    // Time on top, speed below it: the table stays narrow enough for a phone
    const resultCell = document.createElement('td');
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = finished ? `${r.speed} chars/min` : `${r.percent}% typed`;
    resultCell.append(finished ? `${r.seconds} s` : "Didn't finish", detail);

    tr.append(placeCell, playerCell, resultCell);
    resultsBody.append(tr);
  });
}

function renderLobby(room) {
  roomCodeEl.textContent = room.code;
  renderResults(room.results);

  playerList.replaceChildren();
  for (const [id, player] of Object.entries(room.players)) {
    const li = document.createElement('li');
    li.append(createCar(player.color), player.name);
    if (id === room.hostId) {
      const crown = document.createElement('span');
      crown.textContent = '👑';
      crown.title = 'Host';
      li.append(crown);
    }
    if (id === playerId) li.append(createTag('you'));
    playerList.append(li);
  }

  const isHost = room.hostId === playerId;
  startButton.hidden = !isHost;
  waitingText.hidden = isHost;
}

function renderRacePlayers(room) {
  // Remove lanes of players who have left the room
  for (const [id, lane] of lanes) {
    if (!room.players[id]) {
      lane.remove();
      lanes.delete(id);
    }
  }

  for (const [id, player] of Object.entries(room.players)) {
    let lane = lanes.get(id);
    if (!lane) {
      lane = document.createElement('li');
      lane.innerHTML = '<div class="lane-head"></div><div class="lane-track"></div>';
      lane.querySelector('.lane-track').append(createCar(player.color));
      lanes.set(id, lane);
    }

    const head = lane.querySelector('.lane-head');
    head.replaceChildren(player.name);
    if (id === playerId) head.append(createTag('you'));
    if (!player.socketId) head.append(createTag('offline', 'muted'));
    if (player.finishedAt) {
      const info = document.createElement('span');
      info.className = 'lane-info';
      info.textContent = `${player.speed} chars/min`;
      head.append(info);
    }

    const car = lane.querySelector('.car');
    car.className = `car color-${player.color}`;
    car.style.setProperty('--progress', player.progress / room.text.length);

    racePlayers.append(lane); // an existing lane just moves, so the order stays the same
  }
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

startButton.addEventListener('click', () => {
  socket.emit('start_race');
});

socket.on('connect', () => {
  statusEl.textContent = 'Connected';
  statusEl.dataset.state = 'online';
  // After a reconnect the server sees a new socket, so join the room again
  if (joined) joinOrCreate();
});

socket.on('disconnect', () => {
  statusEl.textContent = 'Reconnecting…';
  statusEl.dataset.state = 'offline';
});

socket.on('room_state', (room) => {
  joined = true;
  roomCode = room.code;
  history.replaceState(null, '', `?room=${room.code}`);

  if (room.status === 'lobby') {
    renderLobby(room);
    showScreen(lobbyScreen);
  } else {
    // We've just come from the lobby: a new race, show its text and empty lanes
    if (lastStatus !== 'countdown' && lastStatus !== 'racing') {
      setupRace(room.text);
      lanes.clear();
      racePlayers.replaceChildren();
    }

    if (room.status === 'countdown') {
      statsEl.textContent = `Starting in ${room.countdown}…`;
      setLights(lightEls.length + 1 - room.countdown);
    }
    if (room.status === 'racing' && lastStatus !== 'racing') beginRace();

    renderRacePlayers(room);
    showScreen(raceScreen);
  }

  lastStatus = room.status;
});

updateJoinButton();

// ---------- Typing ----------

const textEl = document.getElementById('text');
const inputEl = document.getElementById('input');
const statsEl = document.getElementById('stats');
const lightEls = document.querySelectorAll('#lights span');

let words = []; // current text words
let wordEls = []; // <span> for each word
let wordIndex = 0; // current word index
let typedChars = 0; // total correctly typed chars
let startTime = null; // race start time, null before the start

function normalizeChars(str) {
  return str
    .replace(/[\u2018\u2019\u02BC`]/g, "'")            // ‘ ’ ʼ `
    .replace(/[\u2011\u2013\u2014]/g, '-')             // ‑ – —
    .replace(/[\u00AB\u00BB\u201C\u201D\u201E]/g, '"') // « » “ ” „
    .replace(/\u2026/g, '...')                         // …
    .replace(/\u00A0/g, ' ');                          // non-breaking space
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

// Light up the first `lit` lights, or turn all of them green
function setLights(lit, go = false) {
  lightEls.forEach((light, i) => {
    light.className = go ? 'go' : i < lit ? 'on' : '';
  });
}

// New race: show the text; typing is ignored until the start
function setupRace(text) {
  words = text.split(' ');
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
    if (i > 0) textEl.append(' ');
    textEl.append(span);
  });

  inputEl.value = '';
  inputEl.placeholder = 'Type the highlighted word';
  inputEl.disabled = false; // can be tapped during the countdown to open the phone keyboard
  inputEl.classList.remove('error');
  statsEl.textContent = '';
  setLights(0);
  render();
}

function beginRace() {
  startTime = Date.now();
  inputEl.value = '';
  inputEl.focus();
  statsEl.textContent = 'Go!';
  setLights(0, true);
}

function finishRace() {
  inputEl.value = '';
  inputEl.disabled = true;
  inputEl.classList.remove('error');
  render();
  statsEl.textContent = 'Finished! Waiting for the others…';
}

// The text has to be typed: pasting or dragging it into the field does nothing
inputEl.addEventListener('paste', (e) => e.preventDefault());
inputEl.addEventListener('drop', (e) => e.preventDefault());

inputEl.addEventListener('input', () => {
  // Before the start typing doesn't count
  if (startTime === null) {
    inputEl.value = '';
    return;
  }

  let value = normalizeChars(inputEl.value);
  let wordDone = false;

  while (wordIndex < words.length && value.startsWith(targetFor(wordIndex))) {
    const target = targetFor(wordIndex);
    typedChars += target.length;
    value = value.slice(target.length);
    wordIndex++;
    wordDone = true;
  }

  // Send the total, not the increment: a lost message can't break the count
  if (wordDone) socket.emit('progress', { progress: typedChars });

  if (wordIndex === words.length) {
    finishRace();
    return;
  }

  if (wordDone) {
    inputEl.value = value;
    inputEl.placeholder = '';
    statsEl.textContent = `Speed: ${speed()} chars/min`;
    render();
  }

  inputEl.classList.toggle('error', !targetFor(wordIndex).startsWith(value));
});
