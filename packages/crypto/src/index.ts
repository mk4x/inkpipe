// Crypto for inkpipe. Audited pure-TypeScript primitives from @noble, so the
// identical implementation runs on the phone, the server and the desktop UI.
//
// Two key types, doing two unrelated jobs. Conflating them is the classic
// mistake, so they are separate types here and never interchangeable:
//
//   Ed25519  IDENTITY. Signs requests so the server knows which device is
//            talking. The server holds the public half. Every device has one.
//
//   X25519   CONTENT. The phone seals each page to the desktop's public key.
//            ONLY the desktop holds the private half. The server never has it,
//            which is what makes the server unable to read anything.
//
// The sealed box construction is the standard NaCl one: generate a throwaway
// keypair per message, derive a shared secret with the recipient, encrypt, and
// ship the ephemeral public key alongside. The sender needs no long-term
// encryption key and cannot decrypt its own message afterwards.

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from '@noble/hashes/utils';

export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
export const TAG_BYTES = 16;

/** Domain separation: binds derived keys to this protocol and version, so a key
 *  can never be reused meaningfully by a different construction. */
const HKDF_INFO = new TextEncoder().encode('inkpipe/v1/sealed-box');

// ---------------------------------------------------------------------------
// Encoding. base64url without padding, because these values travel in JSON and
// sometimes in URLs and QR codes.
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

export function sha256Hex(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex');
}

// ---------------------------------------------------------------------------
// Identity keys (Ed25519)
// ---------------------------------------------------------------------------

export interface IdentityKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // A malformed signature or key is a failed verification, not a crash. The
    // server must never 500 on attacker-controlled input.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content keys (X25519)
// ---------------------------------------------------------------------------

export interface ContentKeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateContentKeyPair(): ContentKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * Derive the message key. Both sides must derive identically, so the ephemeral
 * and recipient public keys are mixed into the HKDF salt: that binds the key to
 * this exact pair and stops a shared secret being reused across contexts.
 */
function deriveKey(
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const salt = new Uint8Array(ephemeralPublicKey.length + recipientPublicKey.length);
  salt.set(ephemeralPublicKey, 0);
  salt.set(recipientPublicKey, ephemeralPublicKey.length);
  return hkdf(sha256, sharedSecret, salt, HKDF_INFO, KEY_BYTES);
}

/**
 * Seal a page to the desktop's public key.
 *
 * Layout: ephemeralPublicKey(32) || nonce(24) || ciphertext+tag
 * The header is not secret. It is authenticated, because the AEAD covers it as
 * associated data, so flipping a byte of it fails the open rather than
 * silently decrypting to something else.
 */
export function seal(plaintext: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== KEY_BYTES) {
    throw new Error(`recipient public key must be ${KEY_BYTES} bytes`);
  }

  const ephemeral = generateContentKeyPair();
  const shared = x25519.getSharedSecret(ephemeral.privateKey, recipientPublicKey);
  const key = deriveKey(shared, ephemeral.publicKey, recipientPublicKey);
  const nonce = randomBytes(NONCE_BYTES);

  const header = new Uint8Array(KEY_BYTES + NONCE_BYTES);
  header.set(ephemeral.publicKey, 0);
  header.set(nonce, KEY_BYTES);

  const ciphertext = xchacha20poly1305(key, nonce, header).encrypt(plaintext);

  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

/** Open a sealed page. Throws on any tampering, truncation or wrong key. */
export function open(sealed: Uint8Array, recipientPrivateKey: Uint8Array): Uint8Array {
  const minimum = KEY_BYTES + NONCE_BYTES + TAG_BYTES;
  if (sealed.length < minimum) {
    throw new Error(`sealed box too short: ${sealed.length} < ${minimum}`);
  }

  const ephemeralPublicKey = sealed.subarray(0, KEY_BYTES);
  const nonce = sealed.subarray(KEY_BYTES, KEY_BYTES + NONCE_BYTES);
  const header = sealed.subarray(0, KEY_BYTES + NONCE_BYTES);
  const ciphertext = sealed.subarray(KEY_BYTES + NONCE_BYTES);

  const recipientPublicKey = x25519.getPublicKey(recipientPrivateKey);
  const shared = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublicKey);
  const key = deriveKey(shared, ephemeralPublicKey, recipientPublicKey);

  return xchacha20poly1305(key, nonce, header).decrypt(ciphertext);
}

/** Overhead added by seal(), so the phone can check a page against the size cap
 *  before spending time encrypting it. */
export const SEAL_OVERHEAD_BYTES = KEY_BYTES + NONCE_BYTES + TAG_BYTES;
