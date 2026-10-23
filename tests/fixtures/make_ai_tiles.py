"""Writes tests/fixtures/ai_tiles.pmtiles: the two synthetic AI lines of tests/fixtures/aibundle.mjs as the vector tiles
the app draws (layer "ai", z12-14). Synthetic data only. Run again if the fixture lines change:
    uv run --with numpy --with shapely --with mapbox-vector-tile --with pmtiles python tests/fixtures/make_ai_tiles.py
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "pipeline"))
from build_tiles import Layer, to_geom, write_pmtiles  # noqa: E402

NODES = [[23.0880, 46.6700], [23.0920, 46.6705], [23.0950, 46.6720], [23.0975, 46.6740], [23.1000, 46.6748]]
LINES = [  # (from node, to node, properties) - keep in step with EDGES in aibundle.mjs
    (2, 3, {"id": "ai0", "len": 300, "aic": 0.82, "conf": 0.82, "risk": 1, "ex": 55}),
    (3, 4, {"id": "ai1", "len": 210, "aic": 0.41, "conf": 0.41, "risk": 2, "ex": 45}),
]


def main():
    L = Layer("ai", "line")
    for a, b, p in LINES:
        L.add(to_geom({"type": "LineString", "coordinates": [NODES[a], NODES[b]]}),
              {"class": "ai", **p, "det": 0, "tp": 0, "tn": 0, "tree": 0.1, "g100": 9, "up": 12, "dn": 3, "crop": 0,
               "grass": 0.9, "lvl": 0}, 12)
    L.finish()
    out = HERE / "ai_tiles.pmtiles"
    write_pmtiles([L], out, 12, 14, (23.08, 46.66, 23.11, 46.68), "DirtScout AI tracks (test)", "synthetic test data",
                  bbox=(23.08, 46.66, 23.11, 46.68))
    print("wrote", out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
