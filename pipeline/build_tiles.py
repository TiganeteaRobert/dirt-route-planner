"""Step 8: the area pack. Vector tiles z8-14 for DirtScout's own map and the evidence layers -> data/area/area.pmtiles.

Layers: tracks (every highway; routable edges carry their evidence), waterways, water, landcover, landuse, protected,
places, pois (gates, fords, peaks, springs, huts...), routes (hiking/MTB/cycling/horse relations), contours,
detections (Microsoft road detections).
    uv run --with numpy --with shapely --with mapbox-vector-tile --with pmtiles python pipeline/build_tiles.py
"""
import gzip
import json
import math
import os
import time
from collections import defaultdict

import numpy as np
import shapely
from mapbox_vector_tile import encode
from mapbox_vector_tile.encoder import on_invalid_geometry_make_valid
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

from common import AREA, BBOX, bbox_buffer, read_fc

ZMIN, ZMAX = 8, 14
EXTENT, BUF = 4096, 64
OUT = AREA / "area.pmtiles"
if __name__ == "__main__" and os.environ.get("DS_TILES_OUT"):          # write elsewhere (e.g. to compare builds)
    from pathlib import Path
    OUT = Path(os.environ["DS_TILES_OUT"])


def merc(lon, lat):
    lon, lat = np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
    r = np.radians(lat)
    return (lon + 180) / 360, (1 - np.log(np.tan(r) + 1 / np.cos(r)) / np.pi) / 2


def to_geom(g):
    t = g["type"]
    c = g["coordinates"]
    if t == "Point":
        x, y = merc(c[0], c[1])
        return shapely.points(float(x), float(y))
    if t == "LineString":
        a = np.asarray(c, dtype=float)
        return shapely.linestrings(np.column_stack(merc(a[:, 0], a[:, 1])))
    if t == "MultiLineString":
        return shapely.MultiLineString([np.column_stack(merc(np.asarray(l)[:, 0], np.asarray(l)[:, 1])) for l in c if len(l) > 1])
    if t == "MultiPolygon":
        polys = []
        for poly in c:
            rings = [np.column_stack(merc(np.asarray(r)[:, 0], np.asarray(r)[:, 1])) for r in poly if len(r) >= 4]
            if rings:
                polys.append(shapely.Polygon(rings[0], rings[1:]))
        g = shapely.multipolygons(polys) if polys else None
        return g if g is None or g.is_valid else shapely.make_valid(g)
    raise ValueError(t)


class Layer:
    def __init__(self, name, kind):
        self.name, self.kind = name, kind          # kind: line / poly / point
        self.geoms, self.props, self.minz = [], [], []

    def add(self, geom, props, minz):
        if geom is None or geom.is_empty:
            return
        self.geoms.append(geom)
        self.props.append({k: v for k, v in props.items() if v is not None and v != ""})
        self.minz.append(minz)

    def finish(self):
        self.geoms = np.asarray(self.geoms, dtype=object)
        self.minz = np.asarray(self.minz)
        self.tree = shapely.STRtree(self.geoms)
        return self


# ---------------------------------------------------------------- what goes in each layer

HW_MINZ = {"motorway": 8, "trunk": 8, "primary": 8, "secondary": 9, "tertiary": 10, "unclassified": 11, "track": 11,
           "residential": 12, "path": 12, "bridleway": 12, "living_street": 13, "service": 13, "road": 12,
           "footway": 13, "cycleway": 13, "steps": 14, "pedestrian": 13, "construction": 13, "raceway": 12,
           "detected": 12}


def motor_access(p):
    for k in ("motorcycle", "motor_vehicle", "vehicle", "access"):
        if p.get(k):
            return p[k]
    return None


def year(ts):
    return time.gmtime(ts).tm_year if ts else None


