"""Step 3b: roads Microsoft's model saw in Bing imagery that OpenStreetMap does not have - the pieces of the detections
more than 20 m from every OSM highway, at least 50 m long -> data/area/ms_not_in_osm.geojson (with the detection's
width). graph.py turns them into edges of class "detected" joined to the OSM network.
    uv run --with numpy --with shapely python pipeline/detected_only.py
"""
import json
import math
import time

import numpy as np
import shapely

from common import AREA, read_fc

LON0, LAT0 = 23.3, 46.55
KY = 111132.92 - 559.82 * math.cos(math.radians(2 * LAT0))
KX = 111412.84 * math.cos(math.radians(LAT0))
GAP = 20.0          # m: closer than this to an OSM way = already mapped
MIN_LEN = 50.0      # m: shorter leftovers are noise at junctions


def to_m(c):
    a = np.asarray(c, dtype=float)
    return np.column_stack([(a[:, 0] - LON0) * KX, (a[:, 1] - LAT0) * KY])


def to_ll(xy):
    return [[round(x / KX + LON0, 6), round(y / KY + LAT0, 6)] for x, y in xy]


def main():
    t0 = time.time()
    hw = [shapely.linestrings(to_m(f["geometry"]["coordinates"])) for f in read_fc(AREA / "osm_highways.geojson")]
    tree = shapely.STRtree(hw)
    feats, km_all = [], 0.0
    for f in read_fc(AREA / "ms_roads.geojson"):
        g = shapely.linestrings(to_m(f["geometry"]["coordinates"]))
        km_all += g.length / 1000
        near = tree.query(g, predicate="dwithin", distance=GAP)
        rest = g.difference(shapely.union_all([hw[i].buffer(GAP, quad_segs=4) for i in near])) if len(near) else g
        for part in shapely.get_parts(rest):
            if part.geom_type == "LineString" and part.length >= MIN_LEN:
                feats.append({"type": "Feature", "properties": {"len": round(part.length), "w": f["properties"].get("width")},
                              "geometry": {"type": "LineString", "coordinates": to_ll(part.coords)}})
    with open(AREA / "ms_not_in_osm.geojson", "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh)
    km = sum(x["properties"]["len"] for x in feats) / 1000
    print(f"detections {km_all:.0f} km; not in OSM: {len(feats)} pieces, {km:.0f} km ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
