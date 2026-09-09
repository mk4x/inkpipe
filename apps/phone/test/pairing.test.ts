import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairingQr } from '../src/pairing.ts';

const valid = {
  v: 1,
  serverUrl: 'https://inkpipe.example.com',
  pairingToken: 'a'.repeat(32),
  x25519PublicKey: 'B'.repeat(43),
};

describe('parsePairingQr', () => {
  test('accepts a well-formed payload', () => {
    const parsed = parsePairingQr(JSON.stringify(valid));
    assert.equal(parsed.serverUrl, valid.serverUrl);
    assert.equal(parsed.pairingToken, valid.pairingToken);
    assert.equal(parsed.x25519PublicKey, valid.x25519PublicKey);
  });

  test('rejects a QR code that is not inkpipe at all', () => {
    // Someone will point this at a wifi QR or a URL. The message must say so.
    assert.throws(() => parsePairingQr('https://example.com'), /not an inkpipe pairing code/);
    assert.throws(() => parsePairingQr('WIFI:S:home;T:WPA;;'), /not an inkpipe pairing code/);
  });

  test('rejects a payload from another version', () => {
    assert.throws(
      () => parsePairingQr(JSON.stringify({ ...valid, v: 2 })),
      /different version/,
    );
  });

  test('rejects a missing or malformed server address', () => {
    for (const serverUrl of [undefined, '', 'not-a-url', 'ftp://x', 42]) {
      assert.throws(
        () => parsePairingQr(JSON.stringify({ ...valid, serverUrl })),
        /server address/,
        `accepted ${JSON.stringify(serverUrl)}`,
      );
    }
  });

  test('rejects a truncated pairing token', () => {
    assert.throws(() => parsePairingQr(JSON.stringify({ ...valid, pairingToken: 'short' })), /incomplete/);
  });

  test('rejects a key of the wrong length', () => {
    // 43 base64url characters is exactly 32 bytes. Anything else is not a key,
    // and sealing to it would produce blobs the desktop can never open.
    for (const key of ['B'.repeat(42), 'B'.repeat(44), 'not a key', '']) {
      assert.throws(
        () => parsePairingQr(JSON.stringify({ ...valid, x25519PublicKey: key })),
        /valid key/,
        `accepted a ${key.length} character key`,
      );
    }
  });

  test('rejects a key containing base64 characters that are not URL safe', () => {
    assert.throws(
      () => parsePairingQr(JSON.stringify({ ...valid, x25519PublicKey: `${'B'.repeat(41)}+/` })),
      /valid key/,
    );
  });
});
