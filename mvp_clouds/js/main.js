import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CLOUD_TYPES, KIND_ID, PRESETS, TYPE_ABBR } from './cloudTypes.js';
import * as S from './shaders.js';
import { buildUI } from './ui.js';
import { sunTransmittance, skyAverage, skyRadiance, mieFromVisibility } from './atmosphere.js';
import { packState, unpackState, encode, decode, hashCode } from './share.js';
import { LOCATIONS, IMAGERY, loadTerrain } from './terrain.js';

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
// Телефон/планшет: узкий экран или сенсорный ввод — меньше объём, лёгкий рендер, панель-шторка
const MOBILE = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
const QUALITY = {
  // lite — облегчённое освещение: 4 выборки к солнцу, без боковой затенённости и второй октавы деталей
  low: { pr: MOBILE ? 0.4 : 0.5, stepNear: 0.09, maxSteps: MOBILE ? 160 : 256, lite: 1 },
  medium: { pr: 0.75, stepNear: 0.045, maxSteps: 500, lite: 0 },
  high: { pr: 1.0, stepNear: 0.03, maxSteps: 900, lite: 0 },
};
const MAX_LAYERS = 4;       // слоёв в одной зоне
const MAX_GROUPS = 8;       // разных слоёв (тип + номер) во всём мире
const MAX_ZONES = 9;        // сетка зон до 3×3
const LAYER_GAP = 100;      // м, минимальный зазор между слоями зоны
const MAX_ATLAS = 1024;     // предел стороны атласа зон по горизонтали, текселей
const MAX_VOXELS = MOBILE ? 40e6 : 160e6;   // предел суммарного объёма (RG8: ~80 / ~320 МБ видеопамяти)
const GEN_BUDGET = MOBILE ? 1.5e6 : 6e6;     // вокселей генерации за кадр
const MOBILE_RES = { resH: 256, resV: 128 }; // предел разрешения на телефоне

const state = {
  tileKm: 32, resH: MOBILE ? MOBILE_RES.resH : 384, resV: MOBILE ? MOBILE_RES.resV : 192, seed: 1,
  grid: { nx: 1, ny: 1 }, zones: [{ layers: [] }], sel: 0, blendKm: 8, slabMode: 'auto',
  wind: false, windSpeed: 12, windFrom: 290, develop: false, timeScale: 30,
  sunAz: 280, sunEl: 35, animateSun: false,
  visibilityKm: 100, densMul: 1, ext: 45, exposure: 1.1, erode: 1.0,
  quality: MOBILE ? 'low' : 'medium', showBox: false,
  terrain: '', imagery: 's2', raiseClouds: true,   // ландшафт: '' — процедурная земля
};
// слои выбранной зоны — их редактирует панель
Object.defineProperty(state, 'layers', {
  get: () => state.zones[state.sel].layers,
  set: (v) => { state.zones[state.sel].layers = v; },
});

let nextLayerId = 1;
export function makeLayer(type, over = {}) {
  return { id: nextLayerId++, enabled: true, type, ...CLOUD_TYPES[type].defaults, ...over };
}
const layerTop = (l) => l.base + l.minT + l.range;
const layerBottom = (l) => l.base - (CLOUD_TYPES[l.type].rag + CLOUD_TYPES[l.type].wave) * l.minT;
const cloneLayers = (ls) => ls.map((l) => ({ ...l, id: nextLayerId++ }));

// Слои зоны не пересекаются по вертикали: сортируем и поднимаем перекрывающиеся.
function enforceNonOverlap(ls = state.layers) {
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

// Смена сетки зон: существующие зоны сохраняются по координатам, новые копируют ближайшую
function setGrid(nx, ny) {
  const old = state.zones, onx = state.grid.nx, ony = state.grid.ny;
  const zones = [];
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const src = old[Math.min(ty, ony - 1) * onx + Math.min(tx, onx - 1)];
    zones.push(tx < onx && ty < ony ? src : { layers: cloneLayers(src.layers) });
  }
  state.grid = { nx, ny };
  state.zones = zones;
  state.sel = Math.min(state.sel, zones.length - 1);
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
controls.maxDistance = 300;
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
  // ярусы density volume: нижний и верхний (если ярус один — оба указывают на него)
  uVol: { value: null }, uVolHi: { value: null }, uSplitY: { value: 1e9 },
  uLoY: { value: new THREE.Vector2(0, 1) }, uHiY: { value: new THREE.Vector2(0, 1) },
  // динамика: второй ключевой кадр, вес смешивания и снос ветром каждого кадра (км)
  uVolB: { value: null }, uVolHiB: { value: null }, uMixB: { value: 0 },
  uShiftA: { value: new THREE.Vector2() }, uShiftB: { value: new THREE.Vector2() },
  uExt: { value: state.ext }, uDensMul: { value: state.densMul },
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
  vertexShader: S.worldVert, fragmentShader: S.groundFrag, uniforms: { ...shared, uHole: { value: new THREE.Vector4(1, 1, -1, -1) } },
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
    uDetailShift: { value: new THREE.Vector2() }, uBoil: { value: 0 },
    uStepNear: { value: 0.05 }, uStepGrow: { value: 0.04 }, uLightStep: { value: 0.05 }, uMaxSteps: { value: 400 }, uLite: { value: 0 },
    uDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.001 }, uFar: { value: 2000 },
    uCamFwd: { value: new THREE.Vector3() },
  },
});
const cloudBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMat);
cloudBox.renderOrder = 2;
cloudBox.frustumCulled = false;
const cloudScene = new THREE.Scene();
cloudScene.add(cloudBox);

