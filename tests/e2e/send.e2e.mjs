// Send to phone end-to-end: on the "PC" (a desktop browser) Plan makes a loop, it is saved, and Tracks > Send to phone
// shows a QR code of a link. A "phone" (another browser: its own storage, like a real phone) opens the link: the route
// is rebuilt from its points, saved in Tracks with them, the same length as on the PC, and Navigate starts from the
// toast. The same link again adds nothing; a broken link says so. Also the route builder's own Send to phone.
//   npm run build && node tests/e2e/send.e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-send');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };
const watch = (page, who) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who} console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message}`));
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()));
};
const ready = (page) => page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });

try {
  // ---- the PC
  const pc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const desk = await pc.newPage();
  watch(desk, 'pc');
  await desk.goto(URL0);
  await ready(desk);
  await desk.evaluate(() => {
    window.dirtscout.debug.settings.base = 'ds-topo';
    window.dirtscout.debug.applyLayers(window.dirtscout.map);
    window.dirtscout.map.jumpTo({ center: [23.47, 46.58], zoom: 13 });
  });
  await desk.locator('#toolbar [data-sheet="plan"]').click();
  await desk.getByRole('button', { name: 'Map centre' }).click();
  await desk.locator('.sheet-body button', { hasText: /Generate/ }).click();
  await desk.waitForFunction(() => !window.dirtscout.plan.busy && window.dirtscout.plan.results.length > 0, null, { timeout: 120000 });
  check(await desk.locator('.plan-card').first().getByRole('button', { name: 'Send to phone' }).count() === 1, 'Plan route cards have Send to phone on the PC');
  await desk.locator('.plan-card').first().getByRole('button', { name: 'Save' }).click();
  await desk.waitForFunction(() => window.dirtscout.tracks.length === 1, null, { timeout: 15000 });
  const saved = await desk.evaluate(() => { const t = window.dirtscout.tracks[0]; return { name: t.name, len: t.stats.length }; });
  await desk.locator('#toolbar [data-sheet="tracks"]').click();
  await desk.locator('.card.track').first().getByRole('button', { name: 'Send to phone' }).click();
  await desk.waitForFunction(() => window.dirtscout.send && !window.dirtscout.send.busy, null, { timeout: 60000 });
  await desk.locator('.qr svg').waitFor({ timeout: 10000 });
  const send = await desk.evaluate(() => window.dirtscout.send);
  check(/#route=[A-Za-z0-9_-]+$/.test(send.url) && send.points >= 2, `Tracks > Send to phone: a QR code of a ${send.url.length}-character link with ${send.points} points`);
  check(send.url.length < 700, 'short enough for an easy QR code');
  await desk.screenshot({ path: join(OUT, '01-pc-qr.png') });

  // ---- the phone: its own browser, nothing in Tracks
  const ph = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await ph.newPage();
  watch(phone, 'phone');
  const link = send.url.replace(/^https?:\/\/[^/]+\/(dirt-route-planner\/)?/, URL0);
  await phone.goto(link);
  await ready(phone);
  await phone.waitForFunction(() => window.dirtscout.tracks.length === 1, null, { timeout: 120000 });
  const got = await phone.evaluate(() => {
    const t = window.dirtscout.tracks[0];
    return { name: t.name, len: t.stats.length, pts: t.plan?.built?.pts.length, closed: t.plan?.built?.closed, hash: location.hash,
      toast: document.getElementById('toast').innerText };
  });
  check(got.name === saved.name, `the phone saved "${got.name}"`);
  check(Math.abs(got.len - saved.len) < Math.max(20, saved.len * 0.002), `the same route: ${(got.len / 1000).toFixed(2)} km on the phone, ${(saved.len / 1000).toFixed(2)} km on the PC`);
  check(got.pts === send.points && got.closed, `with its ${got.pts} points (a loop), so Edit works on the phone`);
  check(got.hash === '', 'the link is cleared from the address (a reload adds nothing)');
  await phone.screenshot({ path: join(OUT, '02-phone-received.png') });
  await phone.locator('#toast .toast-btn', { hasText: 'Navigate' }).click();
  await phone.waitForFunction(() => !!window.dirtscout.nav, null, { timeout: 10000 });
  check(true, 'Navigate from the toast starts riding it');
  await phone.evaluate(() => document.getElementById('nav-exit').click());
  await phone.waitForFunction(() => !window.dirtscout.nav, null, { timeout: 10000 });
  // the same link again: nothing added
  await phone.goto(link);
  await ready(phone);
  await phone.waitForFunction(() => /already in Tracks/.test(document.getElementById('toast').innerText), null, { timeout: 60000 });
  check(await phone.evaluate(() => window.dirtscout.tracks.length) === 1, 'the same link again adds nothing');
  // a broken link
  await phone.goto(`${URL0}#route=AAAA`);
  await ready(phone);
  await phone.waitForFunction(() => /broken/.test(document.getElementById('toast').innerText), null, { timeout: 30000 });
  check(await phone.evaluate(() => window.dirtscout.tracks.length) === 1, 'a broken link says so and adds nothing');

  // ---- the route builder's own Send to phone (an unsaved route), opened in an app that is already open
  await desk.locator('#sheet-close').click();
  await desk.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.47, 46.58], zoom: 14.5 }));
  await desk.locator('#toolbar [data-sheet="plan"]').click();
  await desk.getByRole('button', { name: 'Make my own route' }).click();
  await desk.waitForFunction(() => !!window.dirtscout.build, null, { timeout: 30000 });
  const taps = await desk.evaluate(async () => {
    const G = await window.dirtscout.debug.ensureGraph(), map = window.dirtscout.map, out = [];
    for (let n = 0; n < G.N && out.length < 40; n++) {
      if (G.off[n + 1] - G.off[n] < 3) continue;
      const q = map.project([G.lon[n], G.lat[n]]);
      if (q.x > 150 && q.x < 900 && q.y > 200 && q.y < 750) out.push([q.x, q.y]);
    }
    return [out[0], out[Math.floor(out.length / 2)], out[out.length - 1]];
  });
  const box = await desk.locator('#map').boundingBox();
  for (const [x, y] of taps) { await desk.mouse.click(box.x + x, box.y + y); await desk.waitForTimeout(500); }
  await desk.locator('#build-stats').click();
  await desk.getByRole('button', { name: 'Send to phone' }).click();
  await desk.waitForFunction(() => window.dirtscout.send && !window.dirtscout.send.busy, null, { timeout: 60000 });
  const send2 = await desk.evaluate(() => ({ ...window.dirtscout.send, len: window.dirtscout.send.len }));
  check(send2.points === 3, `the builder sends its own ${send2.points} points (${(send2.len / 1000).toFixed(2)} km)`);
  await phone.evaluate((u) => { location.hash = u.slice(u.indexOf('#') + 1); }, send2.url);
  await phone.waitForFunction(() => window.dirtscout.tracks.length === 2, null, { timeout: 60000 });
  const got2 = await phone.evaluate(() => window.dirtscout.tracks.find((t) => t.plan?.built?.pts.length === 3).stats.length);
  check(Math.abs(got2 - send2.len) < 20, `a link opened in the running app is saved too (${(got2 / 1000).toFixed(2)} km)`);
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nall send checks passed');
} finally {
  await browser.close();
  await server?.close();
}
