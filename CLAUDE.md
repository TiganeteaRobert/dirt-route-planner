# DirtScout: notes for Claude sessions

Offline dirt-bike route planner PWA for one riding area (Cluj-Napoca / Apuseni). The full plan, the owner's decisions
and the research live in `private/HANDOFF.md` (gitignored). Read it before starting a milestone.

## Layout
- `core/`: no-DOM ES modules shared by the app and Node (tilemath, geo, area = tile sets/corridors, gpx).
- `app/`: Vite root. `src/` = main, config (sources, area), settings (localStorage), db (IndexedDB), tiles
  (`offline://` and `slope://` protocols, overzoom, elevation), downloads (job queue), gps (position + recorder),
  tracks, mapview, ui (panels). `sw.js` is the app-shell worker; the build fills in its precache list.
- `tests/`: `node --test` unit tests; `tests/e2e/m1.e2e.mjs` = phone emulation in the local Chrome (playwright-core).
- `data/` (raw downloads, area pack) and `private/` are gitignored.

## Rules (binding unless the owner changes them)
- Microsoft (Bing) and Esri imagery: the owner accepted the terms risk for personal use. Downloads stay inside the riding
  area, use at most 6 parallel requests with backoff, and saved tiles are never redistributed or hosted.
- OSM volunteer tile servers (OSM, GPS traces, OpenTopoMap, CyclOSM, Waymarked): online and view-only. No download feature.
- TET/ACT GPX: imported on the device only. Never commit, host or share them.
- OSM-derived maps count as one source (same data), so stacking them adds no confidence.
- The DEM is ~30 m and misses short steep pitches. Say so wherever slope is shown or scored.
- The repo is public: no personal data, no GPX, no imagery in commits.

## Commands
`npm run dev` | `npm test` | `npm run e2e` | push to `main` = deploy to https://tiganetearobert.github.io/dirt-route-planner/