def tracks_layer():
    L = Layer("tracks", "line")
    seen_ways = set()
    score_path = AREA / "edge_scores.json"
    scores = json.loads(score_path.read_text()) if score_path.exists() else {}
    for f in read_fc(AREA / "edges_evidence.geojson"):
        p = f["properties"]
        sc = scores.get(p["id"])
        seen_ways.add(p["way"])
        hw = p["highway"]
        base = hw.replace("_link", "")
        tt = p.get("tracktype", "")
        L.add(to_geom(f["geometry"]), {
            "class": base, "link": 1 if hw.endswith("_link") else None, "id": p["id"], "name": p.get("name"),
            "ref": p.get("ref"), "tt": int(tt[5]) if tt.startswith("grade") and tt[5:6].isdigit() else None,
            "surf": p.get("surface"), "smooth": p.get("smoothness"), "sac": p.get("sac_scale"),
            "mtb": p.get("mtb:scale"), "vis": p.get("trail_visibility"), "acc": motor_access(p),
            "fwd": p.get("4wd_only"), "bridge": 1 if p.get("bridge") not in (None, "no") else None,
            "tunnel": 1 if p.get("tunnel") not in (None, "no") else None, "ford": 1 if p.get("ford") not in (None, "no") else None,
            "len": p["len"], "det": p.get("det"), "tp": p.get("tp"), "tn": p.get("tn"), "tree": p.get("tree"),
            "g50": p.get("g50"), "g100": p.get("g100"), "gall": p.get("gall"), "gdir": p.get("gdir"),
            "up": p.get("up"), "dn": p.get("dn"), "prot": 1 if p.get("prot") else None, "routes": p.get("routes"),
            "bar": ",".join(b.split("=")[1] for b in p.get("barriers", [])) or None,
            "ver": p.get("version"), "yr": year(p.get("ts")), "src": p.get("source"),
            "ex": sc[0] if sc else None, "risk": sc[1] if sc else None, "lvl": sc[2] if sc else None,
            "leg": sc[3] or None if sc else None,
        }, HW_MINZ.get(base, 13))
    for f in read_fc(AREA / "osm_highways.geojson"):          # the rest: footways, steps, motorways...
        p = f["properties"]
        if p["osm_id"] in seen_ways or p.get("highway") in ("proposed", "abandoned", "platform", "elevator", "corridor"):
            continue
        hw = p["highway"]
        base = hw.replace("_link", "")
        L.add(to_geom(f["geometry"]), {"class": base, "link": 1 if hw.endswith("_link") else None, "name": p.get("name"),
                                       "ref": p.get("ref"), "sac": p.get("sac_scale"), "acc": motor_access(p),
                                       "bridge": 1 if p.get("bridge") not in (None, "no") else None,
                                       "tunnel": 1 if p.get("tunnel") not in (None, "no") else None},
              HW_MINZ.get(base, 13))
    return L


def area_km2(g):
    b = g.bounds
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (b[1] + b[3]) / 2))))
    m_per_unit = 40075016.7 * math.cos(math.radians(lat))
    return g.area * m_per_unit ** 2 / 1e6


LANDCOVER = {"natural=wood": "forest", "landuse=forest": "forest", "natural=scrub": "scrub", "natural=heath": "scrub",
             "natural=grassland": "grass", "landuse=meadow": "grass", "landuse=farmland": "farm", "landuse=orchard": "farm",
             "landuse=vineyard": "farm", "natural=bare_rock": "rock", "natural=scree": "rock", "natural=cliff": "rock",
             "landuse=quarry": "quarry", "natural=wetland": "wetland"}
LANDUSE = {"landuse=residential": "residential", "landuse=industrial": "industrial", "landuse=military": "military",
           "landuse=landfill": "landfill", "leisure=park": "park"}
PROTECTED = {"boundary=protected_area", "boundary=national_park", "leisure=nature_reserve"}
WATER = {"natural=water", "landuse=reservoir", "landuse=basin"}


def polygon_layers():
    water, cover, use, prot = Layer("water", "poly"), Layer("landcover", "poly"), Layer("landuse", "poly"), Layer("protected", "poly")
    for f in read_fc(AREA / "osm_areas.geojson"):
        p = f["properties"]
        k = p["kind"]
        g = to_geom(f["geometry"])
        if g is None:
            continue
        km2 = area_km2(g)
        if k in WATER or k.startswith("water="):
            water.add(g, {"name": p.get("name"), "class": p.get("water") or k.split("=")[1]},
                      8 if km2 > 1 else 10 if km2 > 0.1 else 12)
        elif k in LANDCOVER:
            cover.add(g, {"class": LANDCOVER[k]}, 9 if km2 > 5 else 11 if km2 > 0.2 else 12)
        elif k in LANDUSE:
            use.add(g, {"class": LANDUSE[k], "name": p.get("name")}, 10 if km2 > 0.5 else 12)
        elif k in PROTECTED:
            prot.add(g, {"name": p.get("name"), "class": k.split("=")[1], "title": p.get("protection_title")}, 8)
    return [water, cover, use, prot]


WATERWAY_MINZ = {"river": 9, "canal": 11, "stream": 12, "brook": 12, "ditch": 13, "drain": 13}


