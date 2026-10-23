// M4 end-to-end check (route generator) in the PC's Chrome as an Android phone: install the area pack, go offline,
// plan 8 km loops with hill climbs from the map centre near Baisoara, pick one, save it, export GPX.
//   npm run build && node tests/e2e/m4.e2e.mjs      (E2E_URL=https://... to test a deployed site)
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-m4');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true,
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
const settle = (ms = 800) => page.waitForTimeout(ms);
const click = (sel) => page.locator(sel).first().click();
const tilesLoaded = () => page.waitForFunction(() => {
  const m = window.dirtscout?.map;
  return m && m.loaded() && m.areTilesLoaded();
}, null, { timeout: 60000 }).catch(() => console.log('  (tiles still loading)'));

try {
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await click('#toolbar [data-sheet="downloads"]');
  await page.getByText('Install the area pack').first().waitFor({ timeout: 20000 });
  await click('text=Install the area pack');
  for (let i = 0; i < 180; i++) {
    if (await page.evaluate(async () => !!(await window.dirtscout.debug.db.get('packs', 'graph')))) break;
    await settle(1000);
  }
  await click('#sheet-close');

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => {
    const a = window.dirtscout;
    a.debug.settings.base = 'ds-topo';
    a.debug.applyLayers(a.map);
    a.map.jumpTo({ center: [23.47, 46.58], zoom: 13 });
  });
  await tilesLoaded();
  await click('#toolbar [data-sheet="plan"]');
  await settle(400);
  await page.getByRole('button', { name: 'Map centre' }).click();
  await page.locator('.sheet-body input[type=range]').first().evaluate((el) => {
    el.value = '8';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(300);
  await page.getByRole('button', { name: '2', exact: true }).click();
  await settle(300);
  await shot('plan-form');
  const t0 = Date.now();
  await click('text=Generate routes');
  await page.waitForFunction(() => window.dirtscout.plan.results.length > 0 || !window.dirtscout.plan.busy, null, { timeout: 60000 });
  await settle(1500);
  const res = await page.evaluate(() => window.dirtscout.plan.results.map((r) => ({
    km: (r.stats.len / 1000).toFixed(1), up: Math.round(r.stats.up), climbs: r.stats.climbs.length,
    dirt: Math.round(r.stats.dirt * 100), green: Math.round(r.stats.green * 100), red: Math.round(r.stats.red * 100),
  })));
  console.log(`routes (${Date.now() - t0} ms):`, JSON.stringify(res));
  await tilesLoaded(); await settle(1200);
  await shot('plan-results');
  await page.locator('.sheet-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await settle(300);
  await shot('plan-results-list');
  await page.getByRole('button', { name: 'Show' }).nth(1).click();
  await tilesLoaded(); await settle(1500);
  await shot('plan-route-2');
  await click('#toolbar [data-sheet="plan"]');
  await page.getByRole('button', { name: 'Save' }).nth(1).click();
  await settle(800);
  const tracks = await page.evaluate(() => window.dirtscout.tracks.map((t) => `${t.kind}: ${t.name}`));
  console.log('tracks:', tracks);
  const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
  await page.getByRole('button', { name: 'GPX' }).nth(1).click();
  const d = await dl;
  if (d) {
    const f = join(OUT, 'route.gpx');
    await d.saveAs(f);
    console.log('gpx saved', f);
  } else console.log('gpx: no download event (share sheet path?)');
} catch (e) {
  console.error('E2E FAILED:', e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join('\n  ')}` : 'console errors: none');
  await browser.close();
  await server?.close();
}
