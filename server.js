const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 5000,
  pingInterval: 2000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/three/build', express.static(path.join(__dirname, 'node_modules/three/build')));
app.use('/three/examples/jsm', express.static(path.join(__dirname, 'node_modules/three/examples/jsm')));

const lobbies = new Map(); // lobbyId -> lobby object
const playerToLobby = new Map(); // socketId -> lobbyId

function generateCode() {
  return (100000 + crypto.randomInt(900000)).toString();
}

function createLobby(hostId, hostName, isPublic) {
  const code = generateCode();
  const id = uuidv4();
  const lobby = {
    id,
    code,
    hostId,
    isPublic,
    map: 'arabic_city',
    players: [{ id: hostId, name: hostName, isHost: true }],
    gameStarted: false,
    chat: [],
    maxPlayers: 16,
    playerPositions: {} // socketId -> {x,y,z,rotY,rotX}
  };
  lobbies.set(id, lobby);
  lobbies.set(code, lobby);
  return lobby;
}

function removeLobby(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (lobby) {
    lobbies.delete(lobby.id);
    lobbies.delete(lobby.code);
  }
}

function getPlayerName(lobby, socketId) {
  const p = lobby.players.find(p => p.id === socketId);
  return p ? p.name : 'Unknown';
}

function serializeLobby(lobby) {
  return {
    id: lobby.id,
    code: lobby.code,
    hostId: lobby.hostId,
    isPublic: lobby.isPublic,
    map: lobby.map,
    players: lobby.players,
    gameStarted: lobby.gameStarted,
    maxPlayers: lobby.maxPlayers,
    chat: lobby.chat.slice(-50)
  };
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create_lobby', ({ playerName }) => {
    const lobby = createLobby(socket.id, playerName || 'Player', false);
    playerToLobby.set(socket.id, lobby.id);
    socket.join(lobby.id);
    socket.emit('lobby_created', { lobbyId: lobby.id, code: lobby.code, lobby: serializeLobby(lobby) });
    console.log(`Party created: ${lobby.code} by ${playerName}`);
  });

  socket.on('join_lobby', ({ code, playerName }) => {
    const lobby = lobbies.get(code);
    if (!lobby) { socket.emit('join_error', { message: 'Lobby not found' }); return; }
    if (lobby.gameStarted) { socket.emit('join_error', { message: 'Game already started' }); return; }
    if (lobby.players.length >= lobby.maxPlayers) { socket.emit('join_error', { message: 'Lobby is full' }); return; }

    const name = playerName || 'Player';
    lobby.players.push({ id: socket.id, name, isHost: false });
    playerToLobby.set(socket.id, lobby.id);
    socket.join(lobby.id);

    const msg = { system: true, text: `${name} joined the lobby`, timestamp: Date.now() };
    lobby.chat.push(msg);
    io.to(lobby.id).emit('chat_message', msg);
    io.to(lobby.id).emit('lobby_update', serializeLobby(lobby));
    socket.emit('lobby_joined', { lobbyId: lobby.id, code: lobby.code, lobby: serializeLobby(lobby) });
  });

  socket.on('quick_play', ({ playerName, rejoinToken }) => {
    const name = playerName || 'Player';
    // Find a public lobby (not full) - prefer not-yet-started, then already started
    for (const [key, lobby] of lobbies) {
      if (key !== lobby.id) continue;
      if (!lobby.isPublic) continue;
      if (lobby.players.length >= lobby.maxPlayers) continue;
      // Join this lobby
      lobby.players.push({ id: socket.id, name, isHost: false, rejoinToken: rejoinToken || null });
      playerToLobby.set(socket.id, lobby.id);
      socket.join(lobby.id);
      if (!lobby.gameStarted) {
        // Start game for everyone in the lobby
        lobby.gameStarted = true;
        io.to(lobby.id).emit('game_start', { map: lobby.map, players: lobby.players, lobbyId: lobby.id, code: lobby.code });
      } else {
        // Game already running - send new player straight to game
        socket.emit('game_start', { map: lobby.map, players: lobby.players, lobbyId: lobby.id, code: lobby.code });
        io.to(lobby.id).emit('lobby_update', serializeLobby(lobby));
      }
      return;
    }
    // No suitable lobby - create one and start immediately
    const lobby = createLobby(socket.id, name, true);
    // Store rejoin token on host player
    if (rejoinToken) lobby.players[0].rejoinToken = rejoinToken;
    playerToLobby.set(socket.id, lobby.id);
    socket.join(lobby.id);
    lobby.gameStarted = true;
    socket.emit('game_start', { map: lobby.map, players: lobby.players, lobbyId: lobby.id, code: lobby.code });
  });

  socket.on('chat_message', ({ text }) => {
    const lobbyId = playerToLobby.get(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    const name = getPlayerName(lobby, socket.id);
    const msg = { system: false, sender: name, text: String(text).slice(0, 200), timestamp: Date.now() };
    lobby.chat.push(msg);
    if (lobby.chat.length > 100) lobby.chat.shift();
    io.to(lobbyId).emit('chat_message', msg);
  });

  socket.on('set_public', ({ isPublic }) => {
    const lobbyId = playerToLobby.get(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.isPublic = !!isPublic;
    io.to(lobbyId).emit('lobby_update', serializeLobby(lobby));
  });

  socket.on('start_game', () => {
    const lobbyId = playerToLobby.get(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.gameStarted = true;
    io.to(lobbyId).emit('game_start', { map: lobby.map, players: lobby.players, lobbyId: lobby.id, code: lobby.code });
  });

  socket.on('player_move', (data) => {
    const lobbyId = playerToLobby.get(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies.get(lobbyId);
  // Store player's position in the lobby (socketId -> {x,y,z,rotY,rotX})
    if (lobby) lobby.playerPositions[socket.id] = data;
    socket.to(lobbyId).emit('player_moved', { id: socket.id, ...data });
  });

  socket.on('rejoin_game', ({ lobbyCode, playerName, rejoinToken }) => {
    const lobby = lobbies.get(lobbyCode);
    if (!lobby) return;
    // Match player by rejoin token (unique per session) or fall back to name
    let existing = rejoinToken
      ? lobby.players.find(p => p.rejoinToken === rejoinToken)
      : null;
    if (!existing) {
      existing = lobby.players.find(p => p.name === (playerName || 'Player') && !p.rejoinToken);
    }
    if (existing) {
      // Remove old socket mapping if different
      if (existing.id !== socket.id) {
        playerToLobby.delete(existing.id);
        existing.id = socket.id;
      }
    } else {
      lobby.players.push({ id: socket.id, name: playerName || 'Player', isHost: false });
    }
    playerToLobby.set(socket.id, lobby.id);
    socket.join(lobby.id);
    // Send this new player all existing player positions with names
    // Format: { socketId: {x,y,z,rotY,rotX,name} }
    const positionsWithNames = {};
    for (const [sid, pos] of Object.entries(lobby.playerPositions)) {
      const player = lobby.players.find(p => p.id === sid);
      positionsWithNames[sid] = { ...pos, name: player ? player.name : 'Player' };
    }
    socket.emit('sync_positions', positionsWithNames);
    // Tell others to resend their positions
    socket.to(lobby.id).emit('resync_request');
    io.to(lobby.id).emit('lobby_update', serializeLobby(lobby));
  });

  socket.on('leave_lobby', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log('Client disconnected:', socket.id);
  });

  function handleLeave(socket) {
    const lobbyId = playerToLobby.get(socket.id);
    if (!lobbyId) return;
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    const player = lobby.players.find(p => p.id === socket.id);
    const playerName = player ? player.name : 'Unknown';

    lobby.players = lobby.players.filter(p => p.id !== socket.id);
    delete lobby.playerPositions[socket.id];
    playerToLobby.delete(socket.id);
    socket.leave(lobbyId);

    if (lobby.players.length === 0) {
      removeLobby(lobbyId);
      return;
    }

    if (lobby.hostId === socket.id) {
      lobby.hostId = lobby.players[0].id;
      lobby.players[0].isHost = true;
    }

    const msg = { system: true, text: `${playerName} left the lobby`, timestamp: Date.now() };
    lobby.chat.push(msg);
    io.to(lobbyId).emit('chat_message', msg);
    io.to(lobbyId).emit('lobby_update', serializeLobby(lobby));
    io.to(lobbyId).emit('player_left', { id: socket.id });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BaiterFPS server running on port ${PORT}`));
