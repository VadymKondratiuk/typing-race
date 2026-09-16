const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let online = 0;

io.on('connection', (socket) => {
    online++;
    console.log(`- ${socket.id} (online: ${online})`);
    io.emit('online', online);

    socket.on('disconnect', () => {
        online--;
        console.log(`- ${socket.id} (online: ${online})`);
        io.emit('online', online);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});