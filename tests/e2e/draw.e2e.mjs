// Draw-a-road check in the PC's Chrome as a phone: start on a mapped track (snap), add three taps, save it, then
// make sure it has a profile and that the routing graph contains it.
//   npm run build && node tests/e2e/draw.e2e.mjs      (E2E_URL=https://... for the live site)
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-draw');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
let step = 0;
const shot = async (n) => { await page.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-${n}.png`) }); console.log('shot', n); };
const settle = (ms = 800) => page.waitForTimeout(ms);
try {
  await page.goto(process.env.E2E_URL || 'http://localhost:4173/');
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => {
    const a = window.dirtscout;
    a.debug.settings.colorBy = 'type';
    a.debug.applyLayers(a.map);
    a.map.jumpTo({ center: [23.205, 46.607], zoom: 15 });
  });
  await page.waitForFunction(() => { const m = window.dirtscout.map; return m.loaded() && m.areTilesLoaded(); }, null, { timeout: 60000 }).catch(() => {});
  await settle(1500);
  const start = await page.evaluate(() => {
    const m = window.dirtscout.map;
    const r = m.getCanvas().getBoundingClientRect();
    for (const f of m.queryRenderedFeatures({ layers: ['ds-tracks', 'ds-tracks-dash', 'ds-tracks-dot'] })) {
      const c = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0];
      for (const v of c) {
        const p = m.project(v);
        if (p.x > 60 && p.x < r.width - 160 && p.y > 150 && p.y < r.height - 330) return { x: r.left + p.x, y: r.top + p.y };
      }
    }
    return null;
  });
  if (!start) throw new Error('no track on screen to start from');
  await page.locator('#toolbar [data-sheet="tracks"]').click();
  await page.getByRole('button', { name: 'Draw a road on the map' }).click();
  await settle(500);
  // first tap 8 px off the track (should snap), then three taps going right and down
  await page.mouse.click(start.x + 8, start.y + 6);
  for (const [dx, dy] of [[50, 60], [95, 130], [140, 210]]) {
    await page.waitForFunction(() => !window.dirtscout.draw.busy, null, { timeout: 30000 });
    await page.mouse.click(start.x + dx, start.y + dy);
    await settle(300);
  }
  await settle(600);
  await page.waitForFunction(() => window.dirtscout.draw && !window.dirtscout.draw.busy && window.dirtscout.draw.taps.length === 4, null, { timeout: 60000 });
  const st = await page.evaluate(() => ({ taps: window.dirtscout.draw.taps.length, snapped: window.dirtscout.draw.taps.map((t) => t.snapped), bar: document.querySelector('#drawbar-text').textContent }));
  console.log('drawing:', JSON.stringify(st));
  await shot('drawing');
  page.once('dialog', (d) => d.accept('Test road'));
  await page.locator('#draw-save').click();
  await page.waitForFunction(() => window.dirtscout.tracks.some((t) => t.kind === 'drawn'), null, { timeout: 30000 });
  const t = await page.evaluate(() => window.dirtscout.tracks.find((t) => t.kind === 'drawn'));
  console.log('saved:', t.name, 'network', t.network, 'stats', JSON.stringify({ len: Math.round(t.stats.length), up: t.stats.up, dn: t.stats.dn, g100: t.stats.g100 }));
  await settle(800);
  await shot('saved');
  // the routing graph now has the road
  const inGraph = await page.evaluate(async () => {
    const a = window.dirtscout;
    await a.debug.ensureGraph();
    return a.graph.ids.filter((id) => id.startsWith('u:'));
  });
  console.log('graph user edges:', inGraph);
  if (!inGraph.length) throw new Error('drawn road missing from the routing graph');
} catch (e) {
  console.error('E2E FAILED:', e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors (${errors.length}): ${errors.join(' | ')}` : 'console errors: none');
  await browser.close();
  await server?.close();
}