// Непрозрачная сцена (небо, земля, рельеф, здания) рендерится в буфер с глубиной: облака по ней
// обрываются на первой поверхности — гора или здание перед облаком закрывает его
const opaqueRT = new THREE.WebGLRenderTarget(1, 1);
opaqueRT.depthTexture = new THREE.DepthTexture(1, 1);
opaqueRT.depthTexture.type = THREE.UnsignedIntType;
cloudMat.uniforms.uDepth.value = opaqueRT.depthTexture;
function resizeTargets() {
  const v = renderer.getDrawingBufferSize(new THREE.Vector2());
  opaqueRT.setSize(v.x, v.y);
  cloudMat.uniforms.uRes.value.copy(v);
}

const boxHelper = new THREE.Box3Helper(new THREE.Box3(box.min, box.max), 0xffcc44);
boxHelper.renderOrder = 3;
boxHelper.visible = false;
scene.add(boxHelper);

// ---------------------------------------------------------------------------
// Генерация density volume на GPU: рендер в WebGL3DRenderTarget по срезам и по зонам
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

const blit = fsScene(S.blitFrag, { uTex: { value: opaqueRT.texture } });

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

const vec4s = (n) => Array.from({ length: n }, () => new THREE.Vector4());
const gen = fsScene(S.genFrag, {
  uZ: { value: 0 }, uOrigin: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2() },
  uWorld: { value: new THREE.Vector2() }, uGrid: { value: new THREE.Vector2(1, 1) },
  uTile: { value: 32000 }, uBlend: { value: 8000 }, uNG: { value: 0 },
  uOff: { value: new THREE.Vector2() }, uTime: { value: 0 }, uDev: { value: 0 },
  uWind: { value: new THREE.Vector2(1, 0.35).normalize() },
  uGA: { value: vec4s(MAX_GROUPS * MAX_ZONES) },
  uGB: { value: vec4s(MAX_GROUPS) }, uGC: { value: vec4s(MAX_GROUPS) }, uGD: { value: vec4s(MAX_GROUPS) },
  uGE: { value: vec4s(MAX_GROUPS) }, uGF: { value: vec4s(MAX_GROUPS) }, uGZ: { value: vec4s(MAX_GROUPS) },
});

// Группы: одинаковые слои (тип + номер среди слоёв этого типа) всех зон — одна популяция облаков
// с общей сеткой ячеек и seed. Для каждой зоны: высоты и покрытие; у зоны без такого слоя покрытие 0,
// а высоты — от ближайшего по высоте слоя того же семейства в этой зоне (при переходе высоты тоже перетекают).
const family = (t) => (CLOUD_TYPES[t].kind === 'cirrus' ? 1 : 0);
function buildGroups() {
  const nz = state.zones.length;
  const map = new Map();
  state.zones.forEach((zn, zi) => {
    const ls = zn.layers.filter((l) => l.enabled).sort((a, b) => a.base - b.base).slice(0, MAX_LAYERS);
    const cnt = {};
    for (const l of ls) {
      const rank = cnt[l.type] = (cnt[l.type] ?? -1) + 1;
      const key = `${l.type}#${rank}`;
      if (!map.has(key)) map.set(key, { key, type: l.type, rank, entries: new Array(nz).fill(null) });
      map.get(key).entries[zi] = l;
    }
  });
  const all = [...map.values()];
  const groups = all.slice(0, MAX_GROUPS);
  for (const g of groups) {
    const t = CLOUD_TYPES[g.type];
    const present = g.entries.filter(Boolean);
    const mean = (k) => present.reduce((s, l) => s + l[k], 0) / present.length;
    const mBase = mean('base');
    g.zone = state.zones.map((zn, zi) => {
      const l = g.entries[zi];
      if (l) return { base: l.base, minT: l.minT, range: l.range, cov: l.oktas / 8 };
      let best = null, bd = 2500;
      for (const o of zn.layers) {
        if (o.enabled && family(o.type) === family(g.type) && Math.abs(o.base - mBase) < bd) { bd = Math.abs(o.base - mBase); best = o; }
      }
      const h = best ?? { base: mBase, minT: mean('minT'), range: mean('range') };
      return { base: h.base, minT: h.minT, range: h.range, cov: 0 };
    });
    g.zmin = Math.min(...g.zone.map((z) => z.base - (t.rag + t.wave) * z.minT));
    g.zmax = Math.max(...g.zone.map((z) => z.base + z.minT + z.range));
    // масштаб кучевых — по зонам, где слой есть (сетка ячеек общая для всего мира)
    g.rTyp = t.kind === 'cumulo' ? Math.max(...present.map((l) => l.minT + l.range * 0.5)) / (2 * t.aspect) : 0;
  }
  return { groups, dropped: all.length - groups.length };
}

// План объёма (ярусы, размеры атласа) и ключевые кадры. Без динамики кадр один. С ветром/развитием —
// три кадра по кругу: рендер смешивает кадры [0] и [1] со сдвигом по ветру, кадр [2] генерируется в фоне.
let plan = null;              // { slabs: [{ z0, z1, split, nz }], AW, AH }
let sets = [];                // кадры: { rts: [rt на ярус], t (с), off (м), ready }
let tileRes = 384;
let groupsInfo = { groups: [], dropped: 0 };
const job = { set: null, s: 0, k: 0, t: 0, active: false, t0: 0, lastMs: 0, total: 1, done: 0 };
const anim = { t: 0, off: new THREE.Vector2() };   // модельное время (с) и накопленный снос ветром (м)
const KEY_REAL = 2.5;                              // реальных секунд между ключевыми кадрами
const animOn = () => state.wind || state.develop;
// направление, куда дует ветер (в координатах генерации: x — восток, y — юг); метеонаправление — откуда
function windDir() {
  const b = THREE.MathUtils.degToRad((state.windFrom + 180) % 360);
  return new THREE.Vector2(Math.sin(b), -Math.cos(b));
}
const windVec = () => windDir().multiplyScalar(state.wind ? state.windSpeed : 0);   // м/с

