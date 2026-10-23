# Area pack pipeline (M2)

Builds DirtScout's own map and the evidence for every track in the riding area. It runs on the PC with `uv`; no
Java, GDAL or osmium CLI is needed. Steps 2-5 can run in any order once step 1 has run.

| Step | Script | Input | Output (data/area/) |
|---|---|---|---|
| 0 | download by hand (see below) | | data/raw/romania-latest.osm.pbf, ROU.parquet |
| 1 | `osm_extract.py` | Geofabrik Romania pbf | osm_highways / waterways / areas / points / routes .geojson |
| 2 | `fabdem.py` | FABDEM V1-2 (2 tiles out of the 2.1 GB zip, by byte ranges) | dem_fab.npz |
| 2c | `contours.py` | dem_fab.npz | contours.geojson |
| 3 | `detections.py` | Microsoft Road Detections ROU.parquet | ms_roads.geojson |
| 4 | `landcover.py` | ESA WorldCover 2021 (window of the remote COG) | worldcover.npz |
| 5 | `traces.py` | OSM API trackpoints (0.1 degree grid, busy cells split) | traces.npz |
| 6 | `graph.py` | osm_highways | edges.geojson (routable ways split at junctions) |
| 7 | `evidence.py` | edges + 2-5 | edges_evidence.geojson, evidence_summary.json |
| 7b | `score.mjs` (Node) | edges_evidence + core/scoring.js | edge_scores.json (exists, class, level, legal) |
| 8 | `build_tiles.py` | everything above | area.pmtiles (vector tiles z8-14) |
| 8b | `graph_pack.py` | edges_evidence + edge_scores | graph.json (routing graph for the phone) |
| 9 | `dem_tiles.py` | dem_fab.npz | dem.pmtiles (terrarium z8-12) |
| 9b | `../tools/samples.mjs` | graph.json, osm_points | samples.json (sample rides for review) |
| 10 | `pack.py` | area, dem, graph, samples | pack.json, copy in app/public/pack/ |

```
cd pipeline
curl -L -o ../data/raw/romania-latest.osm.pbf https://download.geofabrik.de/europe/romania-latest.osm.pbf
curl -L -o ../data/raw/ROU.parquet https://data.source.coop/nlebovits/microsoft-ml-road-detections/road-detections/by_country/country=ROU/ROU.parquet
uv run --with osmium python osm_extract.py
uv run --with rasterio --with numpy --with scipy python fabdem.py
uv run --with numpy --with scipy --with contourpy --with shapely python contours.py
uv run --with duckdb --with shapely python detections.py
uv run --with rasterio --with numpy python landcover.py
uv run --with numpy python traces.py        # slow (Cluj is dense); --from-cache builds traces.npz from pages so far
uv run python graph.py
uv run --with numpy --with scipy --with shapely python evidence.py
node score.mjs
uv run --with numpy --with shapely --with mapbox-vector-tile --with pmtiles python build_tiles.py
uv run python graph_pack.py
node ../tools/samples.mjs
uv run --with numpy --with scipy --with pillow --with pmtiles python dem_tiles.py
uv run python pack.py
```

## Publishing a new pack

The pack is not committed. It is a GitHub release asset that the Pages workflow copies into `dist/pack/`:

```
gh release create pack-<version> data/area/area.pmtiles data/area/dem.pmtiles data/area/graph.json data/area/samples.json data/area/pack.json --title "Area pack <version>" --notes "..."
```

The workflow always takes the newest release whose tag starts with `pack-`. Re-run the workflow after uploading.

## What the evidence means (and does not)

- **Grades** come from FABDEM, a bare-earth version of Copernicus GLO-30, smoothed over 30 m. They were tested on
  2026-10-23: main roads, which really stay under about 10-12 %, read p90 about 10 % and p99 15-20 %. Treat grades as
  approximate. A 30 m model cannot see a short steep pitch.
- **Seen from above** means Microsoft's model found a road there in Bing imagery (mostly 2020-2022). When it is
  missing, nothing is proven: forest canopy hides tracks, and the coverage has holes.
- **GPS traces** are public OSM trace points within 15 m. Every point counts toward its nearest edge only.
- **Forest** is the ESA WorldCover 2021 tree-cover share within 30 m.
