// GPS position (works in airplane mode; the first fix is slower without network help) and ride recording.
// Recording keeps every fix in IndexedDB as it comes, so a reload or a crash loses nothing.
import * as db from './db.js';
import * as wake from './wakelock.js';
import { haversine, bearing } from '../../core/geo.js';

const REC_KEY = 'dirtscout.recording';

class GPS extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.last = null;          // {lon, lat, acc, alt, heading, speed, t}
    this.error = null;
  }

  get on() { return this.watchId !== null; }

  start() {
    if (this.on || !('geolocation' in navigator)) return;
    this.error = null;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        const prev = this.last;
        const fix = {
          lon: c.longitude, lat: c.latitude, acc: c.accuracy, alt: c.altitude, heading: c.heading,
          speed: c.speed, t: p.timestamp,
        };
        // Some phones leave speed/heading empty: work them out from the previous fix when it moved clearly.
        if (prev && (fix.speed == null || Number.isNaN(fix.speed) || fix.heading == null || Number.isNaN(fix.heading))) {
          const dt = (fix.t - prev.t) / 1000;
          const d = haversine([prev.lon, prev.lat], [fix.lon, fix.lat]);
          const moved = d > Math.max(2, fix.acc * 0.5);
          if (fix.speed == null || Number.isNaN(fix.speed)) fix.speed = dt >= 0.5 && dt <= 15 ? (moved ? d / dt : 0) : null;
          if ((fix.heading == null || Number.isNaN(fix.heading)) && moved) fix.heading = bearing([prev.lon, prev.lat], [fix.lon, fix.lat]);
        }
        this.last = fix;
        this.error = null;
        this.dispatchEvent(new CustomEvent('fix', { detail: this.last }));
      },
      (e) => {
        this.error = e.code === 1 ? 'Location permission denied' : e.code === 3 ? 'Waiting for GPS…' : 'GPS unavailable';
        this.dispatchEvent(new CustomEvent('gpserror', { detail: this.error }));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 },
    );
    this.dispatchEvent(new Event('state'));
  }

  stop() {
    if (!this.on) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.dispatchEvent(new Event('state'));
  }
}

export const gps = new GPS();

// Distance only grows on good fixes that moved more than the noise, so a parked bike does not add kilometres.
class Recorder extends EventTarget {
  constructor() {
    super();
    this.rec = null;           // {id, started, n, dist, moving, maxSpeed, climb, lastGood, lastT, lastEle}
    this.onFix = (e) => this.add(e.detail);
  }

  get on() { return !!this.rec; }

  async start() {
    this.rec = { id: `rec-${Date.now().toString(36)}`, started: Date.now(), n: 0, dist: 0, moving: 0, maxSpeed: 0, climb: 0 };
    this.persist();
    this.begin();
  }

  // Picks up a recording that was running when the app closed.
  async resume() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(REC_KEY) || 'null'); } catch { /* none */ }
    if (!saved) return false;
    this.rec = saved;
    this.begin();
    return true;
  }

  begin() {
    gps.addEventListener('fix', this.onFix);
    gps.start();
    wake.want('record', true);
    this.dispatchEvent(new Event('state'));
  }

  persist() {
    try { localStorage.setItem(REC_KEY, JSON.stringify(this.rec)); } catch { /* best effort */ }
  }

  async add(f) {
    const r = this.rec;
    if (!r || f.acc > 100) return;
    const p = { r: r.id, i: r.n++, t: f.t, lat: f.lat, lon: f.lon, ele: f.alt, acc: f.acc, spd: f.speed };
    db.addRecPoint(p).catch(() => {});
    if (f.acc <= 25) {
      const here = [f.lon, f.lat];
      if (!r.lastGood) {
        r.lastGood = here; r.lastT = f.t;
      } else {
        const d = haversine(r.lastGood, here);
        if (d >= Math.max(3, f.acc * 0.5)) {
          const dt = (f.t - r.lastT) / 1000;
          r.dist += d;
          if (dt > 0 && dt < 30 && d / dt > 1) r.moving += dt;
          r.lastGood = here; r.lastT = f.t;
        }
      }
      if (f.alt != null && f.acc <= 15) {
        if (r.lastEle != null && f.alt - r.lastEle > 2) { r.climb += f.alt - r.lastEle; r.lastEle = f.alt; }
        else if (r.lastEle == null || f.alt < r.lastEle) r.lastEle = f.alt;
      }
    }
    if (f.speed != null && f.speed > r.maxSpeed && f.acc <= 25) r.maxSpeed = f.speed;
    if (r.n % 5 === 0) this.persist();
    this.dispatchEvent(new CustomEvent('point', { detail: p }));
  }

  // Ends the recording; returns {id, started, ended, points, stats} or null when nothing was recorded.
  async stop() {
    const r = this.rec;
    if (!r) return null;
    gps.removeEventListener('fix', this.onFix);
    wake.want('record', false);
    this.rec = null;
    try { localStorage.removeItem(REC_KEY); } catch { /* fine */ }
    this.dispatchEvent(new Event('state'));
    const points = await db.recPoints(r.id);
    if (points.length < 2) { await db.deleteRecPoints(r.id); return null; }
    return {
      id: r.id, started: r.started, ended: Date.now(), points,
      stats: { dist: r.dist, moving: r.moving, maxSpeed: r.maxSpeed, climb: r.climb },
    };
  }

  // Points so far (for drawing the live line).
  points() { return this.rec ? db.recPoints(this.rec.id) : Promise.resolve([]); }
}

export const recorder = new Recorder();
