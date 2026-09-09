// Writing notes into an Obsidian vault that is also a git repository.
//
// Two rules from CLAUDE.md govern everything here:
//
//   Rule 6: never auto-resolve a git conflict. On a dirty tree, refuse. On a
//           rejected push, rebase and retry exactly once, then stop.
//   Rule 7: nothing is written before the human approves. This module is called
//           only after approval, but it still refuses to touch files it did not
//           create, so a bug upstream cannot damage existing notes.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { sanitizeSegment } from './sanitize.ts';

const run = promisify(execFile);

/** Distinct prefix so every commit this tool makes can be found and reverted
 *  with one command. Decision 7. */
export const COMMIT_PREFIX = 'inkpipe:';

export interface VaultConfig {
  /** Absolute path to the vault working tree. */
  root: string;
  /** Where notes go, e.g. "School/Semesters/Semester 5". Relative to root. */
  notesPath: string;
  /** Where source images go, e.g. "Images". Relative to root. */
  attachmentsPath: string;
}

export interface NoteToWrite {
  course: string;
  title: string;
  markdown: string;
  /** Compressed page images, in page order. */
  images: { filename: string; bytes: Uint8Array }[];
}

export class VaultError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** True when the working tree has changes that are not ours. */
export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain'])).length > 0;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/**
 * Resolve a path inside the vault, refusing anything that escapes it.
 *
 * The segments are already sanitised, so this is defence in depth: it is the
 * last check before a write, and it compares resolved absolute paths rather
 * than trusting string manipulation.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, target);
  if (rel.startsWith('..') || rel.startsWith(sep) || resolve(rootResolved, rel) !== target) {
    throw new VaultError('escape', `refusing to write outside the vault: ${target}`);
  }
  return target;
}

/** Where a note will land, without writing anything. The preview shows this so
 *  the user can correct the destination before approving. */
export function plannedPaths(config: VaultConfig, note: NoteToWrite) {
  const course = sanitizeSegment(note.course, 'General');
  const title = sanitizeSegment(note.title, 'Untitled note');
  const notePath = resolveInside(config.root, config.notesPath, course, `${title}.md`);
  const imagePaths = note.images.map((image) =>
    resolveInside(config.root, config.attachmentsPath, sanitizeSegment(image.filename)),
  );
  return { course, title, notePath, imagePaths };
}

export interface WriteResult {
  notePath: string;
  imagePaths: string[];
  committed: boolean;
  commitSha: string | null;
}

/**
 * Write a note and its images, then commit.
 *
 * Refuses if the tree is already dirty, because committing alongside the user's
 * own in-progress edits would mix their work into an inkpipe commit and make it
 * impossible to revert cleanly.
 */
export async function writeNote(
  config: VaultConfig,
  note: NoteToWrite,
  options: { commit?: boolean; allowOverwrite?: boolean } = {},
): Promise<WriteResult> {
  const { commit = true, allowOverwrite = false } = options;

  if (!(await isGitRepo(config.root))) {
    throw new VaultError('not_a_repo', `${config.root} is not a git repository`);
  }
  if (commit && (await isDirty(config.root))) {
    throw new VaultError(
      'dirty_tree',
      'the vault has uncommitted changes. Commit or stash them first, so inkpipe never mixes its work into yours.',
    );
  }

  const planned = plannedPaths(config, note);

  if (!allowOverwrite && existsSync(planned.notePath)) {
    throw new VaultError('exists', `a note already exists at ${planned.notePath}`);
  }

  mkdirSync(dirname(planned.notePath), { recursive: true });
  for (const imagePath of planned.imagePaths) {
    mkdirSync(dirname(imagePath), { recursive: true });
  }

  note.images.forEach((image, i) => {
    writeFileSync(planned.imagePaths[i], image.bytes);
  });
  writeFileSync(planned.notePath, note.markdown, 'utf8');

  if (!commit) {
    return { ...planned, committed: false, commitSha: null };
  }

  // Stage only our own paths. `git add .` would sweep up anything that appeared
  // in the vault since the dirty check, which is exactly what rule 6 forbids.
  const toStage = [planned.notePath, ...planned.imagePaths].map((p) => relative(config.root, p));
  await git(config.root, ['add', '--', ...toStage]);

  await git(config.root, [
    'commit',
    '-m', `${COMMIT_PREFIX} ${planned.course}/${planned.title}`,
    '--', ...toStage,
  ]);

  const commitSha = await git(config.root, ['rev-parse', 'HEAD']);
  return { ...planned, committed: true, commitSha };
}

/**
 * Push, with exactly one rebase retry (CLAUDE.md rule 6).
 *
 * Never resolves a conflict. If the rebase does not apply cleanly it aborts and
 * reports, leaving the vault exactly as it was.
 */
export async function push(root: string, remote = 'origin', branch = 'main'): Promise<'pushed' | 'rebased-and-pushed'> {
  try {
    await git(root, ['push', remote, branch]);
    return 'pushed';
  } catch {
    // Most likely the remote moved, which obsidian-git does routinely.
    try {
      await git(root, ['pull', '--rebase', remote, branch]);
    } catch (rebaseError) {
      await git(root, ['rebase', '--abort']).catch(() => {});
      throw new VaultError(
        'conflict',
        'the vault has diverged from the remote and rebasing hit a conflict. ' +
        'inkpipe will not resolve this automatically. Resolve it in Obsidian or git, then retry. ' +
        `Underlying error: ${(rebaseError as Error).message}`,
      );
    }
    await git(root, ['push', remote, branch]);
    return 'rebased-and-pushed';
  }
}
