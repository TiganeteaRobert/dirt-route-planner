// Download manager: stores tiles of the offline sources for an area (riding area, screen, or a track corridor) and a
// zoom range. Polite by design: inside the riding area only, 4-6 parallel requests, exponential backoff on 429/5xx,
// pauses while the phone is offline. Jobs live in IndexedDB, so a closed app resumes where it stopped (tiles already
// stored are skipped).
import { SOURCES } from './config.js';
import { settings } from './settings.js';
import * as db from './db.js';
import { fetchTile, HttpError } from './tiles.js';
import { areaTiles } from '../../core/area.js';
import { tileKey } from '../../core/tilemath.js';
import * as wake from './wakelock.js';

const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

const waitOnline = (signal) => new Promise((res) => {
  if (navigator.onLine) return res();
  const on = () => { window.removeEventListener('online', on); res(); };
  window.addEventListener('online', on);
  signal?.addEventListener('abort', on, { once: true });
});

// Zoom range a source gets in a job (elevation always z8-12: it is what hillshade and slope use).
export function sourceZooms(src, zmin, zmax) {
  const s = SOURCES[src];
  if (s.downloadZoom) return s.downloadZoom;
  return [Math.max(zmin, s.minzoom ?? 0), Math.min(zmax, s.maxzoom)];
}

// Average stored tile size for a source: measured once enough tiles are stored, else the config guess.
export function avgBytes(src, stats) {
  const st = stats?.[src];
  return st && st.count > 50 && st.bytes > 0 ? st.bytes / st.count : SOURCES[src].avgKB * 1024;
}

export function estimateJob(job, stats) {
  const rows = [];
  for (const src of job.sources) {
    const [z0, z1] = sourceZooms(src, job.zmin, job.zmax);
    let tiles = 0;
    for (let z = z0; z <= z1; z++) tiles += areaTiles(job.area, z, settings.area).count;
    rows.push({ src, z0, z1, tiles, bytes: tiles * avgBytes(src, stats) });
  }
  return { rows, tiles: rows.reduce((a, r) => a + r.tiles, 0), bytes: rows.reduce((a, r) => a + r.bytes, 0) };
}

class Downloader extends EventTarget {
  constructor() {
    super();
    this.job = null;           // the running job
    this.abort = null;
    this.writes = [];
    this.lastEmit = 0;
  }

  async jobs() {
    return (await db.getAll('jobs')).sort((a, b) => a.created - b.created);
  }

  // Called at start-up: a job that was running when the app closed becomes paused.
  async init() {
    for (const j of await this.jobs()) {
      if (j.status === 'running') { j.status = 'paused'; await db.put('jobs', j); }
    }
    this.emit(true);
  }

  async add(spec) {
    const job = {
      id: `job-${Date.now().toString(36)}`, created: Date.now(), status: 'queued',
      name: spec.name, sources: spec.sources, area: spec.area, zmin: spec.zmin, zmax: spec.zmax,
      progress: { done: 0, total: 0, stored: 0, skipped: 0, none: 0, failed: 0, bytes: 0, errors: {} },
    };
    await db.put('jobs', job);
    this.emit(true);
    this.next();
    return job;
  }

  async next() {
    if (this.job) return;
    const j = (await this.jobs()).find((x) => x.status === 'queued');
    if (j) this.run(j);
  }

  async pause(id) {
    if (this.job?.id === id) { this.job.status = 'paused'; this.abort.abort(); return; }
    const j = await db.get('jobs', id);
    if (j && j.status === 'queued') { j.status = 'paused'; await db.put('jobs', j); this.emit(true); }
  }

  async resume(id) {
    const j = await db.get('jobs', id);
    if (!j || j.status === 'running') return;
    j.status = 'queued';
    await db.put('jobs', j);
    this.emit(true);
    this.next();
  }

  async remove(id) {
    if (this.job?.id === id) { this.job.status = 'cancelled'; this.abort.abort(); }
    await db.del('jobs', id);
    this.emit(true);
  }

