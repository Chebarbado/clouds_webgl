// Модель облакообразования по метеоданным (описание — docs/meteo_model.md).
// Чистые функции без зависимостей: работает в браузере и в node.
// Единицы: высота м, давление Па, температура К (на входе/выходе сценариев — °C), w — м/с, τ — ч.

export const G = 9.81, RD = 287.04, CP = 1004.6, LV = 2.501e6, EPS = 0.622;
const K0 = 273.15;
export const DZ = 50;          // шаг по высоте
export const ZTOP = 16000;     // верх столба

// ------------------------------------------------------------------ термодинамика
export const esat = (T) => 611.2 * Math.exp((17.67 * (T - K0)) / (T - 29.65));
export const rsat = (T, p) => { const e = Math.min(esat(T), p * 0.5); return (EPS * e) / (p - e); };
export const tv = (T, r) => (T * (1 + r / EPS)) / (1 + r);
export function dewpoint(r, p) {              // обращение e_s(Td) = e
  const e = (r * p) / (EPS + r);
  const l = Math.log(Math.max(e, 1e-3) / 611.2);
  return (243.5 * l) / (17.67 - l) + K0;
}
export function moistLapse(T, p) {
  const rs = rsat(T, p);
  return (G * (1 + (LV * rs) / (RD * T))) / (CP + (LV * LV * rs * EPS) / (RD * T * T));
}
export const GAMMA_D = G / CP;

// ------------------------------------------------------------------ профиль столба
// sc: { T0, Td0 (°C), blDepth, blLapse (К/км), invDT, ftLapse, zTrop, rhMid, rhUp, w (м/с), tau (ч), heat (К), entr (1/км), p0 (гПа),
//       capZ, capDT — средняя инверсия (оседания) на высоте capZ силой capDT, ограничивает рост конвекции }
export function buildProfile(sc) {
  const n = Math.round(ZTOP / DZ) + 1;
  const z = new Float64Array(n), T = new Float64Array(n), r = new Float64Array(n), p = new Float64Array(n);
  const T0 = sc.T0 + K0, p0 = (sc.p0 ?? 1013) * 100;
  const r0 = rsat(sc.Td0 + K0, p0);
  const zInvTop = sc.blDepth + 200;
  for (let i = 0; i < n; i++) {
    const zi = i * DZ; z[i] = zi;
    let t;
    if (zi <= sc.blDepth) t = T0 - (sc.blLapse / 1000) * zi;
    else if (zi <= zInvTop) t = T0 - (sc.blLapse / 1000) * sc.blDepth + sc.invDT * ((zi - sc.blDepth) / 200);
    else {
      const tInv = T0 - (sc.blLapse / 1000) * sc.blDepth + sc.invDT;
      t = tInv - (sc.ftLapse / 1000) * (Math.min(zi, sc.zTrop) - zInvTop);
      if (sc.capZ && zi > sc.capZ) t += (sc.capDT ?? 0) * Math.min((zi - sc.capZ) / 300, 1);
    }
    T[i] = Math.max(t, 190);
  }
  // давление — гидростатика (с T_v по первому приближению влажности)
  p[0] = p0;
  for (let i = 1; i < n; i++) {
    const Tm = 0.5 * (T[i] + T[i - 1]);
    p[i] = p[i - 1] * Math.exp((-G * DZ) / (RD * Tm * 1.003));
  }
  // влажность: ПС перемешан (r = r0), выше — по относительной влажности
  for (let i = 0; i < n; i++) {
    const zi = z[i];
    let rh;
    if (zi <= sc.blDepth) { r[i] = Math.min(r0, rsat(T[i], p[i])); continue; }
    if (zi <= zInvTop) rh = mix(Math.min(r0 / rsat(T[i], p[i]), 1), sc.rhMid, (zi - sc.blDepth) / 200);
    else if (zi <= 6000) rh = sc.rhMid;
    else if (zi <= 7000) rh = mix(sc.rhMid, sc.rhUp, (zi - 6000) / 1000);
    else rh = zi < sc.zTrop ? sc.rhUp : sc.rhUp * 0.3;
    r[i] = rh * rsat(T[i], p[i]);
  }
  // точечные модификации от синоптической модели (например, влажный воздух над фронтальной поверхностью)
  if (sc.moistAbove) {
    const { z0, rh } = sc.moistAbove, z1 = sc.moistAbove.z1 ?? sc.zTrop;
    for (let i = 0; i < n; i++) if (z[i] >= z0 && z[i] < z1) r[i] = Math.max(r[i], rh * rsat(T[i], p[i]));
  }
  return { z, T, r, p, n };
}
const mix = (a, b, t) => a + (b - a) * Math.min(Math.max(t, 0), 1);
const at = (prof, zi) => Math.min(Math.max(Math.round(zi / DZ), 0), prof.n - 1);

