// Демонстрация модели облакообразования: Skew-T столба, карта циклона, вертикальный разрез, передача слоёв в 3D.
import { runColumn, scenario, SCENARIOS, BASE, cyclonePoint, cycloneFronts, dewpoint } from './model.js';
import { CLOUD_TYPES } from '../cloudTypes.js';

const $ = (id) => document.getElementById(id);
const K0 = 273.15;

const TYPE_COLOR = {
  CumulusHumilis: '#9be7ff', CumulusMediocris: '#62c7f5', CumulusCongestus: '#2f8fe0', CumulusTowering: '#5b5ff0',
  CumulonimbusCalvus: '#c05bf0', CumulonimbusIncus: '#ff4fa3', AnvilHead: '#ff7ab8', Stratocumulus: '#9ad18b',
  Stratus: '#c9c9a3', Altocumulus: '#f2d36b', Altostratus: '#f2a65a', Nimbostratus: '#8a8f99', NimbostratusFlat: '#8a8f99',
  Cirrus: '#ffffff',
};
const shortName = (t) => CLOUD_TYPES[t]?.label.split(' (')[0] ?? t;

// ------------------------------------------------------------------ параметры
const PARAMS = [
  ['T0', 'Температура у земли', -10, 38, 0.5, '°C'],
  ['Td0', 'Точка росы у земли', -20, 28, 0.5, '°C'],
  ['heat', 'Перегрев частицы (прогрев)', 0, 4, 0.1, 'K'],
  ['blDepth', 'Высота пограничного слоя', 100, 3000, 50, 'м'],
  ['blLapse', 'Градиент в ПС (9.8 — перемешан)', -8, 9.8, 0.2, 'К/км'],
  ['invDT', 'Инверсия над ПС', 0, 8, 0.5, 'K'],
  ['ftLapse', 'Градиент свободной атмосферы', 4, 9, 0.1, 'К/км'],
  ['capZ', 'Средняя инверсия: высота (0 — нет)', 0, 9000, 100, 'м'],
  ['capDT', 'Средняя инверсия: сила', 0, 6, 0.5, 'K'],
  ['rhMid', 'Влажность 2–6 км', 0.05, 1, 0.01, ''],
  ['rhUp', 'Влажность 6–11 км', 0.05, 1, 0.01, ''],
  ['w', 'Вертикальная скорость (синоптика)', -5, 40, 0.5, 'см/с'],
  ['tau', 'Время действия подъёма', 0, 24, 0.5, 'ч'],
  ['entr', 'Вовлечение в облако', 0, 0.5, 0.01, '1/км'],
];
let sc = scenario('thunder');
const fmt = (k, v) => (k === 'rhMid' || k === 'rhUp' ? `${Math.round(v * 100)}%` : `${+v.toFixed(2)}`);

