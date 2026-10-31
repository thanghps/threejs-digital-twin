import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
let selected = null;

// ---------- Building layout ----------
const FLOORS = 8;
const FLOOR_H = 4;
const W = 40;            // building width (x)
const D = 24;            // building depth (z)
const COLS = 5;          // rooms per row
const CORR = 3;          // corridor width
const ROOM_W = W / COLS;
const ROOM_D = (D - CORR) / 2;
const ROOMS_PER_FLOOR = COLS * 2;
const TYPES = ['Office', 'Office', 'Meeting', 'Office', 'Lab', 'Office', 'Office', 'Meeting', 'Lounge', 'Office'];
const CAPACITY = { Office: 6, Meeting: 8, Lab: 6, Lounge: 10 };

// ---------- Metrics ----------
const METRICS = {
  temp: { label: 'Temperature', unit: '°C', fmt: v => v.toFixed(1), stops: [[18, '#3b82f6'], [21, '#22c55e'], [24, '#eab308'], [27, '#ef4444']], alert: v => v > 26 },
  co2:  { label: 'CO₂', unit: 'ppm', fmt: v => Math.round(v), stops: [[400, '#22c55e'], [800, '#eab308'], [1100, '#f97316'], [1400, '#ef4444']], alert: v => v > 1000 },
  occ:  { label: 'Occupancy', unit: '%', fmt: v => Math.round(v), stops: [[0, '#cbd5e1'], [40, '#60a5fa'], [80, '#6366f1'], [100, '#a21caf']], alert: () => false },
};
let metric = 'temp';
const stopColors = {};
for (const [k, m] of Object.entries(METRICS)) stopColors[k] = m.stops.map(([v, c]) => [v, new THREE.Color(c)]);
const tmpColor = new THREE.Color();
function colorFor(key, v, out = tmpColor) {
  const s = stopColors[key];
  if (v <= s[0][0]) return out.copy(s[0][1]);
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) return out.lerpColors(s[i - 1][1], s[i][1], (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
  }
  return out.copy(s[s.length - 1][1]);
}

// ---------- Renderer / scene ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9eef3);
scene.fog = new THREE.Fog(0xe9eef3, 140, 300);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 800);
const HOME = { pos: new THREE.Vector3(62, 48, 70), target: new THREE.Vector3(0, 13, 0) };
if (window.innerWidth < 760) { // phones: pull back and start with the panel collapsed
  HOME.pos.multiplyScalar(1.9);
  HOME.target.y = 9;
  document.getElementById('panel').classList.add('collapsed');
}
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, canvas);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 12;
controls.maxDistance = 240;

