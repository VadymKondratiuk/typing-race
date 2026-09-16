const socket = io();

const statusEl = document.getElementById('status');
const onlineEl = document.getElementById('online');

socket.on('connect', () => {
    statusEl.textContent = 'Connected';
})

socket.on('disconnect', () => {
    statusEl.textContent = 'Disconnected, trying to reconnect...';
})

socket.on('online', (online) => {
    onlineEl.textContent = `Online: ${online}`;
})
