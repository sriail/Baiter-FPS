// BaiterFPS - Home & Lobby logic

const MAX_NAME_LENGTH = 24;

// Initialize player name
if (!sessionStorage.getItem('playerName')) {
  sessionStorage.setItem('playerName', window.generateName());
}

let playerName = sessionStorage.getItem('playerName');
let currentLobby = null;
let mySocketId = null;

// Display name on home screen
document.getElementById('display-name').textContent = playerName;

// Socket connection
const socket = io();

socket.on('connect', () => {
  mySocketId = socket.id;
  console.log('Connected:', socket.id);
});

// ── Name change ──────────────────────────────────────────────────────────────

window.changeNamePrompt = function() {
  const newName = prompt('Enter new name:', playerName);
  if (newName && newName.trim().length > 0) {
    playerName = newName.trim().slice(0, MAX_NAME_LENGTH);
    sessionStorage.setItem('playerName', playerName);
    document.getElementById('display-name').textContent = playerName;
  }
};

// ── Modal helpers ────────────────────────────────────────────────────────────

window.openCreateModal = function() {
  document.getElementById('create-modal').style.display = 'flex';
};

window.openCodeModal = function() {
  document.getElementById('code-input').value = '';
  document.getElementById('code-error').style.display = 'none';
  document.getElementById('code-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('code-input').focus(), 50);
};

window.closeModals = function() {
  document.getElementById('create-modal').style.display = 'none';
  document.getElementById('code-modal').style.display = 'none';
};

// Close modals on backdrop click
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) window.closeModals();
  });
});

// ── Create lobby ─────────────────────────────────────────────────────────────

window.doCreateLobby = function() {
  const isPublic = document.getElementById('create-public-toggle').checked;
  socket.emit('create_lobby', { playerName, isPublic });
  window.closeModals();
};

// ── Join by code ─────────────────────────────────────────────────────────────

window.doJoinByCode = function() {
  const code = document.getElementById('code-input').value.trim();
  if (code.length !== 6) {
    showCodeError('Code must be 6 digits');
    return;
  }
  socket.emit('join_lobby', { code, playerName });
};

document.getElementById('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.doJoinByCode();
});

function showCodeError(msg) {
  const el = document.getElementById('code-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Quick play ───────────────────────────────────────────────────────────────

window.quickPlay = function() {
  socket.emit('quick_play', { playerName });
};

// ── Socket: lobby events ─────────────────────────────────────────────────────

socket.on('lobby_created', (data) => {
  currentLobby = data.lobby;
  sessionStorage.setItem('lobbyData', JSON.stringify(data.lobby));
  sessionStorage.setItem('lobbyId', data.lobbyId);
  sessionStorage.setItem('lobbyCode', data.code);
  showLobby(data.lobby);
});

socket.on('lobby_joined', (data) => {
  currentLobby = data.lobby;
  sessionStorage.setItem('lobbyData', JSON.stringify(data.lobby));
  sessionStorage.setItem('lobbyId', data.lobbyId);
  sessionStorage.setItem('lobbyCode', data.code);
  window.closeModals();
  showLobby(data.lobby);
});

socket.on('join_error', (data) => {
  // Show error in the appropriate modal
  if (document.getElementById('code-modal').style.display !== 'none') {
    showCodeError(data.message);
  } else {
    showToast(data.message);
  }
});

socket.on('lobby_update', (lobby) => {
  currentLobby = lobby;
  sessionStorage.setItem('lobbyData', JSON.stringify(lobby));
  renderLobby(lobby);
});

socket.on('chat_message', (msg) => {
  appendChatMessage(msg);
});

socket.on('game_start', (data) => {
  // Save lobby data and redirect to game
  sessionStorage.setItem('lobbyData', JSON.stringify(currentLobby || {}));
  window.location.href = '/game.html';
});

// ── Lobby UI ─────────────────────────────────────────────────────────────────

function showLobby(lobby) {
  document.getElementById('home-screen').style.display = 'none';
  const ls = document.getElementById('lobby-screen');
  ls.style.display = 'block';
  renderLobby(lobby);
}

function renderLobby(lobby) {
  // Code
  document.getElementById('lobby-code-display').textContent = lobby.code;

  // Player count
  document.getElementById('player-count').textContent = `${lobby.players.length}/${lobby.maxPlayers}`;

  // Player list
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  lobby.players.forEach(p => {
    const item = document.createElement('div');
    item.className = 'player-item' + (p.isHost ? ' is-host' : '') + (p.id === mySocketId ? ' is-you' : '');
    const initials = p.name.slice(0, 2).toUpperCase();
    item.innerHTML = `
      <div class="player-avatar">${initials}</div>
      <span class="player-name">${escapeHtml(p.name)}${p.id === mySocketId ? ' (you)' : ''}</span>
      ${p.isHost ? '<span class="player-badge" title="Host">♛</span>' : ''}
    `;
    list.appendChild(item);
  });

  // Visibility toggle (host only)
  const visRow = document.getElementById('visibility-row');
  const isHost = lobby.hostId === mySocketId;
  visRow.style.display = isHost ? 'flex' : 'none';
  if (isHost) {
    document.getElementById('lobby-public-toggle').checked = lobby.isPublic;
  }

  // Start button / waiting text
  const startBtn = document.getElementById('start-btn');
  const waitText = document.getElementById('waiting-text');
  if (isHost) {
    startBtn.style.display = 'block';
    waitText.style.display = 'none';
  } else {
    startBtn.style.display = 'none';
    waitText.style.display = 'block';
  }

  // Restore chat from lobby history
  const chatBox = document.getElementById('chat-messages');
  chatBox.innerHTML = '';
  (lobby.chat || []).forEach(msg => appendChatMessage(msg, false));
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function appendChatMessage(msg, scroll = true) {
  const chatBox = document.getElementById('chat-messages');
  if (!chatBox) return;
  const div = document.createElement('div');
  if (msg.system) {
    div.className = 'chat-msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'chat-msg';
    div.innerHTML = `<span class="msg-sender">${escapeHtml(msg.sender)}</span><span class="msg-text">${escapeHtml(msg.text)}</span>`;
  }
  chatBox.appendChild(div);
  if (scroll) chatBox.scrollTop = chatBox.scrollHeight;
}

window.sendChat = function() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (text.length === 0) return;
  socket.emit('chat_message', { text });
  input.value = '';
};

window.chatKeydown = function(e) {
  if (e.key === 'Enter') window.sendChat();
};

// ── Lobby controls ───────────────────────────────────────────────────────────

window.copyCode = function() {
  const code = document.getElementById('lobby-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('Code copied!')).catch(() => {
    showToast('Code: ' + code);
  });
};

window.setVisibility = function(isPublic) {
  socket.emit('set_public', { isPublic });
};

window.startGame = function() {
  socket.emit('start_game');
};

window.leaveLobby = function() {
  socket.emit('leave_lobby');
  currentLobby = null;
  sessionStorage.removeItem('lobbyData');
  sessionStorage.removeItem('lobbyId');
  sessionStorage.removeItem('lobbyCode');
  document.getElementById('lobby-screen').style.display = 'none';
  document.getElementById('home-screen').style.display = 'block';
};

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