scene.add(new THREE.HemisphereLight(0xffffff, 0xb7c3cf, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(40, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -50, right: 50, top: 60, bottom: -40, near: 10, far: 220 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(220, 64), new THREE.MeshStandardMaterial({ color: 0xdde3e9, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(200, 50, 0xc5ced8, 0xd3dae1);
grid.position.y = 0.01;
scene.add(grid);
// plaza around the tower
const plaza = new THREE.Mesh(new THREE.BoxGeometry(W + 16, 0.2, D + 16), new THREE.MeshStandardMaterial({ color: 0xf1f4f7, roughness: 0.9 }));
plaza.position.y = 0.1;
plaza.receiveShadow = true;
scene.add(plaza);

// ---------- Shared geometry / materials ----------
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const mats = {
  tile: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, transparent: true, opacity: 0.55 }),
  desk: new THREE.MeshStandardMaterial({ color: 0xc9a77c, roughness: 0.7 }),
  chair: new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 }),
  column: new THREE.MeshStandardMaterial({ color: 0xd6dce2, roughness: 0.8 }),
  mullion: new THREE.MeshStandardMaterial({ color: 0xaab6c3, roughness: 0.35, metalness: 0.5 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x9aa6b2, roughness: 0.8 }),
};

const building = new THREE.Group();
scene.add(building);
const floors = [];      // { group, tiles, slabMat, glassMat }
const rooms = [];       // room state
let instanceCount = 0;

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v3 = new THREE.Vector3();
const s3 = new THREE.Vector3();
function setBox(mesh, i, x, y, z, sx, sy, sz) {
  mesh.setMatrixAt(i, m4.compose(v3.set(x, y, z), q, s3.set(sx, sy, sz)));
}
function instanced(geo, mat, list, shadow = true) {
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((b, i) => setBox(mesh, i, ...b));
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  instanceCount += list.length;
  return mesh;
}

// deterministic pseudo-random so every visitor sees the same building
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function roomCenter(idx) {
  const col = idx % COLS;
  const north = idx >= COLS;
  const cx = -W / 2 + ROOM_W * (col + 0.5);
  const cz = north ? -(CORR / 2 + ROOM_D / 2) : (CORR / 2 + ROOM_D / 2);
  return [cx, cz, north];
}

for (let f = 0; f < FLOORS; f++) {
  const group = new THREE.Group();
  group.userData.floor = f;
  building.add(group);

  const slabMat = new THREE.MeshStandardMaterial({ color: 0xf5f7f9, roughness: 0.8, transparent: true, opacity: 1 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 1, 0.3, D + 1), slabMat);
  slab.position.y = -0.15;
  slab.castShadow = slab.receiveShadow = true;
  group.add(slab);

  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(ROOM_W - 0.35, 0.14, ROOM_D - 0.35), mats.tile, ROOMS_PER_FLOOR);
  tiles.userData.floor = f;
  tiles.receiveShadow = true;
  instanceCount += ROOMS_PER_FLOOR;

  const walls = [], desks = [], chairs = [];
  for (let r = 0; r < ROOMS_PER_FLOOR; r++) {
    const [cx, cz, north] = roomCenter(r);
    tiles.setMatrixAt(r, m4.makeTranslation(cx, 0.07, cz));
    const type = TYPES[(r + f * 3) % TYPES.length];
    const corrZ = north ? -CORR / 2 : CORR / 2;
    // glass partition on corridor side with a door gap
    walls.push([cx - ROOM_W * 0.22, 1.3, corrZ, ROOM_W * 0.56, 2.6, 0.1]);
    walls.push([cx + ROOM_W * 0.42, 1.3, corrZ, ROOM_W * 0.16, 2.6, 0.1]);
    // side wall between rooms
    if (r % COLS !== COLS - 1) walls.push([cx + ROOM_W / 2, 1.3, cz, 0.1, 2.6, ROOM_D]);

    if (type === 'Meeting' || type === 'Lounge') {
      desks.push([cx, 0.38, cz, 4.2, 0.08, 1.8]);
      desks.push([cx, 0.19, cz, 0.3, 0.38, 0.3]);
      for (let k = 0; k < 4; k++) {
        chairs.push([cx - 1.5 + k, 0.25, cz - 1.35, 0.5, 0.5, 0.5]);
        chairs.push([cx - 1.5 + k, 0.25, cz + 1.35, 0.5, 0.5, 0.5]);
      }
    } else {
      for (let a = 0; a < 2; a++) for (let b = 0; b < 3; b++) {
        const dx = cx - 1.7 + a * 3.4, dz = cz - 3.2 + b * 3.2;
        desks.push([dx, 0.38, dz, 1.6, 0.06, 0.8]);
        chairs.push([dx, 0.25, dz + 0.75, 0.5, 0.5, 0.5]);
      }
    }

    const cap = CAPACITY[type];
    rooms.push({
      id: f * ROOMS_PER_FLOOR + r, floor: f, idx: r, type, cx, cz, cap,
      name: `L${f + 1}-${String(r + 1).padStart(2, '0')}`,
      setpoint: 21.2 + rand() * 1.6, busy: 0.45 + rand() * 0.55, vent: 0.7 + rand() * 0.6,
      people: 0, temp: 21.5, co2: 450, occ: 0, fault: false,
      hist: { temp: [], co2: [], occ: [] },
    });
  }
  group.add(tiles);
  group.add(instanced(unitBox, mats.wall, walls, false));
  group.add(instanced(unitBox, mats.desk, desks));
  group.add(instanced(unitBox, mats.chair, chairs));

  // structural columns
  const cols = [];
  for (let x = -W / 2; x <= W / 2; x += ROOM_W) for (const z of [-D / 2, D / 2]) cols.push([x, FLOOR_H / 2, z, 0.5, FLOOR_H, 0.5]);
  group.add(instanced(unitBox, mats.column, cols));

  // facade: glass + vertical fins
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9cc3dc, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.12, depthWrite: false });
  const gh = FLOOR_H - 0.3;
  for (const [x, z, sx, sz] of [[0, D / 2 + 0.3, W, 0.04], [0, -D / 2 - 0.3, W, 0.04], [W / 2 + 0.3, 0, 0.04, D], [-W / 2 - 0.3, 0, 0.04, D]]) {
    const g = new THREE.Mesh(unitBox, glassMat);
    g.scale.set(sx, gh, sz);
    g.position.set(x, gh / 2 + 0.05, z);
    group.add(g);
  }
  const fins = [];
  for (let x = -W / 2; x <= W / 2 + 0.01; x += 4) { fins.push([x, FLOOR_H / 2, D / 2 + 0.45, 0.06, FLOOR_H, 0.2]); fins.push([x, FLOOR_H / 2, -D / 2 - 0.45, 0.06, FLOOR_H, 0.2]); }
  for (let z = -D / 2 + 4; z <= D / 2 - 3.99; z += 4) { fins.push([W / 2 + 0.45, FLOOR_H / 2, z, 0.2, FLOOR_H, 0.06]); fins.push([-W / 2 - 0.45, FLOOR_H / 2, z, 0.2, FLOOR_H, 0.06]); }
  group.add(instanced(unitBox, mats.mullion, fins));

  floors.push({ group, tiles, slabMat, glassMat });
}

