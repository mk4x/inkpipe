// Credentials that are not device keys.
//
// Currently one: the search API key (ADR 0004). It deliberately does not live
// in config.json, for a reason that is practical rather than theoretical. That
// file holds vault paths, course names and a server URL, so it is the file
// someone pastes into an issue when asking why setup failed. A key in there
// gets published by accident sooner or later.
//
// Same storage honesty as keystore.ts: a mode 0600 file beside the config. That
// is readable by anything running as this user, and moving to the OS keyring is
// tracked with the keystore in issue #4, since both touch the same code path.
//
// Separate from keys.json on purpose. That file is derived from the recovery
// phrase and losing it makes every pending blob unreadable. This one holds a
// credential the user can simply reissue, so mixing them would give a
// throwaway value the same handling as an irreplaceable one.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { defaultConfigPath } from './config.ts';

const StoredSecrets = z.object({
  version: z.literal(1),
  /** Google Programmable Search API key. The engine id (cx) is not secret and
   *  lives in the config next to the rest of the research settings. */
  searchApiKey: z.string().default(''),
});

export type Secrets = z.infer<typeof StoredSecrets>;

const EMPTY: Secrets = { version: 1, searchApiKey: '' };

export function defaultSecretsPath(): string {
  return join(dirname(defaultConfigPath()), 'secrets.json');
}

/**
 * Read the secrets file.
 *
 * A missing or unreadable file is not an error. Research is optional, and the
 * correct behaviour without a key is for research to stay off, not for the
 * whole service to refuse to start.
 */
export function loadSecrets(path = defaultSecretsPath()): Secrets {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = StoredSecrets.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export function saveSecrets(secrets: Secrets, path = defaultSecretsPath()): void {
  const parsed = StoredSecrets.parse(secrets);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes. Best effort, same as the keystore.
  }
}

/** Set just the search key, preserving anything else in the file. */
export function setSearchApiKey(key: string, path = defaultSecretsPath()): void {
  saveSecrets({ ...loadSecrets(path), searchApiKey: key.trim() }, path);
}

export function hasSearchApiKey(path = defaultSecretsPath()): boolean {
  return loadSecrets(path).searchApiKey.length > 0;
}
