// Dev workflow: start the Vite dev server, build the main process once,
// then launch Electron pointed at the dev server (with HMR for the UI).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5173;
const DEV_URL = `http://localhost:${PORT}`;

// Vite binds to "localhost", which may be IPv6-only (::1) on Windows,
// so probe over HTTP with hostname resolution instead of a raw IPv4 socket.
async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { method: 'HEAD' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Vite dev server did not respond at ${url}`);
}

function runNode(script, args = []) {
  return spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
}

// 1. Build main process + preload (they don't hot reload; restart dev for changes).
await new Promise((resolve, reject) => {
  const p = runNode(path.join(root, 'scripts', 'build-main.mjs'));
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('main build failed'))));
});

// 2. Start Vite. vite's "exports" map hides ./bin, so resolve via package.json.
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const vite = runNode(viteBin);
try {
  await waitForServer(DEV_URL);
} catch (err) {
  vite.kill();
  throw err;
}

// 3. Launch Electron.
const electronPath = require('electron');
const electron = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
});

const shutdown = () => {
  try { vite.kill(); } catch { /* already dead */ }
  try { electron.kill(); } catch { /* already dead */ }
};
electron.on('exit', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