  async run(job) {
    this.job = job;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    job.status = 'running';
    job.started = Date.now();
    const p = job.progress;
    Object.assign(p, { done: 0, stored: 0, skipped: 0, none: 0, failed: 0, bytes: 0, errors: {} });
    wake.want('download', true);
    try { await navigator.storage?.persist?.(); } catch { /* not granted: data is still kept unless space runs out */ }

    // The plan: one step per source and zoom, all clipped to the riding area.
    const steps = [];
    for (const src of job.sources) {
      const [z0, z1] = sourceZooms(src, job.zmin, job.zmax);
      for (let z = z0; z <= z1; z++) steps.push({ src, z, list: areaTiles(job.area, z, settings.area) });
    }
    p.total = steps.reduce((a, s) => a + s.list.count, 0);
    await db.put('jobs', job);
    this.emit(true);

    try {
      for (const step of steps) {
        if (signal.aborted) break;
        const have = await db.storedKeys(step.src, step.z);
        const queue = [];
        for (const [x, y] of step.list) {
          if (have.has(tileKey(step.src, step.z, x, y))) { p.skipped++; p.done++; } else queue.push([x, y]);
        }
        this.emit();
        await this.pool(step.src, step.z, queue, signal);
        await this.flush();
        await db.put('jobs', job);
      }
    } finally {
      await this.flush();
      if (job.status === 'running') job.status = p.failed ? 'done-errors' : 'done';
      job.finished = Date.now();
      if (job.status !== 'cancelled') await db.put('jobs', job);
      this.job = null;
      wake.want('download', false);
      this.emit(true);
      this.next();
    }
  }

  async pool(src, z, queue, signal) {
    let i = 0;
    const worker = async () => {
      while (i < queue.length && !signal.aborted) {
        const [x, y] = queue[i++];
        await this.fetchOne(src, z, x, y, signal);
      }
    };
    const n = Math.max(1, Math.min(6, settings.concurrency | 0));
    await Promise.all(Array.from({ length: n }, worker));
  }

  async fetchOne(src, z, x, y, signal) {
    const p = this.job.progress;
    const key = tileKey(src, z, x, y);
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return;
      if (!navigator.onLine) await waitOnline(signal);
      try {
        const t = await fetchTile(src, z, x, y, AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : signal);
        if (t.none) {
          this.queueWrite({ key, b: null, n: 0, d: null });
          p.none++;
        } else {
          this.queueWrite({ key, b: new Blob([t.buf], { type: t.type }), n: t.buf.byteLength, d: t.date });
          p.stored++;
          p.bytes += t.buf.byteLength;
        }
        p.done++;
        this.emit();
        return;
      } catch (e) {
        if (signal.aborted) return;
        const st = e instanceof HttpError ? e.status : 0;
        if (st === 404) {                                 // nothing there: remember it, do not ask again
          this.queueWrite({ key, b: null, n: 0, d: null });
          p.none++; p.done++; this.emit();
          return;
        }
        const retry = st === 0 || st === 408 || st === 429 || st >= 500;
        if (!retry || attempt >= 6) {
          p.failed++; p.done++;
          p.errors[src] = `${st ? `HTTP ${st}` : e.message} (${p.failed} tiles failed)`;
          this.emit();
          return;
        }
        await sleep(Math.min(60000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5), signal);
      }
    }
  }

  queueWrite(rec) {
    this.writes.push(rec);
    if (this.writes.length >= 32) this.flush();
  }

  async flush() {
    if (!this.writes.length) return;
    const batch = this.writes;
    this.writes = [];
    try {
      await db.putTiles(batch);
    } catch (e) {
      const p = this.job?.progress;
      if (p) { p.failed += batch.length; p.errors.storage = `Saving failed: ${e.message}`; }
      if (e.name === 'QuotaExceededError' && this.job) { this.job.status = 'paused'; this.abort.abort(); }
    }
  }

  // Progress events, at most 4 a second unless forced.
  emit(force = false) {
    const now = performance.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.dispatchEvent(new CustomEvent('change', { detail: this.job }));
  }
}

export const downloader = new Downloader();