// roof with plant equipment
const roof = new THREE.Group();
const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(W + 1.4, 0.5, D + 1.4), mats.roof);
roofSlab.position.y = 0.25;
roofSlab.castShadow = roofSlab.receiveShadow = true;
roof.add(roofSlab);
roof.add(instanced(unitBox, new THREE.MeshStandardMaterial({ color: 0xcbd2d9, roughness: 0.5, metalness: 0.4 }), [
  [-12, 1.5, -4, 6, 2, 4], [-3, 1.5, -4, 6, 2, 4], [10, 2, 3, 8, 3, 6], [-12, 1, 6, 3, 1, 3], [-7, 1, 6, 3, 1, 3],
]));
building.add(roof);

// stagger the floor plates so they read individually
let explode = 0;
function layout() {
  floors.forEach((fl, f) => { fl.group.position.y = 0.2 + f * (FLOOR_H + explode); });
  roof.position.y = 0.2 + FLOORS * (FLOOR_H + explode) - (explode ? 0 : 0.0);
}
layout();

// ---------- Highlight helpers ----------
const hlGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(ROOM_W - 0.25, 2.8, ROOM_D - 0.25));
const hover = new THREE.LineSegments(hlGeo, new THREE.LineBasicMaterial({ color: 0x0f172a }));
const selectBox = new THREE.LineSegments(hlGeo, new THREE.LineBasicMaterial({ color: 0x2563eb }));
hover.visible = selectBox.visible = false;
function attach(box, room) {
  floors[room.floor].group.add(box);
  box.position.set(room.cx, 1.45, room.cz);
  box.visible = true;
}

// ---------- Simulation ----------
let simMinutes = 7 * 60;
const STEP_MIN = 5;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const noise = () => (rand() - 0.5) * 2;
// two rooms with an HVAC fault so the alert list has something real to show
rooms[23].fault = true;
rooms[57].fault = true;

function presence(h) {
  if (h < 7.5 || h > 19) return 0.03;
  const base = Math.sin(((h - 7.5) / 11.5) * Math.PI);
  const lunch = h > 12 && h < 13.2 ? 0.55 : 1;
  return clamp(base * lunch, 0.03, 1);
}

function tick() {
  simMinutes = (simMinutes + STEP_MIN) % (24 * 60);
  const h = simMinutes / 60;
  const p = presence(h);
  for (const r of rooms) {
    let target = r.cap * p * r.busy;
    if (r.type === 'Meeting') target = rand() < 0.15 ? r.cap * rand() : r.people * 0.9;
    r.people = clamp(r.people + (target - r.people) * 0.35 + noise() * 0.6, 0, r.cap);
    const load = r.people / r.cap;
    const tTarget = r.setpoint + load * 1.8 + (r.fault ? 5.5 : 0);
    r.temp += (tTarget - r.temp) * 0.15 + noise() * 0.06;
    const cTarget = 420 + load * 650 * r.vent + (r.fault ? 520 : 0);
    r.co2 += (cTarget - r.co2) * 0.25 + noise() * 12;
    r.occ = load * 100;
    for (const k of ['temp', 'co2', 'occ']) {
      const hs = r.hist[k];
      hs.push(r[k]);
      if (hs.length > 60) hs.shift();
    }
  }
  paint();
  updateAlerts();
  updateInfo();
  const hh = String(Math.floor(h)).padStart(2, '0'), mm = String(simMinutes % 60).padStart(2, '0');
  document.getElementById('clock').textContent = `Simulated · ${hh}:${mm}`;
}

function paint() {
  for (const r of rooms) floors[r.floor].tiles.setColorAt(r.idx, colorFor(metric, r[metric]));
  for (const fl of floors) fl.tiles.instanceColor.needsUpdate = true;
}

for (let i = 0; i < 30; i++) tick(); // warm up: history + realistic mid-morning state

