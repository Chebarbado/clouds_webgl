import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CLOUD_TYPES, KIND_ID, PRESETS } from './cloudTypes.js';
import * as S from './shaders.js';
import { buildUI } from './ui.js';
import { sunTransmittance, skyAverage, skyRadiance, mieFromVisibility } from './atmosphere.js';

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
const QUALITY = {
  low: { pr: 0.5, stepNear: 0.09, maxSteps: 256 },
  medium: { pr: 0.75, stepNear: 0.045, maxSteps: 500 },
  high: { pr: 1.0, stepNear: 0.03, maxSteps: 900 },
};
const MAX_LAYERS = 4;
const LAYER_GAP = 100; // м, минимальный зазор между слоями

const state = {
  domainKm: 32, resH: 384, resV: 192, seed: 1,
  layers: [],
  sunAz: 280, sunEl: 35, animateSun: false,
  visibilityKm: 100, densMul: 1, ext: 45, exposure: 1.1, erode: 1.0,
  quality: 'medium', showBox: false,
};

let nextLayerId = 1;
export function makeLayer(type, over = {}) {
  return { id: nextLayerId++, enabled: true, type, ...CLOUD_TYPES[type].defaults, ...over };
}
const layerTop = (l) => l.base + l.minT + l.range;
const layerBottom = (l) => l.base - (CLOUD_TYPES[l.type].rag + CLOUD_TYPES[l.type].wave) * l.minT;

// Слои не пересекаются по вертикали: сортируем и поднимаем перекрывающиеся.
function enforceNonOverlap() {
  const ls = state.layers;
  ls.sort((a, b) => a.base - b.base);
  let moved = false, prevTop = -Infinity;
  for (const l of ls) {
    if (!l.enabled) continue;
    const minBase = prevTop + LAYER_GAP + (l.base - layerBottom(l));
    if (l.base < minBase) { l.base = Math.ceil(minBase / 50) * 50; moved = true; }
    prevTop = layerTop(l);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Рендерер, сцена, камера
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.001, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.maxDistance = 200;
controls.minDistance = 0.05;

const scene = new THREE.Scene();
const box = { min: new THREE.Vector3(), max: new THREE.Vector3(), z0: 0, z1: 2000 };

const atm = {
  sunDir: new THREE.Vector3(), sunColor: new THREE.Vector3(), skyTop: new THREE.Vector3(),
  skyHor: new THREE.Vector3(), ambTop: new THREE.Vector3(), ambBottom: new THREE.Vector3(),
  haze: new THREE.Vector3(), beta: { value: 0.1 }, exposure: { value: 1 },
  betaM: { value: 0.03 }, skySunI: { value: 44 },
};
const shared = {
  uSunDir: { value: atm.sunDir }, uSunColor: { value: atm.sunColor },
  uAmbTop: { value: atm.ambTop }, uAmbBottom: { value: atm.ambBottom },
  uHazeColor: { value: atm.haze }, uHazeBeta: atm.beta, uExposure: atm.exposure,
  uBetaM: atm.betaM, uSkySunI: atm.skySunI,
  uBoxMin: { value: box.min }, uBoxMax: { value: box.max },
  uVol: { value: null }, uExt: { value: state.ext }, uDensMul: { value: state.densMul },
};

// Небо
const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
  vertexShader: S.worldVert, fragmentShader: S.skyFrag, side: THREE.BackSide, depthWrite: false,
  uniforms: { ...shared, uSkyTop: { value: atm.skyTop }, uSkyHor: { value: atm.skyHor } },
}));
sky.renderOrder = 0;
scene.add(sky);

// Земля
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1500, 1500), new THREE.ShaderMaterial({
  vertexShader: S.worldVert, fragmentShader: S.groundFrag, uniforms: { ...shared },
}));
ground.rotation.x = -Math.PI / 2;
ground.renderOrder = 1;
scene.add(ground);

// Облака: бокс объёма, рисуются задние грани
const cloudMat = new THREE.ShaderMaterial({
  vertexShader: S.worldVert, fragmentShader: S.cloudFrag, side: THREE.BackSide,
  transparent: true, depthWrite: false, depthTest: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  uniforms: {
    ...shared,
    uDetail: { value: null }, uDetailScale: { value: 0.6 }, uErode: { value: state.erode },
    uStepNear: { value: 0.05 }, uStepGrow: { value: 0.04 }, uLightStep: { value: 0.05 }, uMaxSteps: { value: 400 },
  },
});
const cloudBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMat);
cloudBox.renderOrder = 2;
cloudBox.frustumCulled = false;
scene.add(cloudBox);

