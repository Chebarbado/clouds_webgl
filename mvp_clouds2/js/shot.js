// Режим съёмки для стенда (E0, #76): index.html?shot=<сцена>&view=<0..4>
// Детерминированный кадр: время и динамика заморожены, буфер кадра фиксирован (1600×900,
// не зависит от окна), качество не режется по мобильному профилю. Сцена — из test/scenes.json:
// ссылка-состояние #c= эталонного кадра + возмущение ракурса против подгонки (±10° курс,
// ±20% дистанции, другой seed). Когда ландшафт загружен, генерация доделана и кадр стабилен
// settle кадров — ставится window.__shotReady = true; ошибка — window.__shotError.

export function initShot() {
  const p = new URLSearchParams(location.search);
  const scene = p.get('shot');
  if (!scene) return null;
  const view = Math.min(4, Math.max(0, Number.parseInt(p.get('view') ?? '0', 10) || 0));
  return { scene, view, W: 1600, H: 900, settle: 30, cfg: null, terrain: 'pending', frames: 0, stable: false };
}

export async function loadShotScene(shot) {
  const res = await fetch('test/scenes.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`scenes.json: HTTP ${res.status}`);
  const all = await res.json();
  const sc = all.scenes?.[shot.scene];
  if (!sc) throw new Error(`нет сцены «${shot.scene}» (есть: ${Object.keys(all.scenes ?? {}).join(', ')})`);
  return { ...sc, view: all.views?.[String(shot.view)] ?? {} };
}

// Возмущение ракурса вокруг цели: поворот по курсу и дистанция (детерминированно, до пикселя)
export function applyShotView(camera, controls, shot) {
  const v = shot.cfg?.view ?? {};
  if (shot.cfg?.fov) { camera.fov = shot.cfg.fov; camera.updateProjectionMatrix(); }
  const t = controls.target, p = camera.position;
  const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z;
  const a = ((v.yawDeg ?? 0) * Math.PI) / 180;
  const s = v.dist ?? 1;
  const cos = Math.cos(a) * s, sin = Math.sin(a) * s;
  p.set(t.x + dx * cos - dz * sin, t.y + dy * s, t.z + dx * sin + dz * cos);
}

export function shotFail(shot, msg) {
  if (shot && !window.__shotError) window.__shotError = msg;
}

// Детерминированная последовательность R2 (2D, золотое сечение) — джиттер для TAA (E1, #83)
export function r2Jitter(i) {
  const g1 = 0.6180339887498949, g2 = 0.7548776662466927;
  return [(0.5 + g1 * (i + 1)) % 1, (0.5 + g2 * (i + 1)) % 1];
}
