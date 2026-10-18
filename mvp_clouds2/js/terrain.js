// Реальный ландшафт из открытых данных:
//   рельеф — AWS Terrain Tiles (формат Terrarium, Mapzen), снимок — Sentinel-2 cloudless 2016 (EOX) или Esri World Imagery,
//   здания Лондона — OpenStreetMap (выгружены заранее в data/london_buildings.json, ODbL).
// Квадрат sizeKm × sizeKm вокруг точки переводится в локальные км: x — восток, z — юг (север = −z),
// проекция Web Mercator × cos(lat0) — та же, в которой выгружены здания.
import * as THREE from 'three';

// water — уровень водной глади, км (данные рельефа включают дно моря и Байкала; ниже уровня — ровная вода), −1 — воды нет;
// view — ракурс камеры при загрузке [x, y, z] → цель [x, y, z], км (x — восток, z — юг)
export const LOCATIONS = {
  elbrus: { label: 'Эльбрус', lat: 43.3499, lon: 42.4453, sizeKm: 48, water: -1,
    view: [[-13, 6.8, 15], [0, 4.2, 0]] },
  aipetri: { label: 'Ай-Петри (Крым)', lat: 44.4508, lon: 34.0560, sizeKm: 40, water: 0,
    view: [[-6, 3.2, 14], [0, 0.9, -1]] },
  baikal: { label: 'Байкал (51°53′17″ N 104°49′48″ E)', lat: 51.888122, lon: 104.829989, sizeKm: 48, water: 0.4555,
    view: [[-14, 4.5, 16], [0, 0.8, 0]] },
  london: { label: 'Лондон (со зданиями OSM)', lat: 51.5065, lon: -0.1050, sizeKm: 12, water: 0.0015,
    buildings: 'data/london_buildings.json', view: [[-1.6, 0.55, 2.4], [0.4, 0.04, -0.4]] },
};

