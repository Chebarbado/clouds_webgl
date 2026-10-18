// Ссылка на текущую конфигурацию: всё состояние в части URL после "#", без сервера.
// Формат: "#c=" + base64url( deflate-raw( JSON компактного массива ) ). Типы облаков — индексы,
// высоты — шагом 50 м, прочие числа округлены; ссылка получается ~100–300 символов.
// Если браузер не умеет CompressionStream, JSON кодируется без сжатия (префикс "j").

const VERSION = 1;
const QUALITIES = ['low', 'medium', 'high'];
const r = (v, k = 1) => Math.round(v * k);

export function packState(state, camera, controls, typeKeys) {
  const zones = state.zones.map((z) => z.layers.map((l) => [
    typeKeys.indexOf(l.type), r(l.base / 50), r(l.minT / 50), r(l.range / 50), l.oktas, l.enabled ? 1 : 0, l.clump ?? 1,
  ]));
  const p = camera.position, t = controls.target;
  return [
    VERSION, state.tileKm, state.grid.nx, state.grid.ny, r(state.blendKm, 2), state.seed,
    state.resH, state.resV, state.slabMode === 'auto' ? 0 : 1, zones, state.sel,
    [state.wind ? 1 : 0, state.windSpeed, state.windFrom, state.develop ? 1 : 0, state.timeScale],
    [r(state.sunAz), r(state.sunEl, 2), state.animateSun ? 1 : 0],
    r(state.visibilityKm, 10),
    [r(state.densMul, 100), r(state.ext), r(state.erode, 100), r(state.exposure, 100), QUALITIES.indexOf(state.quality)],
    [r(p.x, 100), r(p.y, 100), r(p.z, 100), r(t.x, 100), r(t.y, 100), r(t.z, 100)],
    [state.terrain || 0, state.imagery],
  ];
}

// Обратное преобразование с проверкой: неизвестные типы отбрасываются, числа ограничиваются
export function unpackState(a, typeKeys) {
  if (!Array.isArray(a) || a[0] !== VERSION) throw new Error('неизвестная версия ссылки');
  const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  const nx = num(a[2], 1, 3, 1), ny = num(a[3], 1, 3, 1);
  const zones = Array.from({ length: nx * ny }, (_, i) => ({
    layers: (a[9]?.[i] ?? []).filter((l) => typeKeys[l[0]]).slice(0, 4).map((l) => ({
      type: typeKeys[l[0]], base: num(l[1] * 50, 0, 12000, 1000), minT: num(l[2] * 50, 50, 9000, 500),
      range: num(l[3] * 50, 0, 6000, 500), oktas: num(l[4], 1, 8, 4), enabled: l[5] !== 0,
      clump: num(l[6] ?? a[17], 0, 3, 1),               // в старых ссылках режим был общий (a[17])
    })),
  }));
  const [wind, speed, from, dev, ts] = a[11] ?? [];
  const [az, el, animSun] = a[12] ?? [];
  const [dens, ext, erode, expo, q] = a[14] ?? [];
  return {
    tileKm: num(a[1], 8, 128, 32), grid: { nx, ny }, blendKm: num(a[4] / 2, 0, 30, 8), seed: num(a[5], 0, 1e6, 1),
    resH: num(a[6], 128, 512, 384), resV: num(a[7], 48, 256, 192), slabMode: a[8] ? 'one' : 'auto',
    zones, sel: num(a[10], 0, nx * ny - 1, 0),
    wind: !!wind, windSpeed: num(speed, 0, 40, 12), windFrom: num(from, 0, 359, 290), develop: !!dev, timeScale: num(ts, 1, 120, 30),
    sunAz: num(az, 0, 360, 280), sunEl: num(el / 2, -5, 90, 35), animateSun: !!animSun,
    visibilityKm: num(a[13] / 10, 0.2, 100, 100),
    densMul: num(dens / 100, 0.1, 3, 1), ext: num(ext, 2, 80, 45), erode: num(erode / 100, 0, 1.5, 1),
    exposure: num(expo / 100, 0.3, 3, 1.1), quality: QUALITIES[q] ?? 'medium',
    camera: Array.isArray(a[15]) && a[15].length === 6 ? a[15].map((v) => v / 100) : null,
    terrain: typeof a[16]?.[0] === 'string' && /^[a-z]+$/.test(a[16][0]) ? a[16][0] : '',
    imagery: a[16]?.[1] === 'esri' ? 'esri' : 's2',
  };
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encode(packed) {
  const json = new TextEncoder().encode(JSON.stringify(packed));
  if (typeof CompressionStream === 'undefined') return 'j' + b64url(json);
  return 'z' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decode(code) {
  const kind = code[0], bytes = fromB64url(code.slice(1));
  const json = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return JSON.parse(new TextDecoder().decode(json));
}

export const hashCode = () => (location.hash.startsWith('#c=') ? location.hash.slice(3) : null);
