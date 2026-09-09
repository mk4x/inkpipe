// Pairing QR parsing.
//
// Pure and Expo-free so it can be tested in Node. This validates a payload that
// arrives from a camera pointed at an arbitrary QR code, so every field is
// checked rather than trusted: a wrong key here would produce blobs the desktop
// can never open, and the failure would only surface much later.

/** Parse a pairing QR payload, refusing anything malformed. */
export function parsePairingQr(raw: string): {
  serverUrl: string;
  pairingToken: string;
  x25519PublicKey: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('that is not an inkpipe pairing code.');
  }

  const payload = parsed as Record<string, unknown>;
  if (payload.v !== 1) throw new Error('this pairing code is from a different version of inkpipe.');

  const { serverUrl, pairingToken, x25519PublicKey } = payload;
  if (typeof serverUrl !== 'string' || !/^https?:\/\//.test(serverUrl)) {
    throw new Error('the pairing code has no valid server address.');
  }
  if (typeof pairingToken !== 'string' || pairingToken.length < 16) {
    throw new Error('the pairing code is incomplete.');
  }
  if (typeof x25519PublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x25519PublicKey)) {
    throw new Error('the pairing code has no valid key.');
  }

  return { serverUrl, pairingToken, x25519PublicKey };
}
