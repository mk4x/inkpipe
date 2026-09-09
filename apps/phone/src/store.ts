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
// The capture store is the backup that makes a lost desktop key survivable
// (decision 17 covers the other half). It keeps originals for 90 days or 2 GB,
// evicting oldest first.

import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import { toBase64Url, fromBase64Url } from '@inkpipe/crypto';

const KEY_IDENTITY = 'inkpipe.identity';
const KEY_PAIRING = 'inkpipe.pairing';

/** Decision 15. */
export const RETENTION_DAYS = 90;
export const RETENTION_BYTES = 2 * 1024 * 1024 * 1024;

const CAPTURES_DIR = `${FileSystem.documentDirectory}captures/`;
const MANIFEST = `${CAPTURES_DIR}manifest.json`;

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

// ---------------------------------------------------------------------------
// Identity
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

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

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

export type CaptureState = 'pending' | 'uploaded' | 'failed';

export interface Capture {
  blobId: string;
  sessionId: string;
  seq: number;
  /** Path inside app-private storage. */
  uri: string;
  bytes: number;
  capturedAt: string;
  state: CaptureState;
  /** Last upload error, shown in the queue screen rather than swallowed. */
  error?: string;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CAPTURES_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(CAPTURES_DIR, { intermediates: true });
}

export async function readManifest(): Promise<Capture[]> {
  await ensureDir();
  const info = await FileSystem.getInfoAsync(MANIFEST);
  if (!info.exists) return [];
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(MANIFEST)) as Capture[];
  } catch {
    // A corrupt manifest must not brick the app. The image files are still on
    // disk and the user can re-shoot; losing the index is recoverable.
    return [];
  }
}

export async function writeManifest(captures: Capture[]): Promise<void> {
  await ensureDir();
  await FileSystem.writeAsStringAsync(MANIFEST, JSON.stringify(captures));
}

export async function addCapture(capture: Omit<Capture, 'state'>): Promise<Capture[]> {
  const captures = await readManifest();
  const next = [...captures, { ...capture, state: 'pending' as const }];
  await writeManifest(next);
  return next;
}

export async function updateCapture(
  blobId: string,
  patch: Partial<Capture>,
): Promise<Capture[]> {
  const captures = await readManifest();
  const next = captures.map((c) => (c.blobId === blobId ? { ...c, ...patch } : c));
  await writeManifest(next);
  return next;
}

/**
 * Evict old captures. Decision 15: 90 days or 2 GB, oldest first.
 *
 * Only ever removes captures that have been uploaded. A pending capture is one
 * the desktop has never seen, so deleting it would silently lose a page.
 */
export async function pruneCaptures(now = new Date()): Promise<{ removed: number; freed: number }> {
  const captures = await readManifest();
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;

  const keep: Capture[] = [];
  const remove: Capture[] = [];

  for (const capture of captures) {
    const tooOld = Date.parse(capture.capturedAt) < cutoff;
    if (tooOld && capture.state === 'uploaded') remove.push(capture);
    else keep.push(capture);
  }

  // Then trim by size, newest first, still never dropping a pending capture.
  keep.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  let total = 0;
  const survivors: Capture[] = [];
  for (const capture of keep) {
    if (total + capture.bytes > RETENTION_BYTES && capture.state === 'uploaded') {
      remove.push(capture);
      continue;
    }
    total += capture.bytes;
    survivors.push(capture);
  }

  let freed = 0;
  for (const capture of remove) {
    freed += capture.bytes;
    await FileSystem.deleteAsync(capture.uri, { idempotent: true });
  }

  survivors.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  await writeManifest(survivors);
  return { removed: remove.length, freed };
}

export function capturesDir(): string {
  return CAPTURES_DIR;
}
