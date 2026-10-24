// "Make my own route" end-to-end in the PC's Chrome as an Android phone (the area pack read from the local server):
// tap three points on tracks near Baisoara, drag point 2 to another track, tap the line between 1 and 2 to add a point
// (the numbers follow), close the loop from point 1's menu, undo, open the profile (stats + elevation chart, zoom),
// save, edit it again from Tracks, and open a track's elevation profile from Tracks.
//   npm run build && node tests/e2e/build.e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-build');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
const settle = (ms = 600) => page.waitForTimeout(ms);
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };
const state = () => page.evaluate(() => {
  const b = window.dirtscout.build;
  if (!b) return null;
  return { n: b.pts.length, closed: b.closed, legs: b.legs.length, undo: b.undo.length,
    pts: b.pts.map((p) => [p.s.lon, p.s.lat]), ends: b.legs.map((l) => [l.coords[0], l.coords.at(-1)]),
    labels: [...document.querySelectorAll('.rb-pt')].map((el) => el.textContent) };
});
const hv = (a, b) => {
  const R = 6371008.8, r = Math.PI / 180, dl = (b[1] - a[1]) * r, dn = (b[0] - a[0]) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
// legs start and end at their points, and each leg starts where the last one ended
function joined(s) {
  for (let i = 0; i < s.legs; i++) {
    const a = s.pts[i], z = s.pts[(i + 1) % s.n];
    if (hv(s.ends[i][0], a) > 2 || hv(s.ends[i][1], z) > 2) return false;
  }
  return true;
}
// screen position of [lon, lat]
const screen = (ll) => page.evaluate((p) => { const q = window.dirtscout.map.project(p); return [q.x, q.y]; }, ll);
const mapBox = async () => page.locator('#map').boundingBox();
async function tapAt(ll) {
  const [x, y] = await screen(ll);
  const box = await mapBox();
  await page.mouse.click(box.x + x, box.y + y);
  await settle(500);
}

try {
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page.evaluate(() => {
    window.dirtscout.debug.settings.base = 'ds-topo';
    window.dirtscout.debug.applyLayers(window.dirtscout.map);
    window.dirtscout.map.jumpTo({ center: [23.47, 46.58], zoom: 14.5 });
  });
  await page.waitForFunction(() => window.dirtscout.map.loaded() && window.dirtscout.map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {});
  // junctions of the network on screen, between the bar and the toast (screen px and [lon, lat])
  const cands = await page.evaluate(async () => {
    const G = await window.dirtscout.debug.ensureGraph();
    const map = window.dirtscout.map;
    const out = [];
    for (let n = 0; n < G.N; n++) {
      if (G.off[n + 1] - G.off[n] < 2) continue;
      const p = map.project([G.lon[n], G.lat[n]]);
      if (p.x > 40 && p.x < 360 && p.y > 330 && p.y < 690) out.push({ x: p.x, y: p.y, ll: [G.lon[n], G.lat[n]] });
    }
    return out;
  });
  // the candidate farthest from what is already there (points and the route line), in screen px
  const pickFar = async () => {
    const taken = await page.evaluate(() => {
      const b = window.dirtscout.build, map = window.dirtscout.map;
      const ll = [...(b?.pts ?? []).map((p) => [p.s.lon, p.s.lat]), ...(b?.legs ?? []).flatMap((l) => l.coords)];
      return ll.map((c) => { const q = map.project(c); return [q.x, q.y]; });
    });
    let best = null, bd = -Infinity;
    for (const c of cands) {
      const d = taken.length ? Math.min(...taken.map(([x, y]) => Math.hypot(c.x - x, c.y - y))) : -Math.hypot(c.x - 110, c.y - 420);
      if (d > bd) { bd = d; best = c; }
    }
    return { ll: best.ll, clear: bd };
  };
  const spots = [];
  check(cands.length >= 10, `track junctions on screen to tap on (${cands.length})`);

  await page.locator('#toolbar [data-sheet="plan"]').click();
  await page.getByRole('button', { name: 'Make my own route' }).click();
  await page.waitForFunction(() => !!window.dirtscout.build && !document.getElementById('buildbar').hidden, null, { timeout: 30000 });
  check(true, 'the builder opens from Plan');
  for (let k = 0; k < 3; k++) {
    const f = await pickFar();
    if (k) check(f.clear > 60, `tap ${k + 1} is ${Math.round(f.clear)} px from the points and the line so far`);
    spots.push(f.ll);
    await tapAt(f.ll);
  }
  let s = await state();
  check(s.n === 3 && s.legs === 2, `three taps: three points, two legs (${s.n}, ${s.legs})`);
  check(s.labels.join(',') === '1,2,3', `numbered 1, 2, 3 (${s.labels})`);
  check(joined(s), 'the legs join their points, end to end');
  check(s.pts.every((p, i) => hv(p, spots[i]) < 30), 'each tap held on to the track it was on');
  await shot('three-points');

  // drag point 2 onto another junction: its two legs follow
  const before = s;
  spots[4] = (await pickFar()).ll;
  const m2 = await page.locator('.rb-pt').nth(1).boundingBox();
  const [tx, ty] = await screen(spots[4]);
  const box = await mapBox();
  await page.mouse.move(m2.x + m2.width / 2, m2.y + m2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + tx, box.y + ty, { steps: 12 });
  await page.mouse.up();
  await settle(800);
  s = await state();
  check(s.n === 3 && hv(s.pts[1], spots[4]) < 30 && hv(s.pts[1], before.pts[1]) > 50, 'dragging point 2 moved it onto the other track');
  check(joined(s), 'after the drag the legs join their points again');
  check(s.undo === before.undo + 1, 'the drag can be undone');
  await shot('dragged');

  // tap the middle of the line between 1 and 2: a new point 2, the old 2 becomes 3
  const mid = await page.evaluate(() => { const c = window.dirtscout.build.legs[0].coords; return c[Math.floor(c.length / 2)]; });
  await tapAt(mid);
  s = await state();
  check(s.n === 4 && hv(s.pts[1], mid) < 15, `a tap on the line added point 2 there (${s.n} points)`);
  check(s.labels.join(',') === '1,2,3,4' && hv(s.pts[2], spots[4]) < 30, 'the numbers after it moved up by one');
  check(joined(s), 'the legs still join');

  // point 1's menu: back to the start
  await page.locator('.rb-pt').first().click();
  await page.locator('.rb-menu').waitFor({ timeout: 5000 });
  await shot('point-menu');
  await page.getByRole('button', { name: 'Back to the start (close the loop)' }).click();
  await settle(500);
  s = await state();
  check(s.closed && s.legs === 4 && hv(s.ends[3][1], s.pts[0]) < 2, 'closing the loop adds a leg from the last point back to point 1');
  await shot('loop');
  await page.locator('#build-undo').click();
  await settle(400);
  s = await state();
  check(!s.closed && s.legs === 3, 'undo opens the loop again');
  await page.locator('#build-loop').click();
  await settle(400);
  check((await state()).closed, 'the Loop button closes it too');

  // the profile: stats and the elevation chart
  await page.locator('#build-stats').click();
  await page.waitForFunction(() => !!window.dirtscout.build.profile, null, { timeout: 60000 });
  await page.locator('.sheet-body .elev-chart canvas').waitFor({ timeout: 10000 });
  const text = await page.locator('.sheet-body').innerText();
  check(/green \d+ %/.test(text) && /Up \d+ m/.test(text), 'the panel shows what the route rides and its climb');
  // a finger sliding along the chart: the dot on the map follows, in the part of the map above the sheet
  check(await page.evaluate(() => document.getElementById('buildbar').hidden), 'the bar steps aside while the profile is open');
  const cb = await page.locator('.sheet-body .elev-chart canvas').boundingBox();
  const dots = [];
  for (const f of [0.2, 0.5, 0.8]) {
    await page.mouse.move(cb.x + cb.width * f, cb.y + cb.height / 2, { steps: 4 });
    await settle(450);
    dots.push(await page.evaluate(() => {
      const el = document.querySelector('.map-cursor');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { label: el.textContent, y: r.top + r.height / 2, x: r.left + r.width / 2, sheetTop: document.getElementById('sheet').getBoundingClientRect().top };
    }));
  }
  check(dots.every((d) => d && /\d+ m · .*%/.test(d.label)), `the dot shows distance, elevation and grade (${dots.map((d) => d?.label).join(' | ')})`);
  check(dots.every((d) => d.y > 60 && d.y < d.sheetTop && d.x > 0 && d.x < 412), 'the dot is on the map above the sheet, every time');
  check(new Set(dots.map((d) => d.label)).size === 3, 'and it moves with the finger');
  await shot('chart-finger');
  const v0 = await page.locator('.elev-chart').evaluate((el) => el.view());
  await page.locator('.elev-chart button', { hasText: '+' }).click();
  await settle(300);
  const v1 = await page.locator('.elev-chart').evaluate((el) => el.view());
  check(v1[1] - v1[0] < v0[1] - v0[0], `"+" zooms the chart in (${Math.round(v0[1] - v0[0])} -> ${Math.round(v1[1] - v1[0])} m)`);
  await shot('profile');

  // still editable with the profile open: drag point 3 to another junction above the sheet
  const sheetTop = (await page.locator('#sheet').boundingBox()).y;
  const free = await page.evaluate(async (top) => {
    const G = await window.dirtscout.debug.ensureGraph();
    const map = window.dirtscout.map, out = [];
    for (let n = 0; n < G.N; n++) {
      if (G.off[n + 1] - G.off[n] < 2) continue;
      const q = map.project([G.lon[n], G.lat[n]]);
      if (q.x > 30 && q.x < 330 && q.y > 90 && q.y < top - 40) out.push({ ll: [G.lon[n], G.lat[n]] });
    }
    return out;
  }, sheetTop);
  check(free.length > 0, `junctions on the map above the profile to drag a dot to (${free.length})`);
  const s0 = await state();
  const target = free.map((c) => ({ c, d: Math.min(...s0.pts.map((p) => hv(p, c.ll))) })).sort((x, y) => y.d - x.d)[0];
  const lenBefore = await page.evaluate(() => window.dirtscout.build.legs.reduce((m, l) => m + l.stats.len, 0));
  const m3 = await page.locator('.rb-pt').nth(2).boundingBox();
  const [ux, uy] = await screen(target.c.ll);
  await page.mouse.move(m3.x + m3.width / 2, m3.y + m3.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + ux, box.y + uy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const stale = await page.evaluate(() => !!document.querySelector('#sheet-body .elev-chart.ec-stale'));
  await page.waitForFunction(() => !!window.dirtscout.build.profile && !document.querySelector('#sheet-body .elev-chart.ec-stale'), null, { timeout: 30000 });
  const lenAfter = await page.evaluate(() => window.dirtscout.build.legs.reduce((m, l) => m + l.stats.len, 0));
  check(stale, 'while the elevation is read again the chart dims');
  check(Math.abs(lenAfter - lenBefore) > 20 && joined(await state()), `a dot dragged under the open profile changed the route (${Math.round(lenBefore)} -> ${Math.round(lenAfter)} m)`);
  const v2 = await page.locator('.elev-chart').evaluate((el) => el.view());
  check(Math.abs((v2[1] - v2[0]) - (v1[1] - v1[0])) < 1, 'the new chart keeps the zoom');
  await page.locator('.sheet-body button', { hasText: 'Undo' }).click();
  await page.waitForFunction(() => !!window.dirtscout.build.profile && !document.querySelector('#sheet-body .elev-chart.ec-stale'), null, { timeout: 30000 });
  const lenUndo = await page.evaluate(() => window.dirtscout.build.legs.reduce((m, l) => m + l.stats.len, 0));
  check(Math.abs(lenUndo - lenBefore) < 1, 'Undo in the profile puts the dot back');

  // save, then edit it again from Tracks
  page.once('dialog', (d) => d.accept('E2E route'));
  await page.locator('.sheet-body button', { hasText: 'Save' }).first().click();
  await page.waitForFunction(() => window.dirtscout.tracks.some((t) => t.name === 'E2E route'), null, { timeout: 10000 });
  const saved = await page.evaluate(() => window.dirtscout.tracks.find((t) => t.name === 'E2E route').plan.built);
  check(!(await page.evaluate(() => !!window.dirtscout.build)) && saved.pts.length === 4 && saved.closed, 'saved with its 4 points and the loop; the builder closed');
  await page.locator('#toolbar [data-sheet="tracks"]').click();
  const card = page.locator('.card.track', { hasText: 'E2E route' });
  await card.getByRole('button', { name: 'Edit' }).click();
  await page.waitForFunction(() => window.dirtscout.build?.pts.length === 4, null, { timeout: 30000 });
  s = await state();
  check(s.closed && s.legs === 4 && joined(s), 'Edit in Tracks opens it in the builder again');
  await page.locator('#build-exit').click();
  await settle(300);
  check(!(await page.evaluate(() => !!window.dirtscout.build)), 'leaving without changes asks nothing');

  // Tracks > Profile on a saved route: the route opens to edit, with the profile under it
  await page.locator('#toolbar [data-sheet="tracks"]').click();
  await page.locator('.card.track', { hasText: 'E2E route' }).getByRole('button', { name: 'Profile' }).click();
  await page.locator('.sheet-body .elev-chart canvas').waitFor({ timeout: 60000 });
  check(await page.evaluate(() => window.dirtscout.build?.pts.length === 4 && document.getElementById('sheet-title').textContent === 'Your route'),
    'Tracks > Profile opens the saved route to edit, with its elevation chart');
  await shot('track-profile');
  await page.locator('#sheet-close').click();
  await page.locator('#build-exit').click();
  await settle(300);

  // Plan > a generated route's Profile: points along it, the same route, ready to edit
  await page.locator('#toolbar [data-sheet="plan"]').click();
  await page.locator('.range2 input[type=range]').nth(0).evaluate((el) => { el.value = '6'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('.range2 input[type=range]').nth(1).evaluate((el) => { el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.getByRole('button', { name: 'Map centre' }).click();
  await page.locator('.sheet-body button', { hasText: /Generate/ }).click();
  await page.waitForFunction(() => !window.dirtscout.plan.busy && window.dirtscout.plan.results.length > 0, null, { timeout: 120000 });
  const genLen = await page.evaluate(() => window.dirtscout.plan.results[0].stats.len);
  await page.locator('.plan-card').first().getByRole('button', { name: 'Profile' }).click();
  await page.waitForFunction(() => window.dirtscout.build?.legs.length > 0 && !!window.dirtscout.build.profile, null, { timeout: 120000 });
  const ed = await page.evaluate(() => {
    const b = window.dirtscout.build;
    return { pts: b.pts.length, closed: b.closed, len: b.legs.reduce((m, l) => m + l.stats.len, 0), title: document.getElementById('sheet-title').textContent };
  });
  check(ed.title === 'Your route' && ed.pts >= 3 && ed.closed, `a generated loop opens to edit: ${ed.pts} dots, a loop`);
  check(Math.abs(ed.len - genLen) / genLen < 0.02, `the same route: ${Math.round(ed.len)} m as generated ${Math.round(genLen)} m`);
  check(await page.evaluate(() => window.dirtscout.map.queryRenderedFeatures({ layers: ['plan-line'] }).length === 0), 'the generated routes leave the map meanwhile');
  await settle(800);
  await shot('plan-route-edit');
  await page.locator('#sheet-close').click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#build-exit').click();
  await settle(500);
  check(await page.evaluate(() => !window.dirtscout.build && window.dirtscout.map.queryRenderedFeatures({ layers: ['plan-line'] }).length > 0),
    'leaving the builder puts them back');

  const bad = errors.filter((e) => !/Failed to load resource|net::/.test(e));
  check(bad.length === 0, `no page errors${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  console.log('build e2e: all checks passed');
} catch (e) {
  console.error(e.message);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await server?.close();
}
