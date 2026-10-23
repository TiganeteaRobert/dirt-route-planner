"""Step 1: one pass over the Geofabrik Romania extract, keeping what DirtScout needs inside the riding area (+1 km).

Writes data/area/osm_highways.geojson (ways with all tags, node ids, version, timestamp), osm_waterways.geojson,
osm_areas.geojson (water, forest, villages, protected areas...), osm_points.geojson (places, gates, peaks...) and
osm_routes.geojson (hiking / MTB / cycling / horse route relations).
    uv run --with osmium python pipeline/osm_extract.py
"""
import json
import time

import osmium
from osmium.filter import KeyFilter

from common import AREA, BBOX, RAW, bbox_buffer, write_fc

PBF = RAW / "romania-latest.osm.pbf"
W, S, E, N = bbox_buffer(BBOX, 1000)
NEAR = 0.25          # degrees: a way whose first node is further out than this cannot reach the area


def inside(lon, lat):
    return W <= lon <= E and S <= lat <= N


def near(lon, lat):
    return W - NEAR <= lon <= E + NEAR and S - NEAR <= lat <= N + NEAR


AREA_KINDS = {
    "natural": {"water", "wood", "scrub", "grassland", "heath", "bare_rock", "scree", "wetland", "cliff"},
    "landuse": {"forest", "reservoir", "residential", "quarry", "meadow", "farmland", "orchard", "vineyard",
                "industrial", "military", "landfill", "basin"},
    "boundary": {"protected_area", "national_park"},
    "leisure": {"nature_reserve", "park"},
    "water": None,
}
POINT_KINDS = {
    "place": {"city", "town", "village", "hamlet", "locality", "isolated_dwelling", "suburb"},
    "barrier": {"gate", "lift_gate", "swing_gate", "chain", "bollard", "block", "kissing_gate", "stile",
                "cattle_grid", "entrance", "turnstile", "log", "jersey_barrier", "toll_booth"},
    "natural": {"peak", "spring", "saddle", "cave_entrance", "waterfall", "rock"},
    "amenity": {"shelter", "drinking_water", "fuel", "parking", "hunting_stand"},
    "tourism": {"viewpoint", "alpine_hut", "wilderness_hut", "camp_site", "picnic_site"},
    "ford": None,
    "mountain_pass": None,
    "waterway": {"waterfall", "dam", "weir"},
}
ROUTES = {"hiking", "mtb", "bicycle", "horse", "foot"}
WATERWAYS = {"river", "stream", "canal", "ditch", "drain", "brook"}


def kind_of(tags, table):
    for k, vals in table.items():
        v = tags.get(k)
        if v is not None and (vals is None or v in vals):
            return k, v
    return None


def meta(o):
    return {"version": o.version, "ts": int(o.timestamp.timestamp()) if o.timestamp else None}


def main():
    t0 = time.time()
    highways, waterways, areas, points, routes = [], [], [], [], []
    hw_geom = {}
    keys = ("highway", "waterway", "natural", "landuse", "boundary", "leisure", "water", "place", "barrier",
            "amenity", "tourism", "ford", "mountain_pass", "route")
    fp = (osmium.FileProcessor(str(PBF))
          .with_locations()
          .with_areas(KeyFilter("natural", "landuse", "boundary", "leisure", "water"))
          .with_filter(KeyFilter(*keys)))
    n_seen = 0
    for o in fp:
        n_seen += 1
        if o.is_node():
            loc = o.location
            if not loc.valid() or not inside(loc.lon, loc.lat):
                continue
            tags = dict(o.tags)
            k = kind_of(tags, POINT_KINDS)
            if not k:
                continue
            points.append({"type": "Feature", "id": o.id,
                           "properties": {"osm_id": o.id, "kind": f"{k[0]}={k[1]}", **tags, **meta(o)},
                           "geometry": {"type": "Point", "coordinates": [round(loc.lon, 7), round(loc.lat, 7)]}})
        elif o.is_way():
            nodes = o.nodes
            if len(nodes) < 2:
                continue
            n0 = nodes[0].location
            if not n0.valid() or not near(n0.lon, n0.lat):
                continue
            tags = dict(o.tags)
            hw, ww = tags.get("highway"), tags.get("waterway")
            if not hw and ww not in WATERWAYS:
                continue
            coords, refs = [], []
            for n in nodes:
                if n.location.valid():
                    coords.append([round(n.lon, 7), round(n.lat, 7)])
                    refs.append(n.ref)
            if len(coords) < 2 or not any(inside(c[0], c[1]) for c in coords):
                continue
            if hw:
                if tags.get("area") == "yes":
                    continue
                highways.append({"type": "Feature", "id": o.id,
                                 "properties": {"osm_id": o.id, **tags, **meta(o), "nodes": refs},
                                 "geometry": {"type": "LineString", "coordinates": coords}})
                hw_geom[o.id] = coords
            else:
                waterways.append({"type": "Feature", "id": o.id, "properties": {"osm_id": o.id, **tags, **meta(o)},
                                  "geometry": {"type": "LineString", "coordinates": coords}})
        elif o.is_relation():
            tags = dict(o.tags)
            if tags.get("type") != "route" or tags.get("route") not in ROUTES:
                continue
            lines = [hw_geom[m.ref] for m in o.members if m.type == "w" and m.ref in hw_geom]
            if lines:
                routes.append({"type": "Feature", "id": o.id,
                               "properties": {"osm_id": o.id, **tags, **meta(o), "members_in_area": len(lines),
                                              "ways": [m.ref for m in o.members if m.type == "w" and m.ref in hw_geom]},
                               "geometry": {"type": "MultiLineString", "coordinates": lines}})
        elif o.is_area():
            tags = dict(o.tags)
            k = kind_of(tags, AREA_KINDS)
            if not k:
                continue
            polys = []
            hit = False
            for outer in o.outer_rings():
                ring = [[round(n.lon, 7), round(n.lat, 7)] for n in outer]
                if not hit and any(inside(c[0], c[1]) for c in ring[:: max(1, len(ring) // 400)]):
                    hit = True
                holes = [[[round(n.lon, 7), round(n.lat, 7)] for n in inner] for inner in o.inner_rings(outer)]
                polys.append([ring, *holes])
            if not hit or not polys:
                continue
            areas.append({"type": "Feature", "id": o.id,
                          "properties": {"osm_id": o.orig_id(), "from_way": o.from_way(), "kind": f"{k[0]}={k[1]}",
                                         **tags, **meta(o)},
                          "geometry": {"type": "MultiPolygon", "coordinates": polys}})
    for name, feats in (("highways", highways), ("waterways", waterways), ("areas", areas), ("points", points),
                        ("routes", routes)):
        write_fc(AREA / f"osm_{name}.geojson", feats)
        print(f"{name:10s} {len(feats):7d}")
    with open(AREA / "osm_extract.json", "w") as f:
        json.dump({"source": PBF.name, "source_mtime": int(PBF.stat().st_mtime), "bbox": BBOX,
                   "built": int(time.time())}, f)
    print(f"objects passed to Python: {n_seen}, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
