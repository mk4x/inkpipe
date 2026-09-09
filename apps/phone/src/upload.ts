// Uploading a capture session.
//
// The phone seals every page to the desktop public key it received during
// pairing, and to nothing else. It cannot read what it uploaded afterwards:
// that is the point of a sealed box, and the reason the local copy in
// app-private storage is the phone's only way back to the original.

import * as FileSystem from 'expo-file-system';
import { InkpipeClient, ApiError } from '@inkpipe/client';
import { seal, toBase64, fromBase64Url } from '@inkpipe/crypto';
import { LIMITS } from '@inkpipe/protocol';
import type { Capture, Pairing, StoredIdentity } from './store.ts';

export interface UploadProgress {
  blobId: string;
  seq: number;
  state: 'uploading' | 'uploaded' | 'failed' | 'skipped';
  error?: string;
}

export interface UploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Upload every pending capture.
 *
 * Continues past a failure rather than aborting: one oversized or corrupt page
 * must not block the rest of a lecture. Failures are reported per capture so
 * the queue screen can show exactly which page needs attention.
 */
export async function uploadPending(
  captures: Capture[],
  pairing: Pairing,
  identity: StoredIdentity,
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const client = new InkpipeClient({
    baseUrl: pairing.serverUrl,
    credentials: { deviceId: pairing.deviceId, ed25519PrivateKey: identity.privateKey },
  });

  const recipient = fromBase64Url(pairing.x25519PublicKey);
  const result: UploadResult = { uploaded: 0, skipped: 0, failed: 0, errors: [] };

  for (const capture of captures) {
    if (capture.state === 'uploaded') {
      result.skipped++;
      onProgress?.({ blobId: capture.blobId, seq: capture.seq, state: 'skipped' });
      continue;
    }

    onProgress?.({ blobId: capture.blobId, seq: capture.seq, state: 'uploading' });

    try {
      const base64 = await FileSystem.readAsStringAsync(capture.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const plaintext = new Uint8Array(Buffer.from(base64, 'base64'));

      // Check before spending time on crypto: the server enforces this too, but
      // failing here gives a clear message instead of a 413.
      if (plaintext.length > LIMITS.maxBlobBytes) {
        throw new Error(
          `page is ${(plaintext.length / 1048576).toFixed(1)} MB, over the ` +
          `${LIMITS.maxBlobBytes / 1048576} MB limit`,
        );
      }

      const sealed = seal(plaintext, recipient);

      await client.post('/blobs', {
        blobId: capture.blobId,
        sessionId: capture.sessionId,
        seq: capture.seq,
        sizeBytes: sealed.length,
        capturedAt: capture.capturedAt,
        ciphertext: toBase64(sealed),
      });

      result.uploaded++;
      onProgress?.({ blobId: capture.blobId, seq: capture.seq, state: 'uploaded' });
    } catch (error) {
      const message = describe(error);
      result.failed++;
      result.errors.push(`page ${capture.seq + 1}: ${message}`);
      onProgress?.({ blobId: capture.blobId, seq: capture.seq, state: 'failed', error: message });
    }
  }

  return result;
}

/** Turn an error into something a person can act on. */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'quota_exceeded':
        return 'your server is full. Open the desktop app and collect the waiting pages first.';
      case 'too_large':
        return 'this page is too large for the server.';
      case 'unauthenticated':
        return 'this phone is no longer paired. Pair it again from the desktop.';
      default:
        return error.message;
    }
  }
  if (error instanceof TypeError) {
    // fetch throws TypeError for a dead network, which is the common case on a
    // phone and deserves better than "Failed to fetch".
    return 'no connection to your server. It will retry when you are back online.';
  }
  return error instanceof Error ? error.message : String(error);
}

export { parsePairingQr } from './pairing.ts';
