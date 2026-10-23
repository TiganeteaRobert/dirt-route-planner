"""AI step 4: run the trained detectors over the area -> data/ai/pred/<i>_<j>.png, the track probability (0-255) of every
pixel of each 512 px patch. Cross-fitting: the patches of fold k are predicted by model_f<k>.pt, which never trained on
them (ai_train.py). Works on 2 x 2 patches at a time (1024 px) with 128 px of the neighbouring imagery around them, so
lines run on across patch edges and the margin costs little; tiles are decoded on the GPU like in training. Re-runs
skip patches already done (delete data/ai/pred to redo them, e.g. after training again).
    .venv-ml/Scripts/python pipeline/ai_infer.py [fold=all folds with a model] [tta=0]
"""
import json
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import torch
from PIL import Image

from ai_common import AI, FOLDS, PRED, TILES, fold_of, has_patch
from ai_train import MEAN, STD, _bytes, _decode

M = 128          # px of context around each 2 x 2 block


def _read_quad(X0, Y0, qi, qj):
    """The 6 x 6 tiles around block (qi, qj) as JPEG bytes (None where there is no imagery)."""
    out = []
    for dy in range(6):
        for dx in range(6):
            p = TILES / str(X0 + 4 * qi - 1 + dx) / f"{Y0 + 4 * qj - 1 + dy}.jpg"
            out.append(_bytes(p) if p.exists() else None)
    return out


def quad_batches(quads, X0, Y0, size=2, threads=6, ahead=3):
    mean = torch.tensor(MEAN, device="cuda").view(3, 1, 1)
    std = torch.tensor(STD, device="cuda").view(3, 1, 1)
    groups = [quads[k:k + size] for k in range(0, len(quads), size)]
    with ThreadPoolExecutor(threads) as pool:
        submit = lambda g: [pool.submit(_read_quad, X0, Y0, qi, qj) for qi, qj in g]
        q = deque((g, submit(g)) for g in groups[:ahead])
        nxt = ahead
        while q:
            g, futs = q.popleft()
            if nxt < len(groups):
                q.append((groups[nxt], submit(groups[nxt])))
                nxt += 1
            raw = [f.result() for f in futs]
            have = [t for tl in raw for t in tl if t is not None]
            dec = iter(_decode(have)) if have else iter(())
            xs = []
            for tl in raw:
                img = torch.zeros((3, 1536, 1536), device="cuda")
                for k, t in enumerate(tl):
                    if t is not None:
                        dy, dx = divmod(k, 6)
                        img[:, dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = next(dec).float() / 255.0
                xs.append((img[:, 256 - M:1280 + M, 256 - M:1280 + M] - mean) / std)
            yield g, torch.stack(xs)


def save(arr, i, j):
    Image.fromarray(arr).save(PRED / f"{i}_{j}.png", compress_level=6)


def main():
    import segmentation_models_pytorch as smp

    meta = json.loads((AI / "grid.json").read_text())
    X0, Y0, ni, nj = meta["X0"], meta["Y0"], meta["ni"], meta["nj"]
    tta = len(sys.argv) > 2 and sys.argv[2] == "1"
    folds = [int(sys.argv[1])] if len(sys.argv) > 1 and sys.argv[1] != "all" else range(FOLDS)
    PRED.mkdir(parents=True, exist_ok=True)
    torch.backends.cudnn.benchmark = True
    t0, done = time.time(), 0
    for fold in folds:
        path = AI / f"model_f{fold}.pt"
        if not path.exists():
            print(f"fold {fold}: no model yet", flush=True)
            continue
        todo = lambda i, j: has_patch(X0, Y0, i, j) and not (PRED / f"{i}_{j}.png").exists()
        quads = [(qi, qj) for qj in range((nj + 1) // 2) for qi in range((ni + 1) // 2)
                 if fold_of(2 * qi, 2 * qj) == fold and any(todo(2 * qi + a, 2 * qj + b) for a in (0, 1) for b in (0, 1))]
        print(f"fold {fold}: {len(quads)} blocks of 2 x 2 patches to predict", flush=True)
        if not quads:
            continue
        model = smp.Unet("resnet34", encoder_weights=None, in_channels=3, classes=1)
        model.load_state_dict(torch.load(path, map_location="cpu"))
        model.to("cuda").eval()
        n, t1 = 0, time.time()
        with ThreadPoolExecutor(4) as pool, torch.no_grad():
            for g, x in quad_batches(quads, X0, Y0):
                with torch.autocast("cuda", dtype=torch.float16):
                    logit = model(x)
                    if tta:
                        logit = (logit + model(x.flip(-1)).flip(-1)) / 2
                p = torch.sigmoid(logit.float())[:, 0, M:M + 1024, M:M + 1024]
                out = (p * 255).round().to(torch.uint8).cpu().numpy()
                for k, (qi, qj) in enumerate(g):
                    for a in (0, 1):
                        for b in (0, 1):
                            i, j = 2 * qi + a, 2 * qj + b
                            if i < ni and j < nj and has_patch(X0, Y0, i, j):
                                pool.submit(save, out[k, b * 512:(b + 1) * 512, a * 512:(a + 1) * 512].copy(), i, j)
                n += len(g)
                if n % 400 < len(g):
                    rate = n / (time.time() - t1)
                    print(f"  fold {fold}: {n}/{len(quads)} ({rate:.1f}/s, {(len(quads) - n) / rate / 60:.1f} min left)", flush=True)
        done += n
        del model
        torch.cuda.empty_cache()
    print(f"predicted {done} blocks in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
