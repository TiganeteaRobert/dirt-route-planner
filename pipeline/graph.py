"""Step 6: the routable graph. Ways a motorcycle might use (tracks, paths and bridleways with their flags, minor and
major roads; no motorways, footways, steps or cycleways) split at every junction into edges.
-> data/area/edges.geojson (one LineString per edge: from/to node, length, the way's tags, version, timestamp,
   gates or other barriers on it).
    uv run python pipeline/graph.py
"""
import time
from collections import Counter

from common import AREA, haversine, read_fc, write_fc

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


def main():
    t0 = time.time()
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
            length = sum(haversine(part[k - 1], part[k]) for k in range(1, len(part)))
            on = [barriers[n] for n in nodes[start:i + 1] if n in barriers]
            edges.append({"type": "Feature",
                          "properties": {"id": f"{p['osm_id']}:{seq}", "way": p["osm_id"], "from": nodes[start],
                                         "to": nodes[i], "len": round(length, 1), **tags,
                                         "version": p.get("version"), "ts": p.get("ts"),
                                         **({"barriers": sorted(set(on))} if on else {})},
                          "geometry": {"type": "LineString", "coordinates": part}})
            start, seq = i, seq + 1
    write_fc(AREA / "edges.geojson", edges)
    km = Counter()
    for e in edges:
        km[e["properties"]["highway"]] += e["properties"]["len"] / 1000
    print(f"{len(ways)} ways -> {len(edges)} edges, {sum(km.values()):.0f} km, {time.time() - t0:.0f} s")
    for k, v in km.most_common():
        print(f"  {k:16s} {v:8.0f} km")
    print(f"  edges with a barrier/ford: {sum(1 for e in edges if 'barriers' in e['properties'])}")


if __name__ == "__main__":
    main()