// ------------------------------------------------------------------ подъём частицы
// Возвращает температуру и отношение смеси частицы, поднятой (или опущенной) с уровня i на dz.
export function liftParcel(prof, i, dz, T, r, entr = 0) {
  const steps = Math.max(1, Math.round(Math.abs(dz) / DZ));
  const s = dz / steps;
  let zi = prof.z[i];
  for (let k = 0; k < steps; k++) {
    const j = at(prof, zi);
    const p = prof.p[j];
    const rs = rsat(T, p);
    if (s > 0 && r >= rs * 0.995) { T -= moistLapse(T, p) * s; r = rsat(T, prof.p[at(prof, zi + s)]); }   // допуск: после шага r = r_s с погрешностью
    else T -= GAMMA_D * s;
    zi += s;
    if (entr > 0 && s > 0) {                        // вовлечение окружающего воздуха
      const jj = at(prof, zi), a = (entr / 1000) * s;
      T += a * (prof.T[jj] - T); r += a * (prof.r[jj] - r);
    }
  }
  return { T, r, z: zi };
}

export function parcelAnalysis(prof, sc) {
  let T = prof.T[0] + (sc.heat ?? 0), r = prof.r[0];
  const entr = sc.entr ?? 0;
  const path = [];
  let lcl = null, lfc = null, el = null, cape = 0, cin = 0, saturated = false;
  let posStarted = false;
  for (let i = 0; i < prof.n; i++) {
    const p = prof.p[i];
    if (i > 0) {
      const res = liftParcel(prof, i - 1, DZ, T, r, saturated ? entr : 0);
      T = res.T; r = res.r;
    }
    if (!saturated && r >= rsat(T, p) * 0.995) { saturated = true; lcl = prof.z[i]; }
    const B = (G * (tv(T, r) - tv(prof.T[i], prof.r[i]))) / tv(prof.T[i], prof.r[i]);
    path.push({ z: prof.z[i], T, B });
    if (saturated) {
      if (B > 0) {
        if (lfc === null) lfc = prof.z[i];
        cape += B * DZ; el = prof.z[i]; posStarted = true;
      } else if (!posStarted) cin += B * DZ;
      else if (el !== null && prof.z[i] - el > 1500) break;   // ушли далеко над EL
    } else cin += Math.min(B, 0) * DZ;
    if (prof.z[i] > sc.zTrop + 2000) break;
  }
  return { path, lcl, lfc, el, cape, cin };
}

// ------------------------------------------------------------------ слоистая облачность
export const rhCrit = (z) => 0.78 + 0.1 * Math.exp(-z / 1500);
export const sundqvist = (rh, rhc) => (rh <= rhc ? 0 : 1 - Math.sqrt(Math.max(0, 1 - Math.min(rh, 1)) / (1 - rhc)));

export function stratiform(prof, sc) {
  const dz = (sc.w ?? 0) * (sc.tau ?? 0) * 3600;
  const n = prof.n;
  const frac = new Float64Array(n), qc = new Float64Array(n), rhL = new Float64Array(n);
  // Эйлерова трактовка: за время τ на уровень z приходит воздух с уровня z − Δz, поднятый адиабатически
  // (у земли — приземный воздух; при опускании — воздух сверху, но не выше тропопаузы).
  for (let j = 0; j < n; j++) {
    if (prof.z[j] > sc.zTrop) break;
    const zs = Math.min(Math.max(prof.z[j] - dz, 0), sc.zTrop);
    const i = at(prof, zs);
    const res = liftParcel(prof, i, prof.z[j] - prof.z[i], prof.T[i], prof.r[i]);
    const rs = rsat(res.T, prof.p[j]);
    const rh = Math.min(res.r / rs, 1.05);
    const inMixedBL = sc.blLapse >= 8 && prof.z[j] <= sc.blDepth;
    frac[j] = sundqvist(rh, inMixedBL ? 0.95 : rhCrit(prof.z[j]));
    qc[j] = Math.max(prof.r[i] - rs, 0); rhL[j] = rh;
  }
  return { frac, qc, rhL, liftM: dz };
}