function buildControls() {
  const sel = $('scenario');
  sel.innerHTML = Object.entries(SCENARIOS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('') +
    '<option value="map">— точка с карты циклона —</option>';
  sel.value = 'thunder';
  sel.addEventListener('change', () => { if (sel.value !== 'map') { sc = scenario(sel.value); syncControls(); update(); } });
  const box = $('params');
  for (const [k, label, min, max, step, unit] of PARAMS) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<div class="ctl-head"><span>${label}</span><b id="v_${k}"></b></div><input id="p_${k}" type="range" min="${min}" max="${max}" step="${step}">`;
    box.append(row);
    row.querySelector('input').addEventListener('input', (e) => {
      let v = +e.target.value;
      if (k === 'w') v /= 100;
      sc[k] = v;
      if (k === 'capZ' && v === 0) sc.capZ = undefined;
      $('scenario').value = sel.value === 'map' ? 'map' : sel.value;
      syncLabels(); update();
    });
  }
  syncControls();
}
function syncLabels() {
  for (const [k, , , , , unit] of PARAMS) {
    let v = sc[k] ?? 0;
    if (k === 'w') v *= 100;
    $(`v_${k}`).textContent = `${fmt(k, v)} ${unit}`;
  }
}
function syncControls() {
  for (const [k] of PARAMS) { let v = sc[k] ?? 0; if (k === 'w') v *= 100; $(`p_${k}`).value = v; }
  syncLabels();
}

// ------------------------------------------------------------------ Skew-T
const P_BOT = 1050, P_TOP = 150;
function skewT(res) {
  const cv = $('skewt'), ctx = cv.getContext('2d');
  const dpr = devicePixelRatio, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = 44, R = W - 150, T = 10, B = H - 26, PW = R - L, PH = B - T;
  const yOf = (p) => B - (PH * (Math.log(P_BOT) - Math.log(p))) / (Math.log(P_BOT) - Math.log(P_TOP));
  const xOf = (Tc, p) => L + ((Tc + 40) / 80) * PW + (B - yOf(p)) * 0.9;
  ctx.fillStyle = '#0d1420'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.beginPath(); ctx.rect(L, T, PW, PH); ctx.clip();
  // сухие адиабаты
  ctx.strokeStyle = 'rgba(255,170,90,.18)'; ctx.lineWidth = 1;
  for (let th = -30; th <= 170; th += 10) {
    ctx.beginPath();
    for (let p = P_BOT; p >= P_TOP; p -= 10) { const Tc = (th + K0) * Math.pow(p / 1000, 0.2857) - K0; const x = xOf(Tc, p), y = yOf(p); p === P_BOT ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // изотермы
  for (let t = -120; t <= 50; t += 10) {
    ctx.strokeStyle = t === 0 ? 'rgba(120,200,255,.6)' : 'rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.moveTo(xOf(t, P_BOT), yOf(P_BOT)); ctx.lineTo(xOf(t, P_TOP), yOf(P_TOP)); ctx.stroke();
  }
  // CAPE / CIN заливка
  const { prof, parcel } = res;
  const pz = (z) => prof.p[Math.min(Math.round(z / 50), prof.n - 1)] / 100;
  for (let k = 1; k < parcel.path.length; k++) {
    const a = parcel.path[k - 1], b = parcel.path[k];
    if (res.diag.lcl === null || a.z < res.diag.lcl) continue;
    const pa = pz(a.z), pb = pz(b.z);
    const ia = Math.round(a.z / 50), ib = Math.round(b.z / 50);
    ctx.fillStyle = b.B > 0 ? 'rgba(255,140,40,.35)' : 'rgba(80,140,255,.18)';
    ctx.beginPath();
    ctx.moveTo(xOf(a.T - K0, pa), yOf(pa)); ctx.lineTo(xOf(b.T - K0, pb), yOf(pb));
    ctx.lineTo(xOf(prof.T[ib] - K0, pb), yOf(pb)); ctx.lineTo(xOf(prof.T[ia] - K0, pa), yOf(pa));
    ctx.fill();
  }
  // профили
  const line = (color, width, fn, dash = []) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
    let first = true;
    for (let i = 0; i < prof.n; i += 2) { const p = prof.p[i] / 100; if (p < P_TOP) break; const x = xOf(fn(i), p), y = yOf(p); first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false; }
    ctx.stroke(); ctx.setLineDash([]);
  };
  line('#ff5a5a', 2.5, (i) => prof.T[i] - K0);
  line('#3fd16b', 2.5, (i) => dewpoint(prof.r[i], prof.p[i]) - K0);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]); ctx.beginPath();
  parcel.path.forEach((s, k) => { const p = pz(s.z); if (p < P_TOP) return; const x = xOf(s.T - K0, p), y = yOf(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  // оси
  ctx.fillStyle = '#8fa0b5'; ctx.font = '11px system-ui'; ctx.strokeStyle = 'rgba(255,255,255,.25)';
  for (const p of [1000, 900, 800, 700, 600, 500, 400, 300, 200]) {
    const y = yOf(p); ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
    let i = 0; while (i < prof.n - 1 && prof.p[i] / 100 > p) i++;
    ctx.fillText(`${p}`, 6, y + 4); ctx.fillText(`${(prof.z[i] / 1000).toFixed(1)} км`, R + 4, y + 4);
  }
  for (let t = -30; t <= 40; t += 10) ctx.fillText(`${t}°`, xOf(t, P_BOT) - 8, B + 16);
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.strokeRect(L, T, PW, PH);
  // уровни
  const mark = (z, label, color) => {
    if (z === null || z === undefined) return;
    const y = yOf(pz(z)); ctx.strokeStyle = color; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.fillText(label, L + 4, y - 3);
  };
  mark(res.diag.lcl, `LCL ${res.diag.lcl} м`, '#ffd166');
  if (res.diag.lfc !== res.diag.lcl) mark(res.diag.lfc, `LFC ${res.diag.lfc} м`, '#ffa94d');
  if (res.diag.el && res.diag.el > (res.diag.lcl ?? 0)) mark(res.diag.el, `EL ${res.diag.el} м`, '#ff6b6b');
  // слои облаков справа
  const bx = R + 50;
  for (const l of res.layers) {
    const top = l.base + l.minT + l.range;
    const y0 = yOf(pz(l.base)), y1 = yOf(pz(Math.min(top, 15900)));
    ctx.fillStyle = TYPE_COLOR[l.type] ?? '#ccc';
    ctx.globalAlpha = 0.35 + 0.65 * (l.oktas / 8);
    ctx.fillRect(bx, y1, 22, Math.max(y0 - y1, 3));
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e6edf5'; ctx.fillText(shortName(l.type).replace('Cumulonimbus', 'Cb').replace('Cumulus', 'Cu'), bx + 26, (y0 + y1) / 2 + 4);
  }
  ctx.fillStyle = '#8fa0b5'; ctx.fillText('облака', bx, T + 10);
}

// ------------------------------------------------------------------ результаты
function results(res) {
  const d = res.diag;
  const v = (x, u = '') => (x === null || x === undefined ? '—' : `${Math.round(x)}${u}`);
  $('diag').innerHTML = `
    <tr><td>Уровень конденсации (LCL)</td><td>${v(d.lcl, ' м')} <span class="muted">Эспи ${v(d.espyLcl, ' м')}</span></td></tr>
    <tr><td>Уровень свободной конвекции (LFC)</td><td>${v(d.lfc, ' м')}</td></tr>
    <tr><td>Уровень равновесия (EL)</td><td>${v(d.el, ' м')}</td></tr>
    <tr><td>CAPE / CIN</td><td>${v(d.cape)} / ${v(d.cin)} Дж/кг</td></tr>
    <tr><td>Подъём слоёв w·τ</td><td>${v(d.liftM, ' м')}</td></tr>
    <tr><td>Видимость</td><td>${d.visibilityKm < 10 ? d.visibilityKm.toFixed(1) : Math.round(d.visibilityKm)} км ${d.fog ? '(туман)' : d.precip ? '(осадки)' : ''}</td></tr>
    <tr><td>Метеорадар</td><td>${d.dbz ? `${Math.round(d.dbz)} dBZ` : 'нет эха'}</td></tr>`;
  $('layers').innerHTML = res.layers.length ? res.layers.map((l) => `
    <tr><td><span class="sw" style="background:${TYPE_COLOR[l.type]}"></span>${shortName(l.type)}</td>
    <td>${l.base}–${l.base + l.minT + l.range} м</td><td>${l.oktas}/8</td><td class="muted">${l.source}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Облаков нет</td></tr>';
  const scene = { layers: res.layers.map(({ type, base, minT, range, oktas }) => ({ type, base, minT, range, oktas })), vis: +d.visibilityKm.toFixed(1) };
  $('open3d').href = `index.html?scene=${encodeURIComponent(JSON.stringify(scene))}`;
  $('open3d').classList.toggle('disabled', !res.layers.length);
}

function update() {
  const res = runColumn(sc);
  skewT(res); results(res);
}

// ------------------------------------------------------------------ карта циклона
const MAP_KM = 2000, NG = 64;
let mapGrid = null, mapSel = { x: 350, y: 120 };
function computeMap(done) {
  mapGrid = new Array(NG * NG);
  let row = 0;
  const step = () => {
    const t0 = performance.now();
    while (row < NG && performance.now() - t0 < 25) {
      for (let gx = 0; gx < NG; gx++) {
        const x = -MAP_KM / 2 + (gx + 0.5) * (MAP_KM / NG), y = MAP_KM / 2 - (row + 0.5) * (MAP_KM / NG);
        const cp = cyclonePoint(x, y);
        const res = runColumn(cp.sc);
        mapGrid[row * NG + gx] = { layers: res.layers, p: cp.p };
      }
      row++;
    }
    drawMap();
    $('mapStatus').textContent = row < NG ? `расчёт ${Math.round((row / NG) * 100)}%` : `${NG}×${NG} столбов`;
    if (row < NG) requestAnimationFrame(step); else done?.();
  };
  step();
}
const dominant = (layers) => layers.slice().sort((a, b) => b.oktas * (b.minT + b.range) - a.oktas * (a.minT + a.range))[0];

function drawMap() {
  const cv = $('map'), ctx = cv.getContext('2d');
  const dpr = devicePixelRatio, S = cv.clientWidth;
  cv.width = cv.height = S * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#16301f'; ctx.fillRect(0, 0, S, S);
  const c = S / NG;
  if (mapGrid) {
    for (let i = 0; i < NG * NG; i++) {
      const cell = mapGrid[i]; if (!cell) continue;
      // все слои, начиная с нижнего, — сверху виден верхний
      for (const l of cell.layers.slice().sort((a, b) => a.base - b.base)) {
        ctx.fillStyle = TYPE_COLOR[l.type]; ctx.globalAlpha = 0.25 + 0.6 * (l.oktas / 8);
        ctx.fillRect((i % NG) * c, Math.floor(i / NG) * c, c + 0.5, c + 0.5);
      }
    }
    ctx.globalAlpha = 1;
    // изобары через 4 гПа
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let gy = 0; gy < NG - 1; gy++) for (let gx = 0; gx < NG - 1; gx++) {
      const a = mapGrid[gy * NG + gx], b = mapGrid[gy * NG + gx + 1], d = mapGrid[(gy + 1) * NG + gx];
      if (!a || !b || !d) continue;
      if (Math.floor(a.p / 4) !== Math.floor(b.p / 4) || Math.floor(a.p / 4) !== Math.floor(d.p / 4)) ctx.fillRect(gx * c + c / 2, gy * c + c / 2, 1.5, 1.5);
    }
  }
  const toPx = (x, y) => [((x + MAP_KM / 2) / MAP_KM) * S, ((MAP_KM / 2 - y) / MAP_KM) * S];
  // фронты
  const fr = cycloneFronts();
  const front = (pts, color, warm) => {
    const [a, b] = pts.map(([x, y]) => toPx(x, y));
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const nx = warm ? uy : -uy, ny = warm ? -ux : ux;   // символы — в сторону движения фронта
    for (let s = 14; s < len; s += 26) {
      const px = a[0] + ux * s, py = a[1] + uy * s;
      ctx.beginPath();
      if (warm) ctx.arc(px, py, 6, Math.atan2(uy, ux), Math.atan2(uy, ux) + Math.PI, nx * uy - ny * ux > 0);
      else { ctx.moveTo(px - ux * 6, py - uy * 6); ctx.lineTo(px + nx * 9, py + ny * 9); ctx.lineTo(px + ux * 6, py + uy * 6); }
      ctx.fill();
    }
  };
  front(fr.warm, '#ff4d4d', true);
  front(fr.cold, '#3d8bff', false);
  const [cx, cy] = toPx(0, 0);
  ctx.fillStyle = '#ff4d4d'; ctx.font = 'bold 22px system-ui'; ctx.fillText('Н', cx - 8, cy + 8);
  // выбранная точка и линия разреза
  const [sx, sy] = toPx(mapSel.x, mapSel.y);
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(S, sy); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#cfd8e3'; ctx.font = '11px system-ui'; ctx.fillText('2000 × 2000 км · север вверху', 6, S - 6);
  drawSection();
}

