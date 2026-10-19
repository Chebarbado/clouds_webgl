// Проверка режима съёмки (#76): снимок эталонного кадра, два раза подряд — хеши равны.
// Запуск при поднятом сервере: node test/shot_check.mjs [http://localhost:8081] [сцена] [view]
// headless-браузер рисует ~1 кадр/с сам; плотная прокачка снимками (jpeg) держит rAF на ходу.
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://localhost:8081';
const sceneName = process.argv[3] ?? 'ieta';
const view = process.argv[4] ?? '0';
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const exe = EDGE.find(existsSync);
if (!exe) throw new Error('Edge не найден');

const browser = await puppeteer.launch({
  executablePath: exe, headless: true,
  args: ['--no-sandbox', '--use-angle=default',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

await page.goto(`${base}/index.html?shot=${sceneName}&view=${view}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
// Критерий #76 — «кадр готов за <5 с ПОСЛЕ загрузки»: модули (включая прогрев шейдера)
// исполняются до DOMContentLoaded, так что таймер ожидания стартует от конца загрузки.
const tLoad = Date.now();

// прокачка: в headless rAF страницы замирает (~1 кадр/с). Смена viewport через CDP двигает
// композитор и держит rAF ~57 кадр/с — кадр достигает готовности за секунды, а не минуты.
let pumping = true;
const pump = (async () => {
  let w = 1600;
  while (pumping) {
    w = w === 1600 ? 1601 : 1600;   // micro-resize: форсирует кадр, буфер кадра 1600×900 не меняется
    try { await page.setViewport({ width: w, height: 900 }); }
    catch { return; }               // страница закрыта
  }
  await page.setViewport({ width: 1600, height: 900 });
})();

let readyMs = null;
try {
  await page.waitForFunction('window.__shotReady === true || window.__shotError', { timeout: 170000, polling: 50 });
  const err = await page.evaluate('window.__shotError || null');
  if (err) throw new Error('shotError: ' + err);
  readyMs = Date.now() - tLoad;
} finally {
  pumping = false;
  await pump;
}
// после прокачки даём композитору отрисовать кадр в финальном размере окна —
// иначе первый снимок ловит viewport на откате 1601→1600 и отличается от второго
await new Promise((r) => setTimeout(r, 500));
console.log(`готов за ${(readyMs / 1000).toFixed(1)} с после загрузки`);

const shot1 = await page.screenshot({ type: 'png' });
await new Promise((r) => setTimeout(r, 1500));
const shot2 = await page.screenshot({ type: 'png' });
const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
console.log('снимок 1:', h(shot1), shot1.length, 'байт');
console.log('снимок 2:', h(shot2), shot2.length, 'байт');
console.log(h(shot1) === h(shot2) ? 'OK: кадры побайтно равны' : 'FAIL: кадры различаются');

mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./shots/${sceneName}_${view}.png`, import.meta.url), shot1);
console.log(`shots/${sceneName}_${view}.png записан`);
await browser.close();