function extractLayers(prof, frac) {
  const layers = [];
  let cur = null, gap = 0;
  for (let i = 0; i < prof.n; i++) {
    if (frac[i] > 0.05) {
      if (!cur) cur = { i0: i, i1: i, sum: 0, cnt: 0, max: 0 };
      cur.i1 = i; cur.sum += frac[i]; cur.cnt++; cur.max = Math.max(cur.max, frac[i]); gap = 0;
    } else if (cur) {
      gap += DZ;
      if (gap > 200) { layers.push(cur); cur = null; gap = 0; }
    }
  }
  if (cur) layers.push(cur);
  return layers.map((l) => ({
    base: prof.z[l.i0], top: prof.z[l.i1] + DZ, cover: l.sum / l.cnt, maxCover: l.max,
    tBase: prof.T[l.i0] - K0, tTop: prof.T[l.i1] - K0,
  }));
}

function classifyStratiform(L, sc, mixedBL) {
  const depth = L.top - L.base;
  if (L.base >= 5000 && L.tTop < -30) return 'Cirrus';
  if (depth >= 2500 && L.base < 3000 && (sc.w ?? 0) > 0.02) return 'Nimbostratus';
  if (L.base >= 2000) return depth >= 800 && L.cover >= 0.6 ? 'Altostratus' : 'Altocumulus';
  if (depth >= 2500 && (sc.w ?? 0) > 0.02) return 'Nimbostratus';
  if (L.base < 500 && !mixedBL) return 'Stratus';
  return mixedBL || L.top >= sc.blDepth - 100 ? 'Stratocumulus' : 'Stratus';
}

function classifyConvective(depth, tTop) {
  if (depth > 7000 && tTop < -38) return 'CumulonimbusIncus';
  if (depth > 5000 && tTop < -20) return 'CumulonimbusCalvus';
  if (depth > 3500) return 'CumulusTowering';
  if (depth > 1800) return 'CumulusCongestus';
  if (depth > 600) return 'CumulusMediocris';
  return 'CumulusHumilis';
}

const CONVECTIVE = new Set(['CumulusHumilis', 'CumulusMediocris', 'CumulusCongestus', 'CumulusTowering', 'CumulonimbusCalvus', 'CumulonimbusIncus']);

// толщины для генератора: у кучевых высоты ячеек разные (диапазон больше), у слоистых — почти одинаковые
function toGenLayer(type, base, top, cover) {
  const depth = Math.max(top - base, 100);
  const conv = CONVECTIVE.has(type);
  const minFrac = type.startsWith('Cumulonimbus') ? 0.75 : conv ? 0.4 : 0.7;
  const r50 = (v) => Math.max(50, Math.round(v / 50) * 50);
  return {
    type, base: Math.round(base / 50) * 50, minT: r50(depth * minFrac), range: r50(depth * (1 - minFrac)),
    oktas: Math.min(8, Math.max(1, Math.round(cover * 8))),
  };
}

