// Keeps the screen on while any reason wants it (riding, recording, downloading).
const reasons = new Set();
let sentinel = null;
let pending = null;

async function sync() {
  if (pending) await pending;
  if (reasons.size && !sentinel && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    pending = navigator.wakeLock.request('screen').then((s) => {
      sentinel = s;
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
    }).catch(() => {}).finally(() => { pending = null; });
    await pending;
  } else if (!reasons.size && sentinel) {
    const s = sentinel;
    sentinel = null;
    await s.release().catch(() => {});
  }
}

export function want(reason, on) {
  if (on) reasons.add(reason); else reasons.delete(reason);
  return sync();
}

export const supported = () => 'wakeLock' in navigator;
export const active = () => !!sentinel;

// The lock drops when the app is hidden; take it again when it comes back.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
