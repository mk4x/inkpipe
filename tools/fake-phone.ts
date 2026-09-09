// A phone, without a phone.
//
// Does exactly what the Expo app will do: read a pairing QR payload, complete
// pairing, seal each page to the desktop's content key, and upload the session.
// Used to exercise the desktop before the real app exists, and to reproduce
// phone-side bugs without a device.
//
//   node tools/fake-phone.ts --pairing '<qr json>' --images a.jpg b.jpg
//   node tools/fake-phone.ts --service http://127.0.0.1:5272 --token <ui token> --images a.jpg
//
// The second form asks the desktop for a fresh pairing itself, which is what
// you want in a scripted test.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InkpipeClient } from '@inkpipe/client';
import { generateIdentityKeyPair, seal, toBase64Url, toBase64 } from '@inkpipe/crypto';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const list = (name: string): string[] => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
};

const images = list('images');
if (images.length === 0) {
  console.error('need --images <file> [file...]');
  process.exit(2);
}

let qr: { serverUrl: string; pairingToken: string; x25519PublicKey: string };

const pairingArg = arg('pairing');
if (pairingArg) {
  qr = JSON.parse(pairingArg);
} else {
  const service = arg('service') ?? 'http://127.0.0.1:5272';
  const uiToken = arg('token');
  if (!uiToken) {
    console.error('need --token <ui token> when not passing --pairing');
    process.exit(2);
  }
  const response = await fetch(`${service}/api/pairing`, {
    method: 'POST',
    headers: { 'x-inkpipe-ui-token': uiToken, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    console.error(`could not get a pairing from the desktop: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  qr = JSON.parse(((await response.json()) as { qr: string }).qr);
}

console.log(`pairing with ${qr.serverUrl}`);

const identity = generateIdentityKeyPair();
const paired = await new InkpipeClient({ baseUrl: qr.serverUrl })
  .post<{ deviceId: string; x25519PublicKey: string }>('/pair/complete', {
    pairingToken: qr.pairingToken,
    ed25519PublicKey: toBase64Url(identity.publicKey),
    label: 'fake phone',
  });

console.log(`paired as device ${paired.deviceId}`);

const phone = new InkpipeClient({
  baseUrl: qr.serverUrl,
  credentials: { deviceId: paired.deviceId, ed25519PrivateKey: identity.privateKey },
});

// The phone seals to the key it received during pairing, never one it picked.
const recipient = new Uint8Array(Buffer.from(paired.x25519PublicKey, 'base64url'));
const sessionId = randomUUID();

for (const [seq, path] of images.entries()) {
  const bytes = new Uint8Array(readFileSync(path));
  const sealed = seal(bytes, recipient);
  await phone.post('/blobs', {
    blobId: randomUUID(),
    sessionId,
    seq,
    sizeBytes: sealed.length,
    capturedAt: new Date().toISOString(),
    ciphertext: toBase64(sealed),
  });
  console.log(`uploaded page ${seq}: ${(bytes.length / 1048576).toFixed(1)} MB -> ${sealed.length} bytes sealed`);
}

console.log(`session ${sessionId} uploaded, ${images.length} page(s)`);
