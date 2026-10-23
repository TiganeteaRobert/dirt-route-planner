// Smart drawing: follows the pale line of a dirt track in the satellite imagery between two taps. The imagery around
// both points is put together at z18 (z17 for longer stretches) from the phone's tiles or the network; pixels on thin
// lines that are paler and less green than their surroundings become cheap, and the cheapest pixel path (A*) between
// the taps is the track. Returns [[lon, lat], ...] or null (then the caller draws a straight segment).
import { imageryBitmap } from './tiles.js';
import { lon2x, lat2y, y2lat } from '../../core/tilemath.js';
import { haversine } from '../../core/routing.js';

const MAX_SIDE = 1400;                 // px: bigger areas would take too long on a phone

export function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    let s = 0;
    const row = y * W;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(W - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s / n;
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}

// 1D kernels of a Gaussian and its first and second derivatives.
function kernels(sigma) {
  const r = Math.ceil(3 * sigma), g = [], d1 = [], d2 = [];
  for (let i = -r; i <= r; i++) {
    const e = Math.exp(-(i * i) / (2 * sigma * sigma));
    g.push(e); d1.push((-i / (sigma * sigma)) * e); d2.push(((i * i - sigma * sigma) / sigma ** 4) * e);
  }
  const sum = g.reduce((a, b) => a + b, 0);
  return { r, g: g.map((v) => v / sum), d1: d1.map((v) => v / sum), d2: d2.map((v) => v / sum) };
}

function convX(src, W, H, k, r) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += src[row + Math.min(W - 1, Math.max(0, x + j))] * k[j + r];
      out[row + x] = s;
    }
  }
  return out;
}

function convY(src, W, H, k, r) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += src[Math.min(H - 1, Math.max(0, y + j)) * W + x] * k[j + r];
      out[y * W + x] = s;
    }
  }
  return out;
}

// Bright line strength: minus the smaller Hessian eigenvalue (scale-normalised), 0 where the image does not curve down.
function brightRidges(img, W, H, sigma) {
  const { r, g, d1, d2 } = kernels(sigma);
  const gx = convX(img, W, H, g, r), d1x = convX(img, W, H, d1, r), d2x = convX(img, W, H, d2, r);
  const Ixx = convY(d2x, W, H, g, r), Iyy = convY(gx, W, H, d2, r), Ixy = convY(d1x, W, H, d1, r);
  const out = new Float32Array(W * H);
  const s2 = sigma * sigma;
  for (let i = 0; i < out.length; i++) {
    const a = (Ixx[i] + Iyy[i]) / 2, b = Math.hypot((Ixx[i] - Iyy[i]) / 2, Ixy[i]);
    const lmin = a - b, lmax = a + b;
    // a line curves down across it (lmin << 0) and barely along it; a blob curves down both ways
    out[i] = lmin < 0 ? s2 * (-lmin - Math.max(0, -lmax) * 0.5) : 0;
  }
  return out;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [x1, y1] = pts[i], [x2, y2] = pts[j];
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * (pts[k][0] - x1) - dx * (pts[k][1] - y1)) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

export async function followTrack(src, a, b) {
  const dist = haversine(a[0], a[1], b[0], b[1]);
  if (dist < 15) return null;
  const z = dist < 700 ? 18 : dist < 1600 ? 17 : 0;
  if (!z) return null;
  const n = 2 ** z * 256;
  const mpp = (156543.03392 * Math.cos((a[1] * Math.PI) / 180)) / 2 ** z;
  const ax = lon2x(a[0], z) * 256, ay = lat2y(a[1], z) * 256, bx = lon2x(b[0], z) * 256, by = lat2y(b[1], z) * 256;
  const pad = Math.max(40, dist * 0.3) / mpp;
  const gx0 = Math.floor(Math.min(ax, bx) - pad), gx1 = Math.ceil(Math.max(ax, bx) + pad);
  const gy0 = Math.floor(Math.min(ay, by) - pad), gy1 = Math.ceil(Math.max(ay, by) + pad);
  const W = gx1 - gx0, H = gy1 - gy0;
  if (W > MAX_SIDE || H > MAX_SIDE) return null;

  // the imagery under the area
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let have = 0, total = 0;
  for (let tx = Math.floor(gx0 / 256); tx <= Math.floor((gx1 - 1) / 256); tx++) {
    for (let ty = Math.floor(gy0 / 256); ty <= Math.floor((gy1 - 1) / 256); ty++) {
      total++;
      const bmp = await imageryBitmap(src, z, tx, ty);
      if (!bmp) continue;
      ctx.drawImage(bmp, tx * 256 - gx0, ty * 256 - gy0, 256, 256);
      bmp.close?.();
      have++;
    }
  }
  if (have < total * 0.6) return null;
  const px = ctx.getImageData(0, 0, W, H).data;

  // pale and not green ...
  const N = W * H;
  const idx = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], bl = px[i * 4 + 2];
    idx[i] = 0.299 * r + 0.587 * g + 0.114 * bl - 1.2 * (g - (r + bl) / 2);
  }
  // ... and a line: darker on both sides (the Hessian's strongest negative curvature), not just the bright side of
  // an edge such as tree shadows next to grass
  const ridge = brightRidges(idx, W, H, z === 18 ? 2.5 : 1.5);
  const pos = Array.from(ridge.filter((v, i) => v > 0 && i % 7 === 0)).sort((p, q) => p - q);
  const p95 = pos.length ? pos[Math.floor(pos.length * 0.95)] : 1;
  const cost = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = Math.min(1, Math.max(0, ridge[i] / (p95 || 1)));
    cost[i] = 1 + 25 * (1 - v) * (1 - v);
  }

  // A* over the pixels, 8 neighbours
  const sx = Math.round(ax - gx0), sy = Math.round(ay - gy0), ex = Math.round(bx - gx0), ey = Math.round(by - gy0);
  const start = sy * W + sx, goal = ey * W + ex;
  const g = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new Heap();
  g[start] = 0;
  heap.push(Math.hypot(ex - sx, ey - sy), start);
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === goal) break;
    const ux = u % W, uy = (u - ux) / W;
    for (const [dx, dy, len] of steps) {
      const vx = ux + dx, vy = uy + dy;
      if (vx < 0 || vy < 0 || vx >= W || vy >= H) continue;
      const v = vy * W + vx;
      if (done[v]) continue;
      const nd = g[u] + len * 0.5 * (cost[u] + cost[v]);
      if (nd < g[v]) {
        g[v] = nd; prev[v] = u;
        heap.push(nd + Math.hypot(ex - vx, ey - vy), v);
      }
    }
  }
  if (!done[goal]) return null;
  const pix = [];
  for (let u = goal; u !== -1; u = prev[u]) pix.push([u % W, Math.floor(u / W)]);
  pix.reverse();
  let len = 0;
  for (let i = 1; i < pix.length; i++) len += Math.hypot(pix[i][0] - pix[i - 1][0], pix[i][1] - pix[i - 1][1]);
  if (len * mpp > dist * 2.5) return null;         // wandered off: no clear line to follow
  // smooth the pixel staircase (keeping the ends), then thin it out
  const k = 5;
  const sm = pix.map((p, i) => {
    if (i === 0 || i === pix.length - 1) return p;
    let sx2 = 0, sy2 = 0, c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(pix.length - 1, i + k); j++) { sx2 += pix[j][0]; sy2 += pix[j][1]; c++; }
    return [sx2 / c, sy2 / c];
  });
  return simplify(sm, 1.2).map(([x, y]) => [((gx0 + x + 0.5) / n) * 360 - 180, y2lat((gy0 + y + 0.5) / 256, z)]);
}
