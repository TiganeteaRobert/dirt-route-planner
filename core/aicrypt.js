// The owner's private AI bundle (pipeline/ai_bundle.py): tracks DirtScout's model found in Esri imagery plus a routing
// graph with them, gzipped and encrypted. Format: "DSAI" | 1 | salt (16) | iv (12) | PBKDF2 iterations (u32 BE) |
// AES-256-GCM ciphertext + tag; key = PBKDF2-SHA256 of the passphrase (lower case, no spaces). WebCrypto only, no DOM:
// runs on the phone and in Node.

export const normPass = (p) => String(p ?? '').toLowerCase().replace(/\s+/g, '');

export class WrongPassphrase extends Error {
  constructor() { super('wrong passphrase'); this.name = 'WrongPassphrase'; }
}

// ArrayBuffer | Uint8Array -> the bundle object {v, version, built, base, stats, graph, ai}.
export async function decryptBundle(buf, pass) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 54 || String.fromCharCode(...u8.subarray(0, 4)) !== 'DSAI' || u8[4] !== 1) {
    throw new Error('not a DirtScout AI file');
  }
  const salt = u8.slice(5, 21), iv = u8.slice(21, 33);
  const iterations = new DataView(u8.buffer, u8.byteOffset + 33, 4).getUint32(0);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normPass(pass)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, u8.subarray(37));
  } catch {
    throw new WrongPassphrase();
  }
  const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return { text, data: JSON.parse(text) };
}