const boxHelper = new THREE.Box3Helper(new THREE.Box3(box.min, box.max), 0xffcc44);
boxHelper.renderOrder = 3;
boxHelper.visible = false;
scene.add(boxHelper);

// ---------------------------------------------------------------------------
// Генерация density volume на GPU: рендер в WebGL3DRenderTarget по срезам
// ---------------------------------------------------------------------------
const fsQuad = new THREE.PlaneGeometry(2, 2);
const fsCam = new THREE.Camera();

// RG8: R — плотность, G — характер края (клубы / волокна)
function make3DTarget(nx, ny, nz, wrap) {
  const rt = new THREE.WebGL3DRenderTarget(nx, ny, nz, { depthBuffer: false });
  const t = rt.texture;
  t.format = THREE.RGFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = wrap;
  renderer.setRenderTarget(rt, 0); // аллокация
  renderer.setRenderTarget(null);
  return rt;
}

function fsScene(fragmentShader, uniforms) {
  const mat = new THREE.ShaderMaterial({ vertexShader: S.fullscreenVert, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(fsQuad, mat);
  mesh.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(mesh);
  return { scene: sc, mat };
}

// Текстура детализации — один раз
{
  const N = 128;
  const rt = make3DTarget(N, N, N, THREE.RepeatWrapping);
  const { scene: sc, mat } = fsScene(S.detailFrag, { uZ: { value: 0 } });
  for (let k = 0; k < N; k++) {
    mat.uniforms.uZ.value = (k + 0.5) / N;
    renderer.setRenderTarget(rt, k);
    renderer.render(sc, fsCam);
  }
  renderer.setRenderTarget(null);
  cloudMat.uniforms.uDetail.value = rt.texture;
}

const v4 = () => Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4());
const gen = fsScene(S.genFrag, {
  uZ: { value: 0 }, uL: { value: 32000 }, uCount: { value: 0 },
  uWind: { value: new THREE.Vector2(1, 0.35).normalize() },
  uLA: { value: v4() }, uLB: { value: v4() }, uLC: { value: v4() }, uLD: { value: v4() }, uLE: { value: v4() }, uLF: { value: v4() },
});
let volRT = null;
const job = { k: 0, nz: 0, active: false, t0: 0, lastMs: 0 };

function startGeneration() {
  const { resH, resV } = state;
  if (!volRT || volRT.width !== resH || volRT.depth !== resV) {
    volRT?.dispose();
    volRT = make3DTarget(resH, resH, resV, THREE.ClampToEdgeWrapping);
    shared.uVol.value = volRT.texture;
    radar.mat.uniforms.uVol.value = volRT.texture;
  }
  const act = state.layers.filter((l) => l.enabled).slice(0, MAX_LAYERS);
  const U = gen.mat.uniforms;
  U.uCount.value = act.length;
  U.uL.value = state.domainKm * 1000;
  const dx = (state.domainKm * 1000) / resH;
  act.forEach((l, i) => {
    const t = CLOUD_TYPES[l.type];
    const seed = ((state.seed * 17.13 + i * 31.7) % 997) + 3.1;
    const cumulo = t.kind === 'cumulo';
    // кучевые: масштаб облаков из толщины слоя и пропорций типа; клубы не мельче ~2 вокселей
    const rTyp = cumulo ? (l.minT + l.range * 0.5) / (2 * t.aspect) : 0;
    const cell = cumulo ? rTyp * t.spacing : t.cell;
    const amp = cumulo ? Math.max(t.billowAmp * rTyp, 1.5 * dx) : 0;
    const bScale = cumulo ? Math.max(t.billowScale * rTyp, 2.5 * dx) : t.billowScale;
    U.uLA.value[i].set(l.base, l.minT, l.range, l.oktas / 8);
    U.uLB.value[i].set(KIND_ID[t.kind], cell, 0, t.density);
    U.uLC.value[i].set(t.taper, t.dome, t.anvilStart, t.anvilSpread);
    U.uLD.value[i].set(amp, bScale, t.rag, t.rows);
    U.uLE.value[i].set(t.skew, t.smoothTop, t.flat, seed);
    U.uLF.value[i].set(t.aspect, t.billowTop, t.billowBottom, cumulo ? t.deck : t.wave);
  });

  // Вертикальный диапазон объёма подстраивается под слои — разное разрешение по вертикали и горизонтали
  if (act.length) {
    box.z0 = Math.max(0, Math.min(...act.map(layerBottom)) - 100);
    box.z1 = Math.max(...act.map(layerTop)) + 100;
  } else { box.z0 = 0; box.z1 = 2000; }
  const h = state.domainKm / 2;
  box.min.set(-h, box.z0 / 1000, -h);
  box.max.set(h, box.z1 / 1000, h);
  cloudBox.scale.set(2 * h, (box.z1 - box.z0) / 1000, 2 * h);
  cloudBox.position.set(0, (box.z0 + box.z1) / 2000, 0);
  boxHelper.box.set(box.min, box.max);
  radar.mat.uniforms.uSpanKm.value = (box.z1 - box.z0) / 1000;

  job.k = 0; job.nz = resV; job.active = true; job.t0 = performance.now();
  ui.updateInfo(volumeInfo());
}

function stepGeneration() {
  if (!job.active) return;
  const per = Math.max(4, Math.floor(6e6 / (state.resH * state.resH)));
  const U = gen.mat.uniforms;
  for (let n = 0; n < per && job.k < job.nz; n++, job.k++) {
    U.uZ.value = box.z0 + ((job.k + 0.5) / job.nz) * (box.z1 - box.z0);
    renderer.setRenderTarget(volRT, job.k);
    renderer.render(gen.scene, fsCam);
  }
  renderer.setRenderTarget(null);
  if (job.k >= job.nz) { job.active = false; job.lastMs = performance.now() - job.t0; }
}

function volumeInfo() {
  const dx = (state.domainKm * 1000) / state.resH;
  const dz = (box.z1 - box.z0) / state.resV;
  const mb = (2 * state.resH * state.resH * state.resV) / 1048576;
  return `Объём ${state.resH}×${state.resH}×${state.resV} (${mb.toFixed(0)} МБ, RG8: плотность + тип края)<br>` +
    `Воксель: ${dx.toFixed(0)} × ${dx.toFixed(0)} м по горизонтали, ${dz.toFixed(0)} м по вертикали<br>` +
    `Высоты: ${box.z0.toFixed(0)}–${box.z1.toFixed(0)} м`;
}

// ---------------------------------------------------------------------------
// Метеорадар (миникарта)
// ---------------------------------------------------------------------------
const radar = fsScene(S.radarFrag, { uVol: { value: null }, uSpanKm: { value: 1 } });
const RADAR_PX = 300, RADAR_RIGHT = 16, RADAR_BOTTOM = 34;
const radarCanvas = document.getElementById('radarOverlay');
const rctx = radarCanvas.getContext('2d');

function drawRadarOverlay(time) {
  const dpr = devicePixelRatio;
  const W = RADAR_PX;
  if (radarCanvas.width !== W * dpr) { radarCanvas.width = radarCanvas.height = W * dpr; }
  const c = rctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, W);
  const cx = W / 2;
  // кольца дальности
  c.strokeStyle = 'rgba(120,255,160,0.35)';
  c.lineWidth = 1;
  for (let i = 1; i <= 4; i++) { c.beginPath(); c.arc(cx, cx, (cx * i) / 4, 0, Math.PI * 2); c.stroke(); }
  c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, W); c.moveTo(0, cx); c.lineTo(W, cx); c.stroke();
  // развёртка
  const ang = (time * 0.0012) % (Math.PI * 2);
  if (c.createConicGradient) {
    const g = c.createConicGradient(ang - 0.9, cx, cx);
    g.addColorStop(0, 'rgba(80,255,140,0)');
    g.addColorStop(0.9 / (Math.PI * 2), 'rgba(80,255,140,0.28)');
    g.addColorStop(0.9 / (Math.PI * 2) + 0.001, 'rgba(80,255,140,0)');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(cx, cx); c.arc(cx, cx, cx, ang - 0.9, ang); c.closePath(); c.fill();
  }
  c.strokeStyle = 'rgba(140,255,180,0.8)';
  c.beginPath(); c.moveTo(cx, cx); c.lineTo(cx + Math.cos(ang) * cx, cx + Math.sin(ang) * cx); c.stroke();
  // подписи
  c.fillStyle = 'rgba(200,255,210,0.9)';
  c.font = '11px system-ui, sans-serif';
  c.fillText('N', cx + 4, 12);
  c.fillText(`R ${(state.domainKm / 2).toFixed(0)} км`, 6, W - 6);
  // камера: позиция и направление взгляда
  const toPx = (x, z) => [((x - box.min.x) / (box.max.x - box.min.x)) * W, ((z - box.min.z) / (box.max.z - box.min.z)) * W];
  const [px, py] = toPx(camera.position.x, camera.position.z);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const yaw = Math.atan2(fwd.z, fwd.x);
  const half = THREE.MathUtils.degToRad(camera.fov * camera.aspect * 0.5);
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.beginPath(); c.moveTo(px, py);
  c.arc(px, py, 46, yaw - Math.min(half, 1.2), yaw + Math.min(half, 1.2)); c.closePath(); c.fill();
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill();
  const [tx, ty] = toPx(controls.target.x, controls.target.z);
  c.strokeStyle = 'rgba(255,220,80,0.9)';
  c.beginPath(); c.moveTo(tx - 5, ty); c.lineTo(tx + 5, ty); c.moveTo(tx, ty - 5); c.lineTo(tx, ty + 5); c.stroke();
}

