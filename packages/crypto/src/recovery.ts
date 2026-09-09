// Recovery codes (decision 17, issue #4).
//
// The problem: the desktop X25519 private key is the only thing that can open a
// page. Lose it and every blob still sitting on the server is permanently
// unreadable, and no second desktop can ever be paired to the same account.
//
// The approach: **derive the keys from the recovery phrase** rather than
// generating random keys and wrapping them.
//
// That choice matters. Wrapping random keys means the wrapped blob has to live
// somewhere, and after a disk failure "somewhere" is exactly what you no longer
// have. Deriving means the phrase alone is sufficient: type it on a new machine
// and the identical keys come back, with nothing to have backed up and nothing
// for the server to hold.
//
// The cost is that the phrase can never be rotated without changing identity.
// For a personal notes tool that is the right trade: a recovery path that
// depends on a file you also lost is not a recovery path.

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { IdentityKeyPair, ContentKeyPair } from './index.ts';

/** 24 words, 256 bits. Long, but this is typed once at setup and once at
 *  restore, and it is the only thing standing between a dead disk and losing
 *  every pending page. */
export const RECOVERY_STRENGTH_BITS = 256;
export const RECOVERY_WORD_COUNT = 24;

// Distinct info strings so the two keys can never collide, even though they
// come from one seed.
const INFO_IDENTITY = new TextEncoder().encode('inkpipe/v1/recovery/identity');
const INFO_CONTENT = new TextEncoder().encode('inkpipe/v1/recovery/content');

export interface RecoveredKeys {
  identity: IdentityKeyPair;
  content: ContentKeyPair;
}

/** A fresh 24 word recovery phrase. Shown once and never stored. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, RECOVERY_STRENGTH_BITS);
}

/** BIP39 validation: word list membership and the checksum. Catches a typo or a
 *  transposed word before it silently produces the wrong keys. */
export function isValidRecoveryPhrase(phrase: string): boolean {
  try {
    return validateMnemonic(normaliseRecoveryPhrase(phrase), wordlist);
  } catch {
    return false;
  }
}

/**
 * Tidy a phrase a human typed.
 *
 * People paste from a screenshot, capitalise the first word, and add double
 * spaces or line breaks when reading from paper. None of that should be an
 * error, so it is normalised rather than rejected.
 */
export function normaliseRecoveryPhrase(phrase: string): string {
  return phrase
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Derive both keypairs from a recovery phrase.
 *
 * Deterministic: the same phrase always yields the same keys, on any machine,
 * which is the entire point.
 */
export function keysFromRecoveryPhrase(phrase: string): RecoveredKeys {
  const normalised = normaliseRecoveryPhrase(phrase);
  if (!validateMnemonic(normalised, wordlist)) {
    throw new Error('that is not a valid recovery phrase. Check for a mistyped or missing word.');
  }

  // Empty passphrase: a second secret to remember would be a second secret to
  // lose, and the 24 word phrase already carries 256 bits.
  const seed = mnemonicToSeedSync(normalised, '');

  const identityPrivate = hkdf(sha256, seed, undefined, INFO_IDENTITY, 32);
  const contentPrivate = hkdf(sha256, seed, undefined, INFO_CONTENT, 32);

  return {
    identity: {
      privateKey: identityPrivate,
      publicKey: ed25519.getPublicKey(identityPrivate),
    },
    content: {
      privateKey: contentPrivate,
      publicKey: x25519.getPublicKey(contentPrivate),
    },
  };
}

/** Group into numbered rows, which is how the wizard displays it and how people
 *  copy it onto paper without losing their place. */
export function formatRecoveryPhrase(phrase: string, perRow = 4): string[][] {
  const words = normaliseRecoveryPhrase(phrase).split(' ');
  const rows: string[][] = [];
  for (let i = 0; i < words.length; i += perRow) {
    rows.push(words.slice(i, i + perRow));
  }
  return rows;
}
