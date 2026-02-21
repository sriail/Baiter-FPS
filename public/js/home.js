// BaiterFPS - Home & Lobby logic

const MAX_NAME_LENGTH = 24;

// ── Chat filter ───────────────────────────────────────────────────────────────

const PROFANITY_LIST = [
  'fuck','shit','bitch','cunt','cock','dick','pussy','bastard','whore','slut',
  'nigger','nigga','fag','faggot','asshole','ass','piss','crap','damn','hell'
];

function censorWord(word) {
  if (word.length <= 2) return '#'.repeat(word.length);
  return word[0] + '#'.repeat(word.length - 2) + word[word.length - 1];
}

function chatFilter(text) {
  return String(text).replace(/\b\w+\b/g, (word) => {
    if (PROFANITY_LIST.includes(word.toLowerCase())) return censorWord(word);
    return word;
  });
}

// ── Initialize player name ────────────────────────────────────────────────────
if (!sessionStorage.getItem('playerName')) {
  sessionStorage.setItem('playerName', window.generateName());
}

let playerName = sessionStorage.getItem('playerName');
let currentLobby = null;
let mySocketId = null;

// Generate a unique rejoin token per browser session for reliable socket ID remapping
if (!sessionStorage.getItem('rejoinToken')) {
  sessionStorage.setItem('rejoinToken', Math.random().toString(36).slice(2) + Date.now().toString(36));
}
const rejoinToken = sessionStorage.getItem('rejoinToken');

// Display name on home screen
document.getElementById('display-name').textContent = playerName;

// Socket connection
const socket = io();

socket.on('connect', () => {
  mySocketId = socket.id;
  console.log('Connected:', socket.id);

  // Auto-join from lobby link (?join=XXXXXX)
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode && /^\d{6}$/.test(joinCode)) {
    history.replaceState(null, '', window.location.pathname);
    socket.emit('join_lobby', { code: joinCode, playerName });
  }
});

// ── Name change ──────────────────────────────────────────────────────────────

window.changeNamePrompt = function() {
  const newName = prompt('Enter new name:', playerName);
  if (newName && newName.trim().length > 0) {
    playerName = chatFilter(newName.trim().slice(0, MAX_NAME_LENGTH));
    sessionStorage.setItem('playerName', playerName);
    document.getElementById('display-name').textContent = playerName;
  }
};

// ── Modal helpers ────────────────────────────────────────────────────────────

let activeModal = null; // 'create' | 'code' | null

window.openCreateModal = function() {
  activeModal = 'create';
  document.getElementById('create-modal').style.display = 'flex';
};

window.openCodeModal = function() {
  activeModal = 'code';
  document.getElementById('code-input').value = '';
  document.getElementById('code-error').style.display = 'none';
  document.getElementById('code-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('code-input').focus(), 50);
};

window.pasteCode = function() {
  navigator.clipboard.readText().then((text) => {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    document.getElementById('code-input').value = digits;
    document.getElementById('code-input').focus();
  }).catch(() => {
    showToast('Clipboard access denied');
    document.getElementById('code-input').focus();
  });
};

window.closeModals = function() {
  activeModal = null;
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
  socket.emit('create_lobby', { playerName });
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
  socket.emit('quick_play', { playerName, rejoinToken });
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
  if (activeModal === 'code') {
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
  // Save game data and redirect to game
  if (data && data.players) {
    sessionStorage.setItem('lobbyData', JSON.stringify(data));
    if (data.code) sessionStorage.setItem('lobbyCode', data.code);
    if (data.lobbyId) sessionStorage.setItem('lobbyId', data.lobbyId);
  } else if (currentLobby) {
    sessionStorage.setItem('lobbyData', JSON.stringify(currentLobby));
  }
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
    const filteredName = chatFilter(p.name);
    const initials = filteredName.slice(0, 2).toUpperCase();
    item.innerHTML = `
      <div class="player-avatar">${initials}</div>
      <span class="player-name">${escapeHtml(filteredName)}${p.id === mySocketId ? ' (you)' : ''}</span>
      ${p.isHost ? '<span class="player-badge" title="Host">♛</span>' : ''}
    `;
    list.appendChild(item);
  });

  // Visibility toggle removed - all parties are code-only
  const isHost = lobby.hostId === mySocketId;

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
    div.textContent = chatFilter(msg.text);
  } else {
    div.className = 'chat-msg';
    div.innerHTML = `<span class="msg-sender">${escapeHtml(chatFilter(msg.sender))}</span><span class="msg-text">${escapeHtml(chatFilter(msg.text))}</span>`;
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

window.copyLink = function() {
  const code = document.getElementById('lobby-code-display').textContent;
  const link = new URL('?join=' + code, window.location.href).toString();
  navigator.clipboard.writeText(link).then(() => showToast('Link copied!')).catch(() => {
    showToast('Party link: ' + link);
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
