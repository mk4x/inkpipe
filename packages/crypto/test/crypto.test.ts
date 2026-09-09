import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentityKeyPair,
  generateContentKeyPair,
  sign,
  verify,
  seal,
  open,
  toBase64Url,
  fromBase64Url,
  sha256Hex,
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  SEAL_OVERHEAD_BYTES,
} from '../src/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('identity keys (Ed25519)', () => {
  test('signs and verifies', () => {
    const kp = generateIdentityKeyPair();
    const msg = bytes('POST\n/blobs\n2026-09-09T10:00:00Z\nabc123');
    assert.equal(verify(sign(msg, kp.privateKey), msg, kp.publicKey), true);
  });

  test('rejects a signature from a different key', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    const msg = bytes('hello');
    assert.equal(verify(sign(msg, a.privateKey), msg, b.publicKey), false);
  });

  test('rejects a modified message', () => {
    const kp = generateIdentityKeyPair();
    const sig = sign(bytes('GET /blobs'), kp.privateKey);
    assert.equal(verify(sig, bytes('GET /blobz'), kp.publicKey), false);
  });

  test('returns false rather than throwing on malformed input', () => {
    // The server verifies attacker-controlled bytes. It must never 500.
    const kp = generateIdentityKeyPair();
    assert.equal(verify(new Uint8Array(0), bytes('x'), kp.publicKey), false);
    assert.equal(verify(new Uint8Array(64), bytes('x'), new Uint8Array(3)), false);
    assert.equal(verify(new Uint8Array(7), bytes('x'), kp.publicKey), false);
  });

  test('public key is 32 bytes, so it matches the protocol PublicKey schema', () => {
    assert.equal(generateIdentityKeyPair().publicKey.length, KEY_BYTES);
  });
});

describe('sealed box (X25519 + XChaCha20-Poly1305)', () => {
  test('round trips', () => {
    const pc = generateContentKeyPair();
    const plaintext = bytes('a page of notes');
    assert.equal(text(open(seal(plaintext, pc.publicKey), pc.privateKey)), 'a page of notes');
  });

  test('round trips an empty payload', () => {
    const pc = generateContentKeyPair();
    assert.equal(open(seal(new Uint8Array(0), pc.publicKey), pc.privateKey).length, 0);
  });

  test('round trips a realistic page-sized payload', () => {
    const pc = generateContentKeyPair();
    const page = new Uint8Array(600 * 1024);
    for (let i = 0; i < page.length; i++) page[i] = i % 256;
    assert.deepEqual(open(seal(page, pc.publicKey), pc.privateKey), page);
  });

  test('the sender cannot decrypt its own message', () => {
    // The point of a sealed box: the phone has no lasting ability to read what
    // it uploaded. Its local backup copy is plaintext on the phone instead.
    const pc = generateContentKeyPair();
    const phone = generateContentKeyPair();
    const sealed = seal(bytes('secret'), pc.publicKey);
    assert.throws(() => open(sealed, phone.privateKey));
  });

  test('a wrong recipient key fails to open', () => {
    const pc = generateContentKeyPair();
    const other = generateContentKeyPair();
    assert.throws(() => open(seal(bytes('secret'), pc.publicKey), other.privateKey));
  });

  test('two seals of identical plaintext differ', () => {
    // Ephemeral key plus random nonce per message. Equal ciphertexts would leak
    // that the same page was uploaded twice.
    const pc = generateContentKeyPair();
    const a = seal(bytes('same'), pc.publicKey);
    const b = seal(bytes('same'), pc.publicKey);
    assert.notDeepEqual(a, b);
  });

  test('overhead is exactly SEAL_OVERHEAD_BYTES', () => {
    const pc = generateContentKeyPair();
    const plaintext = bytes('12345678');
    assert.equal(seal(plaintext, pc.publicKey).length - plaintext.length, SEAL_OVERHEAD_BYTES);
    assert.equal(SEAL_OVERHEAD_BYTES, KEY_BYTES + NONCE_BYTES + TAG_BYTES);
  });

  test('rejects a recipient key of the wrong length', () => {
    assert.throws(() => seal(bytes('x'), new Uint8Array(16)), /32 bytes/);
  });

  describe('tampering', () => {
    // Every byte position matters. Flipping any one of them must fail the open,
    // including in the header, which is why the header is passed as AEAD
    // associated data rather than left unauthenticated.
    const positions = [
      ['ephemeral public key', 0],
      ['ephemeral public key, last byte', KEY_BYTES - 1],
      ['nonce, first byte', KEY_BYTES],
      ['nonce, last byte', KEY_BYTES + NONCE_BYTES - 1],
      ['ciphertext, first byte', KEY_BYTES + NONCE_BYTES],
    ] as const;

    for (const [label, index] of positions) {
      test(`flipping a bit in the ${label} fails`, () => {
        const pc = generateContentKeyPair();
        const sealed = seal(bytes('a page of notes'), pc.publicKey);
        sealed[index] ^= 0x01;
        assert.throws(() => open(sealed, pc.privateKey));
      });
    }

    test('flipping a bit in the auth tag fails', () => {
      const pc = generateContentKeyPair();
      const sealed = seal(bytes('a page of notes'), pc.publicKey);
      sealed[sealed.length - 1] ^= 0x01;
      assert.throws(() => open(sealed, pc.privateKey));
    });

    test('truncation fails', () => {
      const pc = generateContentKeyPair();
      const sealed = seal(bytes('a page of notes'), pc.publicKey);
      assert.throws(() => open(sealed.subarray(0, sealed.length - 1), pc.privateKey));
    });

    test('a too-short box is rejected with a clear error, not a crash', () => {
      const pc = generateContentKeyPair();
      assert.throws(() => open(new Uint8Array(10), pc.privateKey), /too short/);
    });

    test('appending bytes fails', () => {
      const pc = generateContentKeyPair();
      const sealed = seal(bytes('a page of notes'), pc.publicKey);
      const longer = new Uint8Array(sealed.length + 1);
      longer.set(sealed, 0);
      assert.throws(() => open(longer, pc.privateKey));
    });
  });

  test('randomised round trip over many sizes', () => {
    const pc = generateContentKeyPair();
    for (let i = 0; i < 200; i++) {
      const size = Math.floor(Math.random() * 5000);
      const payload = new Uint8Array(size);
      for (let j = 0; j < size; j++) payload[j] = Math.floor(Math.random() * 256);
      assert.deepEqual(open(seal(payload, pc.publicKey), pc.privateKey), payload);
    }
  });
});

describe('encoding', () => {
  test('base64url round trips and is URL and QR safe', () => {
    for (let i = 0; i < 100; i++) {
      const raw = new Uint8Array(32);
      for (let j = 0; j < 32; j++) raw[j] = Math.floor(Math.random() * 256);
      const encoded = toBase64Url(raw);
      assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'must not contain + / or =');
      assert.deepEqual(fromBase64Url(encoded), raw);
    }
  });

  test('a 32 byte key encodes to exactly 43 base64url chars', () => {
    // The protocol PublicKey schema hard-codes 43. If this ever changes, that
    // regex silently starts rejecting every valid key.
    assert.equal(toBase64Url(generateIdentityKeyPair().publicKey).length, 43);
  });

  test('sha256Hex matches a known vector', () => {
    assert.equal(
      sha256Hex(bytes('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('sha256Hex of empty input matches the known vector', () => {
    assert.equal(
      sha256Hex(new Uint8Array(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
