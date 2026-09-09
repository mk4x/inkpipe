// Guard: the shared packages must not use Node-only globals.
//
// @inkpipe/crypto, /protocol and /client all run in three places: Node on the
// server, Node in the desktop sidecar, and Hermes on the phone. Node globals
// work in two of those and throw in the third.
//
// This is exactly the class of bug no other test can catch. `Buffer` worked in
// every unit test, every integration test and the whole desktop app, and then
// the phone died with "Property 'Buffer' doesn't exist" the first time a user
// tried to pair. The failure needs a device, so the guard has to be static.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Packages the phone bundles. Anything here must be platform neutral. */
const SHARED = ['packages/crypto/src', 'packages/protocol/src', 'packages/client/src'];

/** Globals that exist in Node and not in React Native's Hermes runtime. */
const NODE_ONLY = [
  { name: 'Buffer', pattern: /\bBuffer\s*\./ },
  { name: 'process.env', pattern: /\bprocess\s*\.\s*env\b/ },
  { name: 'require(node:...)', pattern: /require\(\s*['"]node:/ },
  { name: "import 'node:...'", pattern: /from\s+['"]node:/ },
  { name: '__dirname', pattern: /\b__dirname\b/ },
  { name: 'globalThis.process', pattern: /globalThis\s*\.\s*process\b/ },
];

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const full = join(absolute, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(join(dir, entry)));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so a mention in a note does not trip the guard. The comment
 *  above this very file names Buffer on purpose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('shared packages stay portable', () => {
  for (const dir of SHARED) {
    for (const file of sourceFiles(dir)) {
      const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/');

      test(`${relative} uses no Node-only globals`, () => {
        const code = stripComments(readFileSync(file, 'utf8'));
        for (const { name, pattern } of NODE_ONLY) {
          assert.equal(
            pattern.test(code),
            false,
            `${relative} uses ${name}, which does not exist on the phone. ` +
            'Use a portable equivalent: @scure/base for encoding, ' +
            'globalThis.crypto for randomness.',
          );
        }
      });
    }
  }

  test('the guard actually detects a violation', () => {
    // Without this, a broken regex would let everything through silently, the
    // same way the em dash checker once did.
    const offending = 'const x = Buffer.from("abc");';
    const buffer = NODE_ONLY.find((g) => g.name === 'Buffer')!;
    assert.equal(buffer.pattern.test(stripComments(offending)), true);
  });

  test('the guard ignores mentions inside comments', () => {
    const commentary = '// Buffer.from is Node only\n/* Buffer.from too */\nconst x = 1;';
    const buffer = NODE_ONLY.find((g) => g.name === 'Buffer')!;
    assert.equal(buffer.pattern.test(stripComments(commentary)), false);
  });
});
