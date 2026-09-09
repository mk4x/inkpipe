// Build the Windows installer, end to end.
//
//   npm run installer
//
// Builds the interface, stages the app with a bundled Node runtime, then runs
// the Inno Setup compiler. The compiler is found rather than assumed: winget
// installs it under the user profile while the documentation and most guides
// point at Program Files, so hardcoding either one fails for somebody.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISS = join(ROOT, 'apps/desktop/installer/inkpipe.iss');

if (process.platform !== 'win32') {
  console.error('The installer is Windows only. ADR 0005 has the reasoning.');
  process.exit(1);
}

/** Every place ISCC.exe realistically lives. */
function findCompiler() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ];
  return candidates.find(existsSync) ?? null;
}

const compiler = findCompiler();
if (!compiler) {
  console.error('Inno Setup was not found. Install it with:');
  console.error('  winget install --id JRSoftware.InnoSetup');
  process.exit(1);
}

console.log('building the interface');
execFileSync('npm', ['run', 'ui:build'], { cwd: ROOT, stdio: 'inherit', shell: true });

console.log('\nstaging');
execFileSync(process.execPath, [join(ROOT, 'scripts/stage-app.mjs')], { cwd: ROOT, stdio: 'inherit' });

console.log('\ncompiling the installer');
execFileSync(compiler, [ISS], { cwd: dirname(ISS), stdio: 'inherit' });

console.log('\ndone. The installer is in build/');