def waterways_layer():
    L = Layer("waterways", "line")
    for f in read_fc(AREA / "osm_waterways.geojson"):
        p = f["properties"]
        L.add(to_geom(f["geometry"]), {"class": p["waterway"], "name": p.get("name"),
                                       "intermittent": 1 if p.get("intermittent") == "yes" else None},
              WATERWAY_MINZ.get(p["waterway"], 13))
    return L


PLACE_MINZ = {"city": 8, "town": 8, "village": 10, "suburb": 11, "hamlet": 12, "locality": 13, "isolated_dwelling": 14}
POI_MINZ = {"natural=peak": 11, "natural=saddle": 12, "mountain_pass=yes": 12, "amenity=shelter": 12,
            "tourism=alpine_hut": 12, "tourism=wilderness_hut": 12, "amenity=fuel": 12, "natural=spring": 13,
            "natural=cave_entrance": 13, "natural=waterfall": 13, "waterway=waterfall": 13, "tourism=viewpoint": 13,
            "tourism=camp_site": 13, "waterway=dam": 13, "waterway=weir": 14, "amenity=drinking_water": 14,
            "amenity=parking": 14, "amenity=hunting_stand": 14, "tourism=picnic_site": 14, "natural=rock": 14}


def point_layers():
    places, pois = Layer("places", "point"), Layer("pois", "point")
    for f in read_fc(AREA / "osm_points.geojson"):
        p = f["properties"]
        k = p["kind"]
        g = to_geom(f["geometry"])
        if k.startswith("place="):
            cls = k.split("=")[1]
            if p.get("name"):
                places.add(g, {"class": cls, "name": p["name"], "pop": int(p["population"]) if str(p.get("population", "")).isdigit() else None},
                           PLACE_MINZ.get(cls, 13))
        else:
            if k.startswith("barrier=") or k.startswith("ford="):
                minz = 13
            else:
                minz = POI_MINZ.get(k)
                if minz is None:
                    continue
            ele = p.get("ele")
            try:
                ele = round(float(str(ele).replace("m", "").strip())) if ele else None
            except ValueError:
                ele = None
            pois.add(g, {"class": k.split("=")[0], "kind": k.split("=")[1], "name": p.get("name"), "ele": ele,
                         "id": p["osm_id"]}, minz)
    return [places, pois]


def routes_layer():
    L = Layer("routes", "line")
    for f in read_fc(AREA / "osm_routes.geojson"):
        p = f["properties"]
        L.add(to_geom(f["geometry"]), {"route": p.get("route"), "name": p.get("name"), "ref": p.get("ref"),
                                       "network": p.get("network"), "colour": p.get("colour"),
                                       "osmc": p.get("osmc:symbol"), "id": p["osm_id"]}, 10)
    return L


def contours_layer():
    L = Layer("contours", "line")
    for f in read_fc(AREA / "contours.geojson"):
        p = f["properties"]
        L.add(to_geom(f["geometry"]), {"ele": p["ele"], "idx": 1 if p["index"] else None}, 10 if p["index"] else 12)
    return L


def detections_layer():
    L = Layer("detections", "line")
    for f in read_fc(AREA / "ms_roads.geojson"):
        L.add(to_geom(f["geometry"]), {"w": f["properties"].get("width")}, 12)
    return L


# ---------------------------------------------------------------- tiling

def tile_layer(layer, z, x, y, zmax=ZMAX):
    n = 2 ** z
    pad = BUF / EXTENT / n
    box = shapely.box(x / n - pad, y / n - pad, (x + 1) / n + pad, (y + 1) / n + pad)
    idx = layer.tree.query(box)
    idx = idx[layer.minz[idx] <= z]
    if not len(idx):
        return []
    geoms = shapely.transform(layer.geoms[idx], lambda c: (c * n - [x, y]) * EXTENT)
    if layer.kind != "point":
        geoms = shapely.clip_by_rect(geoms, -BUF, -BUF, EXTENT + BUF, EXTENT + BUF)
        tol = 1.5 if z == zmax else 2.5
        geoms = shapely.simplify(geoms, tol, preserve_topology=layer.kind == "poly")
    feats = []
    for g, i in zip(geoms, idx):
        if g is None or g.is_empty:
            continue
        if layer.kind == "poly":
            g = shapely.get_parts(g)
            g = [p for p in g if p.geom_type in ("Polygon", "MultiPolygon") and p.area >= 6]
            if not g:
                continue
            g = shapely.multipolygons(g) if len(g) > 1 else g[0]
        elif layer.kind == "line":
            parts = [p for p in shapely.get_parts(g) if p.geom_type == "LineString" and p.length >= 2]
            if not parts:
                continue
            g = shapely.multilinestrings(parts) if len(parts) > 1 else parts[0]
        else:
            px, py = g.x, g.y
            if not (0 <= px < EXTENT and 0 <= py < EXTENT):
                continue
        feats.append({"geometry": g, "properties": layer.props[i]})
    return feats


