# DirtScout: notes for Claude sessions

Offline dirt-bike route planner PWA for one riding area (Cluj-Napoca / Apuseni). The full plan, the owner's decisions
and the research live in `private/HANDOFF.md` (gitignored). Read it before starting a milestone.

## Layout
- `core/`: no-DOM ES modules shared by the app and Node: tilemath, geo, area (tile sets/corridors), gpx, scoring
  (M3 verdicts), routing (M4: A*, loops with climbs), investigate (M5: map matching, profile, ways around), polyline.
- `app/`: Vite root. `src/` = main, config (sources, area), settings (localStorage), db (IndexedDB), tiles
  (`offline://` and `slope://` protocols, overzoom, elevation), downloads (job queue), gps (position + recorder),
  tracks, mapview, ui (panels). `sw.js` is the app-shell worker; the build fills in its precache list.
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
When the owner asks to "investigate" a GPX: `node tools/investigate.mjs <gpx>`, then
`uv run --with pillow python tools/imagery_crops.py private/reports/<name>`, look at the flag-*.jpg images, and report
the verdict, risks with km markers and ways around. The imagery stays local (terms).