// ------------------------------------------------------------------ полный расчёт столба
export function runColumn(sc) {
  const prof = buildProfile(sc);
  const parcel = parcelAnalysis(prof, sc);
  const strat = stratiform(prof, sc);
  const mixedBL = sc.blLapse >= 8;                                  // днём ПС перемешан
  const out = [];

  // конвекция
  let conv = null;
  const trigger = parcel.lfc !== null && parcel.cin > -(30 + 300 * Math.max(sc.w ?? 0, 0));
  const lclInBL = parcel.lcl !== null && parcel.lcl < sc.blDepth + 150 && mixedBL;
  if (parcel.lcl !== null && (trigger || lclInBL)) {
    const top = Math.max(trigger ? parcel.el + DZ : sc.blDepth + 200, parcel.lcl + 300);
    const depth = top - parcel.lcl;
    const tTop = prof.T[at(prof, top)] - K0;
    // влажность под LCL и неустойчивость → покрытие
    let rh = 0, c = 0;
    for (let zi = Math.max(parcel.lcl - 500, 0); zi <= parcel.lcl; zi += DZ) { const j = at(prof, zi); rh += prof.r[j] / rsat(prof.T[j], prof.p[j]); c++; }
    rh /= c;
    const sigma = Math.min(0.85, Math.max(0.05, 0.1 + (0.6 * (rh - 0.6)) / 0.4 + 0.15 * Math.min(parcel.cape / 2000, 1)));
    const capped = (sc.invDT ?? 0) >= 2 && top <= sc.blDepth + 400 && depth < 1200;   // упёрлись в инверсию
    const type = capped ? 'Stratocumulus' : classifyConvective(depth, tTop);
    const cover = type.startsWith('Cumulonimbus') ? Math.min(sigma, 0.45) : capped ? Math.min(1, sigma + 0.3) : sigma;
    conv = { type, base: parcel.lcl, top: capped ? Math.min(top, sc.blDepth + 150) : top, cover, depth, tTop };
  }
  if (conv) out.push({ ...toGenLayer(conv.type, conv.base, conv.top, conv.cover), source: 'конвекция' });

  // слоистые слои
  for (const L of extractLayers(prof, strat.frac)) {
    let type = classifyStratiform(L, sc, mixedBL);
    // кучевая облачность в ПС уже описана конвекцией; Sc под Cu-базой не дублируем
    if (conv && type === 'Stratocumulus' && L.base >= conv.base - 300) continue;
    if (conv && conv.type.startsWith('Cumulonimbus') && L.base > conv.base && L.base < conv.top + 1500) continue;   // внутри Cb или его наковальня
    if (L.base === 0) L.cover = Math.max(L.cover, L.maxCover);                                                        // туман
    if (conv && L.top > conv.base && L.base < conv.top) {
      if (conv.type.startsWith('Cumulonimbus')) {                     // Cb поглощает всё, кроме слоя под основанием
        if (L.base > conv.base - 200) continue;
        L.top = conv.base - 100;
      } else if (L.base >= conv.base) {
        if (L.top <= conv.top + 300) continue;                       // внутри конвекции
        L.base = conv.top + 100;                                      // часть выше вершин
        if (L.top - L.base < 200) continue;
      } else L.top = Math.min(L.top, conv.base - 100);                // слой ниже основания Cu
    }
    if (L.top - L.base < 100 || (L.top - L.base < 200 && L.cover < 0.3)) continue;   // клочки не считаем
    type = classifyStratiform(L, sc, mixedBL);                                          // после обрезки — заново
    if (type === 'Nimbostratus') L.base = Math.max(L.base, 150);                        // Ns — низкая база, но не туман
    out.push({ ...toGenLayer(type, L.base, L.top, L.cover), source: 'подъём слоя' });
  }

  // не больше 4 слоёв (как в генераторе), без пересечений, по возрастанию высоты
  out.sort((a, b) => b.oktas * (b.minT + b.range) - a.oktas * (a.minT + a.range));
  const layers = out.slice(0, 4).sort((a, b) => a.base - b.base);
  for (let k = 1; k < layers.length; k++) {
    const prev = layers[k - 1], top = prev.base + prev.minT + prev.range;
    if (layers[k].base < top + 100) layers[k].base = Math.round((top + 100) / 50) * 50;
  }

  // видимость: туман у земли, дымка от влажности, осадки
  const rh0 = prof.r[0] / rsat(prof.T[0], prof.p[0]);
  let vis = 60 * Math.sqrt(Math.max(1 - Math.min(rh0, 0.995), 0.005));
  const fog = strat.frac[0] > 0.5 || strat.frac[1] > 0.5;
  if (fog) {
    const lwc = Math.max(strat.qc[0], strat.qc[1], 2e-5) * (prof.p[0] / (RD * prof.T[0])) * 1000;   // г/м³
    vis = Math.min(vis, 3.912 / (144.7 * Math.pow(lwc, 0.88)));
  }
  const precip = layers.some((l) => l.type === 'Nimbostratus' || l.type.startsWith('Cumulonimbus'));
  if (precip) vis = Math.min(vis, 6);
  const dbz = conv?.type.startsWith('Cumulonimbus') ? 40 + 15 * Math.min(parcel.cape / 3000, 1)
    : precip ? 25 : conv?.type === 'CumulusCongestus' || conv?.type === 'CumulusTowering' ? 15 : 0;

  return {
    prof, parcel, strat, layers, conv,
    diag: {
      lcl: parcel.lcl, lfc: parcel.lfc, el: parcel.el, cape: parcel.cape, cin: parcel.cin,
      liftM: strat.liftM, visibilityKm: Math.max(0.05, Math.min(vis, 100)), fog, precip, dbz,
      espyLcl: 125 * (sc.T0 - sc.Td0),
    },
  };
}

