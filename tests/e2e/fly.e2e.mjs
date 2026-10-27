// Flying over the PC's 3D terrain, in a desktop browser: F starts flying (3D on, tilted), W flies forward the way the
// camera looks, Shift makes it five times faster, D goes sideways, E up and Q down, the arrows and a mouse drag look
// around (the map itself does not move), the camera does not dive into a mountain, ] raises the relief, Esc stops;
// O orbits; a Plan route's "Fly through" rides it (Space pauses, the arrow skips 500 m, x8, Stop).
// Headless Chrome draws the 3D terrain in software: while new terrain tiles load (or the PC is busy) it can drop to
// about one frame a second. So each key is held until the camera has moved, the checks look at directions, and the
// speeds are compared on the camera's own velocity, not on distances in a given time.
//   npm run build && node tests/e2e/fly.e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-fly');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
let step = 0;
const shot = (name) => page.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`) });
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };
const cam = () => page.evaluate(() => {
  const m = window.dirtscout.map, c = m.getCenter(), T = m.transform ?? m._camera.transform, f = window.dirtscout.debug.fly();
  const ll = T.getCameraLngLat();
  return { lon: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch(), mode: f.mode, vel: f.vel, tour: f.tour,
    exag: m.getTerrain()?.exaggeration ?? null, above: T.getCameraAltitude() - (m.queryTerrainElevation(ll) ?? 0), dragPan: m.dragPan.isEnabled() };
});
const R = 6371008.8, RAD = Math.PI / 180;
const moved = (a, b) => {
  const dn = (b.lat - a.lat) * RAD * R, de = (b.lon - a.lon) * RAD * R * Math.cos(a.lat * RAD);
  return { d: Math.hypot(dn, de), dir: (Math.atan2(de, dn) / RAD + 360) % 360 };
};
const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
// waits until the camera has stopped gliding
async function settled() {
  for (let i = 0; i < 120; i++) {
    const c = await cam();
    if (Object.values(c.vel).every((v) => Math.abs(v) < 0.5)) return c;
    await page.waitForTimeout(250);
  }
  return cam();
}
// holds keys until done(start, now) (or 30 s), lets go and waits for the camera to stop; returns
// {a: before, b: after, top: the largest |velocity| of `velKey` seen while held}
async function hold(keyList, done, velKey = null) {
  const a = await settled();
  for (const k of keyList) await page.keyboard.down(k);
  let top = 0;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(250);
    const c = await cam();
    if (velKey) top = Math.max(top, Math.abs(c.vel[velKey]));
    if (done(a, c)) break;
  }
  for (const k of [...keyList].reverse()) await page.keyboard.up(k);
  return { a, b: await settled(), top };
}

try {
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => {
    window.dirtscout.debug.settings.base = 'ds-topo';
    window.dirtscout.debug.applyLayers(window.dirtscout.map);
    window.dirtscout.map.jumpTo({ center: [22.75, 46.55], zoom: 13, bearing: 30 });
  });
  await page.mouse.click(550, 350);
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.dirtscout.map.getPitch() > 60, null, { timeout: 30000 }).catch(() => {});
  let c = await cam();
  check(c.mode === 'fly' && c.exag && c.pitch > 60, `F: flying, 3D on, tilted (pitch ${Math.round(c.pitch)})`);
  check(!(await page.locator('#fly-hud').isHidden()) && !c.dragPan, 'the key help shows; the mouse looks instead of moving the map');
  await page.waitForFunction(() => window.dirtscout.map.areTilesLoaded(), null, { timeout: 30000 }).catch(() => {});
  await shot('flying');

  const w = await hold(['w'], (a, b) => moved(a, b).d > 60 && b.vel.f > 0 && Math.abs(b.vel.f - a.vel.f) < 1e9, 'f');
  const fw = moved(w.a, w.b);
  check(angle(fw.dir, w.a.bearing) < 8, `W: forward the way the camera looks (${Math.round(fw.d)} m towards ${Math.round(fw.dir)}°, looking ${Math.round(w.a.bearing)}°)`);
  const sw = await hold(['Shift', 'w'], (a, b) => moved(a, b).d > 60, 'f');
  check(sw.top > w.top * 3.5, `Shift: five times the speed (${Math.round(sw.top)} m/s against ${Math.round(w.top)} m/s)`);
  const d = await hold(['d'], (a, b) => moved(a, b).d > 40);
  const sd = moved(d.a, d.b);
  check(angle(sd.dir, d.a.bearing + 90) < 8, `D: sideways to the right (${Math.round(sd.dir)}°, looking ${Math.round(d.a.bearing)}°)`);
  const up = await hold(['e'], (a, b) => b.zoom < a.zoom - 0.15);
  check(up.b.zoom < up.a.zoom - 0.1, `E: up (zoom ${up.a.zoom.toFixed(2)} -> ${up.b.zoom.toFixed(2)})`);
  const dn = await hold(['q'], (a, b) => b.zoom > a.zoom + 0.15);
  check(dn.b.zoom > dn.a.zoom + 0.1, `Q: down (zoom ${dn.a.zoom.toFixed(2)} -> ${dn.b.zoom.toFixed(2)})`);
  const turn = await hold(['ArrowRight'], (a, b) => angle(a.bearing, b.bearing) > 10);
  check(angle(turn.b.bearing, turn.a.bearing) > 8 && moved(turn.a, turn.b).d < 5, `the arrows turn on the spot (${Math.round(turn.a.bearing)}° -> ${Math.round(turn.b.bearing)}°)`);
  let a = await settled();
  await page.mouse.move(550, 350);
  await page.mouse.down();
  await page.mouse.move(750, 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  let b = await cam();
  check(angle(b.bearing, a.bearing) > 30 && moved(a, b).d < 5, `a drag looks around without moving the map (turned ${Math.round(angle(b.bearing, a.bearing))}°)`);
  // down hard into the mountains: the camera stays above the ground
  const dive = await hold(['Shift', 'q'], (p, q) => q.zoom > p.zoom + 2.5);
  check(dive.b.above > 25, `diving: the camera stays above the ground (${Math.round(dive.b.above)} m above it, zoom ${dive.b.zoom.toFixed(1)})`);
  await shot('low');
  await page.keyboard.press(']');
  await page.waitForTimeout(300);
  const ex = (await cam()).exag;
  check(Math.abs(ex - (dive.b.exag + 0.5)) < 0.01, `] raises the relief (×${dive.b.exag} -> ×${ex})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  c = await cam();
  check(c.mode === null && c.dragPan && await page.locator('#fly-hud').isHidden(), 'Esc stops flying: the mouse moves the map again');
  // orbit
  a = await cam();
  await page.keyboard.press('o');
  await page.waitForFunction((b0) => Math.abs(((window.dirtscout.map.getBearing() - b0 + 540) % 360) - 180) > 3, a.bearing, { timeout: 30000 }).catch(() => {});
  b = await cam();
  check(b.mode === 'orbit' && angle(a.bearing, b.bearing) > 2 && moved(a, b).d < 5, `O: the view turns around the middle (${Math.round(angle(a.bearing, b.bearing))}°)`);
  await page.keyboard.press('o');
  await page.waitForTimeout(300);
  check((await cam()).mode === null, 'O again stops it');

  // fly through a Plan route
  await page.evaluate(() => window.dirtscout.map.jumpTo({ center: [23.47, 46.58], zoom: 13, pitch: 0 }));
  await page.locator('#toolbar [data-sheet="plan"]').click();
  await page.getByRole('button', { name: 'Map centre' }).click();
  await page.locator('.sheet-body button', { hasText: /Generate/ }).click();
  await page.waitForFunction(() => !window.dirtscout.plan.busy && window.dirtscout.plan.results.length > 0, null, { timeout: 120000 });
  await page.locator('.plan-card').first().getByRole('button', { name: 'Fly through' }).click();
  await page.waitForFunction(() => (window.dirtscout.debug.fly().tour?.s ?? 0) > 30, null, { timeout: 60000 }).catch(() => {});
  c = await cam();
  check(c.mode === 'tour' && c.tour.s > 30 && c.tour.playing, `Fly through: the camera rides the route (${Math.round(c.tour.s)} m in)`);
  const onRoute = await page.evaluate(() => {
    const m = window.dirtscout.map, q = m.getCenter(), r = window.dirtscout.plan.results[0].coords;
    return Math.min(...r.map((p) => Math.hypot((p[0] - q.lng) * 76400, (p[1] - q.lat) * 111200)));
  });
  check(onRoute < 40, `looking at the route (${Math.round(onRoute)} m from it)`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const p1 = (await cam()).tour.s;
  await page.waitForTimeout(1000);
  c = await cam();
  check(!c.tour.playing && Math.abs(c.tour.s - p1) < 1, 'Space pauses');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  check(Math.abs((await cam()).tour.s - p1 - 500) < 1, '→ skips 500 m');
  await page.waitForFunction(() => window.dirtscout.map.areTilesLoaded(), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await shot('fly-through');
  await page.locator('#tour button', { hasText: '×8' }).click();
  await page.keyboard.press('Space');
  const p2 = (await cam()).tour.s;
  await page.waitForFunction((s0) => window.dirtscout.debug.fly().tour.s > s0 + 100, p2, { timeout: 60000 }).catch(() => {});
  c = await cam();
  check(c.tour.playing && c.tour.speed === 8 && c.tour.s - p2 > 100, `×8 plays on (${Math.round(c.tour.s - p2)} m further)`);
  await page.locator('#tour button', { hasText: 'Stop' }).click();
  await page.waitForTimeout(300);
  c = await cam();
  check(c.mode === null && await page.locator('#tour').isHidden(), 'Stop ends the fly-through');
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nall fly checks passed');
} finally {
  await browser.close();
  await server?.close();
}
