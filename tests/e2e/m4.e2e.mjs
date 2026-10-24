// M4 end-to-end check (route generator) in the PC's Chrome as an Android phone: install the area pack, go offline,
// set the length range with its two knobs (6-10 km), tap the start on the map near Baisoara, plan loops with hill
// climbs, check each is in the range and continuous, pick one, save it, export GPX; the range is remembered.
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
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };
const knob = (i, v) => page.locator('.range2 input[type=range]').nth(i).evaluate((el, val) => {
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, String(v));
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
  await knob(0, 6);                    // low knob first: the high one may not go below it
  await knob(1, 10);
  await knob(1, 4);                    // dragged below the low knob: stops 1 km above it
  check(await page.evaluate(() => [window.dirtscout.plan.kmMin, window.dirtscout.plan.kmMax].join('-')) === '6-7',
    'the high knob stops above the low one');
  await knob(1, 10);
  check((await page.locator('#plan-len').textContent()) === 'Length: 6-10 km', 'the label follows the knobs');
  // the start: tap the map where the car waits
  await page.getByRole('button', { name: 'Tap the map' }).click();
  await settle(500);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.sheet-body').waitFor({ timeout: 10000 });
  await settle(400);
  const start = await page.evaluate(() => window.dirtscout.plan.start);
  check(start && Math.abs(start[0] - 23.47) < 0.01 && Math.abs(start[1] - 46.58) < 0.01, `the tapped start is kept (${start})`);
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
  const ok = await page.evaluate(async () => {
    const G = await window.dirtscout.debug.ensureGraph();
    return window.dirtscout.plan.results.map((r) => {
      let at = null, broken = 0;
      for (const { e, dir } of r.path) {
        if (at !== null && (dir > 0 ? G.e.a[e] : G.e.b[e]) !== at) broken++;
        at = dir > 0 ? G.e.b[e] : G.e.a[e];
      }
      return { fits: r.fits, km: r.stats.len / 1000, broken, closed: at === (r.path[0].dir > 0 ? G.e.a[r.path[0].e] : G.e.b[r.path[0].e]) };
    });
  });
  check(ok.length >= 2, `${ok.length} routes`);
  check(ok.every((r) => r.fits && r.km >= 6 && r.km <= 10), 'every route is 6-10 km');
  check(ok.every((r) => r.broken === 0 && r.closed), 'every route is continuous and comes back to its start');
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
  await page.reload();
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  const kept = await page.evaluate(() => window.dirtscout.plan);
  check(kept.kmMin === 6 && kept.kmMax === 10 && kept.startMode === 'tap' && kept.start, 'after a reload: the range and the start are remembered');
} catch (e) {
  console.error('E2E FAILED:', e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join('\n  ')}` : 'console errors: none');
  await browser.close();
  await server?.close();
}