// ------------------------------------------------------------------ сценарии
export const BASE = {
  T0: 15, Td0: 8, p0: 1013, blDepth: 1000, blLapse: 9.8, invDT: 0, ftLapse: 6.5, zTrop: 11000,
  rhMid: 0.4, rhUp: 0.3, w: 0, tau: 6, heat: 1, entr: 0.15,
};
export const SCENARIOS = {
  fairMorning: { label: 'Ясное летнее утро (инверсия)', T0: 16, Td0: 11, blDepth: 400, blLapse: 4, invDT: 3, rhMid: 0.3, rhUp: 0.2, heat: 0 },
  fairNoon: { label: 'Хорошая погода днём → Cu humilis', T0: 24, Td0: 12, blDepth: 1600, invDT: 1.5, rhMid: 0.35, rhUp: 0.25, heat: 1.5 },
  convection: { label: 'Влажный жаркий день → Cu congestus', T0: 28, Td0: 16, blDepth: 1500, invDT: 0.5, ftLapse: 6.3, rhMid: 0.5, rhUp: 0.3, heat: 1.5, entr: 0.12, capZ: 4800, capDT: 3 },
  thunder: { label: 'Неустойчивая масса → гроза (Cb)', T0: 31, Td0: 21, blDepth: 1200, invDT: 0, ftLapse: 7, rhMid: 0.6, rhUp: 0.5, heat: 2, entr: 0.08 },
  anticyclone: { label: 'Антициклон: Sc под инверсией', T0: 9, Td0: 6.5, blDepth: 1100, blLapse: 9.8, invDT: 5, rhMid: 0.25, rhUp: 0.2, w: -0.01, heat: 0.3 },
  fog: { label: 'Радиационный туман', T0: 4, Td0: 4, blDepth: 250, blLapse: -6, invDT: 4, rhMid: 0.3, rhUp: 0.2, heat: 0 },
  warmFront: { label: 'Тёплый фронт (за 300 км): As', T0: 10, Td0: 0, blDepth: 600, blLapse: 5, invDT: 1, rhMid: 0.35, rhUp: 0.35, w: 0.05, tau: 6, heat: 0, moistAbove: { z0: 2200, z1: 5000, rh: 0.84 } },
  warmFrontNear: { label: 'Тёплый фронт (у линии): Ns', T0: 11, Td0: 9.5, blDepth: 500, blLapse: 5, invDT: 0.5, rhMid: 0.85, rhUp: 0.7, w: 0.1, tau: 8, heat: 0, moistAbove: { z0: 600, z1: 7000, rh: 0.92 } },
  warmFrontFar: { label: 'Тёплый фронт (за 800 км): Ci', T0: 12, Td0: 5, blDepth: 900, invDT: 1, rhMid: 0.35, rhUp: 0.75, w: 0.03, tau: 8, heat: 0.5, moistAbove: { z0: 7000, z1: 10000, rh: 0.9 } },
  coldFront: { label: 'Холодный фронт: линия Cb', T0: 22, Td0: 16, blDepth: 1000, invDT: 0, ftLapse: 7, rhMid: 0.7, rhUp: 0.55, w: 0.3, tau: 2, heat: 1, entr: 0.1 },
  postFrontal: { label: 'Тыл циклона: Cu mediocris', T0: 12, Td0: 4, blDepth: 1400, ftLapse: 7, invDT: 0.3, rhMid: 0.35, rhUp: 0.25, heat: 1.5, entr: 0.12, capZ: 2800, capDT: 3 },
};
export const scenario = (key, over = {}) => ({ ...BASE, ...SCENARIOS[key], ...over });

