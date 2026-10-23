# DirtScout

An offline dirt-bike map for one riding area: Cluj-Napoca west into the Apuseni mountains past Lake Beliș-Fântânele,
south to Aiud. An installable web app for Android (Chrome), built to work in airplane mode.

**App:** https://tiganetearobert.github.io/dirt-route-planner/

## What it does (M1)

- **Maps:** Microsoft Earth (Bing aerial), Microsoft Hybrid and Esri World Imagery, which you can save to the phone. OpenStreetMap,
  OpenTopoMap and CyclOSM are online only.
- **Overlays:** riding-area outline, hillshade and slope shading. Both are computed on the phone from saved elevation tiles,
  so they work offline. Waymarked MTB/hiking routes and OSM public GPS traces are online only.
- **Offline maps:** save tiles for the whole riding area, for what is on screen, or along a track with a buffer, for a chosen
  zoom range. You see the tile count and size before starting. Downloads can be paused, resumed or cancelled, tiles
  already saved are skipped, 4-6 requests run at a time with backoff, and the screen stays on while downloading. With no
  network, zoom levels that were not saved are filled in by stretching the closest saved level.
- **GPS:** position, accuracy circle, heading and follow mode. Ride recording is crash-safe, shows live time, distance,
  speed and climb, and exports to GPX (Android share sheet or download).
- **Tracks:** import GPX/KML files (Wikiloc, TET, ACT, your own). Every track stays on the phone.
- **Checks:** a source check (one tile per map server) and device checks (installed, offline-ready, storage protected,
  keep-screen-on, location permission).

## Install on Android

1. Open the app link in **Chrome**.
2. Tap menu ⋮ → **Install app** (or "Add to Home screen"), or use the Install button under More.
3. Open DirtScout from the home screen. Go to Offline → **Whole area overview** → Start download (about 0.6-0.8 GB on
   Wi-Fi).
4. For riding detail, import a track and use **Save detail offline** on it (z17-18 along the track).
5. Test in airplane mode: the app opens and shows the saved imagery, slope and your GPS position.

Keep DirtScout on screen while riding. Android can pause web-app GPS when the screen is off or another app is in front.

## Data sources and terms

| Source | Use in DirtScout |
|---|---|
| Microsoft Earth / Hybrid (Bing Maps) | Can be saved for personal use. Bing's terms do not allow caching; the owner accepted that risk. Never shared. |
| Esri World Imagery | Same as Bing. Esri's terms only allow offline use through Esri's own apps; the owner accepted that risk. |
| OpenStreetMap, OpenTopoMap, CyclOSM, Waymarked Trails, OSM GPS traces | Online only. Their volunteer servers forbid bulk or offline download. |
| Terrain Tiles (Mapzen/Tilezen on AWS Open Data) | Elevation for hillshade and slope. Open data. |
| TET / ACT GPX | Imported on the phone only. Their terms forbid redistribution, so they never enter this repository. |

The elevation model has ~25-30 m pixels. Short steep pitches (10-20 m) do not show in the slope shading, so a clear
slope map does not prove that a climb is rideable.

## Development

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (core/: tile math, corridors, GPX/KML)
npm run e2e        # build + phone emulation in the local Chrome (download, airplane mode, GPS, recording, import)
```

- `core/`: plain ES modules with no DOM, shared by the app and the Node data pipeline.
- `app/`: the PWA (MapLibre GL JS 6, IndexedDB tile store, service worker).

Pushing to `main` deploys to GitHub Pages.

Roadmap: M2 area pack (own OSM track map, Microsoft road detections, GPS traces, land cover), M3 scoring and risk
colours, M4 route generator, M5 "investigate this track", M6 a batch of 100 tracks.

Map data © OpenStreetMap contributors (ODbL). Imagery © Microsoft, © Esri and its providers.