// Вертикальное деление на ярусы: по самому большому промежутку между слоями, иначе посередине
function planSlabs(z0, z1, groups) {
  if (state.slabMode !== 'auto' || z1 - z0 < 4500) return [[z0, z1]];
  const bands = groups.map((g) => [g.zmin, g.zmax]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of bands) {
    const m = merged[merged.length - 1];
    if (m && b[0] <= m[1] + 300) m[1] = Math.max(m[1], b[1]); else merged.push([...b]);
  }
  let split = (z0 + z1) / 2, gap = 0;
  for (let i = 1; i < merged.length; i++) {
    const gp = merged[i][0] - merged[i - 1][1];
    if (gp > gap) { gap = gp; split = (merged[i][0] + merged[i - 1][1]) / 2; }
  }
  if (gap < 800) split = (z0 + z1) / 2;
  return [[z0, split], [split, z1]];
}

function startGeneration() {
  const { nx, ny } = state.grid;
  state.blendKm = Math.min(state.blendKm, state.tileKm * 0.9);
  groupsInfo = buildGroups();
  const { groups } = groupsInfo;
  const nSets = animOn() ? 3 : 1;

  // разрешение зоны: сторона атласа не больше MAX_ATLAS
  tileRes = Math.min(state.resH, Math.floor(MAX_ATLAS / Math.max(nx, ny) / 16) * 16);
  const AW = nx * tileRes, AH = ny * tileRes;

  // высоты мира и ярусы; объём на кадр — с учётом числа кадров
  if (groups.length) {
    box.z0 = Math.max(0, Math.min(...groups.map((g) => g.zmin)) - 100);
    box.z1 = Math.max(...groups.map((g) => g.zmax)) + 100;
  } else { box.z0 = 0; box.z1 = 2000; }
  const ranges = planSlabs(box.z0, box.z1, groups);
  const nzMax = Math.floor(MAX_VOXELS / nSets / (AW * AH * ranges.length) / 16) * 16;
  const nz = Math.max(48, Math.min(state.resV, nzMax));
  // ярусы перекрываются на один срез — на границе оба считают одну и ту же функцию, шва нет
  plan = {
    AW, AH,
    slabs: ranges.map(([a, b], i) => {
      const pad = (b - a) / nz;
      return { z0: i > 0 ? a - pad : a, z1: i < ranges.length - 1 ? b + pad : b, split: b, nz };
    }),
  };

  // текстуры кадров: переиспользуем, если размеры совпали
  const fits = (rt) => rt && rt.width === AW && rt.height === AH && rt.depth === nz;
  const newSets = [];
  for (let i = 0; i < nSets; i++) {
    const old = sets[i];
    const rts = plan.slabs.map((sl, j) => {
      const rt = old?.rts[j];
      if (fits(rt)) return rt;
      rt?.dispose();
      return make3DTarget(AW, AH, nz, THREE.ClampToEdgeWrapping);
    });
    old?.rts.slice(plan.slabs.length).forEach((rt) => rt.dispose());
    newSets.push({ rts, t: anim.t, off: anim.off.clone(), ready: false });
  }
  sets.slice(nSets).forEach((s) => s.rts.forEach((rt) => rt.dispose()));
  sets = newSets;

  const lo = plan.slabs[0], hi = plan.slabs[plan.slabs.length - 1];
  shared.uSplitY.value = plan.slabs.length > 1 ? lo.split / 1000 : 1e9;
  shared.uLoY.value.set(lo.z0 / 1000, lo.z1 / 1000);
  shared.uHiY.value.set(hi.z0 / 1000, hi.z1 / 1000);

  // параметры групп
  const U = gen.mat.uniforms;
  const dx = (state.tileKm * 1000) / tileRes;
  const typeKeys = Object.keys(CLOUD_TYPES);
  U.uNG.value = groups.length;
  U.uGrid.value.set(nx, ny);
  U.uTile.value = state.tileKm * 1000;
  U.uBlend.value = Math.max(1, state.blendKm * 1000);
  U.uWorld.value.set(nx * state.tileKm * 1000, ny * state.tileKm * 1000);
  U.uSize.value.set(state.tileKm * 1000, state.tileKm * 1000);
  groups.forEach((g, gi) => {
    const t = CLOUD_TYPES[g.type];
    const cumulo = t.kind === 'cumulo';
    const seed = ((state.seed * 17.13 + typeKeys.indexOf(g.type) * 31.7 + g.rank * 57.3) % 997) + 3.1;
    // кучевые: масштаб облаков из толщины слоя и пропорций типа; клубы не мельче ~2 вокселей
    const cell = cumulo ? g.rTyp * t.spacing : t.cell;
    const amp = cumulo ? Math.max(t.billowAmp * g.rTyp, 1.5 * dx) : 0;
    const bScale = cumulo ? Math.max(t.billowScale * g.rTyp, 2.5 * dx) : t.billowScale;
    U.uGB.value[gi].set(KIND_ID[t.kind], cell, 0, t.density);
    U.uGC.value[gi].set(t.taper, t.dome, t.anvilStart, t.anvilSpread);
    U.uGD.value[gi].set(amp, bScale, t.rag, t.rows);
    U.uGE.value[gi].set(t.skew, t.smoothTop, t.flat, seed);
    U.uGF.value[gi].set(t.aspect, t.billowTop, t.billowBottom, cumulo ? t.deck : t.wave);
    U.uGZ.value[gi].set(g.zmin, g.zmax, t.life, 0);
    g.zone.forEach((z, zi) => U.uGA.value[gi * MAX_ZONES + zi].set(z.base, z.minT, z.range, z.cov));
  });

  // мир по горизонтали — сетка зон, центр в начале координат
  const wx = nx * state.tileKm, wz = ny * state.tileKm;
  box.min.set(-wx / 2, box.z0 / 1000, -wz / 2);
  box.max.set(wx / 2, box.z1 / 1000, wz / 2);
  cloudBox.scale.set(wx, (box.z1 - box.z0) / 1000, wz);
  cloudBox.position.set(0, (box.z0 + box.z1) / 2000, 0);
  boxHelper.box.set(box.min, box.max);

  startJob(sets[0]);
  bindFrames(0);
  ui.updateInfo(volumeInfo());
}