// ------------------------------------------------------------------ синоптика: идеализированный циклон
// Возвращает параметры столба для точки (x, y) в км. Центр циклона в (0, 0), север — +y.
export function cyclonePoint(x, y, cyc = {}) {
  const R = cyc.R ?? 600, dp = cyc.dp ?? 25, T0 = cyc.T0 ?? 14;
  const r = Math.hypot(x, y);
  const p = 1015 - dp * Math.exp(-(r * r) / (R * R));
  // накачка Экмана: подъём в центре, опускание на периферии
  const rho = 1.2, f = 1e-4, Rm = R * 1000;
  const zeta = ((4 * dp * 100) / (rho * f * Rm * Rm)) * (1 - (r * r) / (R * R)) * Math.exp(-(r * r) / (R * R));
  let w = 0.5 * 500 * zeta;
  const sc = { ...BASE, T0, Td0: T0 - 9, p0: p, blDepth: 800, invDT: 1.5, ftLapse: 6, rhMid: 0.3, rhUp: 0.3, tau: 8, heat: 0.3, entr: 0.25 };

  // фронты: тёплый — на восток-юго-восток (−20°), холодный — на юго-запад (−125°)
  const ang = Math.atan2(y, x);
  const aw = (-20 * Math.PI) / 180, ac = (-125 * Math.PI) / 180;
  const inSector = ang < aw && ang > ac && r < R * 1.4;      // тёплый сектор — между фронтами, вблизи циклона
  // расстояние перед тёплым фронтом (к северу/северо-востоку от его линии)
  const dWarm = -x * Math.sin(aw) + y * Math.cos(aw);        // >0 — «перед» фронтом
  const alongW = x * Math.cos(aw) + y * Math.sin(aw);
  const dCold = x * Math.sin(ac) - y * Math.cos(ac);         // >0 — за холодным фронтом (тыл)
  const alongC = x * Math.cos(ac) + y * Math.sin(ac);
  const aheadWarm = !inSector && dWarm > 0 && dWarm < 1000 && alongW > -150 && alongW < 1300;
  const rear = !inSector && !aheadWarm && dCold > 0 && alongC > -200 && r < R * 1.6;

  if (inSector) {                                            // тёплый сектор
    Object.assign(sc, { T0: T0 + 5, Td0: T0 + 1, blDepth: 1200, invDT: 1, rhMid: 0.5, rhUp: 0.4, heat: 0.8, ftLapse: 6.2 });
    // у холодного фронта: узкая полоса сильного подъёма → Cb
    if (dCold > -120 && alongC > 0 && alongC < 1300) {
      const k = Math.exp(-((dCold + 40) ** 2) / (2 * 50 * 50));
      w += 0.3 * k; sc.ftLapse = 7; sc.rhMid = 0.7; sc.tau = 2; sc.entr = 0.1;
    }
  } else if (aheadWarm) {
    // перед тёплым фронтом: влажный тёплый воздух над фронтальной поверхностью z_f = d/150
    const zf = (dWarm / 150) * 1000;
    w += 0.1 * Math.exp(-dWarm / 400) + 0.02;
    sc.moistAbove = { z0: Math.max(zf, 300), z1: Math.max(zf, 300) + 3000 + 4000 * Math.exp(-dWarm / 300), rh: 0.9 - 0.12 * (dWarm / 1000) };
    sc.rhUp = 0.6; sc.heat = 0; sc.blLapse = 5;
  } else if (rear) {                                         // тыл: холодный воздух, неустойчиво, сухо наверху
    Object.assign(sc, { T0: T0 - 4, Td0: T0 - 10, blDepth: 1400, ftLapse: 7.5, invDT: 0, rhMid: 0.45, rhUp: 0.25, heat: 1.6 });
  }
  if (r < R * 0.35) { sc.moistAbove = { z0: 500, rh: 0.92 }; sc.rhUp = 0.7; w = Math.max(w, 0.06); }   // центр/окклюзия
  if (w < 0 && !inSector) { sc.invDT += Math.min(-w * 250, 4); sc.heat = Math.max(sc.heat - 0.3, 0); sc.rhMid = Math.min(sc.rhMid, 0.35); }
  sc.w = w;
  const zone = r < R * 0.35 ? 'центр (окклюзия)' : inSector ? 'тёплый сектор' : aheadWarm ? 'перед тёплым фронтом' : rear ? 'тыл' : 'периферия';
  return { sc, p, w, zone };
}

// геометрия фронтов для отрисовки (км)
export function cycloneFronts() {
  const aw = (-20 * Math.PI) / 180, ac = (-125 * Math.PI) / 180;
  return {
    warm: [[0, 0], [1300 * Math.cos(aw), 1300 * Math.sin(aw)]],
    cold: [[0, 0], [1300 * Math.cos(ac), 1300 * Math.sin(ac)]],
  };
}
