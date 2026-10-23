// AI layer end-to-end check in the PC's Chrome, emulating an Android phone: the private AI file (a test bundle from
// tests/fixtures/aibundle.mjs, served in place of pack/ai.enc) refuses a wrong passphrase, opens with the right one,
// draws its tracks, shows their card, joins the route network, and is still there after a reload in airplane mode.
// Screenshots go to tests/e2e/out-ai/ (gitignored: they show imagery).
//   npm run build && node tests/e2e/ai.e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeBundle, bundleData, TEST_PASS } from '../fixtures/aibundle.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-ai');
mkdirSync(OUT, { recursive: true });
const PORT = 4177;
const server = await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: PORT, strictPort: true } });
const URL0 = `http://localhost:${PORT}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const bundle = makeBundle();
// context-wide: the service worker fetches the file itself, and page.route does not see those requests
await context.route('**/pack/ai.enc', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bundle }));

let step = 0;
const shot = async (name) => {
  const f = join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  console.log('shot', f);
};
const settle = (ms = 800) => page.waitForTimeout(ms);
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };
const { line } = bundleData();
const VIEW = { center: [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2], zoom: 16 };

// AI tracks drawn after the sensitivity filter (unique ids: a line crossing tile edges comes back once per tile)
async function aiShown() {
  return page.evaluate(() => new Set(window.dirtscout.map.queryRenderedFeatures({ layers: ['ds-tracks-ai'] })
    .map((f) => f.properties.id)).size);
}
async function aiEdges() {
  return page.evaluate(async () => {
    const G = await window.dirtscout.debug.ensureGraph();
    let n = 0;
    for (let e = 0; e < G.M; e++) if (G.classes[G.e.cls[e]] === 'ai') n++;
    return n;
  });
}
async function setAiMin(v) {
  await page.locator('#toolbar [data-sheet="layers"]').click();
  await page.locator('#ai-min').waitFor({ timeout: 10000 });
  await page.locator('#ai-min').fill(String(v));
  await page.locator('#sheet-close').click();
  await settle(800);
}

async function aiFeatures() {
  // unique ids: a line crossing tile edges comes back once per tile
  return page.evaluate(() => new Set(window.dirtscout.map.querySourceFeatures('ai', { sourceLayer: 'ai' }).map((f) => f.properties.id)).size);
}

try {
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  check(!(await page.evaluate(() => !!window.dirtscout.ai)), 'nothing unlocked at first');

  // Offline panel: the AI card, a wrong passphrase first
  await page.locator('#toolbar [data-sheet="downloads"]').click();
  await page.locator('#ai-pass').waitFor({ timeout: 20000 });
  await page.locator('#ai-card').scrollIntoViewIfNeeded();
  await page.locator('#ai-pass').fill('not the passphrase');
  await page.locator('#ai-card button', { hasText: 'Unlock' }).click();
  await page.locator('#ai-card', { hasText: 'wrong passphrase' }).waitFor({ timeout: 20000 });
  check(true, 'a wrong passphrase is refused');
  await shot('wrong-passphrase');

  await page.locator('#ai-pass').fill(`  ${TEST_PASS.toUpperCase()}  `);
  await page.locator('#ai-card button', { hasText: 'Unlock' }).click();
  await page.waitForFunction(() => !!window.dirtscout.ai, null, { timeout: 30000 });
  await page.locator('#ai-card', { hasText: 'unlocked' }).waitFor({ timeout: 10000 });
  check(true, 'the right passphrase (any case, spaces) opens it');
  await shot('unlocked');
  const rec = await page.evaluate(async () => {
    const r = await window.dirtscout.debug.db.get('packs', 'ai');
    return r ? { version: r.version, hasPass: !!r.pass } : null;
  });
  check(rec?.version === '2026-10-23.test01' && rec.hasPass, 'kept on the phone with its passphrase for updates');

  // the layer on the map
  await page.locator('#sheet-close').click();
  await page.evaluate((v) => window.dirtscout.map.jumpTo(v), VIEW);
  await page.waitForFunction(() => window.dirtscout.map.loaded(), null, { timeout: 30000 });
  await settle(1500);
  check((await aiFeatures()) === 2, 'both AI tracks are in the layer');
  check(await page.evaluate(() => window.dirtscout.map.getLayoutProperty('ds-tracks-ai', 'visibility') === 'visible'), 'the AI layer is visible');
  await setAiMin(0.5);
  check((await aiShown()) === 1, 'slider at 50 %: only the track scoring 82 % shows');
  await setAiMin(0.3);
  check((await aiShown()) === 2 && (await aiEdges()) === 2, 'slider at 30 %: both tracks shown and routed on');
  await setAiMin(0.9);
  check((await aiShown()) === 0 && (await aiEdges()) === 0, 'slider at 90 %: none shown or routed on');
  await setAiMin(0.3);
  await shot('ai-tracks-on-map');

  // tap one: the track card
  const pt = await page.evaluate((c) => {
    const m = window.dirtscout.map;
    const p = m.project([(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2]);
    const r = m.getCanvas().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, line);
  await page.mouse.click(pt.x, pt.y);
  await page.locator('#sheet-body', { hasText: 'Track the AI found' }).waitFor({ timeout: 10000 });
  const card = await page.locator('#sheet-body').innerText();
  check(card.includes('AI score') && card.includes('82 %'), 'the card shows the AI score');
  check(/DirtScout's own AI found this line/.test(card), 'the card explains where it comes from');
  await shot('ai-track-card');
  await page.locator('#sheet-close').click();

  // the route network includes the AI edges while the layer is on, and not when it is off
  const withAi = await aiEdges();
  check(withAi === 2, `routing uses the AI edges (${withAi})`);
  await page.locator('#toolbar [data-sheet="layers"]').click();
  const row = page.locator('label.row', { hasText: 'Tracks the AI found' });
  await row.waitFor({ timeout: 10000 });
  await row.locator('input[type=checkbox]').uncheck();
  await settle(300);
  const off = await page.evaluate(async () => {
    const G = await window.dirtscout.debug.ensureGraph();
    return { ai: G.classes.includes('ai') ? [...G.e.cls].filter((c) => G.classes[c] === 'ai').length : 0,
      visible: window.dirtscout.map.getLayoutProperty('ds-tracks-ai', 'visibility') };
  });
  check(off.ai === 0 && off.visible === 'none', 'layer off: hidden and routes use the public network');
  await row.locator('input[type=checkbox]').check();
  await page.locator('#sheet-close').click();

  // airplane mode + reload: still unlocked, still drawn
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate((v) => window.dirtscout.map.jumpTo(v), VIEW);
  await settle(1500);
  check(await page.evaluate(() => window.dirtscout.ai?.meta?.version === '2026-10-23.test01'), 'offline after a reload: still unlocked');
  check((await aiFeatures()) === 2, 'offline after a reload: the AI tracks are drawn');
  await shot('offline-reload');
  await context.setOffline(false);

  // a phone that unlocked the first (GeoJSON) format: the stored record has no format; the app fetches the new one
  // with the saved passphrase by itself
  await page.evaluate(async (pass) => {
    const db = window.dirtscout.debug.db;
    for (const k of ['ai-tiles', 'ai-graph']) await db.del('packs', k);
    await db.put('packs', { blob: new Blob(['{}']), version: '2026-10-23.old', bytes: 2, saved: Date.now(), pass }, 'ai');
  }, TEST_PASS.toLowerCase().replace(/\s+/g, ''));
  await page.reload();
  await page.waitForFunction(() => window.dirtscout?.ai?.meta?.version === '2026-10-23.test01', null, { timeout: 60000 });
  check(await page.evaluate(async () => (await window.dirtscout.debug.db.get('packs', 'ai')).format === 2),
    'an AI file in the old format is replaced by the new one on its own');

  const bad = errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(e));
  check(bad.length === 0, `no page errors${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  console.log('AI e2e: all checks passed');
} catch (e) {
  console.error(e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
