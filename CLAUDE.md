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
  `private/ai_passphrase.txt`), opened in Offline > "Tracks the AI found" (`app/src/aibundle.js`, `core/aicrypt.js`).
  `tests/e2e/ai.e2e.mjs` checks it with a test bundle (`tests/fixtures/aibundle.mjs`).

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
The AI-found tracks (7,725 tracks, ~900 km, deployed 2026-10-23) wait for the owner's verdict: tune the filters in
pipeline/ai_vectorize.py from what they report (terraces, field edges and shores are the known false lines).
When the owner asks to "investigate" a GPX: `node tools/investigate.mjs <gpx>`, then
`uv run --with pillow python tools/imagery_crops.py private/reports/<name>`, look at the flag-*.jpg images, and report
the verdict, risks with km markers and ways around. The imagery stays local (terms).
