"""Step 7: evidence per edge, from points every 10 m along it.
  e0/e1, up/dn       start/end elevation, total climb and descent (m) from FABDEM (bare-earth Copernicus GLO-30,
                     forests and buildings removed), profile smoothed over 30 m (sigma)
  g50/g100, gdir     steepest grade (%) over 50/100 m windows (null when the edge is shorter, or a bridge/tunnel);
                     gdir +1 = the steepest stretch climbs in the edge's direction, -1 = against it.
                     Main roads (real grades < ~10-12 %) read p90 ~10 %, p99 ~15-20 % with this method, so grades
                     are approximate, and a 30 m model cannot see short pitches at all (tested 2026-10-23).
  det                share of the edge within 10 m of a Microsoft road detection (seen from above)
  tp, tn             OSM public GPS trace points matched to this edge (each point to its nearest edge within 15 m),
                     and distinct identifiable traces among them
  tree               mean tree-cover share within 30 m (ESA WorldCover 2021)
  prot               protected area(s) the edge crosses
  routes             hiking / mtb / bicycle / horse route relations using the edge's way
-> data/area/edges_evidence.geojson and evidence_summary.json (DS_AI=1: data/ai/, the private graph)
    uv run --with numpy --with scipy --with shapely python pipeline/evidence.py
"""
import json
import math
import time
from collections import defaultdict

import numpy as np
import shapely
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree

from common import AREA, EDGES, read_fc, write_fc
from copdem import CopDem

STEP = 10.0
LON0, LAT0 = 23.3, 46.55
KY = 111132.92 - 559.82 * math.cos(math.radians(2 * LAT0)) + 1.175 * math.cos(math.radians(4 * LAT0))
KX = 111412.84 * math.cos(math.radians(LAT0)) - 93.5 * math.cos(math.radians(3 * LAT0))


def local(lon, lat):
    return (np.asarray(lon) - LON0) * KX, (np.asarray(lat) - LAT0) * KY


def sample_edges(edges):
    lons, lats, offs, spacing = [], [], [0], []
    for e in edges:
        c = np.asarray(e["geometry"]["coordinates"], dtype=float)
        x, y = local(c[:, 0], c[:, 1])
        seg = np.hypot(np.diff(x), np.diff(y))
        keep = np.concatenate([[True], seg > 0.01])
        c, seg = c[keep], seg[seg > 0.01]
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        length = cum[-1]
        n = max(2, int(math.ceil(length / STEP)) + 1)
        d = np.linspace(0, length, n)
        lons.append(np.interp(d, cum, c[:, 0]) if len(c) > 1 else np.full(n, c[0, 0]))
        lats.append(np.interp(d, cum, c[:, 1]) if len(c) > 1 else np.full(n, c[0, 1]))
        offs.append(offs[-1] + n)
        spacing.append(length / (n - 1) if n > 1 else 0.0)
    return np.concatenate(lons), np.concatenate(lats), np.asarray(offs), np.asarray(spacing)


class FabDem(CopDem):
    def __init__(self):
        d = np.load(AREA / "dem_fab.npz")
        self.e = d["elev"]
        self.a, _, self.c, _, self.ee, self.f = d["transform"]


SMOOTH = 30.0


def profile_stats(e, d, flat=False):
    if d > 0 and len(e) > 3:
        e = gaussian_filter1d(e.astype(float), SMOOTH / d, mode="nearest")
    if flat:                                    # bridge / tunnel: the ground below says nothing about the deck
        e = np.linspace(e[0], e[-1], len(e))
    diffs = np.diff(e)
    out = {"e0": round(float(e[0]), 1), "e1": round(float(e[-1]), 1),
           "up": round(float(diffs[diffs > 0].sum()), 1), "dn": round(float(-diffs[diffs < 0].sum()), 1)}
    gdir = None
    for w in (50, 100):
        key = f"g{w}"
        if flat or d <= 0 or (len(e) - 1) * d < w * 0.95:
            out[key] = None
            continue
        k = max(1, int(round(w / d)))
        k = min(k, len(e) - 1)
        g = (e[k:] - e[:-k]) / (k * d) * 100
        i = int(np.argmax(np.abs(g)))
        out[key] = round(float(abs(g[i])), 1)
        if w == 50 or gdir is None:
            gdir = 1 if g[i] >= 0 else -1
    if gdir is None and len(e) > 1 and d > 0:                       # short edge: its overall grade
        g = (e[-1] - e[0]) / ((len(e) - 1) * d) * 100
        out["gall"] = round(float(abs(g)), 1)
        gdir = 1 if g >= 0 else -1
    out["gdir"] = gdir
    return out


