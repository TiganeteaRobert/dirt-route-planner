"""Step 3: Microsoft Road Detections (ODbL; roads seen by Microsoft's model in Bing imagery, mostly 2020-2022) inside
the area, from the Romania GeoParquet in data/raw -> data/area/ms_roads.geojson.
Absence proves nothing (holes by design, canopy hides tracks); presence = "visible from above".
    uv run --with duckdb --with shapely python pipeline/detections.py
"""
import time

import duckdb
import shapely

from common import AREA, BBOX, RAW, bbox_buffer, write_fc

PARQUET = RAW / "ROU.parquet"


def main():
    t0 = time.time()
    w, s, e, n = bbox_buffer(BBOX, 1000)
    con = duckdb.connect()
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{PARQUET.as_posix()}')").fetchall()]
    print("columns:", cols)
    rows = con.execute(f"""
        SELECT width_meters, geometry FROM read_parquet('{PARQUET.as_posix()}')
        WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}
    """).fetchall()
    feats = []
    for width, wkb in rows:
        g = shapely.from_wkb(bytes(wkb))
        if g.is_empty:
            continue
        parts = [g] if g.geom_type == "LineString" else list(getattr(g, "geoms", []))
        for p in parts:
            if p.geom_type != "LineString" or len(p.coords) < 2:
                continue
            feats.append({"type": "Feature", "properties": {"width": round(float(width), 1) if width is not None else None},
                          "geometry": {"type": "LineString",
                                       "coordinates": [[round(x, 7), round(y, 7)] for x, y, *_ in p.coords]}})
    write_fc(AREA / "ms_roads.geojson", feats)
    print(f"detections: {len(feats)} lines from {len(rows)} rows, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
