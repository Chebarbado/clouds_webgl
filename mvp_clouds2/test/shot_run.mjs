// Полный прогон режима съёмки (#76): 3 сцены × 5 ракурсов = 15 эталонных кадров.
// Для каждого: открываем по ссылке, ждём __shotReady, делаем два снимка подряд и сравниваем
// хеши (детерминизм), замеряем время готовности от конца загрузки (критерий < 5 с).
// После снимков считаются метрики похожести на референсы (#78) → shots/metrics.json.
// Запуск: node test/shot_run.mjs [http://localhost:8081]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://localhost:8081';
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const exe = EDGE.find(existsSync);
if (!exe) throw new Error('Edge не найден');

const { scenes, views } = JSON.parse(readFileSync(new URL('./scenes.json', import.meta.url), 'utf8'));
const sceneNames = Object.keys(scenes);
const viewNames = Object.keys(views);
const hash16 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

const browser = await puppeteer.launch({
  executablePath: exe, headless: true,
  args: ['--no-sandbox', '--use-angle=default',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
const results = [];
let fail = 0;

for (const sceneName of sceneNames) {
  for (const view of viewNames) {
    const row = { scene: sceneName, view };
    await page.goto(`${base}/index.html?shot=${sceneName}&view=${view}`,
      { waitUntil: 'domcontentloaded', timeout: 180000 });
    const tLoad = Date.now();                        // критерий «<5 с после загрузки»

    let pumping = true;
    const pump = (async () => {                      // прокачка viewport держит rAF на ходу
      let w = 1600;
      while (pumping) {
        w = w === 1600 ? 1601 : 1600;
        try { await page.setViewport({ width: w, height: 900 }); }
        catch { return; }
      }
      await page.setViewport({ width: 1600, height: 900 });
    })();

    try {
      await page.waitForFunction('window.__shotReady === true || window.__shotError',
        { timeout: 120000, polling: 50 });
      const err = await page.evaluate('window.__shotError || null');
      if (err) throw new Error(err);
      row.readyMs = Date.now() - tLoad;
    } catch (e) {
      row.error = String(e.message || e);
    } finally {
      pumping = false;
      await pump;                       // снимки — только после остановки: прокачка меняет размер окна
    }

    if (!row.error) {
      try {
        // пауза после прокачки: первый снимок не должен ловить откат viewport 1601→1600
        await new Promise((r) => setTimeout(r, 500));
        const shot1 = await page.screenshot({ type: 'png' });
        await new Promise((r) => setTimeout(r, 800));
        const shot2 = await page.screenshot({ type: 'png' });
        row.hash1 = hash16(shot1);
        row.hash2 = hash16(shot2);
        row.bytes = shot1.length;
        row.deterministic = row.hash1 === row.hash2;
        row.fast = row.readyMs < 5000;
        writeFileSync(new URL(`./shots/${sceneName}_${view}.png`, import.meta.url), shot1);
      } catch (e) {
        row.error = String(e.message || e);
      }
    }

    const ok = row.error ? false : row.deterministic && row.fast;
    if (!ok) fail++;
    results.push(row);
    const status = row.error ? `ERROR: ${row.error}`
      : !row.deterministic ? 'FAIL: кадры различаются'
      : !row.fast ? `FAIL: готовность ${row.readyMs} мс ≥ 5000`
      : 'OK';
    console.log(`${sceneName}/${view}: ${status}${row.readyMs ? ` · ready ${row.readyMs} мс · ${row.hash1} · ${row.bytes} б` : ''}`);
  }
}

await browser.close();

const summary = {
  date: new Date().toISOString(),
  base,
  total: results.length,
  passed: results.length - fail,
  failed: fail,
  maxReadyMs: Math.max(...results.filter((r) => r.readyMs).map((r) => r.readyMs)),
  results,
};
writeFileSync(new URL('./shots/report.json', import.meta.url), JSON.stringify(summary, null, 1) + '\n');

// шаг метрик похожести (#78): python tools/clouds2_bench/metrics.py → shots/metrics.json.
// Необязательный: без python/scipy стенд отработает, отчёт будет без таблицы метрик.
const py = spawnSync('python', [
  fileURLToPath(new URL('../../tools/clouds2_bench/metrics.py', import.meta.url)),
  '--shots', fileURLToPath(new URL('./shots/', import.meta.url)),
  '--scenes', fileURLToPath(new URL('./scenes.json', import.meta.url)),
], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
if (py.status === 0) console.log(py.stdout.trim());
else console.warn('метрики не посчитаны (шаг необязательный): '
  + (py.stderr || '').trim().split('\n').slice(-2).join(' | '));

await import('./report.mjs');                          // HTML-отчёт стенда (#77)
console.log(`\nИтог: ${summary.passed}/${summary.total} кадров, худшая готовность ${summary.maxReadyMs} мс`);
console.log(fail ? `FAIL: ${fail} кадров` : 'OK: все кадры детерминированы и готовы <5 с');
process.exit(fail ? 1 : 0);
