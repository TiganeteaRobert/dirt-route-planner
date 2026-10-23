"""Shared settings for the area-pack pipeline (run on the PC with uv; see pipeline/README.md)."""
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
AREA = ROOT / "data" / "area"
AREA.mkdir(parents=True, exist_ok=True)
# DS_AI=1: graph.py, evidence.py, score.mjs and graph_pack.py build the private graph with the AI-found tracks in
# data/ai/ instead (never published as it is: derived from Esri imagery). Everything else reads data/area/.
EDGES = ROOT / "data" / "ai" if os.environ.get("DS_AI") else AREA
EDGES.mkdir(parents=True, exist_ok=True)

# Riding area [west, south, east, north] - keep in sync with DEFAULT_AREA in app/src/config.js.
BBOX = (22.85, 46.28, 23.80, 46.82)
UA = "DirtScout-pipeline/0.1 (personal dirt-bike planner; github.com/TiganeteaRobert/dirt-route-planner)"


def bbox_buffer(b, metres):
    d_lat = metres / 111320.0
    d_lon = d_lat / math.cos(math.radians((b[1] + b[3]) / 2))
    return (b[0] - d_lon, b[1] - d_lat, b[2] + d_lon, b[3] + d_lat)


def haversine(a, b):
    r = 6371008.8
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def write_fc(path, features):
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"type":"FeatureCollection","features":[\n')
        for i, feat in enumerate(features):
            f.write(("," if i else "") + json.dumps(feat, ensure_ascii=False, separators=(",", ":")) + "\n")
        f.write("]}\n")


def read_fc(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)["features"]
