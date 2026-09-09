// WebCrypto polyfill, imported before anything else.
//
// React Native has no `globalThis.crypto`. @noble/curves and @noble/ciphers
// both call `crypto.getRandomValues` when they generate a key or a nonce, and
// they throw "crypto.getRandomValues must be defined" the moment you try to
// pair or seal a page.
//
// This must be the FIRST import in the app entry point. @noble captures the
// function at module load, so a polyfill installed after it is imported is too
// late and the error persists in a way that looks like the polyfill is broken.
//
// expo-crypto is already a dependency and is backed by the platform's secure
// RNG, so no extra native module is needed.

import { getRandomValues } from 'expo-crypto';

type MutableGlobal = typeof globalThis & {
  crypto?: Partial<Crypto>;
};

const target = globalThis as MutableGlobal;

if (!target.crypto) {
  // Object rather than a Crypto instance: React Native has no Crypto class, and
  // @noble only ever reaches for getRandomValues.
  target.crypto = {};
}

if (typeof target.crypto.getRandomValues !== 'function') {
  target.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array;
    // expo-crypto types this narrower than the DOM signature, but accepts any
    // integer typed array, which is all @noble ever passes.
    return getRandomValues(array as unknown as Uint8Array) as unknown as T;
  }) as Crypto['getRandomValues'];
}

/** Proves the polyfill is live. Called at startup so a failure surfaces as a
 *  clear message rather than as an obscure error deep inside a key exchange. */
export function assertRandomAvailable(): void {
  const probe = new Uint8Array(8);
  globalThis.crypto.getRandomValues(probe);
  if (probe.every((byte) => byte === 0)) {
    throw new Error(
      'the secure random number generator returned all zeros. ' +
      'Refusing to generate keys, because they would be predictable.',
    );
  }
}