// ---------- UI ----------
function drawLegend() {
  const m = METRICS[metric];
  const lo = m.stops[0][0], hi = m.stops[m.stops.length - 1][0];
  $('legend-bar').style.background = `linear-gradient(90deg, ${m.stops.map(([v, c]) => `${c} ${((v - lo) / (hi - lo)) * 100}%`).join(', ')})`;
  $('legend-ticks').innerHTML = m.stops.map(([v]) => `<span>${v}${m.unit === '%' ? '%' : ''}</span>`).join('') ;
  $('legend-ticks').lastElementChild.textContent += ` ${m.unit === '%' ? '' : m.unit}`;
}

$('metric').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  metric = b.dataset.m;
  for (const x of $('metric').children) x.classList.toggle('on', x === b);
  drawLegend();
  paint();
  updateInfo();
});

const floorSel = $('floor');
floorSel.innerHTML = '<option value="all">All floors</option>' +
  Array.from({ length: FLOORS }, (_, i) => `<option value="${i}">Level ${i + 1}</option>`).join('');
let isolated = 'all';
function setFloor(v, fly = true) {
  isolated = v;
  floorSel.value = v;
  const f = v === 'all' ? FLOORS : Number(v);
  floors.forEach((fl, i) => { fl.group.visible = i <= f; });
  roof.visible = v === 'all';
  if (!fly) return;
  if (v === 'all') flyTo(HOME.pos, HOME.target);
  else {
    const y = floors[f].group.position.y;
    flyTo(new THREE.Vector3(34, y + 34, 40), new THREE.Vector3(0, y, 0));
  }
}
floorSel.addEventListener('change', () => setFloor(floorSel.value));

$('explode').addEventListener('input', e => {
  explode = Number(e.target.value);
  $('explode-v').textContent = `${explode.toFixed(1)} m`;
  layout();
  if (selected) attach(selectBox, selected);
});
// when the slider is released, reframe the whole stack so the top floors stay in view
$('explode').addEventListener('change', () => {
  if (isolated !== 'all') return;
  const k = (FLOORS * (FLOOR_H + explode)) / (FLOORS * FLOOR_H);
  flyTo(new THREE.Vector3(HOME.pos.x * (0.6 + 0.4 * k), HOME.pos.y * k, HOME.pos.z * (0.6 + 0.4 * k)),
        new THREE.Vector3(0, HOME.target.y * k, 0));
});

let live = true;
let timer = setInterval(() => live && tick(), 1000);
$('live').addEventListener('click', () => {
  live = !live;
  $('live').classList.toggle('on', live);
  $('live').textContent = live ? '● Live' : '❚❚ Paused';
});
$('reset').addEventListener('click', () => {
  setFloor('all');
  $('explode').value = 0; explode = 0; $('explode-v').textContent = '0 m'; layout();
  select(null);
});
$('collapse').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

function updateAlerts() {
  const list = [];
  for (const r of rooms) {
    if (METRICS.temp.alert(r.temp)) list.push({ r, k: 'temp', txt: `${r.temp.toFixed(1)} °C` });
    else if (METRICS.co2.alert(r.co2)) list.push({ r, k: 'co2', txt: `${Math.round(r.co2)} ppm` });
  }
  const badge = $('alert-count');
  badge.textContent = list.length;
  badge.classList.toggle('zero', list.length === 0);
  const ul = $('alerts');
  if (!list.length) { ul.innerHTML = '<li class="empty">All rooms within range</li>'; return; }
  ul.innerHTML = list.slice(0, 6).map(({ r, k, txt }) =>
    `<li data-id="${r.id}"><b>${r.name}</b> ${k === 'temp' ? 'High temperature' : 'High CO₂'}<span class="v">${txt}</span></li>`).join('');
}
$('alerts').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const r = rooms[Number(li.dataset.id)];
  setFloor(String(r.floor), false);
  select(r, true);
});

// ---------- Selection + info panel ----------
function select(r, fly = false) {
  selected = r;
  if (!r) { selectBox.visible = false; $('info').hidden = true; return; }
  attach(selectBox, r);
  $('info').hidden = false;
  updateInfo();
  if (fly) {
    const y = floors[r.floor].group.position.y;
    const t = new THREE.Vector3(r.cx, y + 1, r.cz);
    flyTo(t.clone().add(new THREE.Vector3(14, 20, 22)), t);
  }
}
$('info-close').addEventListener('click', () => select(null));