function startJob(set) {
  set.ready = false;
  Object.assign(job, { set, s: 0, k: 0, t: 0, active: true, t0: performance.now(), done: 0,
    total: plan.slabs.length * plan.slabs[0].nz * state.zones.length });
}

// Следующий нужный кадр: [1] через шаг после [0], затем [2] через шаг после [1]; снос — прогноз по текущему ветру
function scheduleNext() {
  if (!animOn() || sets.length < 3) return;
  const step = KEY_REAL * state.timeScale;
  const next = !sets[1].ready ? 1 : !sets[2].ready ? 2 : -1;
  if (next < 0) return;
  const s = sets[next];
  s.t = sets[next - 1].t + step;
  s.off = anim.off.clone().addScaledVector(windVec(), s.t - anim.t);
  startJob(s);
}

// Один проход = один срез одной зоны (её собственный density volume); зоны пишутся в свои области атласа
function genPass() {
  const { nx } = state.grid;
  const set = job.set, sl = plan.slabs[job.s];
  const tx = job.t % nx, ty = Math.floor(job.t / nx);
  const U = gen.mat.uniforms;
  U.uZ.value = sl.z0 + ((job.k + 0.5) / sl.nz) * (sl.z1 - sl.z0);
  U.uOrigin.value.set(tx * state.tileKm * 1000, ty * state.tileKm * 1000);
  U.uOff.value.copy(set.off);
  U.uTime.value = set.t;
  U.uDev.value = state.develop ? 1 : 0;
  U.uWind.value.copy(windDir());
  const rt = set.rts[job.s];
  rt.viewport.set(tx * tileRes, ty * tileRes, tileRes, tileRes);
  renderer.setRenderTarget(rt, job.k);
  renderer.render(gen.scene, fsCam);
  job.done++;
  if (++job.t >= state.zones.length) { job.t = 0; if (++job.k >= sl.nz) { job.k = 0; job.s++; } }
  if (job.s >= plan.slabs.length) {
    job.active = false;
    job.lastMs = performance.now() - job.t0;
    set.ready = true;
    scheduleNext();
  }
}

function stepGeneration(all = false) {
  if (!job.active) return;
  const per = all ? Infinity : Math.max(1, Math.floor(GEN_BUDGET / (tileRes * tileRes)));
  const ac = renderer.autoClear;
  renderer.autoClear = false;   // очистка стёрла бы соседние зоны в том же срезе атласа
  for (let n = 0; n < per && job.active; n++) genPass();
  renderer.autoClear = ac;
  renderer.setRenderTarget(null);
}

// Привязка кадров к шейдерам: A = кадр [0], B = кадр [1] с весом mixB; сдвиг — снос с момента кадра
function bindFrames(mixB) {
  const A = sets[0], B = mixB > 0 ? sets[1] : sets[0];
  shared.uVol.value = A.rts[0].texture;
  shared.uVolHi.value = A.rts[A.rts.length - 1].texture;
  shared.uVolB.value = B.rts[0].texture;
  shared.uVolHiB.value = B.rts[B.rts.length - 1].texture;
  shared.uMixB.value = mixB;
  shared.uShiftA.value.copy(anim.off).sub(A.off).multiplyScalar(0.001);
  shared.uShiftB.value.copy(anim.off).sub(B.off).multiplyScalar(0.001);
  cloudMat.uniforms.uDetailShift.value.copy(anim.off).multiplyScalar(0.001);
  cloudMat.uniforms.uBoil.value = state.develop ? anim.t * 0.0015 : 0;
}

// Модельное время идёт, пока готовы кадры [0] и [1]; дойдя до [1], кадры сдвигаются по кругу
function updateAnim(dt) {
  if (!animOn() || sets.length < 3 || !sets[0].ready || !sets[1].ready) { bindFrames(0); return; }
  let nt = anim.t + dt * state.timeScale;
  if (nt >= sets[1].t) {
    if (sets[2].ready) {
      sets.push(sets.shift());          // [1] → [0], [2] → [1], старый [0] — под новый кадр
      sets[2].ready = false;
      scheduleNext();
    }
    nt = Math.min(nt, sets[1].t);       // следующий кадр ещё не готов — ждём, без рывка
  }
  anim.off.addScaledVector(windVec(), nt - anim.t);
  anim.t = nt;
  bindFrames(Math.min(1, Math.max(0, (anim.t - sets[0].t) / (sets[1].t - sets[0].t))));
}

