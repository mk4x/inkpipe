// Phone-side persistence.
//
// Three things are kept, with different durability requirements:
//
//   identity key   SecureStore, which is Android Keystore backed. Losing it
//                  means re-pairing, which is cheap.
//   pairing        SecureStore. Small, and includes the desktop public key that
//                  every page is sealed to.
//   captures       App-private file storage, decision 15. NOT the camera roll:
//                  the gallery should not fill with notebook pages, and
//                  app-private storage is cleaned up on uninstall.
//
// Uses the CURRENT expo-file-system API (File, Directory, Paths). The older
// `documentDirectory` / `getInfoAsync` / `readAsStringAsync` functions moved to
// `expo-file-system/legacy` in SDK 54. Writing against them on SDK 57 made
// every call throw, which surfaced as an app stuck on its loading spinner
// forever, because the failure had nowhere to go. See the notes in App.tsx.

import * as SecureStore from 'expo-secure-store';
import { File, Directory, Paths } from 'expo-file-system';
import { toBase64Url, fromBase64Url } from '@inkpipe/crypto';
import { planPrune, DEFAULT_RETENTION, type CaptureState } from './retention.ts';

const KEY_IDENTITY = 'inkpipe.identity';
const KEY_PAIRING = 'inkpipe.pairing';

export type { CaptureState };
export const RETENTION_DAYS = DEFAULT_RETENTION.days;
export const RETENTION_BYTES = DEFAULT_RETENTION.bytes;

export interface Pairing {
  serverUrl: string;
  deviceId: string;
  /** The desktop content key. Every page is sealed to this and nothing else. */
  x25519PublicKey: string;
  pairedAt: string;
}

export interface StoredIdentity {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface Capture {
  blobId: string;
  sessionId: string;
  seq: number;
  /** File name inside the captures directory, not a full uri: a uri can change
   *  between installs, a name cannot. */
  fileName: string;
  bytes: number;
  capturedAt: string;
  state: CaptureState;
  error?: string;
}

// ---------------------------------------------------------------------------
// Identity and pairing
// ---------------------------------------------------------------------------

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await SecureStore.setItemAsync(KEY_IDENTITY, JSON.stringify({
    privateKey: toBase64Url(identity.privateKey),
    publicKey: toBase64Url(identity.publicKey),
  }));
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const raw = await SecureStore.getItemAsync(KEY_IDENTITY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { privateKey: string; publicKey: string };
  return {
    privateKey: fromBase64Url(parsed.privateKey),
    publicKey: fromBase64Url(parsed.publicKey),
  };
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await SecureStore.setItemAsync(KEY_PAIRING, JSON.stringify(pairing));
}

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY_PAIRING);
  return raw ? (JSON.parse(raw) as Pairing) : null;
}

export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_PAIRING);
  await SecureStore.deleteItemAsync(KEY_IDENTITY);
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

export function capturesDirectory(): Directory {
  const dir = new Directory(Paths.document, 'captures');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function captureFile(fileName: string): File {
  return new File(capturesDirectory(), fileName);
}

function manifestFile(): File {
  return new File(capturesDirectory(), 'manifest.json');
}

export async function readManifest(): Promise<Capture[]> {
  const file = manifestFile();
  if (!file.exists) return [];
  try {
    return JSON.parse(await file.text()) as Capture[];
  } catch {
    // A corrupt manifest must not brick the app. The images are still on disk
    // and can be re-shot; losing the index is recoverable, a crash loop is not.
    return [];
  }
}

export async function writeManifest(captures: Capture[]): Promise<void> {
  const file = manifestFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(captures));
}

export async function addCapture(capture: Omit<Capture, 'state'>): Promise<Capture[]> {
  const next = [...(await readManifest()), { ...capture, state: 'pending' as const }];
  await writeManifest(next);
  return next;
}

export async function updateCapture(blobId: string, patch: Partial<Capture>): Promise<Capture[]> {
  const next = (await readManifest()).map((c) => (c.blobId === blobId ? { ...c, ...patch } : c));
  await writeManifest(next);
  return next;
}

/**
 * Evict old captures per decision 15.
 *
 * The policy itself lives in retention.ts and is unit tested. This only applies
 * the plan, so the rule that a pending capture is never deleted is enforced in
 * code that runs under `node --test` rather than only on a device.
 */
export async function pruneCaptures(now = new Date()): Promise<{ removed: number; freed: number }> {
  const captures = await readManifest();
  const { keep, remove } = planPrune(captures, now);

  let freed = 0;
  for (const capture of remove) {
    freed += capture.bytes;
    const file = captureFile(capture.fileName);
    if (file.exists) file.delete();
  }

  await writeManifest(keep);
  return { removed: remove.length, freed };
}
