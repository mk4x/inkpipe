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
  mkdirSync, rmSync, cpSync, existsSync, writeFileSync, readFileSync, readdirSync,
  createWriteStream,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
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

// --- workspace imports become relative paths --------------------------------
//
// Node refuses to strip TypeScript types for any file under node_modules, and
// that is not overridable by a flag. In the repository this never bites: npm
// symlinks each workspace into node_modules, Node resolves the symlink to its
// real path in packages/, and the real path is not under node_modules.
//
// The installer copies rather than links, so every symlink lands as a real
// directory and the whole application dies on its first import with
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. It did exactly that.
//
// So the shipped tree does not rely on workspace resolution at all. Bare
// "@inkpipe/x" specifiers are rewritten to relative paths into packages/, and
// the staged manifest declares no workspaces, so npm installs only the external
// dependencies. Checked below rather than assumed.

/** Where each workspace specifier actually lives, from its exports map. */
const WORKSPACE = new Map(Object.entries({
  '@inkpipe/crypto': 'packages/crypto/src/index.ts',
  '@inkpipe/crypto/recovery': 'packages/crypto/src/recovery.ts',
  '@inkpipe/protocol': 'packages/protocol/src/index.ts',
  '@inkpipe/client': 'packages/client/src/index.ts',
  '@inkpipe/quality': 'packages/quality/src/index.ts',
  '@inkpipe/imaging': 'packages/imaging/src/index.ts',
}));

function sourceFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

let rewritten = 0;
for (const file of sourceFilesUnder(STAGE)) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /(['"])(@inkpipe\/[a-z/-]+)\1/g,
    (whole, quote, specifier) => {
      const target = WORKSPACE.get(specifier);
      if (!target) throw new Error(`unmapped workspace import ${specifier} in ${file}`);
      let rel = relative(dirname(file), join(STAGE, target)).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      return `${quote}${rel}${quote}`;
    },
  );
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}
console.log(`rewrote workspace imports in ${rewritten} files`);

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
  // Deliberately no "workspaces". See the rewrite above: declaring them
  // recreates node_modules/@inkpipe, and the installer would copy TypeScript
  // under node_modules where Node refuses to strip its types.
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

// --- the checks that would have caught the broken installer -----------------
//
// The first build installed cleanly, created its shortcuts, and then died on
// its first import. Everything about it looked right from the outside, which is
// exactly why these are assertions rather than a careful reading.

const problems = [];

// 1. No TypeScript under node_modules. Node cannot strip it and says so at
//    runtime, which is the failure that shipped.
const modules = join(STAGE, 'node_modules', '@inkpipe');
if (existsSync(modules)) {
  problems.push('node_modules/@inkpipe exists, so workspace TypeScript will ship under node_modules');
}

// 2. No bare workspace specifier survived the rewrite.
for (const file of sourceFilesUnder(STAGE).filter((f) => !f.includes('node_modules'))) {
  if (/['"]@inkpipe\//.test(readFileSync(file, 'utf8'))) {
    problems.push(`${relative(STAGE, file)} still imports a bare @inkpipe specifier`);
  }
}

// 3. The rewrite actually did something. A silent no-op here would leave the
//    same bug with a reassuring log line above it.
if (rewritten === 0) problems.push('no files were rewritten, which cannot be right');

// 4. It starts. The only check that would have caught this without knowing
//    what to look for, so it runs last and it runs for real.
if (!skipNode) {
  console.log('\nchecking that the staged application actually starts');
  try {
    execFileSync(join(STAGE, 'runtime', 'node.exe'), [
      '--experimental-strip-types',
      '--input-type=module',
      '-e', "await import('./apps/desktop/service/src/api.ts'); console.log('imports fine');",
    ], { cwd: STAGE, stdio: 'inherit', timeout: 120_000 });
  } catch (error) {
    problems.push(`the staged application does not start: ${error.message.split('\n')[0]}`);
  }
}

if (problems.length > 0) {
  console.error('\nSTAGE IS BROKEN:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\nstage complete:', STAGE);