function volumeInfo() {
  const { nx, ny } = state.grid;
  const dxm = (state.tileKm * 1000) / tileRes;
  const nz = plan.slabs[0].nz;
  const mb = (sets.length * plan.slabs.length * 2 * plan.AW * plan.AH * nz) / 1048576;
  const zinfo = plan.slabs.map((sl, i) => `${plan.slabs.length > 1 ? (i ? 'Верхний ярус' : 'Нижний ярус') : 'Высоты'}: ` +
    `${sl.z0.toFixed(0)}–${sl.z1.toFixed(0)} м, ${((sl.z1 - sl.z0) / sl.nz).toFixed(0)} м/воксель`).join('<br>');
  const warn = groupsInfo.dropped ? `<br><span class="warn">Разных слоёв больше ${MAX_GROUPS} — лишние не показаны</span>` : '';
  const frames = sets.length > 1 ? `<br>Динамика: ${sets.length} ключевых кадра (разрешение снижено, чтобы уместить их в память)` : '';
  return `Density volume: ${nx}×${ny} зон × ${plan.slabs.length} яр. = <b>${nx * ny * plan.slabs.length}</b>, ` +
    `каждый ${tileRes}×${tileRes}×${nz} (RG8, всего ${mb.toFixed(0)} МБ)<br>` +
    `Воксель по горизонтали: ${dxm.toFixed(0)} м<br>${zinfo}${warn}${frames}`;
}

