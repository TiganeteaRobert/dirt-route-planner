"""AI step 6: the owner's private bundle for the phone -> data/ai/ai.enc (and a copy in app/public/pack/ for local
tests): the private routing graph (graph.py ... graph_pack.py run with DS_AI=1) and the AI-found tracks with their
evidence and scores (the map layer and the track card), gzipped and encrypted with AES-256-GCM under a key derived
from a passphrase (PBKDF2-SHA256). The lines are derived from Esri imagery, so the file may sit next to the public
pack only encrypted. The passphrase is private/ai_passphrase.txt (made on the first run); the owner types it into the
app once. Publishing: pipeline/README.md.
Format: b"DSAI" | 1 | salt (16) | iv (12) | PBKDF2 iterations (u32, big-endian) | ciphertext + tag.
    uv run --with cryptography python pipeline/ai_bundle.py
"""
import gzip
import hashlib
import json
import secrets
import shutil
import struct
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from common import AREA, ROOT, read_fc

AI = ROOT / "data" / "ai"
PASS = ROOT / "private" / "ai_passphrase.txt"
ITERATIONS = 600_000
ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"          # no l, o, 0, 1: easy to type on a phone


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


def ai_features():
    """The AI edges as the map layer wants them (the same properties as the pack's tracks layer)."""
    scores = json.loads((AI / "edge_scores.json").read_text())
    feats = []
    for f in read_fc(AI / "edges_evidence.geojson"):
        p = f["properties"]
        if p["highway"] != "ai":
            continue
        sc = scores.get(p["id"])
        props = {"class": "ai", "id": p["id"], "len": p["len"], "det": p.get("det"), "tp": p.get("tp"), "tn": p.get("tn"),
                 "tree": p.get("tree"), "g50": p.get("g50"), "g100": p.get("g100"), "gall": p.get("gall"),
                 "gdir": p.get("gdir"), "up": p.get("up"), "dn": p.get("dn"), "prot": 1 if p.get("prot") else None,
                 "src": p.get("source"), "aic": p.get("aic"), "crop": p.get("aicrop"), "grass": p.get("aigrass"),
                 "ex": sc[0] if sc else None, "risk": sc[1] if sc else None, "lvl": sc[2] if sc else None,
                 "leg": (sc[3] or None) if sc else None}
        feats.append({"type": "Feature", "properties": {k: v for k, v in props.items() if v is not None},
                      "geometry": {"type": "LineString",
                                   "coordinates": [[round(x, 6), round(y, 6)] for x, y, *_ in f["geometry"]["coordinates"]]}})
    return feats


def main():
    t0 = time.time()
    graph = json.loads((AI / "graph.json").read_text())
    feats = ai_features()
    km = sum(f["properties"]["len"] for f in feats) / 1000
    base = json.loads((AREA / "pack.json").read_text())["version"] if (AREA / "pack.json").exists() else None
    body = {"graph": graph, "ai": {"type": "FeatureCollection", "features": feats}}
    digest = hashlib.sha256(json.dumps(body, separators=(",", ":")).encode()).hexdigest()[:6]
    payload = {"v": 1, "version": time.strftime("%Y-%m-%d") + "." + digest, "built": int(time.time()), "base": base,
               "stats": {"lines": len(feats), "km": round(km)}, **body}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    blob = encrypt(gzip.compress(raw, 9), passphrase())
    out = AI / "ai.enc"
    out.write_bytes(blob)
    dest = ROOT / "app" / "public" / "pack"
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(out, dest / out.name)
    print(f"ai.enc {payload['version']}: {len(feats)} AI tracks, {km:.0f} km; {len(raw) / 1e6:.1f} MB json -> "
          f"{len(blob) / 1e6:.1f} MB encrypted ({time.time() - t0:.0f} s). Passphrase: {PASS}")


if __name__ == "__main__":
    main()
