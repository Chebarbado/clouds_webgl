// Генерация test/scenes.json — эталонные сцены E0 (#76) как ссылки-состояния #c=.
// Запуск из mvp_clouds2: node test/make_scenes.mjs
// Детерминированно: повторный запуск даёт тот же файл байт-в-байт.
import { writeFileSync } from 'node:fs';
import { packState, encode } from '../js/share.js';
import { CLOUD_TYPES } from '../js/cloudTypes.js';

const TYPE_KEYS = Object.keys(CLOUD_TYPES);

// Минимальное состояние для packState: всё, что не задано сценой, — дефолты приложения.
// resH/resV снижены под стенд: генерация объёма стоит ~90 мс на срез (тяжёлый шейдер
// genFrag на реальном GPU), и на дефолтных 384×192 кадр достигал бы готовности за ~40 с
// вместо требуемых <5 с. Стоимость генерации ~ resH²×resV, поэтому половина по каждому
// даёт ~8× быстрее (готовность ~4–5 с). Разрешение эталонного кадра фиксировано в ссылке.
const baseState = (over = {}) => ({
  tileKm: 32, resH: 192, resV: 96, seed: 1,
  grid: { nx: 1, ny: 1 }, zones: [{ layers: [] }], sel: 0, blendKm: 8, slabMode: 'auto',
  wind: false, windSpeed: 12, windFrom: 290, develop: false, timeScale: 30,
  sunAz: 280, sunEl: 35, animateSun: false,
  visibilityKm: 100, densMul: 1, ext: 45, exposure: 1.1, erode: 1, quality: 'high',
  terrain: '', imagery: 's2',
  cine: false, focal: 35, fstop: 1.5, iso: 800, focusUV: [0.5, 0.5],
  manualExposure: false, dofBoost: 2000,
  ...over,
});

// Слой: высоты/покрытие по умолчанию из типа, поверх — правки сцены
const L = (type, over = {}) => {
  const d = CLOUD_TYPES[type].defaults;
  return { type, oktas: d.oktas, enabled: true, clump: 1, base: d.base, minT: d.minT, range: d.range, ...over };
};

const cam = (p, t) => ({ position: { x: p[0], y: p[1], z: p[2] }, target: { x: t[0], y: t[1], z: t[2] } });

// Сцены по три референса (обзор проекта): ieta.webp, cool_1.png, cool_2.png
const SCENES = {
  // ieta: Cu mediocris/congestus 3–4/8, база ~1.2 км, вид с земли, солнце ~55° сбоку-сзади, полдень
  ieta: {
    label: 'ieta — кучевые сбоку, полдень',
    ref: '../../images/ieta.webp',
    state: baseState({
      seed: 7, tileKm: 32,
      zones: [{ layers: [L('CumulusCongestus', { oktas: 3, base: 1200 })] }],
      sunAz: 215, sunEl: 58, visibilityKm: 35, exposure: 1.05,
    }),
    camera: cam([0, 0.003, 14], [0, 1.7, 0]),
  },
  // cool_1: плотное поле Cu congestus + Sc 6–7/8, камера над полем ~4 км, взгляд вниз ~25°, солнце ~40°
  cool_1: {
    label: 'cool_1 — поле кучевых сверху',
    ref: '../../images/cool_1.png',
    state: baseState({
      seed: 21, tileKm: 64,
      zones: [{ layers: [L('Stratocumulus', { oktas: 7, base: 900, minT: 250, range: 300 }),
        L('CumulusCongestus', { oktas: 6, base: 1300 })] }],
      sunAz: 160, sunEl: 40, visibilityKm: 45,
    }),
    camera: cam([-1.5, 4.0, 6.5], [0, 1.5, 0]),
  },
  // cool_2: Ci fibratus/uncinus 4–5/8 на 8–10 км, широкоугольник (FOV 95°), солнце ~3° над горизонтом впереди
  cool_2: {
    label: 'cool_2 — перистые веером, контровое солнце',
    ref: '../../images/cool_2.png',
    fov: 95,
    state: baseState({
      seed: 33, tileKm: 64,
      zones: [{ layers: [L('Cirrus', { oktas: 4, base: 8500 })] }],
      sunAz: 0, sunEl: 3, visibilityKm: 60, exposure: 1.15,
    }),
    camera: cam([0, 0.5, 12], [0, 3.2, -10]),
  },
};

// Возмущённые ракурсы против подгонки (wiki «Методика тестирования»)
const VIEWS = {
  '0': { label: 'эталон' },
  '1': { label: '+10° по курсу', yawDeg: 10 },
  '2': { label: '−10° по курсу', yawDeg: -10 },
  '3': { label: '+20% дистанции', dist: 1.2 },
  '4': { label: '−20% дистанции, другой seed', dist: 0.8, seedShift: 101 },
};

const scenes = {};
for (const [name, sc] of Object.entries(SCENES)) {
  const hash = await encode(packState(sc.state, sc.camera, sc.camera, TYPE_KEYS));
  scenes[name] = { label: sc.label, ref: sc.ref, hash, ...(sc.fov ? { fov: sc.fov } : {}) };
}

const out = JSON.stringify({ version: 1, views: VIEWS, scenes }, null, 1) + '\n';
writeFileSync(new URL('./scenes.json', import.meta.url), out);
console.log('scenes.json записан:', Object.keys(scenes).map((n) => `${n} (${scenes[n].hash.length} симв.)`).join(', '));
