// Модель атмосферы на CPU — те же формулы, что skyRadiance в shaders.js (км, однократное рассеяние).
// Считается только при смене солнца/видимости: цвет солнца, окружающий свет неба, цвет дымки.

const RE = 6360, RA = 6420, HR = 8, HM = 1.2;
const BR = [5.8e-3, 13.5e-3, 33.1e-3];

function raySph(o, d, r) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return [-1, -1];
  const q = Math.sqrt(disc);
  return [-b - q, -b + q];
}
const at = (o, d, t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

// Оптическая толща (Рэлей, Ми) от точки p до верхней границы атмосферы вдоль d; null — Земля заслоняет
function opticalDepth(p, d, n = 8) {
  if (raySph(p, d, RE)[0] > 0) return null;
  const dl = raySph(p, d, RA)[1] / n;
  let r = 0, m = 0;
  for (let j = 0; j < n; j++) {
    const h = len(at(p, d, dl * (j + 0.5))) - RE;
    r += Math.exp(-h / HR) * dl; m += Math.exp(-h / HM) * dl;
  }
  return [r, m];
}

// Пропускание атмосферы от высоты altKm до солнца (RGB)
export function sunTransmittance(altKm, sd, betaM) {
  const od = opticalDepth([0, RE + altKm, 0], sd, 16);
  if (!od) return [0, 0, 0];
  return BR.map((b) => Math.exp(-(b * od[0] + betaM * 1.1 * od[1])));
}

// Яркость неба в направлении rd (без множителя интенсивности солнца)
export function skyRadiance(altKm, rd, sd, betaM) {
  const ro = [0, RE + Math.max(altKm, 0.002), 0];
  let tEnd = raySph(ro, rd, RA)[1];
  const tg = raySph(ro, rd, RE);
  if (tg[0] > 0) tEnd = tg[0];
  const N = 16;
  const sR = [0, 0, 0], sM = [0, 0, 0];
  let oR = 0, oM = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N;                          // шаги сгущаются у камеры: t = tEnd·x²
    const ds = (tEnd * 2 * x) / N;
    const p = at(ro, rd, tEnd * x * x);
    const h = len(p) - RE;
    const hr = Math.exp(-h / HR) * ds, hm = Math.exp(-h / HM) * ds;
    oR += hr; oM += hm;
    const l = opticalDepth(p, sd, 6);
    if (!l) continue;
    for (let k = 0; k < 3; k++) {
      const att = Math.exp(-(BR[k] * (oR + l[0]) + betaM * 1.1 * (oM + l[1])));
      sR[k] += att * hr; sM[k] += att * hm;
    }
  }
  const mu = rd[0] * sd[0] + rd[1] * sd[1] + rd[2] * sd[2];
  const pR = 0.0597 * (1 + mu * mu);
  const g = 0.76, g2 = g * g;
  const pM = 0.1194 * (1 - g2) * (1 + mu * mu) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));
  return [0, 1, 2].map((k) => sR[k] * BR[k] * pR + sM[k] * betaM * pM);
}

// Средняя яркость неба по направлениям с заданными высотами (град) и весами
export function skyAverage(altKm, sd, betaM, elevs, weights) {
  const acc = [0, 0, 0];
  let wsum = 0;
  elevs.forEach((e, i) => {
    const el = (e * Math.PI) / 180;
    for (let a = 0; a < 8; a++) {
      const az = (a / 8) * Math.PI * 2;
      const rd = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
      const L = skyRadiance(altKm, rd, sd, betaM);
      for (let k = 0; k < 3; k++) acc[k] += L[k] * weights[i];
      wsum += weights[i];
    }
  });
  return acc.map((v) => v / wsum);
}

// Коэффициент рассеяния Ми у земли из метеовидимости (Кошмидер), за вычетом Рэлея
export const mieFromVisibility = (visKm) => Math.max(3.912 / visKm - 0.0135, 0.002);