function updateInfo() {
  if (!selected) return;
  const r = selected;
  $('info-type').textContent = `${r.type} · Level ${r.floor + 1}`;
  $('info-name').textContent = `Room ${r.name}`;
  $('i-temp').textContent = `${r.temp.toFixed(1)} °C`;
  $('i-co2').textContent = `${Math.round(r.co2)} ppm`;
  $('i-occ').textContent = `${Math.round(r.people)} / ${r.cap}`;
  $('i-area').textContent = `${Math.round(ROOM_W * ROOM_D)} m²`;
  $('spark-label').textContent = `${METRICS[metric].label} (${METRICS[metric].unit})`;
  const flag = $('info-flag');
  const bad = r.temp > 26 ? 'Temperature above 26 °C. Check the HVAC zone.' : r.co2 > 1000 ? 'CO₂ above 1000 ppm. Increase ventilation.' : '';
  flag.hidden = !bad;
  flag.textContent = bad;
  drawSpark(r.hist[metric], METRICS[metric]);
}

function drawSpark(data, m) {
  const c = $('spark');
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  if (data.length < 2) return;
  let lo = Math.min(...data), hi = Math.max(...data);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
  const X = i => (i / (data.length - 1)) * w;
  const Y = v => h - ((v - lo) / (hi - lo)) * h;
  const last = data[data.length - 1];
  const col = '#' + colorFor(metric, last, new THREE.Color()).getHexString();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, col + '55'); grad.addColorStop(1, col + '00');
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(X(data.length - 1), Y(last), 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#64748b'; ctx.font = '11px Inter, sans-serif';
  ctx.fillText(m.fmt(hi - pad), 2, 11);
  ctx.fillText(m.fmt(lo + pad), 2, h - 3);
}

// ---------- Picking ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tip = $('tip');
let downAt = null, pointer = null;

function pick(x, y) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = floors.filter(fl => fl.group.visible).map(fl => fl.tiles);
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return null;
  return rooms[hit.object.userData.floor * ROOMS_PER_FLOOR + hit.instanceId];
}
canvas.addEventListener('pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { pointer = null; hover.visible = false; tip.hidden = true; });
canvas.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; $('hint').style.opacity = 0; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  select(pick(e.clientX, e.clientY));
});

function updateHover() {
  if (!pointer || flying) return;
  const r = pick(pointer.x, pointer.y);
  if (!r) { hover.visible = false; tip.hidden = true; canvas.style.cursor = ''; return; }
  attach(hover, r);
  canvas.style.cursor = 'pointer';
  const m = METRICS[metric];
  tip.hidden = false;
  tip.textContent = `${r.name} · ${r.type} · ${m.fmt(r[metric])} ${m.unit}`;
  tip.style.left = pointer.x + 'px';
  tip.style.top = pointer.y + 'px';
}

// ---------- Camera fly-to ----------
let flying = null;
function flyTo(pos, target) {
  flying = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), t: 0 };
}
function stepFly(dt) {
  if (!flying) return;
  flying.t = Math.min(1, flying.t + dt / 1.1);
  const k = flying.t < 0.5 ? 4 * flying.t ** 3 : 1 - (-2 * flying.t + 2) ** 3 / 2;
  camera.position.lerpVectors(flying.p0, flying.p1, k);
  controls.target.lerpVectors(flying.t0, flying.t1, k);
  if (flying.t >= 1) flying = null;
}

// ---------- Resize + loop ----------
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (selected) drawSpark(selected.hist[metric], METRICS[metric]);
}
new ResizeObserver(resize).observe(canvas);
resize();

const clock = new THREE.Clock();
let frames = 0, acc = 0;
$('inst').textContent = instanceCount.toLocaleString();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.1);
  stepFly(dt);
  controls.update();
  updateHover();
  renderer.render(scene, camera);
  frames++; acc += dt;
  if (acc >= 0.5) {
    $('fps').textContent = Math.round(frames / acc);
    $('calls').textContent = renderer.info.render.calls;
    $('tris').textContent = renderer.info.render.triangles.toLocaleString();
    frames = 0; acc = 0;
  }
  requestAnimationFrame(loop);
}
drawLegend();
updateAlerts();
loop();

// handy for screenshots: ?floor=3&room=L4-05&metric=co2&explode=4
const qs = new URLSearchParams(location.search);
if (qs.has('shot')) document.body.classList.add('shot');
if (qs.has('metric')) $('metric').querySelector(`[data-m="${qs.get('metric')}"]`)?.click();
if (qs.has('explode')) { $('explode').value = qs.get('explode'); $('explode').dispatchEvent(new Event('input')); $('explode').dispatchEvent(new Event('change')); }
if (qs.has('floor')) setFloor(String(Number(qs.get('floor')) - 1));
if (qs.has('room')) { const r = rooms.find(x => x.name === qs.get('room')); if (r) select(r, true); }
