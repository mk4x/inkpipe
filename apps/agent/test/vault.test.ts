// Real git repositories in temp directories. No mocks: the failure modes worth
// testing here (dirty tree, diverged remote, conflict) only exist in real git.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  writeNote, push, isDirty, resolveInside, plannedPaths, VaultError, COMMIT_PREFIX,
  classifyPushFailure,
  type VaultConfig,
} from '../src/vault.ts';

let root: string;
let remote: string;
let config: VaultConfig;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  remote = mkdtempSync(join(tmpdir(), 'inkpipe-remote-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);

  root = mkdtempSync(join(tmpdir(), 'inkpipe-vault-'));
  execFileSync('git', ['init', '-b', 'main', root]);
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), '# vault\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');

  config = { root, notesPath: 'School/Semester 5', attachmentsPath: 'Images' };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

const note = (over: Partial<Parameters<typeof writeNote>[1]> = {}) => ({
  course: 'Algorithms',
  title: 'Leftist Heaps',
  markdown: '# Leftist Heaps\n\nrank is distance to nil.\n',
  images: [{ filename: 'page-b.webp', bytes: new Uint8Array([1, 2, 3, 4]) }],
  ...over,
});

describe('resolveInside', () => {
  test('resolves an ordinary path', () => {
    assert.equal(resolveInside(root, 'a', 'b.md'), join(root, 'a', 'b.md'));
  });

  test('refuses to escape the vault', () => {
    for (const attack of ['../outside.md', '../../etc/passwd', join('a', '..', '..', 'x')]) {
      assert.throws(() => resolveInside(root, attack), VaultError, `escaped with ${attack}`);
    }
  });

  test('refuses an absolute path that lands elsewhere', () => {
    assert.throws(() => resolveInside(root, tmpdir()), VaultError);
  });
});

describe('plannedPaths', () => {
  test('sanitises a hostile title into the vault', () => {
    const planned = plannedPaths(config, note({ title: '../../../evil', course: '../..' }));
    assert.ok(planned.notePath.startsWith(root), 'must stay under the vault root');
    assert.ok(!planned.notePath.includes('..'));
  });

  test('is pure: it writes nothing', () => {
    const planned = plannedPaths(config, note());
    assert.equal(existsSync(planned.notePath), false);
  });
});