export const IMAGERY = {
  s2: {
    label: 'Sentinel-2 cloudless (10 м, CC BY 4.0)', maxZ: 14,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`,
    attribution: 'Снимок: Sentinel-2 cloudless 2016 © EOX IT Services GmbH (CC BY 4.0), содержит данные Copernicus Sentinel',
  },
  esri: {
    label: 'Esri World Imagery (детальнее, лицензия Esri)', maxZ: 18,
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: 'Снимок: Esri, Maxar, Earthstar Geographics, GIS User Community',
  },
};
const TERRAIN_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const TERRAIN_ATTRIBUTION = 'Рельеф: Mapzen / AWS Terrain Tiles (SRTM, GMTED, ETOPO1 и др.)';

const R = 6378137;
const TILE = 256;
const pxPerM = (z) => (TILE * 2 ** z) / (2 * Math.PI * R);              // пикселей мира на метр Меркатора
const mercX = (lon) => R * THREE.MathUtils.degToRad(lon);
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + THREE.MathUtils.degToRad(lat) / 2));

// Область квадрата в пикселях мира на уровне z: [x0, y0, x1, y1] (y вниз, север сверху)
function regionPx(loc, z) {
  const k = Math.cos(THREE.MathUtils.degToRad(loc.lat));
  const half = (loc.sizeKm * 500) / k;                                  // половина стороны в метрах Меркатора
  const s = pxPerM(z), w = TILE * 2 ** z;
  const cx = mercX(loc.lon) * s + w / 2, cy = w / 2 - mercY(loc.lat) * s;
  return [cx - half * s, cy - half * s, cx + half * s, cy + half * s];
}
// наименьший уровень, на котором сторона квадрата ≥ target пикселей
function pickZoom(loc, target, maxZ) {
  for (let z = 1; z <= maxZ; z++) { const r = regionPx(loc, z); if (r[2] - r[0] >= target) return z; }
  return maxZ;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`не загрузилась плитка ${url}`));
    img.src = url;
  });
}

// Мозаика плиток, покрывающих область; на выходе — canvas ровно по области (в родном разрешении уровня z)
async function mosaic(urlFn, z, reg, onTile) {   // onTile(готово, всего)
  const [x0, y0, x1, y1] = reg;
  const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE), tx1 = Math.floor(x1 / TILE), ty1 = Math.floor(y1 / TILE);
  const cw = Math.ceil(x1 - x0), ch = Math.ceil(y1 - y0);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  let i = 0, loaded = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [tx, ty] = jobs[i++];
      const img = await loadImage(urlFn(z, tx, ty));
      g.drawImage(img, tx * TILE - x0, ty * TILE - y0);
      onTile?.(++loaded, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));                 // не больше 8 запросов одновременно
  return { canvas: cv, count: jobs.length };
}

// ---------------------------------------------------------------------------
// Загрузка: высоты (сетка N×N, км) + снимок (текстура) + при наличии — здания
// ---------------------------------------------------------------------------
// кадр браузеру между тяжёлыми этапами — чтобы успел перерисовать прогресс
const yieldFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export async function loadTerrain(key, imageryKey, { mobile = false, onStatus = () => {}, onProgress = () => {} } = {}) {
  const loc = LOCATIONS[key], img = IMAGERY[imageryKey];
  // доли этапов в общем прогрессе: рельеф, снимок, здания (если есть)
  const wH = loc.buildings ? 0.3 : 0.35, wI = loc.buildings ? 0.5 : 0.6;
  const step = (f, label) => { onProgress(Math.min(1, f), label); onStatus(label); };
  const N = mobile ? 256 : 384;

  // рельеф: родное разрешение плиток, затем билинейная выборка на сетку N×N (кодированные RGB смешивать нельзя)
  const zh = Math.min(pickZoom(loc, N * 1.2, 14), 14);
  const regH = regionPx(loc, zh);
  step(0, 'Рельеф: загрузка плиток…');
  const mh = await mosaic(TERRAIN_URL, zh, regH, (k, n) => step(wH * k / n, `Рельеф: плитка ${k} из ${n}`));
  step(wH, 'Рельеф: обработка…');
  await yieldFrame();
  const { width: hw, height: hh } = mh.canvas;
  const px = mh.canvas.getContext('2d').getImageData(0, 0, hw, hh).data;
  const raw = new Float32Array(hw * hh);
  for (let i = 0; i < hw * hh; i++) raw[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  const sample = (u, v) => {                                            // u, v ∈ [0, 1] по области
    const x = Math.min(Math.max(u * (regH[2] - regH[0]), 0), hw - 1.001), y = Math.min(Math.max(v * (regH[3] - regH[1]), 0), hh - 1.001);
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, o = iy * hw + ix;
    return (raw[o] * (1 - fx) + raw[o + 1] * fx) * (1 - fy) + (raw[o + hw] * (1 - fx) + raw[o + hw + 1] * fx) * fy;
  };
  const heights = new Float32Array(N * N);                              // км над уровнем моря; вода — ровно на своём уровне
  const floor = Math.max(loc.water, 0);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) heights[j * N + i] = Math.max(floor, sample(i / (N - 1), j / (N - 1)) / 1000);

  // края плавно сводятся к среднему уровню по периметру — там продолжается обычная земля
  let edge = 0;
  for (let i = 0; i < N; i++) edge += heights[i] + heights[(N - 1) * N + i] + heights[i * N] + heights[i * N + N - 1];
  edge /= 4 * N;
  const fade = Math.round(N * 0.08);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const d = Math.min(i, j, N - 1 - i, N - 1 - j);
    if (d < fade) { const t = d / fade, s = t * t * (3 - 2 * t); heights[j * N + i] = edge + (heights[j * N + i] - edge) * s; }
  }
  const sorted = Float32Array.from(heights).sort();
  const stats = { min: sorted[0], max: sorted[sorted.length - 1], median: sorted[sorted.length >> 1], edge };

  // снимок: сторона ~2048 px (телефон — 1024), обрезан ровно по квадрату
  const target = mobile ? 1024 : 2048;
  const zi = Math.min(pickZoom(loc, target, img.maxZ), img.maxZ);
  const regI = regionPx(loc, zi);
  step(wH + 0.02, 'Снимок: загрузка плиток…');
  const mi = await mosaic(img.url, zi, regI, (k, n) => step(wH + 0.02 + (wI - 0.02) * k / n, `Снимок: плитка ${k} из ${n}`));
  step(wH + wI, 'Построение поверхности…');
  await yieldFrame();
  const side = Math.min(target, Math.max(mi.canvas.width, mi.canvas.height));
  const tc = document.createElement('canvas');
  tc.width = tc.height = side;
  tc.getContext('2d').drawImage(mi.canvas, 0, 0, mi.canvas.width, mi.canvas.height, 0, 0, side, side);
  const tex = new THREE.CanvasTexture(tc);
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;

  const size = loc.sizeKm;
  const heightAt = (x, z) => {                                          // км; вне квадрата — уровень краёв
    const u = x / size + 0.5, v = z / size + 0.5;
    if (u < 0 || v < 0 || u > 1 || v > 1) return edge;
    const fx = u * (N - 1), fy = v * (N - 1), ix = Math.min(Math.floor(fx), N - 2), iy = Math.min(Math.floor(fy), N - 2);
    const ax = fx - ix, ay = fy - iy, o = iy * N + ix;
    return (heights[o] * (1 - ax) + heights[o + 1] * ax) * (1 - ay) + (heights[o + N] * (1 - ax) + heights[o + N + 1] * ax) * ay;
  };

  // меш рельефа: ряд 0 — север (z = −size/2), как и верх снимка
  const geo = new THREE.PlaneGeometry(size, size, N - 1, N - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i]);
  geo.computeVertexNormals();

  let buildings = null;
  if (loc.buildings) {
    step(wH + wI + 0.03, 'Здания: загрузка…');
    const json = await (await fetch(loc.buildings)).json();
    step(0.93, 'Здания: построение…');
    await yieldFrame();
    buildings = buildBuildings(json, heightAt);
  }
  step(1, '');
  return { key, loc, size, N, heights, heightAt, stats, geo, tex, buildings,
    attribution: [TERRAIN_ATTRIBUTION, img.attribution, buildings ? 'Здания © OpenStreetMap contributors (ODbL)' : ''].filter(Boolean).join(' · ') };
}

// ---------------------------------------------------------------------------
// Здания: стены и плоские крыши из контуров OSM, одна общая геометрия с цветом вершин
// ---------------------------------------------------------------------------
const WALLS = [[0.62, 0.57, 0.48], [0.55, 0.42, 0.34], [0.70, 0.66, 0.58], [0.47, 0.45, 0.43], [0.60, 0.52, 0.42]];
const GLASS = [[0.38, 0.45, 0.52], [0.30, 0.36, 0.42], [0.50, 0.55, 0.58]];

function buildBuildings(data, heightAt) {
  const sc = data.scale / 1000;                                          // единицы файла → км
  const P = [], Nn = [], C = [];
  const push = (x, y, z, nx, ny, nz, c) => { P.push(x, y, z); Nn.push(nx, ny, nz); C.push(c[0], c[1], c[2]); };
  let count = 0;
  for (const b of data.b) {
    const hKm = b[0] / 1000, minKm = b[1] / 1000;
    const pts = [];
    for (let i = 2; i < b.length; i += 2) pts.push(new THREE.Vector2(b[i] * sc, b[i + 1] * sc));
    if (pts.length < 3) continue;
    let cx = 0, cz = 0, area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      cx += a.x; cz += a.y; area += a.x * c.y - c.x * a.y;
    }
    cx /= pts.length; cz /= pts.length;
    if (Math.abs(area) < 1e-9) continue;
    const ground = heightAt(cx, cz);
    const y0 = ground + minKm - 0.002, y1 = ground + hKm;              // −2 м: стены уходят в землю, без щелей на склоне
    const seed = Math.abs(Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % 1;
    const pal = hKm > 0.06 ? GLASS : WALLS;
    const wall = pal[Math.floor(seed * pal.length)].map((v) => v * (0.85 + 0.3 * ((seed * 7) % 1)));
    const roof = wall.map((v) => v * 0.7);
    const sgn = area > 0 ? 1 : -1;                                       // ориентация контура → наружные нормали
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      let nx = (c.y - a.y) * sgn, nz = -(c.x - a.x) * sgn;
      const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
      push(a.x, y0, a.y, nx, 0, nz, wall); push(c.x, y0, c.y, nx, 0, nz, wall); push(c.x, y1, c.y, nx, 0, nz, wall);
      push(a.x, y0, a.y, nx, 0, nz, wall); push(c.x, y1, c.y, nx, 0, nz, wall); push(a.x, y1, a.y, nx, 0, nz, wall);
    }
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    for (const t of tris) for (const k of t) push(pts[k].x, y1, pts[k].y, 0, 1, 0, roof);
    count++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return { geo, count };
}
