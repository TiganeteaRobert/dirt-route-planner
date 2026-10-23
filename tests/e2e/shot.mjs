// One-off screenshots of the built app as a phone, online: node tests/e2e/shot.mjs <lon> <lat> <zoom> <name> [base] [colorBy]
// -> tests/e2e/out-shot/<name>.png (gitignored: may show Bing imagery).
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const [, , lon, lat, zoom, name, base = 'ms-earth', colorBy = 'type'] = process.argv;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-shot');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4174, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
try {
  await page.goto(process.env.E2E_URL || 'http://localhost:4174/');
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(([lo, la, z, b, c]) => {
    const a = window.dirtscout;
    a.debug.settings.base = b;
    a.debug.settings.colorBy = c;
    a.debug.applyLayers(a.map);
    a.map.jumpTo({ center: [+lo, +la], zoom: +z });
  }, [lon, lat, zoom, base, colorBy]);
  await page.waitForFunction(() => { const m = window.dirtscout.map; return m.loaded() && m.areTilesLoaded(); }, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log('shot', join(OUT, `${name}.png`));
} finally {
  await browser.close();
  await server?.close();
}
