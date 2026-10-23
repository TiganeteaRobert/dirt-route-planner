// M1 end-to-end check in the PC's Chrome, emulating an Android phone: build preview, small download, airplane mode
// reload, GPS fix, a short recorded ride, GPX import, slope + hillshade offline. Screenshots go to tests/e2e/out/.
//   npm run build && node tests/e2e/m1.e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out');
mkdirSync(OUT, { recursive: true });

const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 46.6205, longitude: 23.0510, accuracy: 6 }, permissions: ['geolocation'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let step = 0;
const shot = async (name) => {
  const f = join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  console.log('shot', f);
};
const tilesLoaded = () => page.waitForFunction(() => {
  const m = window.dirtscout?.map;
  return m && m.loaded() && m.areTilesLoaded();
}, null, { timeout: 60000 }).catch(() => console.log('  (tiles still loading)'));
const settle = (ms = 800) => page.waitForTimeout(ms);
const click = (sel) => page.locator(sel).first().click();
const text = (t) => page.getByText(t, { exact: false }).first();

try {
  // 1. First start online: the service worker installs the app shell.
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await tilesLoaded(); await settle();
  await shot('start-online');

  // 2. Offline panel, small download: what is on screen around Belis at z12-15, Microsoft Earth + elevation.
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.051, 46.6205], zoom: 14 }));
  await tilesLoaded();
  await click('#toolbar [data-sheet="downloads"]');
  await settle();
  await shot('offline-panel');
  await page.getByLabel('What is on screen now').check();
  const selects = page.locator('.zoom-row select');
  await selects.nth(0).selectOption('12');
  await selects.nth(1).selectOption('15');
  await settle(300);
  console.log('estimate:', (await page.locator('.estimate').innerText()).replace(/\n/g, ' | '));
  await click('text=Start download');
  for (let i = 0; ; i++) {
    const finished = await page.evaluate(async () => {
      const d = window.dirtscout.debug.downloader;
      const jobs = await d.jobs();
      return !d.job && jobs.length > 0 && jobs.every((j) => j.status.startsWith('done'));
    });
    if (finished) break;
    if (i > 180) throw new Error('download did not finish in 3 minutes');
    await settle(1000);
  }
  await settle();
  const jobs = await page.evaluate(() => window.dirtscout.debug.downloader.jobs());
  console.log('job:', jobs.map((j) => `${j.name} ${j.status} ${JSON.stringify(j.progress)}`));
  await page.locator('#sheet-body').evaluate((el) => { el.scrollTop = 0; });
  await shot('download-done');
  const stats = await page.evaluate(() => window.dirtscout.debug.db.tileStats());
  console.log('stored:', JSON.stringify(stats));

  // 3. Airplane mode: reload with no network. App shell from the service worker, tiles from IndexedDB.
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.051, 46.6205], zoom: 15 }));
  await tilesLoaded(); await settle(1500);
  await shot('offline-z15');
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.051, 46.6205], zoom: 17.5 }));
  await tilesLoaded(); await settle(1500);
  await shot('offline-z17-overzoom');

  // 4. GPS fix (works offline) and follow.
  await click('#btn-locate');
  await page.waitForFunction(() => document.querySelector('#st-gps')?.textContent.includes('±'), null, { timeout: 20000 });
  await page.evaluate(() => window.dirtscout.map.jumpTo({ zoom: 15 }));
  await tilesLoaded(); await settle(1200);
  await shot('offline-gps');

  // 5. A short recorded ride: start, move the fake GPS along a few points, stop and save.
  await click('#btn-record');
  await click('text=Start recording');
  const path = [[46.6205, 23.0510], [46.6212, 23.0522], [46.6220, 23.0536], [46.6229, 23.0549], [46.6240, 23.0558], [46.6251, 23.0570]];
  for (const [lat, lon] of path) {
    await context.setGeolocation({ latitude: lat, longitude: lon, accuracy: 5 });
    await settle(1100);
  }
  await shot('recording');
  page.once('dialog', (d) => d.accept());
  await click('text=Stop and save ride');
  await settle(1000);

  // 6. GPX import (a made-up test track, not a real TET file).
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Test loop Belis</name><trkseg>${
    [[46.615, 23.04], [46.618, 23.047], [46.621, 23.055], [46.626, 23.06], [46.629, 23.052], [46.624, 23.044], [46.615, 23.04]]
      .map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"><ele>${1000 + Math.round(la * 10) % 50}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;
  const gpxPath = join(OUT, 'test-loop.gpx');
  writeFileSync(gpxPath, gpx);
  await click('#toolbar [data-sheet="tracks"]');
  await page.locator('#sheet-body input[type=file]').setInputFiles(gpxPath);
  await page.waitForFunction(() => window.dirtscout.tracks.length >= 2, null, { timeout: 10000 });
  await settle(800);
  await shot('tracks-panel');
  await click('#sheet-close');
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.05, 46.622], zoom: 14.5 }));
  await tilesLoaded(); await settle(1200);
  await shot('tracks-map');

  // 7. Slope shading and hillshade from the stored elevation tiles, still offline.
  await click('#toolbar [data-sheet="layers"]');
  await page.getByLabel('Slope shading').check();
  await page.getByLabel('Hillshade').check();
  await settle(500);
  await shot('layers-panel');
  await click('#sheet-close');
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.05, 46.622], zoom: 12.5 }));
  await tilesLoaded(); await settle(2000);
  await shot('slope-offline');
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.05, 46.622], zoom: 14.6 }));
  await tilesLoaded(); await settle(2000);
  await shot('slope-offline-z15');
  const toastText = await page.locator('#toast').innerText().catch(() => '');
  if (/\bnull\b/.test(toastText)) throw new Error(`toast shows "null": ${toastText}`);

  // 8. More panel: device checks.
  await click('#toolbar [data-sheet="more"]');
  await settle(800);
  await shot('more-panel');
  console.log('device checks:', (await page.locator('#sheet-body').innerText()).split('\n').filter((l) => /Installed|offline|protected|screen on|permission/i.test(l)).join(' | '));
} catch (e) {
  console.error('E2E FAILED:', e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join('\n  ')}` : 'console errors: none');
  await browser.close();
  await server?.close();
}
