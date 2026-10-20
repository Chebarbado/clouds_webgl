// HTML-отчёт стенда (#77): собирает shots/report.json, снимки и референсы в один
// самодостаточный файл test/report/index.html — картинки вшиты base64, файл открывается
// без сервера и без сети. Автоматически вызывается в конце shot_run.mjs; отдельный
// запуск (по уже снятым кадрам): node test/report.mjs
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
const reportPath = dir('./shots/report.json');
if (!existsSync(reportPath)) {
  if (import.meta.url.endsWith('report.mjs') && process.argv[1]?.endsWith('report.mjs'))
    console.error('нет shots/report.json — сначала запустите node test/shot_run.mjs');
  process.exit(1);
}
const summary = JSON.parse(readFileSync(reportPath, 'utf8'));
const { views, scenes, mask } = JSON.parse(readFileSync(dir('./scenes.json'), 'utf8'));

// метрики похожести (#78) — их может не быть (шаг необязательный в shot_run.mjs)
const metricsPath = dir('./shots/metrics.json');
const metrics = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, 'utf8')) : null;
// коридоры реальности (realset, p10–90 по 30 фото типа) — опционально
const corrPath = dir('../../tools/clouds2_bench/realset/corridors.json');
const corridors = existsSync(corrPath) ? JSON.parse(readFileSync(corrPath, 'utf8')) : null;