def main():
    t0 = time.time()
    edges = read_fc(EDGES / "edges.geojson")
    lon, lat, offs, spacing = sample_edges(edges)
    N = len(lon)
    edge_of = np.repeat(np.arange(len(edges)), np.diff(offs))
    sx, sy = local(lon, lat)
    print(f"{len(edges)} edges, {N} sample points ({time.time() - t0:.0f} s)", flush=True)

    # elevation profile
    elev = FabDem().sample(lon, lat)
    flat = [bool(e["properties"].get("bridge") not in (None, "no") or e["properties"].get("tunnel") not in (None, "no"))
            for e in edges]
    ev = [profile_stats(elev[offs[i]:offs[i + 1]], spacing[i], flat[i]) for i in range(len(edges))]
    print(f"elevation done ({time.time() - t0:.0f} s)", flush=True)

    # Microsoft road detections within 10 m
    det_feats = read_fc(AREA / "ms_roads.geojson")
    lines = []
    for f in det_feats:
        c = np.asarray(f["geometry"]["coordinates"])
        lx, ly = local(c[:, 0], c[:, 1])
        lines.append(shapely.linestrings(np.column_stack([lx, ly])))
    tree = shapely.STRtree(lines)
    pairs = tree.query(shapely.points(sx, sy), predicate="dwithin", distance=10.0)
    near = np.zeros(N, dtype=bool)
    near[pairs[0]] = True
    det = np.add.reduceat(near.astype(np.int32), offs[:-1]) / np.diff(offs)
    print(f"detections done ({time.time() - t0:.0f} s)", flush=True)

    # GPS trace points: each point to the nearest sample within 15 m
    tp = np.zeros(len(edges), dtype=np.int64)
    tn = np.zeros(len(edges), dtype=np.int64)
    tr_path = AREA / "traces.npz"
    if tr_path.exists():
        t = np.load(tr_path)
        tx, ty = local(t["lon"], t["lat"])
        dist, idx = cKDTree(np.column_stack([sx, sy])).query(np.column_stack([tx, ty]), distance_upper_bound=15.0)
        ok = np.isfinite(dist)
        e_hit = edge_of[idx[ok]]
        tp = np.bincount(e_hit, minlength=len(edges))
        ids = defaultdict(set)
        for e_i, tid in zip(e_hit, t["tid"][ok]):
            if tid >= 0:
                ids[e_i].add(int(tid))
        for e_i, s in ids.items():
            tn[e_i] = len(s)
        print(f"traces: {ok.sum()} of {len(tx)} points matched ({time.time() - t0:.0f} s)", flush=True)
    else:
        print("traces: no traces.npz yet - run pipeline/traces.py", flush=True)

    # tree cover within 30 m (summed-area table of WorldCover class 10)
    wc = np.load(AREA / "worldcover.npz")
    cls, (a, _, c, _, e, f) = wc["cls"], wc["transform"]
    sat = np.zeros((cls.shape[0] + 1, cls.shape[1] + 1), dtype=np.int32)
    sat[1:, 1:] = (cls == 10).astype(np.int32).cumsum(0).cumsum(1)
    col, row = (lon - c) / a, (lat - f) / e
    rx, ry = 30 / (a * KX), 30 / (abs(e) * KY)
    c0 = np.clip(np.floor(col - rx).astype(int), 0, cls.shape[1]); c1 = np.clip(np.ceil(col + rx).astype(int), 0, cls.shape[1])
    r0 = np.clip(np.floor(row - ry).astype(int), 0, cls.shape[0]); r1 = np.clip(np.ceil(row + ry).astype(int), 0, cls.shape[0])
    area = np.maximum(1, (c1 - c0) * (r1 - r0))
    trees = (sat[r1, c1] - sat[r0, c1] - sat[r1, c0] + sat[r0, c0]) / area
    tree = np.add.reduceat(trees, offs[:-1]) / np.diff(offs)
    print(f"tree cover done ({time.time() - t0:.0f} s)", flush=True)

    # protected areas crossed
    prot = defaultdict(set)
    pa = [f for f in read_fc(AREA / "osm_areas.geojson")
          if f["properties"]["kind"] in ("boundary=protected_area", "boundary=national_park", "leisure=nature_reserve")]
    if pa:
        polys = [shapely.from_geojson(json.dumps(f["geometry"])) for f in pa]
        polys = [p if p.is_valid else p.buffer(0) for p in polys]
        ptree = shapely.STRtree(polys)
        elines = [shapely.linestrings(np.asarray(x["geometry"]["coordinates"])) for x in edges]
        hits = ptree.query(elines, predicate="intersects")
        for ei, pi in zip(*hits):
            p = pa[pi]["properties"]
            prot[ei].add(p.get("name") or p.get("protection_title") or p["kind"])
    print(f"protected areas: {len(pa)}, edges inside: {len(prot)} ({time.time() - t0:.0f} s)", flush=True)

    # route relations using the edge's way
    way_routes = defaultdict(set)
    for r in read_fc(AREA / "osm_routes.geojson"):
        rp = r["properties"]
        for w in rp.get("ways", []):
            way_routes[w].add(rp.get("route"))

    out = []
    for i, edge in enumerate(edges):
        p = edge["properties"]
        p.update(ev[i])
        p["det"] = round(float(det[i]), 2)
        p["tp"] = int(tp[i])
        p["tn"] = int(tn[i])
        p["tree"] = round(float(tree[i]), 2)
        if i in prot:
            p["prot"] = "; ".join(sorted(prot[i]))
        if p["way"] in way_routes:
            p["routes"] = ",".join(sorted(way_routes[p["way"]]))
        out.append(edge)
    write_fc(EDGES / "edges_evidence.geojson", out)

    # summary for a sanity check
    km = lambda sel: round(sum(e["properties"]["len"] for e in sel) / 1000)
    by = defaultdict(list)
    for e in out:
        by[e["properties"]["highway"]].append(e)
    summary = {}
    for hw in ("track", "path", "unclassified", "residential", "service", "tertiary", "secondary"):
        s = by.get(hw, [])
        summary[hw] = {
            "km": km(s),
            "km_detected_70": km([e for e in s if e["properties"]["det"] >= 0.7]),
            "km_with_traces": km([e for e in s if e["properties"]["tp"] > 0]),
            "km_forest_80": km([e for e in s if e["properties"]["tree"] >= 0.8]),
            "km_g50_over_25": km([e for e in s if (e["properties"].get("g50") or 0) > 25]),
        }
    with open(EDGES / "evidence_summary.json", "w") as fh:
        json.dump(summary, fh, indent=1)
    print(json.dumps(summary, indent=1))
    print(f"done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
