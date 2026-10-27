// Riding a route end-to-end in the PC's Chrome as an Android phone, with a made-up GPS: Plan makes loops near Baisoara,
// Navigate on route 1; far away the banner shows the way to the start and a car navigator; at the start the ride
// begins (the recording too) and the rider moves along the route: the distance left goes down, a turn shows before
// it comes, the camera follows (heading up turns the map, 3D tilts it, north up does neither); off the route the
// banner says so, and back on it the guidance returns. The layer chips (Plain, Hillshade), a reload in the middle of
// the ride, then Edit: the builder opens with a blue dot where the rider is, Avoid the stretch ahead, Continue rides
// the changed route; the exit keeps the route and the ride in Tracks. Then the PC: the 3D terrain and its slider
// (not offered on the phone).
//   npm run build && node tests/e2e/nav.e2e.mjs
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'tests', 'e2e', 'out-nav');
mkdirSync(OUT, { recursive: true });
const server = process.env.E2E_URL ? null : await preview({ configFile: join(ROOT, 'vite.config.js'), preview: { port: 4173, strictPort: true } });
const URL0 = process.env.E2E_URL || 'http://localhost:4173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
let step = 0;
const check = (ok, msg) => { if (!ok) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };
const hv = (a, b) => {
  const R = 6371008.8, r = Math.PI / 180, dl = (b[1] - a[1]) * r, dn = (b[0] - a[0]) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
// points every `d` metres along a line
function along(coords, d) {
  const out = [coords[0]];
  let left = d;
  for (let i = 1; i < coords.length; i++) {
    let a = coords[i - 1];
    const b = coords[i];
    let seg = hv(a, b);
    while (seg >= left) {
      const t = left / seg;
      a = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      out.push(a);
      seg -= left;
      left = d;
    }
    left -= seg;
  }
  return out;
}

async function phone() {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    permissions: ['geolocation'], geolocation: { latitude: 46.77, longitude: 23.59, accuracy: 8 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()));
  const shot = async (name) => {
    const f = join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: f });
    console.log('shot', f);
  };
  const settle = (ms = 600) => page.waitForTimeout(ms);
  // the rider is at p: wait until the app has the fix
  const goTo = async (p, acc = 6) => {
    await context.setGeolocation({ longitude: p[0], latitude: p[1], accuracy: acc });
    await page.waitForFunction((q) => { const f = window.dirtscout.debug.gps.last; return f && Math.abs(f.lon - q[0]) < 1e-7 && Math.abs(f.lat - q[1]) < 1e-7; },
      p, { timeout: 15000 });
  };
  const nav = () => page.evaluate(() => {
    const n = window.dirtscout.nav;
    if (!n) return null;
    const m = window.dirtscout.map;
    return { along: n.along, len: n.R.len, joined: n.joined, state: n.state, d: n.d, turns: n.turns.map((t) => [t.along, t.kind]),
      mode: n.mode, heading: n.heading, edited: n.edited, following: n.following,
      bearing: m.getBearing(), pitch: m.getPitch(), banner: document.getElementById('nav-banner').innerText.replace(/\s+/g, ' '),
      togo: document.getElementById('nav-togo').textContent, rec: !document.getElementById('nav-rec').hidden };
  });
  return { context, page, shot, settle, goTo, nav };
}

