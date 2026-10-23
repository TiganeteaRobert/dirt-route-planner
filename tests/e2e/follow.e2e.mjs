// Smart drawing check in the PC's Chrome as a phone: on the Marisel plateau, two taps at the ends of an unmapped grass
// track in the Esri imagery; the drawn line must follow the track (more points than a straight line, close to the
// pale line), not cut straight across. Screenshot for a look.
//   npm run build && node tests/e2e/follow.e2e.mjs      (E2E_URL=https://... for the live site)
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-follow');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
const A = [23.093433, 46.674666], B = [23.097349, 46.674224];
try {
  await page.goto(process.env.E2E_URL || 'http://localhost:4173/');
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(([a, b]) => {
    const x = window.dirtscout;
    x.debug.settings.base = 'esri-imagery';
    x.debug.applyLayers(x.map);
    x.map.jumpTo({ center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 0.0002], zoom: 15.8 });
  }, [A, B]);
  await page.waitForFunction(() => { const m = window.dirtscout.map; return m.loaded() && m.areTilesLoaded(); }, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator('#toolbar [data-sheet="tracks"]').click();
  await page.getByRole('button', { name: 'Draw a road on the map' }).click();
  await page.waitForTimeout(400);
  const scr = await page.evaluate(([a, b]) => {
    const m = window.dirtscout.map;
    const r = m.getCanvas().getBoundingClientRect();
    return [a, b].map((p) => { const q = m.project(p); return [r.left + q.x, r.top + q.y]; });
  }, [A, B]);
  await page.mouse.click(...scr[0]);
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.mouse.click(...scr[1]);
  await page.waitForFunction(() => window.dirtscout.draw && !window.dirtscout.draw.busy && window.dirtscout.draw.taps.length === 2, null, { timeout: 60000 });
  const res = await page.evaluate(() => ({ parts: window.dirtscout.draw.parts.map((p) => p.length), bar: document.querySelector('#drawbar-text').textContent }));
  console.log(`followed in ${Date.now() - t0} ms:`, JSON.stringify(res));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'follow.png') });
  // the same two taps without following, for comparison
  await page.locator('#draw-undo').click();
  await page.locator('#draw-follow').uncheck();
  await page.mouse.click(...scr[1]);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'straight.png') });
  if (res.parts[0] < 3) throw new Error('the drawn line did not follow anything (straight)');
} catch (e) {
  console.error('E2E FAILED:', e.message);
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors (${errors.length}): ${errors.join(' | ')}` : 'console errors: none');
  await browser.close();
  await server?.close();
}