// файл картинки → data URL; файла может не быть (референсы cool_* не в репозитории)
const dataUrl = (rel) => {
  const p = dir(rel);
  if (!existsSync(p)) return null;
  const mime = p.endsWith('.webp') ? 'image/webp' : 'image/png';
  return `data:${mime};base64,` + readFileSync(p).toString('base64');
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = (b) => (b / 1024).toFixed(0) + ' КБ';

// ячейка одного кадра: снимок, статус, метаданные
function cell(r) {
  const img = dataUrl(`./shots/${r.scene}_${r.view}.png`);
  const label = views[r.view]?.label ?? r.view;
  let badge, why = '';
  if (r.error) { badge = '<b class="bad">ERROR</b>'; why = esc(r.error); }
  else if (!r.deterministic) { badge = '<b class="bad">FAIL</b>'; why = 'кадры различаются'; }
  else if (!r.fast) { badge = '<b class="bad">FAIL</b>'; why = `готовность ${r.readyMs} мс ≥ 5000`; }
  else badge = '<b class="ok">OK</b>';
  const meta = r.error ? why
    : `ready ${r.readyMs} мс · ${r.hash1} · ${kb(r.bytes)}${!r.deterministic ? ' · второй кадр ' + r.hash2 : ''}`;
  return `<figure>${img ? `<img src="${img}" alt="${esc(r.scene)}/${esc(r.view)}" loading="lazy">`
    : '<div class="noimg">снимок отсутствует</div>'}
  <figcaption>${badge} <span>${esc(label)}</span><small>${esc(meta)}</small></figcaption></figure>`;
}

// таблица метрик похожести сцены (#78): строка референса + по строке на ракурс.
// Если для типа сцены есть коридор (realset: p10–90 по 30 фото) — значения
// подсвечиваются, добавляется колонка «в коридоре» (приёмка: ≥6 из 7).
const mnum = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const CORR_KEYS = [
  ['m2', (r) => r.m2_contrast, 2],
  ['m3', (r) => r.m3_slope, 3],
  ['m4', (r) => r.m4_fd, 3],
  ['m5_median', (r) => r.m5?.median, 2],
  ['m5_p90', (r) => r.m5?.p90, 2],
  ['m7a', (r) => r.m7?.cloud?.a_mean, 2],
  ['m7b', (r) => r.m7?.cloud?.b_mean, 2],
];

function metricsTable(name) {
  if (!metrics) return '';
  const type = scenes[name]?.type;
  const bands = corridors?.types?.[type] ?? null;
  const ref = metrics.references?.[name];
  const rows = (metrics.results ?? []).filter((r) => r.scene === name);
  if (!ref && !rows.length) return '';
  const line = (label, r, isRef = false) => {
    const tr = isRef ? ' class="refrow"' : '';
    if (r.error) return `<tr${tr}><td>${esc(label)}</td><td colspan="${9 + (bands ? 1 : 0)}">ошибка: ${esc(r.error)}</td></tr>`;
    let inN = 0, cnt = 0;
    const tds = CORR_KEYS.map(([k, get, d]) => {
      const v = get(r);
      const txt = mnum(v, d);
      if (!bands?.[k] || v == null || Number.isNaN(v)) return `<td>${txt}</td>`;
      cnt++;
      const ok = v >= bands[k].p10 && v <= bands[k].p90;
      if (ok) inN++;
      return `<td><span class="${ok ? 'inb' : 'outb'}"`
        + ` title="коридор ${bands[k].p10.toFixed(3)}…${bands[k].p90.toFixed(3)}">${txt}</span></td>`;
    }).join('');
    const score = bands ? `<td>${cnt ? `${inN}/${cnt}` : '—'}</td>` : '';
    return `<tr${tr}><td>${esc(label)}</td><td>${mnum(r.cloud_frac)}</td>`
      + `<td>${mnum(r.m1_emd)}</td>${tds}${score}</tr>`;
  };
  const refLine = ref ? line('референс (фото)', ref, true) : '';
  // маски-измерители: коридор по дефолтной; если сцена меряет кадры/референс
  // своей маской — это расхождение инструментов, вердикт помечаем
  const mb = mask?.[name] ?? {};
  const frameDiff = Object.entries(mb)
    .some(([k, v]) => k !== 'ref' && v && Object.keys(v).length);
  const refDiff = !!mb.ref;
  const warn = bands
    ? (frameDiff ? ' · ⚠ снимки — своей кадровой маской, вердикт индикативен' : '')
      + (refDiff ? ' · референс — своим перекрытием маски' : '')
    : '';
  const corrNote = bands
    ? ` · коридор: p10–90 по ${corridors.calib_n?.[type] ?? 30} фото типа «${esc(type)}» (realset,`
      + ` holdout ${corridors.holdout?.[type] ? Math.round(100 * corridors.holdout[type].frac) + '% в коридоре' : '—'})`
      + warn
    : '';
  const scoreHead = bands ? '<th>в коридоре</th>' : '';
  return `<table class="metrics">
  <caption>Метрики похожести (#78) — по маске облаков, нормированы по ширине 1024 px${corrNote}</caption>
  <tr><th>кадр</th><th>облако, доля</th><th>M1 EMD</th><th>M2 p95/p5</th><th>M3 наклон</th>
      <th>M4 D границы</th><th>M5 p50</th><th>M5 p90</th>
      <th>M7 a*</th><th>M7 b*</th>${scoreHead}</tr>
  ${refLine}
  ${rows.map((r) => line(views[r.view]?.label ?? r.view, r)).join('\n  ')}
</table>`;
}

// блок сцены: референс рядом с эталонным ракурсом, ниже — возмущённые
function sceneBlock(name) {
  const sc = scenes[name];
  const rs = summary.results.filter((r) => r.scene === name);
  const ref = dataUrl(sc?.ref ?? '');
  const refNote = ref ? 'референс (фото)' : 'референс недоступен (фото не в репозитории)';
  return `<section id="s-${esc(name)}">
  <h2>${esc(sc?.label ?? name)}</h2>
  ${metricsTable(name)}
  <div class="pair">
    <figure><div class="ref">${ref ? `<img src="${ref}" alt="референс ${esc(name)}" loading="lazy">`
      : '<div class="noimg">нет файла</div>'}</div>
    <figcaption><span>${refNote}</span></figcaption></figure>
    ${rs.map(cell).join('\n    ')}
  </div>
</section>`;
}

const fail = summary.failed > 0;
const verdict = fail
  ? `<span class="bad">FAIL: ${summary.failed} из ${summary.total} кадров</span>`
  : `<span class="ok">OK: все ${summary.total} кадров детерминированы и готовы &lt;5 с</span>`;
const when = new Date(summary.date).toLocaleString('ru-RU', { hour12: false });

const html = `<!doctype html>
<meta charset="utf-8">
<title>Стенд mvp_clouds2 — отчёт</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #0e141e; color: #dbe4ef;
         font: 14px/1.5 system-ui, "Segoe UI", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 28px 0 12px; font-size: 16px; color: #9fc0e8; }
  .sum { color: #8b98a9; margin-bottom: 16px; }
  .banner { display: inline-block; padding: 6px 12px; border-radius: 8px; font-size: 15px;
            background: #12200f; border: 1px solid #3fb95033; }
  .banner .bad { color: #ff7b72; background: #240e0e; border-color: #f8514933; }
  .ok  { color: #3fb950; } .bad { color: #ff7b72; }
  .pair { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  figure { margin: 0; }
  img, .noimg { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px;
                border: 1px solid #2b3648; background: #101826; display: block; }
  .ref img { object-fit: contain; background: #0a0f16; }
  .noimg { display: grid; place-items: center; color: #596372; font-size: 12px; }
  figcaption { padding: 6px 2px 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  figcaption span { color: #dbe4ef; }
  figcaption small { color: #8b98a9; width: 100%; }
  /* таблица метрик похожести (#78) */
  table.metrics { border-collapse: collapse; margin: 0 0 12px; font-variant-numeric: tabular-nums; }
  table.metrics caption { text-align: left; color: #8b98a9; font-size: 12px; padding: 0 0 6px; }
  table.metrics th, table.metrics td { padding: 3px 10px; border-bottom: 1px solid #223046;
    text-align: right; white-space: nowrap; }
  table.metrics th:first-child, table.metrics td:first-child { text-align: left; }
  table.metrics th { color: #9fc0e8; font-weight: 600; }
  table.metrics tr.refrow td { color: #e3b341; }
  table.metrics span.outb { color: #ff7b72; }
</style>
<h1>Стенд mvp_clouds2 — эталонные кадры</h1>
<div class="sum">${verdict}<br>
Кадр 1600×900 · ${esc(when)} · источник: <code>${esc(summary.base)}</code> ·
худшая готовность ${summary.maxReadyMs} мс (критерий &lt; 5000 мс)</div>
<nav class="sum">${Object.keys(scenes).map((n) => `<a href="#s-${esc(n)}" style="color:#9fc0e8;margin-right:12px">${esc(n)}</a>`).join('')}</nav>
${Object.keys(scenes).filter((n) => summary.results.some((r) => r.scene === n)).map(sceneBlock).join('\n')}
`;

mkdirSync(dir('./report/'), { recursive: true });
const out = dir('./report/index.html');
writeFileSync(out, html);
console.log(`HTML-отчёт: ${out} (${kb(Buffer.byteLength(html))})`);