def write_pmtiles(layers, out, zmin, zmax, bounds, name, attribution, bbox=BBOX, t0=None):
    """Vector tiles zmin-zmax of the finished layers over bounds (w, s, e, n) -> a PMTiles file (or a BytesIO).
    Returns (bytes per zoom, z-max bytes per layer, tile count)."""
    t0 = t0 or time.time()
    w, s, e, n = bounds
    tiles = []
    for z in range(zmin, zmax + 1):
        x0, y0 = merc(w, n)
        x1, y1 = merc(e, s)
        k = 2 ** z
        for ty in range(int(y0 * k), int(y1 * k) + 1):
            for tx in range(int(x0 * k), int(x1 * k) + 1):
                tiles.append((zxy_to_tileid(z, tx, ty), z, tx, ty))
    tiles.sort()
    sizes = defaultdict(int)
    layer_bytes = defaultdict(int)
    opts = {"extents": EXTENT, "y_coord_down": True, "on_invalid_geometry": on_invalid_geometry_make_valid}
    fh = open(out, "wb") if not hasattr(out, "write") else out
    try:
        writer = Writer(fh)
        for i, (tid, z, x, y) in enumerate(tiles):
            data_layers = []
            for L in layers:
                feats = tile_layer(L, z, x, y, zmax)
                if feats:
                    data_layers.append({"name": L.name, "features": feats})
            if not data_layers:
                continue
            raw = encode(data_layers, default_options=opts)
            if z == zmax:
                for dl in data_layers:
                    layer_bytes[dl["name"]] += len(encode([dl], default_options=opts))
            data = gzip.compress(raw, compresslevel=9, mtime=0)
            sizes[z] += len(data)
            writer.write_tile(tid, data)
            if i % 300 == 0:
                print(f"  tile {i}/{len(tiles)} z{z} ({time.time() - t0:.0f} s)", flush=True)
        cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
        header = {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP, "min_zoom": zmin, "max_zoom": zmax,
                  "min_lon_e7": int(w * 1e7), "min_lat_e7": int(s * 1e7), "max_lon_e7": int(e * 1e7),
                  "max_lat_e7": int(n * 1e7), "center_zoom": 10, "center_lon_e7": int(cx * 1e7), "center_lat_e7": int(cy * 1e7)}
        fields = {}
        for L in layers:
            keys = {}
            for p in L.props:
                for kk, vv in p.items():
                    keys.setdefault(kk, "Number" if isinstance(vv, (int, float)) else "String")
            fields[L.name] = keys
        metadata = {
            "name": name, "format": "pbf", "version": time.strftime("%Y-%m-%d"), "attribution": attribution,
            "bbox": list(bbox),
            "vector_layers": [{"id": L.name, "fields": fields[L.name], "minzoom": int(L.minz.min()), "maxzoom": zmax}
                              for L in layers],
        }
        writer.finalize(header, metadata)
    finally:
        if fh is not out:
            fh.close()
    return sizes, layer_bytes, len(tiles)


def main():
    t0 = time.time()
    layers = [tracks_layer(), waterways_layer(), *polygon_layers(), *point_layers(), routes_layer(),
              contours_layer(), detections_layer()]
    for L in layers:
        L.finish()
        print(f"{L.name:11s} {len(L.geoms):7d} features", flush=True)
    print(f"loaded in {time.time() - t0:.0f} s", flush=True)
    sizes, layer_bytes, n_tiles = write_pmtiles(
        layers, OUT, ZMIN, ZMAX, bbox_buffer(BBOX, 1000), "DirtScout area pack",
        "© OpenStreetMap contributors (ODbL); road detections © Microsoft (ODbL); "
        "WorldCover © ESA 2021 (CC BY 4.0); elevation and contours: FABDEM V1-2 © Univ. of Bristol "
        "(CC BY-NC-SA 4.0)", t0=t0)
    total = OUT.stat().st_size
    print("bytes per zoom:", {z: f"{v / 1e6:.1f} MB" for z, v in sorted(sizes.items())})
    print("z14 bytes per layer (uncompressed):", {k: f"{v / 1e6:.1f} MB" for k, v in sorted(layer_bytes.items(), key=lambda kv: -kv[1])})
    print(f"{OUT.name}: {total / 1e6:.1f} MB, {n_tiles} tiles, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
