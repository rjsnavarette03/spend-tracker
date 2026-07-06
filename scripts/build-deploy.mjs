// Assembles the ready-to-upload site in deploy/:
//   deploy/
//     index.html, assets/, icon.png     <- built frontend (dist/)
//     .htaccess                         <- rewrites + security headers
//     api/index.php                     <- API front controller
//     api/app/{lib,schema,.htaccess}    <- application internals (web-blocked)
//     router.php                        <- local `php -S` testing only
// Run `npm run build` first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const server = path.join(root, 'server');
const deploy = path.join(root, 'deploy');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

// Clear contents rather than removing the folder itself — a dev server
// with its CWD inside deploy/ would otherwise make the rmdir fail (EBUSY).
fs.mkdirSync(deploy, { recursive: true });
for (const entry of fs.readdirSync(deploy)) {
  fs.rmSync(path.join(deploy, entry), { recursive: true, force: true });
}

fs.cpSync(dist, deploy, { recursive: true });
fs.copyFileSync(path.join(server, 'public', '.htaccess'), path.join(deploy, '.htaccess'));
fs.copyFileSync(path.join(server, 'router.php'), path.join(deploy, 'router.php'));

fs.mkdirSync(path.join(deploy, 'api', 'app', 'lib'), { recursive: true });
fs.copyFileSync(path.join(server, 'api', 'index.php'), path.join(deploy, 'api', 'index.php'));
for (const f of fs.readdirSync(path.join(server, 'api', 'app', 'lib'))) {
  fs.copyFileSync(
    path.join(server, 'api', 'app', 'lib', f),
    path.join(deploy, 'api', 'app', 'lib', f)
  );
}
fs.copyFileSync(
  path.join(server, 'api', 'app', 'config.sample.php'),
  path.join(deploy, 'api', 'app', 'config.sample.php')
);
fs.copyFileSync(
  path.join(server, 'api', 'app', '.htaccess'),
  path.join(deploy, 'api', 'app', '.htaccess')
);
fs.copyFileSync(
  path.join(server, 'schema.mysql.sql'),
  path.join(deploy, 'api', 'app', 'schema.mysql.sql')
);
fs.copyFileSync(
  path.join(server, 'schema.sqlite.sql'),
  path.join(deploy, 'api', 'app', 'schema.sqlite.sql')
);

console.log('Assembled', deploy);
