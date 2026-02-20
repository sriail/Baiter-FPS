// BaiterFPS - Game Client
(function() {
  'use strict';

  const socket = io();
  const playerName = sessionStorage.getItem('playerName') || 'Player';
  const lobbyCode = sessionStorage.getItem('lobbyCode') || '';
  let lobbyData = JSON.parse(sessionStorage.getItem('lobbyData') || '{}');

  // ── Three.js Setup ────────────────────────────────────────────────────────

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 80, 220);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 3, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = false;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.id = 'game-canvas';

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xfffde7, 0.9);
  dirLight.position.set(60, 120, 60);
  scene.add(dirLight);

  // ── Player State ──────────────────────────────────────────────────────────

  const velocity = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const keys = {};
  let canJump = false;
  let mapLoaded = false;
  let isPaused = false;
  let isPointerLocked = false;

  const GRAVITY = -22;
  const PLAYER_SPEED = 9;
  const JUMP_FORCE = 9;
  const PLAYER_HEIGHT = 1.8;
  const MIN_WORLD_HEIGHT = -80;

  // ── Other Players ─────────────────────────────────────────────────────────

  const otherPlayers = new Map(); // id -> { mesh, targetPos, nameSprite }
  const playerGeo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
  const playerColors = [0x4fc3f7, 0xff6b6b, 0x6bff6b, 0xffff6b, 0xff6bff, 0x6bffff, 0xff9f43, 0xa29bfe];
  let colorIndex = 0;

  // ── Collision & Map ───────────────────────────────────────────────────────

  const collisionObjects = [];
  const CHUNK_SIZE = 50;
  const RENDER_DISTANCE = 3;
  const COLLISION_CHECK_RADIUS_SQ = 400; // 20 units squared
  const chunks = new Map();
  let lastChunkX = Infinity, lastChunkZ = Infinity;

  // ── Pointer Lock ──────────────────────────────────────────────────────────

  document.addEventListener('click', () => {
    if (!isPaused && mapLoaded) {
      renderer.domElement.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = document.pointerLockElement === renderer.domElement;
    document.getElementById('crosshair').style.display = isPointerLocked ? 'block' : 'none';
    document.getElementById('lock-prompt').style.display = isPointerLocked ? 'none' : 'block';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPointerLocked || isPaused) return;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= e.movementX * 0.002;
    euler.x -= e.movementY * 0.002;
    euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
    camera.quaternion.setFromEuler(euler);
  });

  // ── Keyboard ──────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space' && canJump) {
      velocity.y = JUMP_FORCE;
      canJump = false;
    }
    if (e.code === 'Escape') togglePause();
  });
  document.addEventListener('keyup', (e) => { keys[e.code] = false; });

  // ── Pause ─────────────────────────────────────────────────────────────────

  function togglePause() {
    isPaused = !isPaused;
    const menu = document.getElementById('pause-menu');
    menu.style.display = isPaused ? 'flex' : 'none';
    if (isPaused && isPointerLocked) document.exitPointerLock();
  }

  window.resumeGame = function() {
    isPaused = false;
    document.getElementById('pause-menu').style.display = 'none';
    renderer.domElement.requestPointerLock();
  };

  window.exitLobby = function() {
    socket.emit('leave_lobby');
    window.location.href = '/';
  };

  window.exitGame = function() {
    socket.emit('leave_lobby');
    window.location.href = '/';
  };

  // ── Map Loading ───────────────────────────────────────────────────────────

  const setBar = (pct, text) => {
    document.getElementById('loading-bar').style.width = pct + '%';
    if (text) document.getElementById('loading-text').textContent = text;
  };

  const loader = new THREE.GLTFLoader();

  // Set up DRACO decoder (optional - graceful fallback)
  try {
    const dracoLoader = new THREE.DRACOLoader();
    dracoLoader.setDecoderPath('https://unpkg.com/three@0.158.0/examples/js/libs/draco/');
    loader.setDRACOLoader(dracoLoader);
  } catch(e) {
    console.warn('DRACOLoader not available, skipping');
  }

  loader.load(
    '/maps/arabic_city/scene.gltf',
    (gltf) => {
      setBar(80, 'Processing map...');
      const mapGroup = gltf.scene;

      mapGroup.traverse((child) => {
        if (!child.isMesh) return;

        // Simplify materials
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => {
          if (!m) return;
          m.roughness = 1;
          m.metalness = 0;
          m.envMap = null;
        });
        child.castShadow = false;
        child.receiveShadow = false;

        // Assign to spatial chunk
        const pos = new THREE.Vector3();
        child.getWorldPosition(pos);
        const cx = Math.floor(pos.x / CHUNK_SIZE);
        const cz = Math.floor(pos.z / CHUNK_SIZE);
        const key = cx + ',' + cz;
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push(child);

        if (child.geometry) collisionObjects.push(child);
      });

      scene.add(mapGroup);
      setBar(95, 'Finding spawn...');
      findStartPosition();
      updateChunkVisibility(true);

      setBar(100, 'Ready!');
      setTimeout(() => {
        document.getElementById('loading').style.display = 'none';
        mapLoaded = true;
      }, 400);
    },
    (progress) => {
      if (progress.total > 0) {
        setBar(Math.min(75, (progress.loaded / progress.total) * 75));
      }
    },
    (error) => {
      console.error('Map load error:', error);
      setBar(100, 'Map load failed. Starting in empty world...');
      setTimeout(() => {
        document.getElementById('loading').style.display = 'none';
        mapLoaded = true;
      }, 1500);
    }
  );

  function findStartPosition() {
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0, 200, 0),
      new THREE.Vector3(0, -1, 0)
    );
    const hits = raycaster.intersectObjects(collisionObjects, true);
    if (hits.length > 0) {
      camera.position.set(hits[0].point.x, hits[0].point.y + PLAYER_HEIGHT, hits[0].point.z);
    } else {
      camera.position.set(0, PLAYER_HEIGHT, 0);
    }
  }

  // ── Chunk Visibility ──────────────────────────────────────────────────────

  function updateChunkVisibility(force) {
    const cx = Math.floor(camera.position.x / CHUNK_SIZE);
    const cz = Math.floor(camera.position.z / CHUNK_SIZE);
    if (!force && cx === lastChunkX && cz === lastChunkZ) return;
    lastChunkX = cx; lastChunkZ = cz;

    chunks.forEach((meshes, key) => {
      const [kx, kz] = key.split(',').map(Number);
      const dist = Math.max(Math.abs(kx - cx), Math.abs(kz - cz));
      const visible = dist <= RENDER_DISTANCE;
      for (let i = 0; i < meshes.length; i++) meshes[i].visible = visible;
    });
  }

  // ── Other Players ─────────────────────────────────────────────────────────

  function makeNameSprite(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const w = ctx.measureText(name).width + 16;
    ctx.fillRect(128 - w / 2, 10, w, 40);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.slice(0, 18), 128, 30);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, 1.4, 0);
    sprite.scale.set(2.2, 0.55, 1);
    return sprite;
  }

  function addPlayer(id, name, pos) {
    if (otherPlayers.has(id)) return;
    const color = playerColors[colorIndex++ % playerColors.length];
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(playerGeo, mat);
    mesh.position.set(pos.x || 0, (pos.y || 2) - 0.9, pos.z || 0);
    const sprite = makeNameSprite(name || 'Player');
    mesh.add(sprite);
    scene.add(mesh);
    otherPlayers.set(id, { mesh, targetPos: mesh.position.clone() });
  }

  function removePlayer(id) {
    const p = otherPlayers.get(id);
    if (p) { scene.remove(p.mesh); otherPlayers.delete(id); }
  }

  // ── Collision Helpers ─────────────────────────────────────────────────────

  const _downOrigin = new THREE.Vector3();
  const _downDir = new THREE.Vector3(0, -1, 0);
  const _raycasterDown = new THREE.Raycaster();
  const _raycasterWall = new THREE.Raycaster();

  function getNearbyColliders() {
    const result = [];
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    for (let i = 0; i < collisionObjects.length; i++) {
      const obj = collisionObjects[i];
      if (!obj.visible) continue;
      const op = obj.position;
      const dx = op.x - px, dy = op.y - py, dz = op.z - pz;
      if (dx * dx + dy * dy + dz * dz < COLLISION_CHECK_RADIUS_SQ) result.push(obj);
    }
    return result;
  }

  // ── Animation Loop ────────────────────────────────────────────────────────

  const clock = new THREE.Clock();
  let lastMoveEmit = 0;
  let lastChunkCheck = 0;

  function animate() {
    requestAnimationFrame(animate);

    const delta = Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    if (!isPaused && isPointerLocked && mapLoaded) {
      const spd = PLAYER_SPEED * delta;
      const sinY = Math.sin(euler.y);
      const cosY = Math.cos(euler.y);

      // Forward and right vectors (flat)
      const fwdX = -sinY, fwdZ = -cosY;
      const rgtX = cosY, rgtZ = -sinY;

      let moveX = 0, moveZ = 0;
      if (keys['KeyW']) { moveX += fwdX; moveZ += fwdZ; }
      if (keys['KeyS']) { moveX -= fwdX; moveZ -= fwdZ; }
      if (keys['KeyA']) { moveX -= rgtX; moveZ -= rgtZ; }
      if (keys['KeyD']) { moveX += rgtX; moveZ += rgtZ; }

      // Normalise diagonal movement
      const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
      if (len > 0) { moveX /= len; moveZ /= len; }

      // Gravity
      velocity.y += GRAVITY * delta;

      const nearbyColliders = getNearbyColliders();

      // Wall check
      if (len > 0) {
        _raycasterWall.set(camera.position, new THREE.Vector3(moveX, 0, moveZ).normalize());
        _raycasterWall.far = 0.55;
        const wallHits = _raycasterWall.intersectObjects(nearbyColliders, true);
        if (wallHits.length === 0) {
          camera.position.x += moveX * spd;
          camera.position.z += moveZ * spd;
        }
      }

      // Vertical move
      camera.position.y += velocity.y * delta;

      // Ground check
      _downOrigin.set(camera.position.x, camera.position.y - 0.1, camera.position.z);
      _raycasterDown.set(_downOrigin, _downDir);
      _raycasterDown.far = PLAYER_HEIGHT + 0.3;
      const groundHits = _raycasterDown.intersectObjects(nearbyColliders, true);
      if (groundHits.length > 0 && velocity.y <= 0) {
        camera.position.y = groundHits[0].point.y + PLAYER_HEIGHT;
        velocity.y = 0;
        canJump = true;
      }

      // Safety floor
      if (camera.position.y < MIN_WORLD_HEIGHT) {
        findStartPosition();
        velocity.y = 0;
        canJump = true;
      }
    }

    // Interpolate other players
    otherPlayers.forEach(p => {
      p.mesh.position.lerp(p.targetPos, 0.18);
    });

    // Chunk update (every 500ms)
    if (now - lastChunkCheck > 500) {
      updateChunkVisibility(false);
      lastChunkCheck = now;
    }

    // Emit position (every 50ms)
    if (now - lastMoveEmit > 50 && mapLoaded) {
      socket.emit('player_move', {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        rotY: euler.y,
        rotX: euler.x
      });
      lastMoveEmit = now;
    }

    renderer.render(scene, camera);
  }

  // ── Socket Events ─────────────────────────────────────────────────────────

  socket.on('connect', () => {
    console.log('Game socket connected:', socket.id);
    updateHUD();
  });

  socket.on('player_moved', (data) => {
    if (data.id === socket.id) return;
    if (!otherPlayers.has(data.id)) {
      const players = (lobbyData.players || []);
      const info = players.find(p => p.id === data.id);
      addPlayer(data.id, info ? info.name : 'Player', data);
    }
    const p = otherPlayers.get(data.id);
    if (p) {
      p.targetPos.set(data.x, data.y - 0.9, data.z);
      p.mesh.rotation.y = data.rotY || 0;
    }
  });

  socket.on('player_left', (data) => {
    removePlayer(data.id);
    updateHUD();
  });

  socket.on('lobby_update', (lobby) => {
    lobbyData = lobby;
    sessionStorage.setItem('lobbyData', JSON.stringify(lobby));
    updateHUD();
  });

  // ── HUD ───────────────────────────────────────────────────────────────────

  function updateHUD() {
    const count = (lobbyData.players || []).length;
    const max = lobbyData.maxPlayers || 16;
    document.getElementById('hud').innerHTML =
      '<div style="color:#4fc3f7">' + escHtml(playerName) + '</div>' +
      '<div>Lobby: ' + escHtml(lobbyCode) + '</div>' +
      '<div>Players: ' + count + '/' + max + '</div>' +
      '<div style="color:#555;font-size:11px;margin-top:4px;">[ESC] Pause</div>';
  }

  updateHUD();

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Resize ────────────────────────────────────────────────────────────────

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();

})();
