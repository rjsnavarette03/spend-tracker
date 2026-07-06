// Runs the app in --smoke-test mode and mirrors its exit code.
// The main process writes PASS/FAIL to smoke-result.txt as well.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = require('electron');

const extraArgs = process.argv.slice(2); // e.g. --smoke-shot=path/to/shot.png
const child = spawn(electronPath, ['.', '--smoke-test', ...extraArgs], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
