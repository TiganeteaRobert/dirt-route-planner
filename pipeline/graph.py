"""Step 6: the routable graph. Ways a motorcycle might use (tracks, paths and bridleways with their flags, minor and
major roads; no motorways, footways, steps or cycleways) split at every junction into edges, plus the roads Microsoft's
model saw from above that OSM does not have (class "detected", from detected_only.py). A detected road whose end
comes within 30 m of an OSM edge is joined to it there (the OSM edge is split at that point); ends of detected roads
within 12 m of each other are joined too.
DS_AI=1: also the tracks our own model found (class "ai", data/ai/ai_lines.geojson from ai_vectorize.py), joined the
same way -> data/ai/edges.geojson, the private graph.
-> data/area/edges.geojson (one LineString per edge: from/to node, length, the way's tags, version, timestamp,
   gates or other barriers on it). New nodes have negative ids.
    uv run --with numpy --with shapely python pipeline/graph.py
"""
import itertools
import math
import os
import time
from collections import Counter, defaultdict

import numpy as np
import shapely
from shapely.ops import substring

from common import AREA, EDGES, haversine, read_fc, write_fc

ROUTABLE = {
    "track", "path", "bridleway", "unclassified", "residential", "service", "tertiary", "tertiary_link",
    "secondary", "secondary_link", "primary", "primary_link", "trunk", "trunk_link", "living_street", "road",
}
KEEP_TAGS = (
    "highway", "name", "ref", "tracktype", "surface", "smoothness", "width", "4wd_only", "incline", "access",
    "motor_vehicle", "motorcycle", "vehicle", "motorcar", "foot", "bicycle", "horse", "sac_scale", "mtb:scale",
    "mtb:scale:uphill", "trail_visibility", "source", "check_date", "bridge", "tunnel", "ford", "oneway",
    "seasonal", "service", "informal", "abandoned", "disused", "construction",
)
LON0, LAT0 = 23.3, 46.55
KY = 111132.92 - 559.82 * math.cos(math.radians(2 * LAT0))
KX = 111412.84 * math.cos(math.radians(LAT0))
SNAP_OSM, SNAP_END, NEAR_NODE = 30.0, 12.0, 8.0


def to_m(c):
    a = np.asarray(c, dtype=float)
    return np.column_stack([(a[:, 0] - LON0) * KX, (a[:, 1] - LAT0) * KY])


def to_ll(xy):
    return [[round(x / KX + LON0, 7), round(y / KY + LAT0, 7)] for x, y in xy]


def length_ll(c):
    return sum(haversine(c[k - 1], c[k]) for k in range(1, len(c)))


def osm_edges():
    ways = [f for f in read_fc(AREA / "osm_highways.geojson") if f["properties"].get("highway") in ROUTABLE]
    barriers = {f["properties"]["osm_id"]: f["properties"]["kind"]
                for f in read_fc(AREA / "osm_points.geojson")
                if f["properties"]["kind"].startswith(("barrier=", "ford="))}
    use = Counter()
    for w in ways:
        nodes = w["properties"]["nodes"]
        use.update(nodes)
        use[nodes[0]] += 1                 # way ends are always edge ends
        use[nodes[-1]] += 1
    edges = []
    for w in ways:
        p = w["properties"]
        nodes, coords = p["nodes"], w["geometry"]["coordinates"]
        tags = {k: p[k] for k in KEEP_TAGS if k in p}
        start, seq = 0, 0
        for i in range(1, len(nodes)):
            if use[nodes[i]] < 2 and i < len(nodes) - 1:
                continue
            part = coords[start:i + 1]
            on = [(k - start, barriers[n]) for k, n in enumerate(nodes[start:i + 1], start) if n in barriers]
            edges.append({"type": "Feature",
                          "properties": {"id": f"{p['osm_id']}:{seq}", "way": p["osm_id"], "from": nodes[start],
                                         "to": nodes[i], "len": round(length_ll(part), 1), **tags,
                                         "version": p.get("version"), "ts": p.get("ts"), "_bar": on},
                          "geometry": {"type": "LineString", "coordinates": part}})
            start, seq = i, seq + 1
    return edges


def detected_props(k, f):
    return {"id": f"d{k}", "way": None, "highway": "detected", "source": "Microsoft Road Detections",
            "mswidth": f["properties"].get("w")}


def ai_props(k, f):
    p = f["properties"]
    return {"id": f"ai{k}", "way": None, "highway": "ai", "source": "DirtScout AI (Esri imagery)",
            "aic": p.get("score", p.get("conf")), "aiconf": p.get("conf"), "ailine": p.get("line"),
            "aicrop": p.get("crop"), "aigrass": p.get("grass")}