// Клик по миникарте переносит точку обзора
radarCanvas.addEventListener('click', (e) => {
  const r = radarCanvas.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  const x = box.min.x + u * (box.max.x - box.min.x), z = box.min.z + v * (box.max.z - box.min.z);
  const d = new THREE.Vector3(x - controls.target.x, 0, z - controls.target.z);
  controls.target.add(d);
  camera.position.add(d);
});

// ---------------------------------------------------------------------------
// Атмосфера и солнце
// ---------------------------------------------------------------------------
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Интенсивности: солнце, освещающее облака, и множитель яркости неба (их отношение фиксировано,
// поэтому небо, облака и дымка согласованы между собой и с цветом солнца на любой его высоте).
const SUN_I = 3.4, SKY_I = SUN_I * 13;

function updateAtmosphere() {
  const az = THREE.MathUtils.degToRad(state.sunAz), el = THREE.MathUtils.degToRad(state.sunEl);
  atm.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const sd = atm.sunDir.toArray();
  const betaM = mieFromVisibility(state.visibilityKm);
  atm.betaM.value = Math.min(betaM, 0.25);           // для модели неба; плотный туман добавляется отдельно
  atm.skySunI.value = SKY_I;
  // солнце, прошедшее атмосферу до высоты облаков: днём белое, на закате оранжевое
  const T = sunTransmittance(2, sd, atm.betaM.value);
  atm.sunColor.set(T[0], T[1], T[2]).multiplyScalar(SUN_I);
  // окружающий свет неба (среднее по верхней полусфере, с весом cos) и отражённый от земли
  const sky = skyAverage(2, sd, atm.betaM.value, [10, 35, 60, 85], [0.17, 0.57, 0.87, 1.0]);
  atm.ambTop.set(sky[0], sky[1], sky[2]).multiplyScalar(SKY_I * 0.8);
  const sunUp = Math.max(Math.sin(el), 0);
  // отражённый от земли свет (ламбертово: альбедо·E/π)
  atm.ambBottom.copy(atm.sunColor).multiplyScalar(sunUp).add(atm.ambTop.clone().multiplyScalar(Math.PI)).multiplyScalar(0.15 / Math.PI);
  // дымка: цвет неба у горизонта перпендикулярно солнцу (пик Ми добавляется в шейдерах по направлению); в тумане — серая
  const e4 = THREE.MathUtils.degToRad(4);
  const hor = skyRadiance(0.3, [Math.cos(az) * Math.cos(e4), Math.sin(e4), Math.sin(az) * Math.cos(e4)], sd, atm.betaM.value);
  const fogT = smooth(15, 1, state.visibilityKm);
  const grey = (atm.ambTop.x + atm.ambTop.y + atm.ambTop.z) / 3 * 1.4;
  atm.haze.set(hor[0], hor[1], hor[2]).multiplyScalar(SKY_I).lerp(new THREE.Vector3(grey, grey, grey * 1.04), 0.8 * fogT);
  atm.skyTop.copy(atm.ambTop);
  atm.skyHor.copy(atm.haze);
  atm.beta.value = 3.912 / state.visibilityKm; // Кошмидер: МДВ при контрасте 2%
  atm.exposure.value = state.exposure;
}

function applyQuality() {
  const q = QUALITY[state.quality];
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5) * q.pr);
  renderer.setSize(innerWidth, innerHeight);
  cloudMat.uniforms.uStepNear.value = q.stepNear;
  cloudMat.uniforms.uMaxSteps.value = q.maxSteps;
}

