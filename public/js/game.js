// BaiterFPS - Game Client
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

(function() {
  'use strict';

  const socket = io();
  const playerName = sessionStorage.getItem('playerName') || 'Player';
  const lobbyCode = sessionStorage.getItem('lobbyCode') || '';
  const rejoinToken = sessionStorage.getItem('rejoinToken') || '';
  let lobbyData = JSON.parse(sessionStorage.getItem('lobbyData') || '{}');

  // ── Three.js Setup ────────────────────────────────────────────────────────

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 80, 220);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 0.3, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = false;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.id = 'game-canvas';

  // Weapon scene rendered on top (prevents clipping through walls)
  const weaponScene = new THREE.Scene();
  const weaponCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.001, 10);
  renderer.autoClear = false;

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xfffde7, 0.9);
  dirLight.position.set(60, 120, 60);
  scene.add(dirLight);

  // Weapon lights (mirrored for weapon scene)
  weaponScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const wDirLight = new THREE.DirectionalLight(0xfffde7, 0.8);
  wDirLight.position.set(1, 2, 1);
  weaponScene.add(wDirLight);

  // ── Player State ──────────────────────────────────────────────────────────

  const velocity = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const keys = {};
  let canJump = false;
  let mapLoaded = false;
  let isPaused = false;
  let isPointerLocked = false;

  // Player scaled to 1/10 of original size to match map scale
  const GRAVITY = -2.2;
  const PLAYER_SPEED = 0.9;
  const JUMP_FORCE = 0.9;
  const PLAYER_HEIGHT = 0.18;
  const MIN_WORLD_HEIGHT = -8;

  // ── Other Players ─────────────────────────────────────────────────────────

  const otherPlayers = new Map(); // id -> { mesh, targetPos }
  const playerColors = [0x4fc3f7, 0xff6b6b, 0x6bff6b, 0xffff6b, 0xff6bff, 0x6bffff, 0xff9f43, 0xa29bfe];
  let colorIndex = 0;

  // ── Collision & Map ───────────────────────────────────────────────────────

  const collisionObjects = [];
  const CHUNK_SIZE = 50;
  const RENDER_DISTANCE = 2;
  const COLLISION_CHECK_RADIUS_SQ = 25; // 5 units radius (optimized for 1/10 player scale)
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

  const loader = new GLTFLoader();

  // Set up DRACO decoder (optional - graceful fallback)
  try {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/three/examples/jsm/libs/draco/gltf/');
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

        // Cache world position for fast collision checks
        const pos = new THREE.Vector3();
        child.getWorldPosition(pos);
        child.userData.cachedWorldPos = pos.clone();

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

  // ── Gun Model Loading ─────────────────────────────────────────────────────

  const fbxLoader = new FBXLoader();
  let weaponMixer = null;
  const gunContainer = new THREE.Group();
  // Position: right side, slightly forward and down from eye level
  gunContainer.position.set(0.15, -0.1, -0.3);
  weaponScene.add(gunContainer);

  fbxLoader.load(
    '/weapons/gun-m4a1/source/Gun_M41D.fbx',
    (fbx) => {
      // Scale gun to fit first-person view
      fbx.scale.setScalar(0.001);
      // Rotate so barrel points forward (-Z)
      fbx.rotation.set(0, Math.PI, 0);

      // Load the actual PNG texture (FBX references TGA which isn't supported)
      const texLoader = new THREE.TextureLoader();
      texLoader.load(
        '/weapons/gun-m4a1/textures/M4_D.png',
        (tex) => {
          const mat = new THREE.MeshLambertMaterial({ map: tex });
          fbx.traverse((child) => {
            if (child.isMesh) {
              child.material = mat;
              child.castShadow = false;
              child.receiveShadow = false;
            }
          });
        },
        null,
        () => {
          // Fallback material if texture fails
          const metalMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
          fbx.traverse((child) => {
            if (child.isMesh) {
              child.material = metalMat;
              child.castShadow = false;
              child.receiveShadow = false;
            }
          });
        }
      );

      gunContainer.add(fbx);

      // Set up animation mixer if FBX has animations
      if (fbx.animations && fbx.animations.length > 0) {
        weaponMixer = new THREE.AnimationMixer(fbx);
        const idleClip = fbx.animations[0];
        const action = weaponMixer.clipAction(idleClip);
        action.play();
      }
      console.log('Gun model loaded');
    },
    null,
    (err) => console.warn('Gun load failed:', err)
  );

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
    sprite.position.set(0, 0.14, 0);
    sprite.scale.set(0.5, 0.13, 1);
    return sprite;
  }

  function createPlayerMesh(color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    // Compute a darker version of the color by scaling each RGB channel
    const r = ((color >> 16) & 0xff) * 0.7 | 0;
    const g = ((color >> 8) & 0xff) * 0.7 | 0;
    const b = (color & 0xff) * 0.7 | 0;
    const darkColor = (r << 16) | (g << 8) | b;
    const darkMat = new THREE.MeshLambertMaterial({ color: darkColor });
    const s = 0.1; // 1/10 scale factor
    // Body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6 * s, 0.7 * s, 0.3 * s), mat);
    body.position.y = 0.85 * s;
    group.add(body);
    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4 * s, 0.35 * s, 0.35 * s), mat);
    head.position.y = 1.42 * s;
    group.add(head);
    // Left arm
    const lArm = new THREE.Mesh(new THREE.BoxGeometry(0.2 * s, 0.6 * s, 0.2 * s), mat);
    lArm.position.set(-0.4 * s, 0.85 * s, 0);
    group.add(lArm);
    // Right arm
    const rArm = new THREE.Mesh(new THREE.BoxGeometry(0.2 * s, 0.6 * s, 0.2 * s), mat);
    rArm.position.set(0.4 * s, 0.85 * s, 0);
    group.add(rArm);
    // Left leg
    const lLeg = new THREE.Mesh(new THREE.BoxGeometry(0.25 * s, 0.6 * s, 0.25 * s), darkMat);
    lLeg.position.set(-0.17 * s, 0.3 * s, 0);
    group.add(lLeg);
    // Right leg
    const rLeg = new THREE.Mesh(new THREE.BoxGeometry(0.25 * s, 0.6 * s, 0.25 * s), darkMat);
    rLeg.position.set(0.17 * s, 0.3 * s, 0);
    group.add(rLeg);
    return group;
  }

  function addPlayer(id, name, pos) {
    if (otherPlayers.has(id)) return;
    const color = playerColors[colorIndex++ % playerColors.length];
    const mesh = createPlayerMesh(color);
    const yOffset = PLAYER_HEIGHT * 0.5;
    mesh.position.set(pos.x || 0, (pos.y || PLAYER_HEIGHT) - yOffset, pos.z || 0);
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
  const _tmpPos = new THREE.Vector3(); // reused for world position fallback

  function getNearbyColliders() {
    const result = [];
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    for (let i = 0; i < collisionObjects.length; i++) {
      const obj = collisionObjects[i];
      if (!obj.visible) continue;
      // Use cached world position for fast distance check
      const wp = obj.userData.cachedWorldPos
        ? obj.userData.cachedWorldPos
        : obj.getWorldPosition(_tmpPos);
      const dx = wp.x - px, dy = wp.y - py, dz = wp.z - pz;
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
        _raycasterWall.far = 0.055;
        const wallHits = _raycasterWall.intersectObjects(nearbyColliders, true);
        if (wallHits.length === 0) {
          camera.position.x += moveX * spd;
          camera.position.z += moveZ * spd;
        }
      }

      // Vertical move
      camera.position.y += velocity.y * delta;

      // Ground check
      _downOrigin.set(camera.position.x, camera.position.y - 0.01, camera.position.z);
      _raycasterDown.set(_downOrigin, _downDir);
      _raycasterDown.far = PLAYER_HEIGHT + 0.03;
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

    // Update weapon animations
    if (weaponMixer) weaponMixer.update(delta);

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

    renderer.clear();
    renderer.render(scene, camera);
    // Render weapon on top
    renderer.clearDepth();
    weaponCamera.quaternion.copy(camera.quaternion);
    renderer.render(weaponScene, weaponCamera);
  }

  // ── Socket Events ─────────────────────────────────────────────────────────

  socket.on('connect', () => {
    console.log('Game socket connected:', socket.id);
    // Rejoin the lobby room (new socket ID after page navigation)
    if (lobbyCode) {
      socket.emit('rejoin_game', { lobbyCode, playerName, rejoinToken });
    }
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
      p.targetPos.set(data.x, data.y - PLAYER_HEIGHT * 0.5, data.z);
      p.mesh.rotation.y = data.rotY || 0;
    }
  });

  // Server asks this client to resend position (new player joined)
  socket.on('resync_request', () => {
    socket.emit('player_move', {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      rotY: euler.y,
      rotX: euler.x
    });
  });

  // Server sends existing player positions when we rejoin
  // Format: { socketId: {x,y,z,rotY,rotX,name} }
  socket.on('sync_positions', (positions) => {
    for (const [id, pos] of Object.entries(positions)) {
      if (id === socket.id) continue;
      if (!otherPlayers.has(id)) {
        // Use name from position payload if available, otherwise look up in lobbyData
        const name = pos.name || (lobbyData.players || []).find(p => p.id === id)?.name || 'Player';
        addPlayer(id, name, pos);
      }
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
    weaponCamera.aspect = window.innerWidth / window.innerHeight;
    weaponCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();

})();
