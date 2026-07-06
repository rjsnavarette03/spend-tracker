// Bundles the Electron main process and preload script with esbuild and
// copies the sql.js wasm binary next to them. sql.js is bundled into
// main.js, so the packaged app does not need node_modules at all.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-electron');

await build({
  entryPoints: [path.join(root, 'electron', 'main.ts'), path.join(root, 'electron', 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outdir: outDir,
  external: ['electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

const wasmSrc = path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDest = path.join(outDir, 'sql-wasm.wasm');
fs.copyFileSync(wasmSrc, wasmDest);
console.log('Copied sql-wasm.wasm ->', path.relative(root, wasmDest));