// ---------------------------------------------------------------------------
// Камера
// ---------------------------------------------------------------------------
function setCameraView(kind) {
  const L = state.domainKm;
  const zMid = (box.z0 + box.z1) / 2000;
  const act = state.layers.filter((l) => l.enabled);
  const t = controls.target, p = camera.position;
  switch (kind) {
    case 'ground': t.set(0, Math.max(1.5, zMid), -L * 0.25); p.set(0, 0.002, L * 0.2); break;
    case 'top': t.set(0, 0, 0); p.set(0, L * 1.25, 0.01); break;
    case 'above': {                                   // над облаками, взгляд вниз под ~25°
      const top = box.z1 / 1000;
      t.set(0, Math.max(top * 0.6, 0.5), -L * 0.15); p.set(-L * 0.08, top + 1.5, L * 0.3); break;
    }
    case 'below': {                                   // под облаками, взгляд вверх под ~35°
      const l = act[0];
      const y = l ? (l.base + l.minT) / 1000 : 2;
      t.set(0, y, -L * 0.1); p.set(0, 0.002, L * 0.12); break;
    }
    case 'side': t.set(0, zMid, 0); p.set(0, zMid, L * 1.1); break;
    case 'inside': {
      const l = act[0];
      const y = l ? (l.base + l.minT * 0.5) / 1000 : 1;
      t.set(0, y, -2); p.set(0, y, 0); break;
    }
    case 'closeup': {
      const l = act[0];
      // из-под нижней границы — камера гарантированно не внутри облака
      const base = l ? l.base / 1000 : 1;
      t.set(0, base + (l ? (l.minT + l.range) * 0.3 / 1000 : 1), 0);
      p.set(-L * 0.4, base * 0.6, L * 0.4); break;
    }
    default: t.set(0, zMid * 0.7, 0); p.set(-L * 0.6, Math.max(3, L * 0.22), L * 0.7);
  }
  controls.update();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function applyPreset(key) {
  const pr = PRESETS[key];
  state.domainKm = pr.domainKm;
  state.layers = pr.layers.map(({ type, ...over }) => makeLayer(type, over));
  enforceNonOverlap();
  ui.refresh();
  startGeneration();
  setCameraView(pr.camera || 'overview');
}

const ui = buildUI({
  state, CLOUD_TYPES, PRESETS, MAX_LAYERS, makeLayer, layerTop, enforceNonOverlap,
  onLayersChanged: () => startGeneration(),
  onVolumeChanged: () => startGeneration(),
  onAtmosphereChanged: () => updateAtmosphere(),
  onRenderChanged: () => {
    shared.uExt.value = state.ext;
    shared.uDensMul.value = state.densMul;
    cloudMat.uniforms.uErode.value = state.erode;
    boxHelper.visible = state.showBox;
    applyQuality();
  },
  onPreset: applyPreset,
  onCamera: setCameraView,
});

window.clouds = { camera, controls, state }; // для отладки из консоли

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Цикл
// ---------------------------------------------------------------------------
updateAtmosphere();
applyQuality();
applyPreset('congestusCirrus');

let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0;
renderer.setAnimationLoop((time) => {
  const dt = (time - last) / 1000; last = time;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  if (state.animateSun) { state.sunAz = (state.sunAz + dt * 12) % 360; ui.syncSun(); updateAtmosphere(); }

  stepGeneration();
  controls.update();
  if (camera.position.y < 0.002) camera.position.y = 0.002;
  sky.position.copy(camera.position);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.render(scene, camera);

  // миникарта радара в правом нижнем углу
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  const x = innerWidth - RADAR_PX - RADAR_RIGHT;
  renderer.setScissor(x, RADAR_BOTTOM, RADAR_PX, RADAR_PX);
  renderer.setViewport(x, RADAR_BOTTOM, RADAR_PX, RADAR_PX);
  renderer.render(radar.scene, fsCam);
  renderer.setScissorTest(false);
  renderer.autoClear = true;
  drawRadarOverlay(time);

  const alt = (camera.position.y * 1000).toFixed(0);
  ui.setHud(`${fps.toFixed(0)} FPS · камера ${alt} м` +
    (job.active ? ` · генерация ${Math.round((job.k / job.nz) * 100)}%` : ` · объём за ${job.lastMs.toFixed(0)} мс`));
});