function drawSection() {
  const cv = $('section'), ctx = cv.getContext('2d');
  const dpr = devicePixelRatio, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sky = ctx.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#0b2a55'); sky.addColorStop(1, '#5c8fc4');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  const L = 36, B = H - 22, ZMAX = 13000, yOf = (z) => B - (z / ZMAX) * (B - 8);
  const N = 120, cw = (W - L) / N;
  for (let k = 0; k < N; k++) {
    const x = -MAP_KM / 2 + (k + 0.5) * (MAP_KM / N);
    const res = runColumn(cyclonePoint(x, mapSel.y).sc);
    for (const l of res.layers) {
      const top = l.base + l.minT + l.range;
      ctx.fillStyle = TYPE_COLOR[l.type]; ctx.globalAlpha = 0.25 + 0.7 * (l.oktas / 8);
      if (l.type.startsWith('Cumulonimbus') || l.type.startsWith('Cumulus')) {
        const w = cw * (0.3 + 0.7 * (l.oktas / 8));                // кучевые — отдельные башни
        ctx.fillRect(L + k * cw + (cw - w) / 2, yOf(top), w, yOf(l.base) - yOf(top));
      } else ctx.fillRect(L + k * cw, yOf(top), cw + 0.5, yOf(l.base) - yOf(top));
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = '#2b4a2f'; ctx.fillRect(0, B, W, H - B);
  // фронтальные поверхности на разрезе (пересечение линий фронтов с разрезом)
  ctx.fillStyle = '#e6edf5'; ctx.font = '11px system-ui';
  for (let z = 0; z <= 12000; z += 2000) { ctx.fillText(`${z / 1000}`, 6, yOf(z) + 4); }
  ctx.fillText('км', 6, 14);
  const sx = L + ((mapSel.x + MAP_KM / 2) / MAP_KM) * (W - L);
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, B); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillText('З', L + 2, B + 15); ctx.fillText('В', W - 12, B + 15);
  ctx.fillText(`разрез вдоль y = ${Math.round(mapSel.y)} км`, L + 30, B + 15);
}

function legend() {
  const used = ['CumulusHumilis', 'CumulusMediocris', 'CumulusCongestus', 'CumulusTowering', 'CumulonimbusCalvus', 'CumulonimbusIncus',
    'Stratocumulus', 'Stratus', 'Altocumulus', 'Altostratus', 'Nimbostratus', 'Cirrus'];
  $('legend').innerHTML = used.map((t) => `<span><i style="background:${TYPE_COLOR[t]}"></i>${shortName(t)}</span>`).join('');
}

$('map').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  mapSel = { x: ((e.clientX - r.left) / r.width - 0.5) * MAP_KM, y: (0.5 - (e.clientY - r.top) / r.height) * MAP_KM };
  const cp = cyclonePoint(mapSel.x, mapSel.y);
  sc = { ...cp.sc };
  $('scenario').value = 'map';
  $('mapInfo').textContent = `точка (${Math.round(mapSel.x)}, ${Math.round(mapSel.y)}) км · ${cp.zone} · p = ${cp.p.toFixed(0)} гПа · w = ${(cp.w * 100).toFixed(1)} см/с`;
  syncControls(); update(); drawMap();
});
addEventListener('resize', () => { update(); drawMap(); });

buildControls();
legend();
update();
computeMap();
