// Адверсальные тесты режима съёмки (#76): пытаемся сломать детерминизм кадра.
//   1. Сделать снимок, «свернуть вкладку» на 30 с, вернуть — кадр тот же
//   2. Изменить размер окна между снимками — буфер фиксирован 1600×900
//   3. Медленная сеть — ready не выставляется раньше полной загрузки страницы
// Запуск: node test/adverse_run.mjs [http://localhost:8081]
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://localhost:8081';
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const exe = EDGE.find(existsSync);
if (!exe) throw new Error('Edge не найден');
const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

const browser = await puppeteer.launch({
  executablePath: exe, headless: true,
  args: ['--no-sandbox', '--use-angle=default',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

async function openShot(scene = 'ieta', view = '0') {
  await page.goto(`${base}/index.html?shot=${scene}&view=${view}`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  let pumping = true;
  const pump = (async () => {
    let w = 1600;
    while (pumping) {
      w = w === 1600 ? 1601 : 1600;
      try { await page.setViewport({ width: w, height: 900 }); } catch { return; }
    }
    await page.setViewport({ width: 1600, height: 900 });
  })();
  await page.waitForFunction('window.__shotReady === true || window.__shotError',
    { timeout: 120000, polling: 50 });
  const err = await page.evaluate('window.__shotError || null');
  if (err) throw new Error(err);
  pumping = false; await pump;
  await new Promise((r) => setTimeout(r, 400));
}

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`);
};

// --- 1. «Свёрнутая вкладка» 30 с -------------------------------------------------
// Буфер кадра читаем напрямую из канваса (toDataURL): скриншот страницы зависит от
// размера окна, а нам нужна именно неизменность содержимого фиксированного буфера.
await openShot();
const canvasPng = () => page.evaluate(() => {
  // канвасы на странице: WebGL (основной кадр) и #radarOverlay (миникарта); берём основной
  const c = document.querySelector('canvas:not(#radarOverlay)');
  return c.toDataURL('image/png').split(',')[1];
});
const before = await canvasPng();
await page.evaluate(() => Object.defineProperty(document, 'visibilityState',
  { value: 'hidden', configurable: true }));           // вкладка «свернута»
await new Promise((r) => setTimeout(r, 30000));
await page.evaluate(() => Object.defineProperty(document, 'visibilityState',
  { value: 'visible', configurable: true }));
await new Promise((r) => setTimeout(r, 1000));
const after = await canvasPng();
ok('свёрнутая вкладка 30 с', before === after, `${h(Buffer.from(before, 'base64'))} / ${h(Buffer.from(after, 'base64'))}`);

// --- 2. Смена размера окна между снимками ----------------------------------------
for (const [w, hgt] of [[800, 600], [1920, 1080]]) {
  await page.setViewport({ width: w, height: hgt });
  await new Promise((r) => setTimeout(r, 500));
  const s = await canvasPng();
  const dim = await page.evaluate(() => {
    const c = document.querySelector('canvas:not(#radarOverlay)');
    return [c.width, c.height];
  });
  ok(`окно ${w}×${hgt} между снимками`, s === before && dim[0] === 1600 && dim[1] === 900,
    `хеш ${h(Buffer.from(s, 'base64'))}, буфер ${dim[0]}×${dim[1]}`);
}
await page.setViewport({ width: 1600, height: 900 });

// --- 3. Медленная сеть: ready не раньше полной загрузки ---------------------------
// Эталонные сцены без ландшафта (terrain=''), поэтому проверяем саму сеть:
// перехватываем загрузку модулей и сцен и следим, что __shotReady не выставлен
// раньше, чем завершился последний network-запрос.
await page.evaluateOnNewDocument(() => {
  window.__netPending = 0;
  window.__readyBeforeLoad = false;
  const origFetch = window.fetch;
  window.fetch = (...a) => { window.__netPending++; return origFetch(...a).finally(() => window.__netPending--); };
  const check = setInterval(() => {
    if (window.__shotReady && window.__netPending > 0) window.__readyBeforeLoad = true;
    if (window.__shotReady && document.readyState === 'complete') clearInterval(check);
  }, 20);
});
await page.emulateNetworkConditions({ download: (100 * 1024) / 8, upload: (40 * 1024) / 8, latency: 400 });
await page.goto(`${base}/index.html?shot=ieta&view=0`, { waitUntil: 'load', timeout: 300000 });
const tLoad = Date.now();
await page.waitForFunction('window.__shotReady === true || window.__shotError',
  { timeout: 240000, polling: 100 });
const errSlow = await page.evaluate('window.__shotError || null');
const early = await page.evaluate('window.__readyBeforeLoad');
ok('медленная сеть (Slow-3G): ready не раньше загрузки', !errSlow && !early,
  errSlow ? `ошибка: ${errSlow}` : `ready через ${Date.now() - tLoad} мс после load`);
await page.emulateNetworkConditions(null);

await browser.close();
console.log(fail ? `FAIL: ${fail} адверсальных тестов` : 'OK: адверсальные тесты пройдены');
process.exit(fail ? 1 : 0);