// ---------------------------------------------------------------------------
// Экспорт density volume выбранной зоны (текущий ключевой кадр): uint8 0..255, файл .cvol
//   [uint32 LE длина JSON][JSON-заголовок][ярусы подряд: x быстрее всего, затем z (с севера на юг), затем высота]
// ---------------------------------------------------------------------------
const copy = fsScene(S.copySliceFrag, { uSrc: { value: null }, uRegion: { value: new THREE.Vector4() }, uR: { value: 0 } });
function exportZone() {
  while (!sets[0].ready) stepGeneration(true);
  const { nx, ny } = state.grid;
  const tx = state.sel % nx, ty = Math.floor(state.sel / nx);
  const N = tileRes;
  const rt = new THREE.WebGLRenderTarget(N, N, { depthBuffer: false });
  const px = new Uint8Array(N * N * 4);
  const parts = [];
  const U = copy.mat.uniforms;
  U.uRegion.value.set(tx / nx, ty / ny, 1 / nx, 1 / ny);
  plan.slabs.forEach((sl, j) => {
    const data = new Uint8Array(N * N * sl.nz);
    U.uSrc.value = sets[0].rts[j].texture;
    for (let k = 0; k < sl.nz; k++) {
      U.uR.value = (k + 0.5) / sl.nz;
      renderer.setRenderTarget(rt);
      renderer.render(copy.scene, fsCam);
      renderer.readRenderTargetPixels(rt, 0, 0, N, N, px);
      for (let i = 0; i < N * N; i++) data[k * N * N + i] = px[i * 4];
    }
    parts.push(data);
  });
  renderer.setRenderTarget(null);
  rt.dispose();
  const wx = nx * state.tileKm, wz = ny * state.tileKm;
  const header = {
    format: 'cloud-density-volume/1', zone: [tx, ty], grid: [nx, ny],
    originKm: [-wx / 2 + tx * state.tileKm, -wz / 2 + ty * state.tileKm], sizeKm: [state.tileKm, state.tileKm],
    voxels: [N, N], slabs: plan.slabs.map((sl) => ({ z0: sl.z0, z1: sl.z1, nz: sl.nz })),
    layers: state.zones[state.sel].layers.filter((l) => l.enabled).map(({ type, base, minT, range, oktas }) => ({ type, base, minT, range, oktas })),
    blendKm: state.blendKm, seed: state.seed, timeS: sets[0].t, windOffsetM: sets[0].off.toArray(),
    layout: 'uint8 density 0..255; per slab: x fastest, then z (north to south), then altitude (bottom to top)',
  };
  const json = new TextEncoder().encode(JSON.stringify(header, null, 1));
  const len = new Uint8Array(new Uint32Array([json.length]).buffer);
  const blob = new Blob([len, json, ...parts], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zone_${tx}_${ty}.cvol`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------------
// Метеорадар (миникарта): квадрат со стороной max(ширина, глубина) мира
// ---------------------------------------------------------------------------
const radar = fsScene(S.radarFrag, {
  uVol: shared.uVol, uVolHi: shared.uVolHi, uSplitY: shared.uSplitY, uLoY: shared.uLoY, uHiY: shared.uHiY,
  uVolB: shared.uVolB, uVolHiB: shared.uVolHiB, uMixB: shared.uMixB, uShiftA: shared.uShiftA, uShiftB: shared.uShiftB,
  uBoxMin: shared.uBoxMin, uBoxMax: shared.uBoxMax, uView: { value: new THREE.Vector4() },
});
// Размер и место миникарты задаёт CSS (#radarOverlay); WebGL-вьюпорт берётся из его прямоугольника
const radarCanvas = document.getElementById('radarOverlay');
const rctx = radarCanvas.getContext('2d');

// область миникарты в км мира: [xmin, zmin, сторона]
function radarView() {
  const side = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  return [(box.min.x + box.max.x) / 2 - side / 2, (box.min.z + box.max.z) / 2 - side / 2, side];
}

function zoneLabel(i) {
  const ls = state.zones[i].layers.filter((l) => l.enabled).sort((a, b) => a.base - b.base);
  return ls.length ? ls.map((l) => `${TYPE_ABBR[l.type]} ${l.oktas}/8`).join(' · ') : 'ясно';
}

function drawRadarOverlay(time) {
  const dpr = devicePixelRatio;
  const W = Math.round(radarCanvas.getBoundingClientRect().width);
  if (!W) return;
  if (radarCanvas.width !== W * dpr || radarCanvas.height !== W * dpr) { radarCanvas.width = radarCanvas.height = W * dpr; }
  const c = rctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, W);
  const cx = W / 2;
  const [vx, vz, side] = radarView();
  const toPx = (x, z) => [((x - vx) / side) * W, ((z - vz) / side) * W];
  // кольца дальности
  c.strokeStyle = 'rgba(120,255,160,0.35)';
  c.lineWidth = 1;
  for (let i = 1; i <= 4; i++) { c.beginPath(); c.arc(cx, cx, (cx * i) / 4, 0, Math.PI * 2); c.stroke(); }
  c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, W); c.moveTo(0, cx); c.lineTo(W, cx); c.stroke();
  // зоны: полосы перехода, границы, выбранная зона, подписи
  const { nx, ny } = state.grid;
  if (nx * ny > 1) {
    const T = state.tileKm, bw = (state.blendKm / side) * W;
    const [ax0, az0] = toPx(box.min.x, box.min.z), [ax1, az1] = toPx(box.max.x, box.max.z);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    for (let tx = 1; tx < nx; tx++) { const [x] = toPx(box.min.x + tx * T, 0); c.fillRect(x - bw / 2, az0, bw, az1 - az0); }
    for (let ty = 1; ty < ny; ty++) { const [, y] = toPx(0, box.min.z + ty * T); c.fillRect(ax0, y - bw / 2, ax1 - ax0, bw); }
    c.font = '10px system-ui, sans-serif';
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const i = ty * nx + tx, sel = i === state.sel;
      const [x0, y0] = toPx(box.min.x + tx * T, box.min.z + ty * T);
      const [x1, y1] = toPx(box.min.x + (tx + 1) * T, box.min.z + (ty + 1) * T);
      c.strokeStyle = sel ? 'rgba(255,220,80,0.95)' : 'rgba(255,255,255,0.3)';
      c.setLineDash(sel ? [] : [4, 3]);
      c.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      c.setLineDash([]);
      c.fillStyle = sel ? 'rgba(255,220,80,0.95)' : 'rgba(255,255,255,0.65)';
      c.fillText(`${String.fromCharCode(65 + tx)}${ty + 1}`, x0 + 4, y0 + 12);
    }
  }
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
  c.fillText(`R ${(side / 2).toFixed(0)} км`, 6, W - 6);
  // камера: позиция и направление взгляда
  const [px, py] = toPx(camera.position.x, camera.position.z);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const yaw = Math.atan2(fwd.z, fwd.x);
  const half = THREE.MathUtils.degToRad(camera.fov * camera.aspect * 0.5);
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.beginPath(); c.moveTo(px, py);
  c.arc(px, py, W * 0.15, yaw - Math.min(half, 1.2), yaw + Math.min(half, 1.2)); c.closePath(); c.fill();
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill();
  const [tx, ty] = toPx(controls.target.x, controls.target.z);
  c.strokeStyle = 'rgba(255,220,80,0.9)';
  c.beginPath(); c.moveTo(tx - 5, ty); c.lineTo(tx + 5, ty); c.moveTo(tx, ty - 5); c.lineTo(tx, ty + 5); c.stroke();
}

// Клик по миникарте переносит точку обзора; с Shift — выбирает зону
radarCanvas.addEventListener('click', (e) => {
  const r = radarCanvas.getBoundingClientRect();
  const [vx, vz, side] = radarView();
  const x = vx + ((e.clientX - r.left) / r.width) * side, z = vz + ((e.clientY - r.top) / r.height) * side;
  if (e.shiftKey) {
    const tx = Math.floor((x - box.min.x) / state.tileKm), ty = Math.floor((z - box.min.z) / state.tileKm);
    if (tx >= 0 && ty >= 0 && tx < state.grid.nx && ty < state.grid.ny) { state.sel = ty * state.grid.nx + tx; ui.refresh(); }
    return;
  }
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
  cloudMat.uniforms.uLite.value = q.lite;
  resizeTargets();
}

// ---------------------------------------------------------------------------
// Ландшафт (terrain.js): рельеф + снимок из открытых данных, для Лондона — здания OSM
// ---------------------------------------------------------------------------
const terr = { data: null, mesh: null, bld: null, token: 0 };
const attribEl = document.getElementById('attrib');
const surfUniforms = () => ({ ...shared });

function clearTerrain() {
  for (const m of [terr.mesh, terr.bld]) {
    if (!m) continue;
    scene.remove(m);
    m.geometry.dispose();
    m.material.uniforms.uImage?.value.dispose();
    m.material.dispose();
  }
  terr.data = terr.mesh = terr.bld = null;
  ground.position.y = 0;
  ground.material.uniforms.uHole.value.set(1, 1, -1, -1);
  attribEl.textContent = '';
}

async function applyTerrain() {
  const token = ++terr.token;
  const key = state.terrain;
  if (!key) { clearTerrain(); ui.setTerrainStatus(''); return; }
  try {
    const d = await loadTerrain(key, state.imagery, { mobile: MOBILE, onStatus: (t) => token === terr.token && ui.setTerrainStatus(t) });
    if (token !== terr.token) { d.geo.dispose(); d.tex.dispose(); d.buildings?.geo.dispose(); return; }
    clearTerrain();
    terr.data = d;
    terr.mesh = new THREE.Mesh(d.geo, new THREE.ShaderMaterial({
      vertexShader: S.surfaceVert, fragmentShader: S.terrainFrag,
      uniforms: { ...surfUniforms(), uImage: { value: d.tex }, uWater: { value: d.loc.water } },
    }));
    terr.mesh.renderOrder = 1;
    scene.add(terr.mesh);
    if (d.buildings) {
      terr.bld = new THREE.Mesh(d.buildings.geo, new THREE.ShaderMaterial({
        vertexShader: S.surfaceVert, fragmentShader: S.buildingFrag, uniforms: surfUniforms(),
        vertexColors: true, side: THREE.DoubleSide,
      }));
      terr.bld.renderOrder = 1;
      scene.add(terr.bld);
    }
    ground.position.y = d.stats.edge - 0.003;     // за краями рельефа — обычная земля на уровне его краёв
    const hs = d.size / 2 - 0.05;                 // отверстие чуть меньше квадрата: края рельефа и земля стыкуются
    ground.material.uniforms.uHole.value.set(-hs, -hs, hs, hs);
    attribEl.textContent = d.attribution;
    // высоты облаков — над уровнем моря: при желании поднимаем слои над типичным рельефом
    let msg = `Рельеф ${Math.round(d.stats.min * 1000)}–${Math.round(d.stats.max * 1000)} м` +
      (d.buildings ? `, зданий ${d.buildings.count}` : '');
    if (state.raiseClouds) {
      const bases = state.zones.flatMap((z) => z.layers.filter((l) => l.enabled).map((l) => l.base));
      const need = Math.ceil(((d.stats.median + 0.3) * 1000 - Math.min(...bases)) / 50) * 50;
      if (bases.length && need > 0) {
        state.zones.forEach((z) => z.layers.forEach((l) => { l.base += need; }));
        ui.refresh();
        startGeneration();
        msg += `; облака подняты на ${need} м`;
      }
    }
    ui.setTerrainStatus(msg);
    const [vp, vt] = d.loc.view;
    camera.position.set(...vp);
    controls.target.set(...vt);
    controls.update();
  } catch (e) {
    if (token === terr.token) ui.setTerrainStatus(`Не удалось загрузить: ${e.message}`);
  }
}
// высота поверхности под точкой (км) — для удержания камеры над землёй
const surfaceY = (x, z) => (terr.data ? terr.data.heightAt(x, z) : ground.position.y);

// ---------------------------------------------------------------------------
// Камера
// ---------------------------------------------------------------------------
function setCameraView(kind) {
  const L = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
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
  const [nx, ny] = pr.grid ?? [1, 1];
  state.grid = { nx, ny };
  state.tileKm = pr.tileKm ?? pr.domainKm;
  state.zones = (pr.zones ?? [pr.layers]).map((ls) => ({ layers: ls.map(({ type, ...over }) => makeLayer(type, over)) }));
  state.zones.forEach((z) => enforceNonOverlap(z.layers));
  state.sel = 0;
  if (pr.blendKm) state.blendKm = pr.blendKm;
  ui.refresh();
  startGeneration();
  setCameraView(pr.camera || 'overview');
}

const ui = buildUI({
  state, CLOUD_TYPES, PRESETS, MAX_LAYERS, makeLayer, layerTop, enforceNonOverlap, zoneLabel,
  onLayersChanged: () => startGeneration(),
  onVolumeChanged: () => startGeneration(),
  onGridChanged: (nx, ny) => { setGrid(nx, ny); ui.refresh(); startGeneration(); setCameraView('overview'); },
  onZoneSelect: (i) => { state.sel = i; ui.refresh(); },
  onCopyZone: () => {
    const src = state.layers;
    state.zones.forEach((z, i) => { if (i !== state.sel) z.layers = cloneLayers(src); });
    ui.refresh();
    startGeneration();
  },
  onExport: exportZone,
  // вкл/выкл ветра и развития, а без динамики — и направление ветра: перегенерация;
  // скорость, направление и ускорение при включённой динамике применяются к следующим кадрам
  onDynamicsChanged: (restart) => { if (restart || !animOn()) startGeneration(); },
  onAtmosphereChanged: () => updateAtmosphere(),
  onRenderChanged: () => applyRender(),
  onShare: () => shareLink(),
  onTerrainChanged: () => applyTerrain(),
  LOCATIONS, IMAGERY,
  onPreset: applyPreset,
  onCamera: setCameraView,
});

function applyRender() {
  shared.uExt.value = state.ext;
  shared.uDensMul.value = state.densMul;
  cloudMat.uniforms.uErode.value = state.erode;
  boxHelper.visible = state.showBox;
  applyQuality();
}

// ---------------------------------------------------------------------------
// Ссылка на конфигурацию (share.js): всё состояние — в "#c=..." адреса страницы
// ---------------------------------------------------------------------------
const TYPE_KEYS = Object.keys(CLOUD_TYPES);
let lastCode = null;

async function shareLink() {
  const code = await encode(packState(state, camera, controls, TYPE_KEYS));
  lastCode = code;
  history.replaceState(null, '', `${location.pathname}#c=${code}`);
  const url = location.href;
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* нет доступа к Clipboard API */ }
  copied = ui.showShare(url, copied);
}