def add_lines(edges, det, make_props):
    """Joins lines that are not in OSM to the network (see the module notes); make_props(k, feature) -> their tags."""
    if not det:
        return edges, 0, 0
    geom = [shapely.linestrings(to_m(e["geometry"]["coordinates"])) for e in edges]
    tree = shapely.STRtree(geom)
    splits = defaultdict(list)              # OSM edge index -> [(position along it, node id)]
    ends = defaultdict(list)                # free ends of added lines by 12 m grid cell: [(point, node id)]
    new_id = itertools.count(-1, -1)

    def snap(pt):
        i = int(tree.nearest(pt))
        if geom[i].distance(pt) <= SNAP_OSM:
            g, p = geom[i], edges[i]["properties"]
            s = g.project(pt)
            if s < NEAR_NODE:
                return p["from"], g.interpolate(0)
            if s > g.length - NEAR_NODE:
                return p["to"], g.interpolate(g.length)
            for s2, nid in splits[i]:
                if abs(s2 - s) < NEAR_NODE:
                    return nid, g.interpolate(s2)
            nid = next(new_id)
            splits[i].append((s, nid))
            return nid, g.interpolate(s)
        cx, cy = int(pt.x // SNAP_END), int(pt.y // SNAP_END)     # a grid, not a scan of every end so far (n^2)
        near = [(q.distance(pt), q, nid) for gx in (cx - 1, cx, cx + 1) for gy in (cy - 1, cy, cy + 1)
                for q, nid in ends[(gx, gy)]]
        near = [x for x in near if x[0] <= SNAP_END]
        if near:
            _, q, nid = min(near, key=lambda x: x[0])
            return nid, q
        nid = next(new_id)
        ends[(cx, cy)].append((pt, nid))
        return nid, None

    det_edges = []
    for k, f in enumerate(det):
        xy = to_m(f["geometry"]["coordinates"])
        na, pa = snap(shapely.Point(xy[0]))
        nb, pb = snap(shapely.Point(xy[-1]))
        pts = ([list(pa.coords)[0]] if pa is not None else []) + xy.tolist() + ([list(pb.coords)[0]] if pb is not None else [])
        c = to_ll(pts)
        det_edges.append({"type": "Feature",
                          "properties": {**make_props(k, f), "from": na, "to": nb, "len": round(length_ll(c), 1), "_bar": []},
                          "geometry": {"type": "LineString", "coordinates": c}})

    # cut the OSM edges where detected roads join them
    out = []
    for i, e in enumerate(edges):
        if i not in splits:
            out.append(e)
            continue
        g, p = geom[i], e["properties"]
        cuts = sorted(splits[i])
        bounds = [0.0] + [s for s, _ in cuts] + [g.length]
        nodes = [p["from"]] + [n for _, n in cuts] + [p["to"]]
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(np.asarray(g.coords), axis=0).T))])
        for k in range(len(bounds) - 1):
            piece = substring(g, bounds[k], bounds[k + 1])
            c = to_ll(piece.coords)
            pc = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(np.asarray(piece.coords), axis=0).T))]) + bounds[k]
            # barriers by their place along the edge, renumbered to the piece's own vertices (it may be split again)
            bar = [(int(np.argmin(np.abs(pc - cum[vi]))), kind) for vi, kind in p["_bar"]
                   if bounds[k] - 0.5 <= cum[vi] <= bounds[k + 1] + 0.5]
            out.append({"type": "Feature",
                        "properties": {**p, "id": f"{p['id']}.{k}", "from": nodes[k], "to": nodes[k + 1],
                                       "len": round(length_ll(c), 1), "_bar": bar},
                        "geometry": {"type": "LineString", "coordinates": c}})
    n_split = len(splits)
    return out + det_edges, len(det_edges), n_split


def main():
    t0 = time.time()
    edges = osm_edges()
    det = read_fc(AREA / "ms_not_in_osm.geojson") if (AREA / "ms_not_in_osm.geojson").exists() else []
    edges, n_det, n_split = add_lines(edges, det, detected_props)
    if os.environ.get("DS_AI"):
        # lines under the app slider's floor (0.3) could never be shown or routed on: left out
        ai = [f for f in read_fc(EDGES / "ai_lines.geojson") if (f["properties"].get("score") or 0) >= 0.3]
        edges, n_ai, n_split_ai = add_lines(edges, ai, ai_props)
        print(f"AI tracks: {n_ai} added, {n_split_ai} edges split to join them")
    for e in edges:
        bar = e["properties"].pop("_bar")
        if bar:
            e["properties"]["barriers"] = sorted({kind for _, kind in bar})
    write_fc(EDGES / "edges.geojson", edges)
    km = Counter()
    for e in edges:
        km[e["properties"]["highway"]] += e["properties"]["len"] / 1000
    print(f"{len(edges)} edges, {sum(km.values()):.0f} km, {n_det} detected roads added, {n_split} OSM edges split "
          f"to join them, {time.time() - t0:.0f} s")
    for k, v in km.most_common():
        print(f"  {k:16s} {v:8.0f} km")
    print(f"  edges with a barrier/ford: {sum(1 for e in edges if 'barriers' in e['properties'])}")


if __name__ == "__main__":
    main()
