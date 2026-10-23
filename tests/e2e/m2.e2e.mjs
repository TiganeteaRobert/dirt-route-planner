// M2 end-to-end check (area pack) in the PC's Chrome, emulating an Android phone: DirtScout tracks over imagery
// straight from the server, installing the pack, then airplane mode: topo base, evidence colours, track info, slope
// from the pack's bare-earth elevation. Screenshots go to tests/e2e/out-m2/.
//   npm run build && node tests/e2e/m2.e2e.mjs      (E2E_URL=https://... to test a deployed site)
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-m2');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 46.6205, longitude: 23.0510, accuracy: 6 }, permissions: ['geolocation'],
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
const tilesLoaded = () => page.waitForFunction(() => {
  const m = window.dirtscout?.map;
  return m && m.loaded() && m.areTilesLoaded();
}, null, { timeout: 60000 }).catch(() => console.log('  (tiles still loading)'));
const click = (sel) => page.locator(sel).first().click();
const VIEW = { center: [23.205, 46.607], zoom: 13.4 };

// Taps the middle of a visible DirtScout track; returns its properties.
async function tapTrack() {
  const pt = await page.evaluate(() => {
    const m = window.dirtscout.map;
    const fs = m.queryRenderedFeatures({ layers: ['ds-tracks', 'ds-tracks-dash', 'ds-tracks-dot'] })
      .filter((f) => f.properties.det != null && f.properties.len > 300);
    const r = m.getCanvas().getBoundingClientRect();
    for (const f of fs) {
      const c = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0];
      const p = m.project(c[Math.floor(c.length / 2)]);
      if (p.x > 40 && p.x < r.width - 40 && p.y > 120 && p.y < r.height * 0.45) return { x: r.left + p.x, y: r.top + p.y, props: f.properties };
    }
    return null;
  });
  if (!pt) throw new Error('no track to tap');
  await page.mouse.click(pt.x, pt.y);
  return pt.props;
}

try {
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.evaluate((v) => window.dirtscout.map.jumpTo(v), VIEW);
  await tilesLoaded(); await settle(1500);
  await shot('online-tracks-over-imagery');

  // Install the area pack from the Offline panel.
  await click('#toolbar [data-sheet="downloads"]');
  await page.getByText('Install the area pack').first().waitFor({ timeout: 20000 });
  await shot('offline-panel-pack');
  await click('text=Install the area pack');
  await page.waitForFunction(async () => {
    const r = await window.dirtscout.debug.db.get('packs', 'dem');
    return !!r;
  }, null, { timeout: 180000, polling: 1000 }).catch(() => {});
  for (let i = 0; i < 120; i++) {
    const ok = await page.evaluate(async () => !!(await window.dirtscout.debug.db.get('packs', 'dem')));
    if (ok) break;
    await settle(1000);
  }
  await settle(1500);
  await shot('pack-installed');

  // Airplane mode: everything from the phone.
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate((v) => window.dirtscout.map.jumpTo(v), VIEW);
  await click('#toolbar [data-sheet="layers"]');
  await page.getByLabel('DirtScout topo (area pack)').check();
  await settle(500);
  await shot('layers-panel-pack');
  await click('#sheet-close');
  await tilesLoaded(); await settle(2000);
  await shot('offline-topo');

  for (const mode of ['det', 'grade', 'tree', 'traces']) {
    await page.evaluate((m) => {
      const a = window.dirtscout;
      a.debug.settings.colorBy = m;
      a.debug.applyLayers(a.map);
    }, mode);
    await settle(1200);
    await shot(`offline-colour-${mode}`);
  }

  const props = await tapTrack();
  await settle(800);
  console.log('tapped:', JSON.stringify(props).slice(0, 300));
  await shot('track-info');
  await click('#sheet-close');

  // Imagery base + slope from the pack's FABDEM, still offline (no imagery saved here: base stays dark).
  await page.evaluate(() => {
    const a = window.dirtscout;
    a.debug.settings.colorBy = 'type';
    a.debug.settings.base = 'ds-topo';
    a.debug.settings.overlays.slope.on = true;
    a.debug.settings.overlays.hillshade.on = true;
    a.debug.applyLayers(a.map);
    a.map.jumpTo({ center: [23.18, 46.62], zoom: 12.3 });
  });
  await tilesLoaded(); await settle(2500);
  await shot('offline-topo-slope-hillshade');
} catch (e) {
  console.error('E2E FAILED:', e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join('\n  ')}` : 'console errors: none');
  await browser.close();
  await server?.close();
}