try {
  const { context, page, shot, settle, goTo, nav } = await phone();
  await page.goto(URL0);
  await page.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  check(await page.locator('.ctrl-3d').count() === 0, 'no 3D button on the phone');
  await page.evaluate(() => {
    window.dirtscout.debug.settings.base = 'ds-topo';
    window.dirtscout.debug.applyLayers(window.dirtscout.map);
    window.dirtscout.map.jumpTo({ center: [23.47, 46.58], zoom: 13 });
  });
  // Plan: loops from the map centre, then Navigate on route 1
  await page.locator('#toolbar [data-sheet="plan"]').click();
  await page.getByRole('button', { name: 'Map centre' }).click();
  await page.locator('.sheet-body button', { hasText: /Generate/ }).click();
  await page.waitForFunction(() => !window.dirtscout.plan.busy && window.dirtscout.plan.results.length > 0, null, { timeout: 120000 });
  const route = await page.evaluate(() => window.dirtscout.plan.results[0].coords);
  await page.locator('.plan-card').first().getByRole('button', { name: 'Navigate' }).click();
  await page.waitForFunction(() => !!window.dirtscout.nav && !document.getElementById('nav').hidden, null, { timeout: 10000 });
  check(await page.evaluate(() => document.getElementById('toolbar').offsetParent === null), 'riding: the toolbar makes room for the map');

  // far from the start (in Cluj): the way there, and a car navigator
  await goTo([23.59, 46.77]);
  await settle(800);
  let n = await nav();
  check(!n.joined && /to the start/.test(n.banner), `far away: "${n.banner.slice(0, 60)}"`);
  const href = await page.locator('#nav-banner a', { hasText: 'Google Maps' }).getAttribute('href');
  check(href.includes(`destination=${route[0][1].toFixed(6)},${route[0][0].toFixed(6)}`), 'Drive: Google Maps goes to the start of the route');
  check(await page.locator('#nav-banner a', { hasText: 'Waze' }).count() === 1, 'and Waze is offered too');
  await shot('to-the-start');

  // at the start: the ride begins
  const pts = along(route, 30);
  await goTo(pts[0]);
  await settle(500);
  n = await nav();
  check(n.joined && n.state === 'on' && n.along < 30, `at the start the ride begins (along ${Math.round(n.along)} m)`);
  check(n.rec, 'and the ride is being recorded');
  await page.waitForFunction(() => window.dirtscout.nav.turns.length > 0, null, { timeout: 60000 }).catch(() => {});
  n = await nav();
  const firstTurn = n.turns.find(([a]) => a > 150);
  check(n.turns.length > 0, `turns along the route: ${n.turns.length} (the first: ${n.turns.slice(0, 4).map(([a, k]) => `${k} at ${Math.round(a)} m`).join(', ')})`);
  // ride: up to 150 m past the first turn (at most 3 km)
  const stop = Math.min(firstTurn ? firstTurn[0] + 150 : 2000, 3000, pts.length * 30 - 60);
  const seen = new Set();
  let last = null, k = 1;
  for (; k * 30 < stop; k++) {
    await goTo(pts[k]);
    await settle(1050);
    last = await nav();
    seen.add(last.banner.split(' ').slice(1, 3).join(' '));
    if (firstTurn && last.along < firstTurn[0] - 40 && firstTurn[0] - last.along < 400 && !seen.has('turn-shot')) {
      seen.add('turn-shot');
      check(/Turn|Bear|Keep|Sharp/.test(last.banner), `a turn is announced ${Math.round(firstTurn[0] - last.along)} m before it: "${last.banner.slice(0, 50)}"`);
      await shot('turn-ahead');
    }
  }
  check(Math.abs(last.along - k * 30 + 30) < 40, `the rider is followed along the route (${Math.round(last.along)} m, rode ${k * 30 - 30} m)`);
  check(last.state === 'on' && last.d < 15, 'on the route all the way');
  const togo = Number.parseFloat(last.togo);
  check(togo > 0 && Math.abs(last.len - last.along - togo * (last.togo.includes('km') ? 1000 : 1)) < 120, `the distance left: ${last.togo}`);
  // the camera: heading up turns the map with the rider
  check(last.mode === 'heading' && Math.abs(((last.bearing - last.heading + 540) % 360) - 180) < 12, `heading up: the map turns with the rider (map ${Math.round(last.bearing)}°, rider ${Math.round(last.heading)}°)`);
  await shot('riding-heading');
  await page.locator('#nav-cam').click();
  await settle(1300);
  n = await nav();
  check(n.mode === 'follow' && n.pitch > 50, `3D: the map tilts, from behind the rider (pitch ${Math.round(n.pitch)})`);
  await shot('riding-3d');
  await page.locator('#nav-cam').click();
  await settle(1300);
  n = await nav();
  check(n.mode === 'north' && Math.abs(n.bearing) < 1 && n.pitch < 1, 'north up: north stays up, flat');
  await shot('riding-north');
  await page.locator('#nav-cam').click();
  await settle(800);

  // off the route (to the side, at least 110 m from any part of it) and back
  const here = pts[k - 1], prevPt = pts[k - 2];
  const kx = 111320 * Math.cos(here[1] * Math.PI / 180), ky = 110540;
  const dx = (here[0] - prevPt[0]) * kx, dy = (here[1] - prevPt[1]) * ky, dl = Math.hypot(dx, dy) || 1;
  const side = (m) => [here[0] + (-dy / dl) * m / kx, here[1] + (dx / dl) * m / ky];
  const gap = (p) => Math.min(...along(route, 10).map((q) => hv(p, q)));
  const off = [120, -120, 180, -180, 250, -250].map(side).find((p) => gap(p) > 110);
  check(!!off, 'a place off the route to go to');
  await goTo(off);
  await settle(600);
  await goTo([off[0] + 0.00003, off[1] + 0.00002]);
  await settle(600);
  n = await nav();
  check(n.state === 'off' && /off the route/i.test(n.banner), `off the route: "${n.banner.slice(0, 40)}"`);
  await shot('off-route');
  await goTo(pts[k]);
  await settle(600);
  n = await nav();
  check(n.state === 'on' && !/off the route/i.test(n.banner), 'back on the route: the guidance is back');

  // the layer chips: Plain (no base map), Hillshade
  await page.locator('#nav-layers-btn').click();
  await page.locator('#nav-layers .chip', { hasText: 'Plain' }).click();
  await page.locator('#nav-layers .chip', { hasText: 'Hillshade' }).click();
  const lay = await page.evaluate(() => {
    const m = window.dirtscout.map, v = (id) => m.getLayoutProperty(id, 'visibility');
    return { base: window.dirtscout.debug.settings.base, sat: v('ms-earth'), hill: v('hillshade') };
  });
  check(lay.base === 'none' && lay.sat === 'none' && lay.hill === 'visible', 'Plain: no base map; Hillshade on');
  await shot('layers-plain');
  await page.locator('#nav-layers .chip', { hasText: 'Topo' }).click();
  await page.locator('#nav-layers .chip', { hasText: 'Hillshade' }).click();
  await page.locator('#nav-layers .chip', { hasText: 'Done' }).click();

  // a reload in the middle of the ride: it carries on
  const before = await nav();
  await page.reload();
  await page.waitForFunction(() => !!window.dirtscout?.nav && window.dirtscout.map.loaded(), null, { timeout: 60000 });
  await goTo(pts[k + 1]);
  await settle(800);
  n = await nav();
  check(n.joined && Math.abs(n.along - before.along) < 80 && Math.abs(n.len - before.len) < 1, `after a reload the ride carries on (${Math.round(n.along)} m)`);
  k += 1;

  // Edit: the builder with a dot where the rider is; Avoid the stretch ahead; Continue
  await page.locator('#nav-edit').click();
  await page.waitForFunction(() => !!window.dirtscout.build && !document.getElementById('buildbar').hidden, null, { timeout: 30000 });
  await settle(800);
  const ed = await page.evaluate(() => {
    const b = window.dirtscout.build;
    const hi = b.pts.findIndex((p) => p.here);
    return { n: b.pts.length, hi, here: hi >= 0 ? [b.pts[hi].s.lon, b.pts[hi].s.lat] : null,
      save: document.getElementById('build-save').textContent, avoid: !document.getElementById('build-avoid').hidden,
      loop: !document.getElementById('build-loop').hidden, dots: document.querySelectorAll('.rb-pt.here').length };
  });
  check(ed.hi > 0 && hv(ed.here, pts[k]) < 25 && ed.dots === 1, `Edit: a blue dot where the rider is (point ${ed.hi + 1} of ${ed.n})`);
  check(ed.save === 'Continue' && ed.avoid && !ed.loop, 'the bar: Avoid and Continue');
  await shot('edit-here');
  const lenBefore = await page.evaluate(() => window.dirtscout.nav.R.len);
  // the stretch 300-400 m ahead of the rider, on the route line
  const target = await page.evaluate((hi) => {
    const b = window.dirtscout.build, c = b.legs[hi].coords;
    let d = 0;
    for (let i = 1; i < c.length; i++) {
      const R = 6371008.8, r = Math.PI / 180, a = c[i - 1], z = c[i];
      const x = Math.sin((z[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(z[1] * r) * Math.sin((z[0] - a[0]) * r / 2) ** 2;
      d += 2 * R * Math.asin(Math.sqrt(x));
      if (d > 300) return z;
    }
    return c[Math.floor(c.length / 2)];
  }, ed.hi);
  await page.evaluate((p) => window.dirtscout.map.jumpTo({ center: p, zoom: 15.5 }), target);
  await settle(600);
  await page.locator('#build-avoid').click();
  const [tx, ty] = await page.evaluate((p) => { const q = window.dirtscout.map.project(p); return [q.x, q.y]; }, target);
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + tx, box.y + ty);
  await settle(1200);
  const av = await page.evaluate(() => ({ blocked: window.dirtscout.build.avoidAt.size, toast: document.getElementById('toast').innerText }));
  check(av.blocked === 1, `Avoid: the stretch is marked (${av.toast})`);
  await shot('avoid');
  await page.locator('#build-save').click();
  await page.waitForFunction(() => !window.dirtscout.build && !window.dirtscout.nav.editing, null, { timeout: 30000 });
  await settle(800);
  n = await nav();
  check(n.edited && n.joined && n.state === 'on', `Continue: riding the changed route (${(lenBefore / 1000).toFixed(2)} -> ${(n.len / 1000).toFixed(2)} km)`);
  check(Math.abs(n.len - lenBefore) > 5 || /still rides it/.test(av.toast), 'the route changed (or there was no way around)');
  check(n.d < 25, `the rider is on the new route (${Math.round(n.d)} m off), at ${Math.round(n.along)} m`);
  await shot('after-edit');

  // the end: the changed route and the ride are kept in Tracks
  const nTracks = await page.evaluate(() => window.dirtscout.tracks.length);
  await page.locator('#nav-exit').click();
  await page.waitForFunction(() => !window.dirtscout.nav, null, { timeout: 15000 });
  await settle(1500);
  const after = await page.evaluate(() => ({ n: window.dirtscout.tracks.length, kinds: window.dirtscout.tracks.map((t) => t.kind),
    toolbar: document.getElementById('toolbar').offsetParent !== null, pitch: window.dirtscout.map.getPitch() }));
  check(after.n === nTracks + 2 && after.kinds.includes('planned') && after.kinds.includes('recording'), `the route and the ride are saved (${after.kinds.join(', ')})`);
  check(after.toolbar && after.pitch < 1, 'the map is back to normal');
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();

  // the PC: 3D terrain with the height slider
  const pc = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page2 = await pc.newPage();
  page2.on('pageerror', (e) => errors.push(`pc pageerror: ${e.message}`));
  await page2.goto(URL0);
  await page2.waitForFunction(() => window.dirtscout?.map?.loaded(), null, { timeout: 60000 });
  await page2.evaluate(() => {
    window.dirtscout.debug.settings.base = 'ds-topo';
    window.dirtscout.debug.applyLayers(window.dirtscout.map);
    window.dirtscout.map.jumpTo({ center: [22.75, 46.55], zoom: 12.5, bearing: 30 });
  });
  check(await page2.locator('.ctrl-3d').count() === 1, 'the PC has the 3D button');
  await page2.locator('.ctrl-3d').click();
  await page2.waitForTimeout(2500);
  let t3 = await page2.evaluate(() => ({ terrain: window.dirtscout.map.getTerrain(), pitch: window.dirtscout.map.getPitch(), panel: !document.getElementById('t3d').hidden }));
  check(t3.terrain?.source === 'terrain' && t3.pitch > 50 && t3.panel, `3D: terrain on, tilted (pitch ${Math.round(t3.pitch)}), the height slider shows`);
  await page2.waitForFunction(() => window.dirtscout.map.loaded() && window.dirtscout.map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {});
  await page2.waitForTimeout(1500);
  await page2.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-pc-3d.png`) });
  await page2.locator('#t3d-exag').fill('3');
  await page2.waitForTimeout(1500);
  t3 = await page2.evaluate(() => ({ ex: window.dirtscout.map.getTerrain()?.exaggeration, label: document.getElementById('t3d-label').textContent }));
  check(t3.ex === 3 && /×3\.0/.test(t3.label), `the slider raises the relief (${t3.label})`);
  await page2.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-pc-3d-x3.png`) });
  await page2.locator('#t3d-off').click();
  await page2.waitForTimeout(1200);
  t3 = await page2.evaluate(() => ({ terrain: window.dirtscout.map.getTerrain(), pitch: window.dirtscout.map.getPitch() }));
  check(!t3.terrain && t3.pitch < 1, 'Flat map: back to 2D');
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\nall nav checks passed');
} finally {
  await browser.close();
  await server?.close();
}
