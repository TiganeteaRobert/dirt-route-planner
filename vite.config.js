import { defineConfig } from 'vite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const publicDir = join(root, 'app', 'public');

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(relative(publicDir, p).split(sep).join('/'));
  }
  return out;
}

// Emits sw.js with every built file in its precache list, so the installed app opens with no network.
function serviceWorker() {
  return {
    name: 'dirtscout-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const files = new Set([...Object.keys(bundle), ...listFiles(publicDir), 'index.html']);
      // pack/ (the area pack, tens of MB) is downloaded on request, not precached with the app shell
      const list = [...files].filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.startsWith('pack/')).sort();
      const hash = createHash('sha256');
      for (const f of list) {
        hash.update(f);
        const item = bundle[f];
        if (item) hash.update(item.type === 'chunk' ? item.code : item.source);
        else if (f !== 'index.html') hash.update(readFileSync(join(publicDir, f)));
      }
      const version = `${pkg.version}-${hash.digest('hex').slice(0, 10)}`;
      const source = readFileSync(join(root, 'app', 'sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(['./', ...list]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root: join(root, 'app'),
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: join(root, 'dist'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2500 },
  server: { port: 5173, strictPort: true, fs: { allow: [root] } },
  preview: { port: 4173, strictPort: true },
  plugins: [serviceWorker()],
});
