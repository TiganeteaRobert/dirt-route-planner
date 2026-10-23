// The owner's private AI bundle (pipeline/ai_bundle.py): tracks DirtScout's model found in Esri imagery, as vector
// tiles for the map, plus a routing graph with them, encrypted. File: "DSAI" | 1 | salt (16) | iv (12) | PBKDF2
// iterations (u32 BE) | AES-256-GCM ciphertext + tag; key = PBKDF2-SHA256 of the passphrase (lower case, no spaces).
// Plaintext: "DSB2" | three u32 BE lengths | meta JSON | graph JSON gzipped | tiles (PMTiles).
// WebCrypto only, no DOM: runs on the phone and in Node.

export const normPass = (p) => String(p ?? '').toLowerCase().replace(/\s+/g, '');

export class WrongPassphrase extends Error {
  constructor() { super('wrong passphrase'); this.name = 'WrongPassphrase'; }
}

const ascii = (u8, a, b) => String.fromCharCode(...u8.subarray(a, b));

// ArrayBuffer | Uint8Array -> {meta, graphGz: Uint8Array, tiles: Uint8Array}
export async function decryptBundle(buf, pass) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 54 || ascii(u8, 0, 4) !== 'DSAI' || u8[4] !== 1) throw new Error('not a DirtScout AI file');
  const salt = u8.slice(5, 21), iv = u8.slice(21, 33);
  const iterations = new DataView(u8.buffer, u8.byteOffset + 33, 4).getUint32(0);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normPass(pass)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, u8.subarray(37)));
  } catch {
    throw new WrongPassphrase();
  }
  if (ascii(plain, 0, 4) !== 'DSB2') throw new Error('this AI file needs a newer DirtScout: reload the app');
  const dv = new DataView(plain.buffer, plain.byteOffset + 4, 12);
  const lm = dv.getUint32(0), lg = dv.getUint32(4), lt = dv.getUint32(8);
  const at = 16;
  return {
    meta: JSON.parse(new TextDecoder().decode(plain.subarray(at, at + lm))),
    graphGz: plain.slice(at + lm, at + lm + lg),
    tiles: plain.slice(at + lm + lg, at + lm + lg + lt),
  };
}

// gzipped JSON (Blob or bytes) -> object
export async function gunzipJson(data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  return JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
