// Elevation for Node tools: reads the area pack's dem.pmtiles (FABDEM terrarium, z12) from data/area/ and samples it
// bilinearly - the same numbers the phone uses for slope and the profile.
import { open } from 'node:fs/promises';
import { PMTiles } from 'pmtiles';
import { PNG } from 'pngjs';

class FileSource {
  constructor(path) { this.path = path; this.fh = null; }
  getKey() { return this.path; }
  async getBytes(offset, length) {
    this.fh ??= await open(this.path, 'r');
    const buf = Buffer.alloc(length);
    await this.fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

export function demSampler(path, z = 12) {
  const pm = new PMTiles(new FileSource(path));
  const cache = new Map();
  const tile = async (x, y) => {
    const k = `${x}/${y}`;
    if (!cache.has(k)) {
      cache.set(k, (async () => {
        const r = await pm.getZxy(z, x, y);
        if (!r) return null;
        const png = PNG.sync.read(Buffer.from(r.data));
        const out = new Float32Array(256 * 256);
        for (let i = 0; i < out.length; i++) out[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
        return out;
      })());
    }
    return cache.get(k);
  };
  const n = 2 ** z;
  return async (lon, lat) => {
    const fx = ((lon + 180) / 360) * n * 256 - 0.5;
    const r = (lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const px = async (gx, gy) => {
      const t = await tile(Math.floor(gx / 256), Math.floor(gy / 256));
      return t ? t[(gy & 255) * 256 + (gx & 255)] : null;
    };
    const [a, b, c, d] = await Promise.all([px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1)]);
    if (a == null || b == null || c == null || d == null) return a ?? b ?? c ?? d ?? null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}
