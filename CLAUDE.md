# DirtScout: notes for Claude sessions

Offline dirt-bike route planner PWA for one riding area (Cluj-Napoca / Apuseni). The full plan, the owner's decisions
and the research live in `private/HANDOFF.md` (gitignored). Read it before starting a milestone. The area is
22.61-23.80 E, 46.28-46.82 N: widened 25 % to the west on 2026-10-27 (HANDOFF.md still says 22.85); BBOX in
pipeline/common.py and DEFAULT_AREA in app/src/config.js must match, and an old default moves on by itself (OLD_AREAS).

## Layout
- `core/`: no-DOM ES modules shared by the app and Node: tilemath, geo, area (tile sets/corridors), gpx, scoring
  (M3 verdicts), routing (M4: A*, loops with climbs), investigate (M5: map matching, profile, ways around), polyline,
  builder (Make my own route), profile (elevation charts), nav (riding a route: where the rider is, turns, climb left).
- `app/`: Vite root. `src/` = main, config (sources, area), settings (localStorage), db (IndexedDB), tiles
  (`offline://` and `slope://` protocols, overzoom, elevation), downloads (job queue), gps (position + recorder),
  tracks, mapview, ui (panels), builder, nav (Navigate), terrain3d (the PC's 3D terrain). `sw.js` is the app-shell
  worker; the build fills in its precache list.
- `tests/`: `node --test` unit tests; `tests/e2e/m1.e2e.mjs` (offline map) and `m2.e2e.mjs` (area pack) = phone
  emulation in the local Chrome (playwright-core). The browser pane cannot screenshot while the app window is hidden:
  use these.
- `pipeline/`: builds the area pack (README there). Grades use FABDEM, smoothed over 30 m; the noise was measured on
  main roads (p90 ~10 %). `core/scoring.js` is used both by `pipeline/score.mjs` and by the phone's track card.
- The area pack is published as a `pack-*` GitHub release (not committed); the Pages workflow copies the newest one in.
- `data/` (raw downloads, area pack) and `private/` are gitignored.
- AI-found tracks (pipeline/README.md, steps A1-A7): a U-Net on Esri z17 imagery, 3-fold cross-fitting, line extraction,
  a private graph (`DS_AI=1`), all in `data/ai/`. The phone gets them only as `pack/ai.enc` (AES-GCM, passphrase in
  `private/ai_passphrase.txt`), opened in Offline > "Tracks the AI found" (`app/src/aibundle.js`, `core/aicrypt.js`):
  vector tiles for the map (pmtiles://ai, added once unlocked), the graph read only when routing; a slider under the
  layer in Layers sets the minimum score (default 0.4); Plan's switch "Use the tracks the AI found" decides whether
  routes use them (hiding the layer does not). Class `gap` joins AI tracks that end in nothing (dots on the map, white
  dashes on a route). Every pass that adds nodes in pipeline/graph.py must take new ids (`next_ids`): a reused id made
  routes jump across the map (2026-10-24); graph_pack.py now stops on it. `tests/e2e/ai.e2e.mjs` checks it with a test bundle
  (`tests/fixtures/aibundle.mjs`, tiles from `make_ai_tiles.py`). A GeoJSON of ~50k lines made the map redraw take ~20 s:
  keep big line sets in tiles.

## Rules (binding unless the owner changes them)
- Microsoft (Bing) and Esri imagery: the owner accepted the terms risk for personal use. Downloads stay inside the riding
  area, use at most 6 parallel requests with backoff, and saved tiles are never redistributed or hosted.
- OSM volunteer tile servers (OSM, GPS traces, OpenTopoMap, CyclOSM, Waymarked): online and view-only. No download feature.
- TET/ACT GPX: imported on the device only. Never commit, host or share them.
- OSM-derived maps count as one source (same data), so stacking them adds no confidence.
- The DEM is ~30 m and misses short steep pitches. Say so wherever slope is shown or scored.
- The repo is public: no personal data, no GPX, no imagery in commits.
- Anything derived from Esri imagery (the AI lines, their graph) is published only encrypted (`ai.enc`); never commit
  the passphrase, the model weights, predictions or crops.

## Commands
`npm run dev` | `npm test` | `npm run e2e` | `node tests/e2e/m2.e2e.mjs` | push to `main` = deploy to
https://tiganetearobert.github.io/dirt-route-planner/

## Status
M1-M5 are built and tested on the PC (tests/e2e/m1, m2, m4, m5) and deployed. They wait for the owner's phone test
and feedback. The risk weights (core/scoring.js) and the route costs (core/routing.js) are first calibrations. The ten
sample rides (tools/samples.mjs -> pack samples.json) are the review set before M6 (100 tracks).
The AI-found tracks (v2: 50,385 tracks, 8,063 km, plus 12,447 gaps, 1,121 km; 2026-10-24) wait for the owner's verdict:
tune the filters in pipeline/ai_vectorize.py from what they report (terraces, field edges and shores are the known false
lines). Plan (2026-10-24): a length range with two knobs (kept with the start in settings.plan), the start on the
mapped way nearest the tap (not an AI track, not an island), waypoints only where a ride can pass through (no
dead-end branches), loops that ride over a third of themselves twice ranked last; waits for the owner's ride feedback.
Make my own route (Plan > "Make my own route"; core/builder.js + app/src/builder.js, 2026-10-24): taps hold on to the
nearest way anywhere along an edge, legs follow the network (a trace cost that forbids nothing), parts of the network
with no link between them are crossed straight (red dashes, counted as "no track known"; via the main network when
that is shorter); drag a point, tap the line to insert one, point 1's menu closes the loop, undo; saved routes keep
their points (track.plan.built) so Tracks > Edit reopens them. Elevation charts (core/profile.js, app/src/chart.js,
app/src/profileview.js) in the builder, Tracks > Profile, Plan's route cards and Investigate; red at or above
settings.steepRed (default 45 %, the owner's number; mountain tracks do read 45-61 %). tests/e2e/build.e2e.mjs.
A route's Profile (the builder's, Tracks, Plan's route cards) opens it to edit with the chart under the map: the dots
stay draggable, the chart dims and comes back with the same zoom, the steep stretches are red on the map. Routes
without dots get them from core/builder.js pointsForLine (every 4 km, plus one where the builder's way leaves the
line: generated 35 km loops come back the same within 0.1 % with 10-22 dots). Rides and imports keep a read-only
profile with "Edit as my own route".
Navigate (2026-10-27; core/nav.js + app/src/nav.js, tests/nav.test.js + tests/e2e/nav.e2e.mjs): a Navigate button
on Tracks, Plan's route cards and the builder's route panel ("Ride it").
- Before the start: away from the route, the banner shows the start (Google Maps / Waze links for the drive) and the
  camera shows the rider and the start together. Within 35 m of the route the ride begins, and the ride recording
  starts (settings.nav.record).
- Turns: core/nav.js routeTurns uses graph junctions within 15 m of the line: a turn of 40 degrees or more, or a fork
  where another way runs about as straight (keep left / right). Gaps are no branch; turn-backs count too.
- Off the route: past 55 m (+ half the GPS accuracy), with a vibration.
- Camera modes (settings.nav.mode): north, heading, follow (3D, pitch 60, the rider low on the screen). A pan stops
  following until Re-centre; pinch zoom keeps it.
- Quick buttons: layer chips (Satellite / Topo / Plain = settings.base 'none', and overlays), Edit, Record, zoom.
- Edit opens the builder with a blue "here" dot inserted where the rider is (nav option of startBuilder). Avoid (also
  in the route panel) marks a whole graph edge 50x dearer, kept as a place in plan.built.avoid. Continue hands back
  {coords, built, stats, hereAlong} and the ride goes on from the dot.
- The state is kept in localStorage (dirtscout.nav.v1) and resumes after a reload. The exit offers to save a changed
  route and to stop the recording that navigation started.
Send to phone (2026-10-27; core/routelink.js + app/src/sendroute.js, tests/routelink.test.js + tests/e2e/send.e2e.mjs):
tracks are per browser (IndexedDB), so a route goes PC -> phone as a QR code of `<app>#route=<base64url JSON>`. The
JSON holds the builder's points (kind "b", from plan.built or pointsForLine on the PC); the phone rebuilds the route
with core/builder.js routeFromPoints (same costs and avoided stretches as the builder) and saves it with plan.sent
(a signature: the same link twice adds nothing). Kind "l" = a line off the network, simplified to fit (lineForLink).
decodeRoute validates and caps everything (links come from anywhere). Not for TET tracks. QR: npm uqr (pinned).
Flying (app/src/fly.js, PC only, tests/e2e/fly.e2e.mjs): F = fly (W A S D, Q E down/up, drag/arrows look, Shift x5,
speed from metres per pixel, keepAboveGround via the camera transform: m.transform ?? m._camera.transform in MapLibre
6), O = orbit, [ ] = relief +-0.5, "Fly through" on Tracks / Plan / the builder (a route tour with play, x1-x8, scrub).
Headless Chrome renders the 3D terrain in software (about 1 fps while terrain tiles load, slower when the GPU is busy):
the e2e holds keys until the camera moved and compares the camera's velocities, not timed distances.
The PC's 3D terrain (app/src/terrain3d.js, a "3D" map button only with a mouse): a separate raster-dem source
"terrain" (same tiles as "dem"), an exaggeration slider (settings.terrain3d), and the hillshade on by itself over the
topo or no base map.

When the owner asks to "investigate" a GPX: `node tools/investigate.mjs <gpx>`, then
`uv run --with pillow python tools/imagery_crops.py private/reports/<name>`, look at the flag-*.jpg images, and report
the verdict, risks with km markers and ways around. The imagery stays local (terms).
