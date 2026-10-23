"""Step 8b: the routing graph for the phone -> data/area/graph.json (column arrays; geometry as encoded polylines,
precision 1e-5 deg ~1 m). Read by core/routing.js. Needs edges_evidence.geojson and edge_scores.json.
    uv run python pipeline/graph_pack.py
"""
import json
import time

from common import AREA, read_fc

PAVED = {"asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett", "cobblestone",
         "unhewn_cobblestone", "chipseal", "metal"}
UNPAVED = {"unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "mud", "sand", "rock",
           "pebblestone", "woodchips", "grass_paver", "stone"}
PAVED_CLASSES = {"residential", "living_street", "tertiary", "secondary", "primary", "trunk"}
DIRT_CLASSES = {"track", "path", "bridleway"}


def paved(p, cls):
    """0 unpaved, 1 paved, 2 unknown - from surface, else from the road class."""
    s = p.get("surface")
    if s in PAVED:
        return 1
    if s in UNPAVED:
        return 0
    if cls in PAVED_CLASSES:
        return 1
    if cls in DIRT_CLASSES:
        return 0
    return 2


# Class codes (index = code) - keep in step with core/routing.js CLASSES.
CLASSES = ["track", "path", "bridleway", "unclassified", "residential", "service", "living_street", "road", "tertiary",
           "secondary", "primary", "trunk"]


def encode_polyline(coords, precision=5):
    """Google polyline encoding of [[lon, lat], ...] (written lat first, like the original algorithm)."""
    f = 10 ** precision
    out, plat, plon = [], 0, 0
    for lon, lat, *_ in coords:
        ilat, ilon = round(lat * f), round(lon * f)
        for d in (ilat - plat, ilon - plon):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def main():
    t0 = time.time()
    edges = read_fc(AREA / "edges_evidence.geojson")
    scores = json.loads((AREA / "edge_scores.json").read_text())
    node_ix, lon, lat = {}, [], []

    def node(osm_id, c):
        i = node_ix.get(osm_id)
        if i is None:
            i = node_ix[osm_id] = len(lon)
            lon.append(round(c[0] * 1e6))
            lat.append(round(c[1] * 1e6))
        return i

    cols = {k: [] for k in ("a", "b", "len", "cls", "risk", "lvl", "leg", "ex", "g", "gdir", "up", "dn", "tree", "det", "tt", "pav")}
    ids, names, geom = [], [], []
    for f in edges:
        p = f["properties"]
        c = f["geometry"]["coordinates"]
        cls = p["highway"].replace("_link", "")
        if cls not in CLASSES:
            continue
        sc = scores.get(p["id"], [0, 2, 2, 0])
        g = p.get("g100") if p.get("g100") is not None else p.get("g50") if p.get("g50") is not None else p.get("gall")
        tt = str(p.get("tracktype", ""))
        cols["a"].append(node(p["from"], c[0]))
        cols["b"].append(node(p["to"], c[-1]))
        cols["len"].append(round(p["len"], 1))
        cols["cls"].append(CLASSES.index(cls))
        cols["risk"].append(sc[1])
        cols["lvl"].append(sc[2])
        cols["leg"].append(sc[3])
        cols["ex"].append(sc[0])
        cols["g"].append(round(g, 1) if g is not None else -1)
        cols["gdir"].append(p.get("gdir") or 0)
        cols["up"].append(round(p.get("up", 0)))
        cols["dn"].append(round(p.get("dn", 0)))
        cols["tree"].append(round(100 * (p.get("tree") or 0)))
        cols["det"].append(round(100 * (p.get("det") or 0)))
        cols["tt"].append(int(tt[5]) if tt.startswith("grade") and tt[5:6].isdigit() else 0)
        cols["pav"].append(paved(p, cls))
        ids.append(p["id"])
        names.append(p.get("name") or "")
        geom.append(encode_polyline(c))
    out = {"version": 1, "classes": CLASSES, "nodes": {"lon": lon, "lat": lat}, "edges": cols, "ids": ids,
           "names": names, "geom": geom}
    path = AREA / "graph.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"graph: {len(lon)} nodes, {len(ids)} edges, {path.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