describe('writeNote', () => {
  test('writes the note and its images, and commits', async () => {
    const result = await writeNote(config, note());

    assert.equal(readFileSync(result.notePath, 'utf8'), '# Leftist Heaps\n\nrank is distance to nil.\n');
    assert.deepEqual(new Uint8Array(readFileSync(result.imagePaths[0])), new Uint8Array([1, 2, 3, 4]));
    assert.equal(result.committed, true);
    assert.match(result.commitSha!, /^[0-9a-f]{40}$/);
  });

  test('the commit message carries the prefix, so it can be found and reverted', async () => {
    await writeNote(config, note());
    assert.ok(git(root, 'log', '-1', '--pretty=%s').startsWith(COMMIT_PREFIX));
  });

  test('leaves the tree clean afterwards', async () => {
    await writeNote(config, note());
    assert.equal(await isDirty(root), false);
  });

  test('refuses when the vault has uncommitted changes', async () => {
    // Rule 6. Committing here would sweep the user's in-progress edit into an
    // inkpipe commit, making it impossible to revert one without the other.
    writeFileSync(join(root, 'my-own-note.md'), 'work in progress');

    await assert.rejects(
      () => writeNote(config, note()),
      (e: VaultError) => e.code === 'dirty_tree',
    );
    assert.equal(readFileSync(join(root, 'my-own-note.md'), 'utf8'), 'work in progress');
  });

  test('refuses to overwrite an existing note by default', async () => {
    await writeNote(config, note());
    await assert.rejects(
      () => writeNote(config, note()),
      (e: VaultError) => e.code === 'exists',
    );
  });

  test('never stages files it did not create', async () => {
    // A file that appears between the dirty check and the commit must not be
    // swept in. `git add .` would do exactly that.
    const planned = plannedPaths(config, note());
    mkdirSync(join(root, 'School/Semester 5/Algorithms'), { recursive: true });
    writeFileSync(planned.notePath, '# placeholder\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'user note');

    const stray = join(root, 'unrelated.md');
    writeFileSync(stray, 'not ours');

    await assert.rejects(() => writeNote(config, note()), (e: VaultError) => e.code === 'dirty_tree');
    assert.equal(git(root, 'status', '--porcelain').includes('unrelated.md'), true);
  });

  test('refuses a directory that is not a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'inkpipe-plain-'));
    try {
      await assert.rejects(
        () => writeNote({ ...config, root: plain }, note()),
        (e: VaultError) => e.code === 'not_a_repo',
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('can write without committing, for a dry run', async () => {
    const result = await writeNote(config, note(), { commit: false });
    assert.equal(result.committed, false);
    assert.equal(await isDirty(root), true);
  });
});

describe('push', () => {
  test('pushes cleanly when the remote has not moved', async () => {
    await writeNote(config, note());
    assert.equal(await push(root), 'pushed');
  });

  test('rebases once and pushes when the remote moved', async () => {
    // Simulate obsidian-git having pushed from another machine.
    const other = mkdtempSync(join(tmpdir(), 'inkpipe-other-'));
    try {
      execFileSync('git', ['clone', remote, other]);
      git(other, 'config', 'user.email', 'other@example.com');
      git(other, 'config', 'user.name', 'Other');
      writeFileSync(join(other, 'from-phone.md'), 'written elsewhere');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'from another machine');
      git(other, 'push', 'origin', 'main');

      await writeNote(config, note());
      assert.equal(await push(root), 'rebased-and-pushed');

      // Both changes survive. Nothing was clobbered.
      assert.ok(existsSync(join(root, 'from-phone.md')));
      assert.ok(existsSync(plannedPaths(config, note()).notePath));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('refuses to resolve a genuine conflict, and leaves the tree usable', async () => {
    // Rule 6: never auto-resolve. Both sides edit the same file.
    const other = mkdtempSync(join(tmpdir(), 'inkpipe-other-'));
    try {
      execFileSync('git', ['clone', remote, other]);
      git(other, 'config', 'user.email', 'other@example.com');
      git(other, 'config', 'user.name', 'Other');
      writeFileSync(join(other, 'README.md'), '# vault\ntheir change\n');
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'their edit');
      git(other, 'push', 'origin', 'main');

      writeFileSync(join(root, 'README.md'), '# vault\nour change\n');
      git(root, 'add', '.');
      git(root, 'commit', '-m', 'our edit');

      await assert.rejects(
        () => push(root),
        (e: VaultError) => e.code === 'conflict' && /will not resolve this automatically/.test(e.message),
      );

      // The rebase was aborted, so the local branch is intact and the user can
      // resolve it themselves.
      assert.equal(git(root, 'log', '-1', '--pretty=%s'), 'our edit');
      assert.equal(existsSync(join(root, '.git', 'rebase-merge')), false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('push failure classification', () => {
  test('a vault with no remote says so, rather than blaming a conflict', async () => {
    // The bug this exists for: any push failure was reported as a diverged
    // remote, so a vault with no remote at all told the user to resolve a
    // merge conflict that did not exist.
    const solo = mkdtempSync(join(tmpdir(), 'inkpipe-noremote-'));
    try {
      execFileSync('git', ['init', '-b', 'main', solo]);
      git(solo, 'config', 'user.email', 't@e.com');
      git(solo, 'config', 'user.name', 'T');
      writeFileSync(join(solo, 'a.md'), 'x');
      git(solo, 'add', '.');
      git(solo, 'commit', '-m', 'one');

      await assert.rejects(
        () => push(solo),
        (e: VaultError) => e.code === 'no_remote' && /no remote configured/.test(e.message),
      );
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  test('an unreachable remote is reported as offline, not as a conflict', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'inkpipe-offline-'));
    try {
      execFileSync('git', ['init', '-b', 'main', solo]);
      git(solo, 'config', 'user.email', 't@e.com');
      git(solo, 'config', 'user.name', 'T');
      writeFileSync(join(solo, 'a.md'), 'x');
      git(solo, 'add', '.');
      git(solo, 'commit', '-m', 'one');
      // A host that cannot resolve.
      git(solo, 'remote', 'add', 'origin', 'https://no-such-host.invalid/x.git');

      await assert.rejects(
        () => push(solo),
        (e: VaultError) => ['offline', 'auth_failed', 'no_remote'].includes(e.code),
      );
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  test('classifier maps real git messages to actionable causes', () => {
    const cases: [string, string | null][] = [
      ["fatal: 'origin' does not appear to be a git repository", 'no_remote'],
      ['fatal: repository not found', 'no_remote'],
      ['fatal: Could not read from remote repository. Permission denied (publickey)', 'auth_failed'],
      ['remote: Support for password authentication was removed. Authentication failed', 'auth_failed'],
      ['fatal: unable to access: Could not resolve host: github.com', 'offline'],
      ['error: src refspec main does not match any', 'bad_branch'],
      // The one case that SHOULD attempt a rebase.
      ['! [rejected] main -> main (non-fast-forward)\nhint: Updates were rejected', null],
      ['! [rejected] main -> main (fetch first)', null],
    ];

    for (const [message, expected] of cases) {
      const result = classifyPushFailure(message);
      assert.equal(result?.code ?? null, expected, `wrong classification for: ${message.slice(0, 50)}`);
    }
  });
});
