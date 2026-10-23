"""AI step 7: the owner's private bundle for the phone -> data/ai/ai.enc (and a copy in app/public/pack/ for local
tests). The lines are derived from Esri imagery, so the file may sit next to the public pack only encrypted
(AES-256-GCM, key from a passphrase by PBKDF2-SHA256; the passphrase is private/ai_passphrase.txt, made on the first
run, typed into the app once).
File: b"DSAI" | 1 | salt (16) | iv (12) | PBKDF2 iterations (u32 BE) | ciphertext + tag.
Plaintext (version 2): b"DSB2" | three u32 BE lengths | meta.json | graph.json.gz | tiles.pmtiles
  meta     {v: 2, version, built, base, stats: {lines, km}, hist: [[score from, lines, km], ...]}
  graph    the private routing graph (graph.py ... graph_pack.py run with DS_AI=1), loaded by the app only to route
  tiles    the AI-found tracks as vector tiles z12-14, layer "ai" (the map draws pre-cut tiles: as one GeoJSON the
           ~50k lines took the phone's map seconds to redraw at every move)
    uv run --with cryptography --with numpy --with shapely --with mapbox-vector-tile --with pmtiles python pipeline/ai_bundle.py
"""
import gzip
import hashlib
import io
import json
import secrets
import shutil
import struct
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from build_tiles import Layer, to_geom, write_pmtiles
from common import AREA, BBOX, ROOT, bbox_buffer, read_fc

AI = ROOT / "data" / "ai"
PASS = ROOT / "private" / "ai_passphrase.txt"
ITERATIONS = 600_000
ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"          # no l, o, 0, 1: easy to type on a phone
ZMIN, ZMAX = 12, 14
HIST = [round(0.3 + 0.05 * k, 2) for k in range(14)]   # slider steps 0.30 ... 0.95


def passphrase():
    if not PASS.exists():
        PASS.parent.mkdir(exist_ok=True)
        PASS.write_text("-".join("".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(4)) + "\n")
    return PASS.read_text().strip()


def norm(p):
    """Lower case, no spaces (the app does the same, so phone keyboards cannot get it wrong)."""
    return "".join(p.lower().split())


def encrypt(data, pw):
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", norm(pw).encode(), salt, ITERATIONS, 32)
    return b"DSAI" + bytes([1]) + salt + iv + struct.pack(">I", ITERATIONS) + AESGCM(key).encrypt(iv, data, None)


def ai_layer():
    """The AI edges as the map layer wants them (the properties of the pack's tracks layer, plus the AI's own)."""
    scores = json.loads((AI / "edge_scores.json").read_text())
    L = Layer("ai", "line")
    for f in read_fc(AI / "edges_evidence.geojson"):
        p = f["properties"]
        if p["highway"] != "ai":
            continue
        sc = scores.get(p["id"])
        L.add(to_geom(f["geometry"]), {
            "class": "ai", "id": p["id"], "len": p["len"], "aic": p.get("aic"), "conf": p.get("aiconf"),
            "line": p.get("ailine"), "det": p.get("det"), "tp": p.get("tp"), "tn": p.get("tn"), "tree": p.get("tree"),
            "g50": p.get("g50"), "g100": p.get("g100"), "gall": p.get("gall"), "gdir": p.get("gdir"), "up": p.get("up"),
            "dn": p.get("dn"), "prot": 1 if p.get("prot") else None, "crop": p.get("aicrop"), "grass": p.get("aigrass"),
            "ex": sc[0] if sc else None, "risk": sc[1] if sc else None, "lvl": sc[2] if sc else None,
            "leg": (sc[3] or None) if sc else None}, ZMIN)
    return L.finish()


def main():
    t0 = time.time()
    graph_text = (AI / "graph.json").read_text()
    L = ai_layer()
    aic = [p.get("aic") or 0 for p in L.props]
    lens = [p["len"] for p in L.props]
    hist = [[t, sum(1 for a in aic if a >= t - 1e-9), round(sum(m for a, m in zip(aic, lens) if a >= t - 1e-9) / 1000)]
            for t in HIST]
    tiles = io.BytesIO()
    sizes, _, n_tiles = write_pmtiles([L], tiles, ZMIN, ZMAX, bbox_buffer(BBOX, 1000), "DirtScout AI tracks (private)",
                                      "Derived from Esri World Imagery: private, personal use only", t0=t0)
    tiles = tiles.getvalue()
    graph_gz = gzip.compress(graph_text.encode(), 9, mtime=0)
    digest = hashlib.sha256(graph_gz + tiles).hexdigest()[:6]
    base = json.loads((AREA / "pack.json").read_text())["version"] if (AREA / "pack.json").exists() else None
    meta = {"v": 2, "version": time.strftime("%Y-%m-%d") + "." + digest, "built": int(time.time()), "base": base,
            "stats": {"lines": len(L.props), "km": round(sum(lens) / 1000)}, "hist": hist}
    meta_b = json.dumps(meta, separators=(",", ":")).encode()
    plain = b"DSB2" + struct.pack(">III", len(meta_b), len(graph_gz), len(tiles)) + meta_b + graph_gz + tiles
    blob = encrypt(plain, passphrase())
    out = AI / "ai.enc"
    out.write_bytes(blob)
    dest = ROOT / "app" / "public" / "pack"
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(out, dest / out.name)
    print(f"ai.enc {meta['version']}: {meta['stats']['lines']} AI tracks, {meta['stats']['km']} km; graph "
          f"{len(graph_gz) / 1e6:.1f} MB gz, tiles {len(tiles) / 1e6:.1f} MB ({n_tiles} tiles) -> {len(blob) / 1e6:.1f} MB "
          f"encrypted ({time.time() - t0:.0f} s). Passphrase: {PASS}")


if __name__ == "__main__":
    main()
