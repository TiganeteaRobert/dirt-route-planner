"""AI step 3: train the track detector - a U-Net (ResNet-34 encoder, ImageNet weights) that marks road/track pixels in
the z17 Esri imagery, taught by the labels from ai_labels.py (known OSM ways and Microsoft detections). Ignore bands
and known lines under trees (often invisible) weigh 0, other tree-covered pixels 0.3. Cross-fitting: model k trains on
every fold but k and is validated on fold k (ai_common.fold_of), so its score shows how it does on ground it has not
seen, and ai_infer.py lets it predict only there. Best model -> data/ai/model_f<k>.pt (fold -1: the old 1-in-6 block split -> model.pt).
    .venv-ml/Scripts/python pipeline/ai_train.py <fold 0-2 | -1> [epochs=12] [samples_per_epoch=6000]
The JPEG tiles are decoded on the GPU (gpu_batches); no DataLoader worker processes, which on Windows each load all
of torch (~0.5 GB RAM, more commit) - two of those trainings side by side ran this 16 GB PC out of memory.
"""
import json
import math
import random
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from torchvision.io import ImageReadMode, decode_jpeg, decode_png

from ai_common import AI, FOLDS, LABELS, TILES, fold_of, has_patch

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def is_val(i, j):
    return ((i // 8) * 7 + (j // 8) * 13) % 6 == 0          # ~1/6 of the 6 km blocks


def _bytes(path):
    with open(path, "rb") as f:
        return torch.frombuffer(bytearray(f.read()), dtype=torch.uint8)


def _read(X0, Y0, i, j):
    """Patch (i, j): its 4 tile JPEGs as bytes and its label PNG decoded (on a thread; none of it needs the GIL)."""
    tiles = [_bytes(TILES / str(X0 + 2 * i + dx) / f"{Y0 + 2 * j + dy}.jpg") for dy in (0, 1) for dx in (0, 1)]
    return tiles, decode_png(_bytes(LABELS / f"{i}_{j}.png"), mode=ImageReadMode.RGB)


def _decode(tiles):
    try:
        return decode_jpeg(tiles, mode=ImageReadMode.RGB, device="cuda")
    except RuntimeError:                       # an odd file: decode them one by one on the CPU
        return [decode_jpeg(t, mode=ImageReadMode.RGB).to("cuda") for t in tiles]


def gpu_batches(ids, X0, Y0, size, train, threads=8, ahead=4, drop_last=False):
    """Batches (x, target, weight) on the GPU for patches `ids`. Threads only read files and decode the small label
    PNGs; the JPEG tiles are decoded on the GPU (nvjpeg) and augmented there, so the training loop keeps the GIL and
    the GPU stays busy (PIL decoding on threads starved it: 2.1 instead of ~1.1 min per epoch).
    Training: a random 384 px crop, rotation, mirror and a light colour jitter (imagery dates and seasons differ)."""
    mean = torch.tensor(MEAN, device="cuda").view(3, 1, 1)
    std = torch.tensor(STD, device="cuda").view(3, 1, 1)
    groups = [ids[k:k + size] for k in range(0, len(ids), size)]
    if drop_last and groups and len(groups[-1]) < size:
        groups.pop()
    with ThreadPoolExecutor(threads) as pool:
        submit = lambda g: [pool.submit(_read, X0, Y0, i, j) for i, j in g]
        q = deque(submit(g) for g in groups[:ahead])
        nxt = ahead
        while q:
            futs = q.popleft()
            if nxt < len(groups):
                q.append(submit(groups[nxt]))
                nxt += 1
            items = [f.result() for f in futs]
            tiles = _decode([t for tl, _ in items for t in tl])
            xs, ts, ws = [], [], []
            for k, (_, lab) in enumerate(items):
                t = tiles[4 * k:4 * k + 4]
                img = torch.cat([torch.cat(t[0:2], 2), torch.cat(t[2:4], 2)], 1).float() / 255.0       # [3, 512, 512]
                lab = lab.to("cuda", non_blocking=True)
                target = (lab[0] == 255).float()[None]
                # known roads under trees are often invisible: no lesson there (else it hunts lines in the canopy);
                # canopy elsewhere still teaches what is not a track, at 0.3
                tree = lab[1] == 255
                weight = torch.where((lab[0] == 128) | (tree & (lab[0] == 255)), 0.0, torch.where(tree, 0.3, 1.0))[None]
                if train:
                    c = 384
                    oy, ox = random.randint(0, 512 - c), random.randint(0, 512 - c)
                    img, target, weight = (a[:, oy:oy + c, ox:ox + c] for a in (img, target, weight))
                    r = random.randint(0, 3)
                    img, target, weight = (torch.rot90(a, r, (1, 2)) for a in (img, target, weight))
                    if random.random() < 0.5:
                        img, target, weight = (a.flip(2) for a in (img, target, weight))
                    chan = torch.tensor([random.uniform(0.92, 1.08) for _ in range(3)], device="cuda").view(3, 1, 1)
                    img = ((img * random.uniform(0.85, 1.15) + random.uniform(-0.05, 0.05)) * chan).clamp(0, 1)
                xs.append((img - mean) / std)
                ts.append(target)
                ws.append(weight)
            yield torch.stack(xs), torch.stack(ts), torch.stack(ws)


TOL = 8          # px (~6.5 m): known lines are often this far off the track in the imagery
NEG_W = 6.0      # background vs line weight: lines are ~1/36 of the pixels; equal halves made it mark every edge


def line_cover(p):
    """How well a line is drawn near each pixel: the firing inside the (2 TOL + 1)^2 window around it, as a share of
    one straight line across the window (2 TOL + 1 px), capped at 1. A single pixel scores 1/17: a max-pool here let
    the model cheat with a sparse grid of dots that is near every label at once."""
    k = 2 * TOL + 1
    return (F.avg_pool2d(p, k, 1, TOL) * k).clamp(max=1.0)


_WIN = None
MAX_POS = 30000      # line pixels scored per batch (a random sample): keeps the top-k gather small on the GPU


def line_reach(p, target):
    """For each known-line pixel: the mean of the 2 TOL + 1 strongest predictions in the (2 TOL + 1)^2 window around it
    (top-k pooling, as in multiple-instance learning). Only a confident line near the label scores high: a single
    pixel scores 1/17 and a faint fog of low values scores low (a max-pool, then an average, let the model cheat with
    a grid of dots, then with fog). Returns (reach [N], (b, y, x) of the pixels)."""
    global _WIN
    k = 2 * TOL + 1
    if _WIN is None or _WIN.device != p.device:
        r = torch.arange(-TOL, TOL + 1, device=p.device)
        _WIN = torch.stack(torch.meshgrid(r, r, indexing="ij"), -1).view(-1, 2)
    b, y, x = target[:, 0].nonzero(as_tuple=True)
    if len(b) > MAX_POS:
        keep = torch.randperm(len(b), device=b.device)[:MAX_POS]
        b, y, x = b[keep], y[keep], x[keep]
    pp = F.pad(p[:, 0], (TOL, TOL, TOL, TOL))
    win = pp[b[:, None], y[:, None] + _WIN[:, 0] + TOL, x[:, None] + _WIN[:, 1] + TOL]
    return win.topk(k, dim=1).values.mean(1), (b, y, x)


def loss_fn(logits, target, weight):
    """Tolerant loss for misaligned labels: a known line is satisfied where the model draws a confident line within
    TOL px of it (line_reach), and everything outside the ignore band must stay off. Positives and negatives are
    averaged separately, which also balances thin lines against the large background."""
    p = torch.sigmoid(logits.float())
    eps = 1e-6
    reach, (b, y, x) = line_reach(p, target)
    w = weight[b, 0, y, x]
    pos_loss = -(torch.log(reach + eps) * w).sum() / w.sum().clamp(min=1)
    neg = (1 - F.max_pool2d(target, 3, 1, 1)) * (weight > 0) * weight
    neg_loss = -(torch.log(1 - p + eps) * neg).sum() / neg.sum().clamp(min=1)
    return pos_loss + NEG_W * neg_loss


THRESHOLDS = (0.3, 0.5, 0.7, 0.85, 0.95)


@torch.no_grad()
def evaluate(model, val_ids, X0, Y0, dev):
    """Relaxed precision / recall / F1 at a few thresholds: predictions inside a known line's band are right; a known
    line is found when a prediction lies within TOL px of it. Unmapped tracks count as errors here, so precision is a
    lower bound. A known line counts as found where at least half a line is drawn near it. Returns
    [(threshold, p, r, f1)]."""
    model.eval()
    st = np.zeros((len(THRESHOLDS), 4))
    for x, target, weight in gpu_batches(val_ids, X0, Y0, 8, False):
        with torch.autocast("cuda", dtype=torch.float16):
            prob = torch.sigmoid(model(x).float())
        near_t = F.max_pool2d(target, 5, 1, 2)                  # within 2 px of a known line
        known = (weight == 0) | (near_t > 0)                     # predictions in the ignore band are not errors
        for k, t in enumerate(THRESHOLDS):
            pred = (prob > t).float()
            near_p = (line_cover(pred) >= 0.5).float()          # found: half a line drawn within TOL px of it
            lesson = target * (weight > 0)                          # not the known lines hidden under trees
            st[k] += [(pred * known).sum().item(), pred.sum().item(), (lesson * near_p).sum().item(), lesson.sum().item()]
    out = []
    for k, t in enumerate(THRESHOLDS):
        p, r = st[k, 0] / max(1, st[k, 1]), st[k, 2] / max(1, st[k, 3])
        out.append((t, p, r, 2 * p * r / max(1e-9, p + r)))
    return out


def main():
    import segmentation_models_pytorch as smp

    fold = int(sys.argv[1])
    epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    per_epoch = int(sys.argv[3]) if len(sys.argv) > 3 else 6000
    held_out = (lambda i, j: fold_of(i, j) == fold) if fold >= 0 else is_val
    name = f"model_f{fold}" if fold >= 0 else "model"
    meta = json.loads((AI / "grid.json").read_text())
    X0, Y0 = meta["X0"], meta["Y0"]
    rng = random.Random(0)
    cache = AI / "keep.json"
    if cache.exists():
        c = json.loads(cache.read_text())
        n_ids, keep = c["n"], [tuple(p) for p in c["keep"]]
    else:
        ids = [tuple(map(int, p.stem.split("_"))) for p in LABELS.glob("*.png")]
        ids = [p for p in ids if has_patch(X0, Y0, *p)]
        # patches with known lines are the lessons; keep some empty ones so it learns what is not a track
        keep = []
        for i, j in ids:
            lab = np.asarray(Image.open(LABELS / f"{i}_{j}.png"))[..., 0]
            if (lab == 255).mean() > 0.002 or rng.random() < 0.25:
                keep.append((i, j))
        n_ids = len(ids)
        cache.write_text(json.dumps({"n": n_ids, "keep": keep}))
    train_ids = [p for p in keep if not held_out(*p)]
    val_ids = [p for p in keep if held_out(*p)]
    rng.shuffle(val_ids)
    val_ids = val_ids[:600]
    print(f"patches: {n_ids} labelled, {len(train_ids)} train, {len(val_ids)} validation", flush=True)

    dev = "cuda"
    # Windows pages GPU memory to RAM when the card is full, and everything crawls: stay well inside the 8 GB
    torch.cuda.set_per_process_memory_fraction(0.6)
    torch.backends.cudnn.benchmark = True
    model = smp.Unet("resnet34", encoder_weights="imagenet", in_channels=3, classes=1).to(dev)    # channels_last: 3.4x slower here
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    steps = epochs * (per_epoch // 12)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=6e-4, total_steps=steps, pct_start=0.1)
    scaler = torch.amp.GradScaler("cuda")
    best, best_t = -1, 0.5
    t0 = time.time()
    for ep in range(epochs):
        model.train()
        tot, n = 0.0, 0
        order = rng.sample(train_ids, min(per_epoch, len(train_ids)))
        for x, target, weight in gpu_batches(order, X0, Y0, 12, True, drop_last=True):
            opt.zero_grad(set_to_none=True)
            with torch.autocast("cuda", dtype=torch.float16):
                loss = loss_fn(model(x), target, weight)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            tot += loss.item()
            n += 1
        ev = evaluate(model, val_ids, X0, Y0, dev)
        torch.cuda.empty_cache()
        t_best, p, r, f1 = max(ev, key=lambda e: e[3])
        mark = ""
        if f1 > best:
            best, best_t = f1, t_best
            torch.save(model.state_dict(), AI / f"{name}.pt")
            mark = " (best, saved)"
        torch.save(model.state_dict(), AI / f"{name}_last.pt")
        torch.save(model.state_dict(), AI / f"{name}_e{ep + 1}.pt")           # to pick an epoch by eye
        table = " ".join(f"{t:.2f}:{p_:.2f}/{r_:.2f}" for t, p_, r_, _ in ev)
        print(f"epoch {ep + 1}/{epochs}: loss {tot / max(1, n):.4f}, val P/R {table}, best F1 {f1:.3f} at {t_best}{mark}, "
              f"{(time.time() - t0) / 60:.1f} min", flush=True)
    (AI / f"{name}.json").write_text(json.dumps({"fold": fold, "folds": FOLDS, "best_f1": best, "best_t": best_t, "epochs": epochs,
                                                 "per_epoch": per_epoch, "neg_w": NEG_W, "train": len(train_ids),
                                                 "val": len(val_ids)}))


if __name__ == "__main__":
    main()
