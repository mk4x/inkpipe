// Device key storage.
//
// Holds the two private keys the desktop owns: the Ed25519 identity that signs
// requests, and the X25519 content key that opens every page. Losing the second
// makes every pending blob permanently unreadable, which is why decision 17
// requires a recovery code.
//
// MVP storage is a mode-0600 file next to the config. That is honest rather
// than ideal: a file is readable by anything running as this user. Moving to
// the OS keyring (Windows Credential Manager, libsecret) is tracked as issue #4
// alongside the recovery code, since both touch the same code path.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  generateIdentityKeyPair, generateContentKeyPair, toBase64Url, fromBase64Url,
} from '@inkpipe/crypto';
import { defaultConfigPath } from './config.ts';

const StoredKeys = z.object({
  version: z.literal(1),
  ed25519PrivateKey: z.string().min(1),
  ed25519PublicKey: z.string().min(1),
  x25519PrivateKey: z.string().min(1),
  x25519PublicKey: z.string().min(1),
});

export interface DeviceKeys {
  identity: { privateKey: Uint8Array; publicKey: Uint8Array };
  content: { privateKey: Uint8Array; publicKey: Uint8Array };
}

export function defaultKeystorePath(): string {
  return join(dirname(defaultConfigPath()), 'keys.json');
}

export function keystoreExists(path = defaultKeystorePath()): boolean {
  return existsSync(path);
}

/** Generate both keypairs and persist them. Refuses to overwrite: silently
 *  replacing the content key would orphan every blob on the server. */
export function createKeys(path = defaultKeystorePath()): DeviceKeys {
  if (existsSync(path)) {
    throw new Error(
      `refusing to overwrite existing keys at ${path}. ` +
      'Replacing the content key would make every pending page permanently unreadable.',
    );
  }

  const identity = generateIdentityKeyPair();
  const content = generateContentKeyPair();

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    ed25519PrivateKey: toBase64Url(identity.privateKey),
    ed25519PublicKey: toBase64Url(identity.publicKey),
    x25519PrivateKey: toBase64Url(content.privateKey),
    x25519PublicKey: toBase64Url(content.publicKey),
  }, null, 2)}\n`, 'utf8');

  restrictPermissions(path);
  return { identity, content };
}

export function loadKeys(path = defaultKeystorePath()): DeviceKeys {
  if (!existsSync(path)) {
    throw new Error(`no keys at ${path}. Run setup first.`);
  }
  const parsed = StoredKeys.parse(JSON.parse(readFileSync(path, 'utf8')));
  return {
    identity: {
      privateKey: fromBase64Url(parsed.ed25519PrivateKey),
      publicKey: fromBase64Url(parsed.ed25519PublicKey),
    },
    content: {
      privateKey: fromBase64Url(parsed.x25519PrivateKey),
      publicKey: fromBase64Url(parsed.x25519PublicKey),
    },
  };
}

/** Best effort on Windows, where POSIX modes are advisory. Not silent about it:
 *  the setup wizard tells the user where the key file lives. */
function restrictPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal. The file is still inside the user profile directory.
  }
}