function applyConfig(c) {
  const keys = ['tileKm', 'grid', 'blendKm', 'seed', 'resH', 'resV', 'slabMode', 'wind', 'windSpeed', 'windFrom', 'develop',
    'timeScale', 'sunAz', 'sunEl', 'animateSun', 'visibilityKm', 'densMul', 'ext', 'erode', 'exposure', 'quality'];
  for (const k of keys) state[k] = c[k];
  if (MOBILE) {                                   // ссылку с десктопа ужимаем до возможностей телефона
    state.quality = 'low';
    state.resH = Math.min(state.resH, MOBILE_RES.resH);
    state.resV = Math.min(state.resV, MOBILE_RES.resV);
  }
  state.zones = c.zones.map((z) => ({ layers: z.layers.map(({ type, ...over }) => makeLayer(type, over)) }));
  state.zones.forEach((z) => enforceNonOverlap(z.layers));
  state.sel = c.sel;
  const terrainChanged = state.terrain !== c.terrain || state.imagery !== c.imagery;
  state.terrain = c.terrain; state.imagery = c.imagery;
  if (terrainChanged) { state.raiseClouds = false; applyTerrain().then(() => { state.raiseClouds = true; }); }
  ui.syncAll();
  ui.refresh();
  updateAtmosphere();
  applyRender();
  startGeneration();
  if (c.camera) {
    camera.position.set(c.camera[0], c.camera[1], c.camera[2]);
    controls.target.set(c.camera[3], c.camera[4], c.camera[5]);
    controls.update();
  } else setCameraView('overview');
}

