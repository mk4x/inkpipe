// Assemble everything the installer ships, into build/stage.
//
// ADR 0005. Three things go in the installer and each is here for a reason.
//
//   the app          TypeScript, run directly by Node 24's type stripping, so
//                    there is no build step for anything except the interface
//   node_modules     production only, and it must be installed ON Windows
//                    because sharp ships a platform specific binary
//   a Node runtime   downloaded and unpacked, so the machine needs nothing
//                    installed beforehand. Decision 25: setup does everything
//
// A single executable was considered and does not work here. Node's SEA cannot
// embed a native addon, and sharp is one.
//
//   node scripts/stage-app.mjs [--skip-node]

import { execFileSync } from 'node:child_process';
import {
  mkdirSync, rmSync, cpSync, existsSync, writeFileSync, readFileSync, createWriteStream,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const STAGE = join(BUILD, 'stage');
const NODE_VERSION = 'v24.19.0';
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;

const skipNode = process.argv.includes('--skip-node');

/** Source that ships. Tests, corpus images and spikes stay out: they are
 *  development scaffolding and the corpus alone is tens of megabytes. */
const SOURCE = [
  'apps/agent/src',
  'apps/desktop/service/src',
  'apps/desktop/launcher/src',
  'apps/desktop/ui/dist',
  'apps/server/src',
  'packages/client/src',
  'packages/crypto/src',
  'packages/imaging/src',
  'packages/protocol/src',
  'packages/quality/src',
];

const MANIFESTS = [
  'apps/agent/package.json',
  'apps/desktop/package.json',
  'apps/server/package.json',
  'packages/client/package.json',
  'packages/crypto/package.json',
  'packages/imaging/package.json',
  'packages/protocol/package.json',
  'packages/quality/package.json',
];

console.log('staging into', STAGE);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// --- source ----------------------------------------------------------------

if (!existsSync(join(ROOT, 'apps/desktop/ui/dist'))) {
  console.error('The interface is not built. Run "npm run ui:build" first.');
  process.exit(1);
}

for (const dir of SOURCE) {
  cpSync(join(ROOT, dir), join(STAGE, dir), { recursive: true });
}
for (const manifest of MANIFESTS) {
  cpSync(join(ROOT, manifest), join(STAGE, manifest));
}
console.log(`copied ${SOURCE.length} source directories`);

// --- dependencies ----------------------------------------------------------

// The root manifest, minus everything only needed to build. The interface is
// already built, so vite, react and the type packages do not ship.
const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const runtimeOnly = { ...root.dependencies };
for (const buildOnly of ['react', 'react-dom', 'qrcode']) delete runtimeOnly[buildOnly];

writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify({
  name: 'inkpipe',
  version: root.version,
  private: true,
  type: 'module',
  workspaces: ['apps/*', 'packages/*'],
  dependencies: runtimeOnly,
}, null, 2)}\n`);

console.log('installing production dependencies (sharp needs its Windows binary)');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: STAGE,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// --- the Node runtime ------------------------------------------------------

if (!skipNode) {
  const zipPath = join(BUILD, NODE_ZIP);
  if (!existsSync(zipPath)) {
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;
    console.log('downloading', url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`node download failed: ${response.status}`);
    mkdirSync(BUILD, { recursive: true });
    await pipeline(response.body, createWriteStream(zipPath));
  }

  console.log('unpacking the runtime');
  const runtime = join(STAGE, 'runtime');
  rmSync(runtime, { recursive: true, force: true });

  // Extract, then rename the single top level directory to "runtime".
  // --strip-components is not honoured for zip archives by the bsdtar that
  // ships with Windows, and fails with status 128 rather than saying so.
  const unpacked = join(BUILD, 'unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });

  // PowerShell rather than tar. The tar on PATH depends on which shell invoked
  // this: Windows ships bsdtar, which reads zip, but Git Bash shadows it with
  // GNU tar, which does not, and reports "does not look like a tar archive".
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${unpacked}' -Force`,
  ], { stdio: 'inherit' });

  const inner = join(unpacked, `node-${NODE_VERSION}-win-x64`);
  if (!existsSync(inner)) throw new Error(`expected ${inner} inside the archive`);

  // Only node.exe. The archive also carries npm, its dependencies, headers and
  // documentation, which is about 26 MB that nothing here ever runs: the
  // launcher is started by absolute path and dependencies ship pre-installed.
  mkdirSync(runtime, { recursive: true });
  cpSync(join(inner, 'node.exe'), join(runtime, 'node.exe'));
  rmSync(unpacked, { recursive: true, force: true });

  if (!existsSync(join(runtime, 'node.exe'))) {
    throw new Error('node.exe is not where it was expected after unpacking');
  }
  console.log(`bundled Node ${NODE_VERSION}`);
}

console.log('\nstage complete:', STAGE);