async function applyHash() {
  const code = hashCode();
  if (!code || code === lastCode) return false;
  lastCode = code;
  try { applyConfig(unpackState(await decode(code), TYPE_KEYS)); return true; } catch (e) { console.warn('ссылка:', e); return false; }
}
addEventListener('hashchange', applyHash);   // вставили другую ссылку в ту же вкладку

window.clouds = { camera, controls, state }; // для отладки из консоли

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeTargets();
});

// ---------------------------------------------------------------------------
// Цикл
// ---------------------------------------------------------------------------
updateAtmosphere();
applyQuality();
// Сцена из метеомодели (meteo.html): index.html?scene={"layers":[...],"vis":км}
function applyScene(scene) {
  const known = (scene.layers || []).filter((l) => CLOUD_TYPES[l.type]).slice(0, MAX_LAYERS);
  state.grid = { nx: 1, ny: 1 };
  state.zones = [{ layers: known.map(({ type, ...over }) => makeLayer(type, over)) }];
  state.sel = 0;
  const deep = known.some((l) => l.type.startsWith('Cumulonimbus') || l.base + l.minT + l.range > 7000);
  state.tileKm = deep ? 64 : 32;
  if (scene.vis) { state.visibilityKm = Math.min(Math.max(scene.vis, 0.2), 100); ui.syncVisibility(); updateAtmosphere(); }
  enforceNonOverlap();
  ui.refresh();
  startGeneration();
  setCameraView('overview');
}

// порядок при открытии: ссылка "#c=…" → сцена из метеомодели "?scene=…" → пресет по умолчанию
const sceneParam = new URLSearchParams(location.search).get('scene');
let sceneApplied = false;
if (sceneParam && !hashCode()) {
  try { applyScene(JSON.parse(sceneParam)); sceneApplied = true; } catch (e) { console.warn('scene:', e); }
}
if (!sceneApplied) {
  if (hashCode()) applyHash().then((ok) => { if (!ok) applyPreset('congestusCirrus'); });
  else applyPreset('congestusCirrus');
}

let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0;
renderer.setAnimationLoop((time) => {
  const dt = (time - last) / 1000; last = time;
  if (!plan) return;                       // ждём разбора ссылки
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  if (state.animateSun) { state.sunAz = (state.sunAz + dt * 12) % 360; ui.syncSun(); updateAtmosphere(); }

  stepGeneration();
  updateAnim(dt);
  controls.update();
  const minY = surfaceY(camera.position.x, camera.position.z) + 0.002;
  if (camera.position.y < minY) camera.position.y = minY;
  sky.position.copy(camera.position);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  // непрозрачная сцена → буфер с глубиной → на экран; поверх — облака, обрезанные по этой глубине
  renderer.setRenderTarget(opaqueRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(blit.scene, fsCam);
  camera.getWorldDirection(cloudMat.uniforms.uCamFwd.value);
  renderer.autoClear = false;
  renderer.render(cloudScene, camera);
  renderer.autoClear = true;

  // миникарта радара: место и размер — из CSS; свёрнутую не рисуем
  const rr = radarCanvas.getBoundingClientRect();
  if (rr.width > 0) {
    const [vx, vz, side] = radarView();
    radar.mat.uniforms.uView.value.set(vx, vz, side, 0);
    const vy = innerHeight - rr.bottom;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(rr.left, vy, rr.width, rr.height);
    renderer.setViewport(rr.left, vy, rr.width, rr.height);
    renderer.render(radar.scene, fsCam);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    drawRadarOverlay(time);
  }

  const alt = (camera.position.y * 1000).toFixed(0);
  const mm = Math.floor(anim.t / 60), ss = Math.floor(anim.t % 60);
  const sim = animOn() ? ` · время +${mm}:${String(ss).padStart(2, '0')}` : '';
  const genTxt = !sets[0].ready ? ` · генерация ${Math.round((job.done / job.total) * 100)}%` : animOn() ? '' : ` · объём за ${job.lastMs.toFixed(0)} мс`;
  ui.setHud(`${fps.toFixed(0)} FPS · камера ${alt} м${sim}${genTxt}`);
});
