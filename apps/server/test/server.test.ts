// Integration tests: real Fastify, real SQLite, real HTTP, real signatures.
// Nothing is mocked, because the interesting failures live in the seams.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.ts';
import { InkpipeClient, ApiError } from '@inkpipe/client';
import {
  generateIdentityKeyPair, generateContentKeyPair,
  seal, open, toBase64Url, toBase64, fromBase64,
} from '@inkpipe/crypto';
import { LIMITS } from '@inkpipe/protocol';

const JOIN_TOKEN = 'test-join-token-0123456789';

let app: ReturnType<typeof createServer>;
let baseUrl: string;
let dataDir: string;
let clock: Date;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'inkpipe-test-'));
  app = createServer({ dataDir, joinToken: JOIN_TOKEN, now: () => clock });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  clock = new Date('2026-09-09T12:00:00.000Z');
});

/** Register a desktop and pair a phone. Returns everything a test needs. */
async function setupPairedAccount() {
  const pcIdentity = generateIdentityKeyPair();
  const pcContent = generateContentKeyPair();
  const anonymous = new InkpipeClient({ baseUrl, now: () => clock });

  const registered = await anonymous.post<{ accountId: string; deviceId: string }>(
    '/pair/register-pc',
    {
      joinToken: JOIN_TOKEN,
      ed25519PublicKey: toBase64Url(pcIdentity.publicKey),
      x25519PublicKey: toBase64Url(pcContent.publicKey),
      label: 'desktop',
    },
  );

  const pc = new InkpipeClient({
    baseUrl,
    now: () => clock,
    credentials: { deviceId: registered.deviceId, ed25519PrivateKey: pcIdentity.privateKey },
  });

  const pairing = await pc.post<{ pairingToken: string }>('/pair/create', { ttlSeconds: 300 });

  const phoneIdentity = generateIdentityKeyPair();
  const paired = await anonymous.post<{ deviceId: string; x25519PublicKey: string }>(
    '/pair/complete',
    {
      pairingToken: pairing.pairingToken,
      ed25519PublicKey: toBase64Url(phoneIdentity.publicKey),
      label: 'pixel',
    },
  );

  const phone = new InkpipeClient({
    baseUrl,
    now: () => clock,
    credentials: { deviceId: paired.deviceId, ed25519PrivateKey: phoneIdentity.privateKey },
  });

  return { pc, phone, anonymous, pcContent, paired, registered, phoneIdentity };
}

function uploadBody(ciphertext: Uint8Array, over: Partial<Record<string, unknown>> = {}) {
  return {
    blobId: randomUUID(),
    sessionId: randomUUID(),
    seq: 0,
    sizeBytes: ciphertext.length,
    capturedAt: clock.toISOString(),
    ciphertext: toBase64(ciphertext),
    ...over,
  };
}

describe('health', () => {
  test('is unauthenticated and leaks nothing personal', async () => {
    const body = await new InkpipeClient({ baseUrl }).get<Record<string, unknown>>('/health');
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.deepEqual(Object.keys(body).sort(), ['devices', 'ok', 'pendingBlobs', 'version']);
  });
});

describe('pairing', () => {
  test('a desktop can register with the join token and pair a phone', async () => {
    const { paired, pcContent } = await setupPairedAccount();
    assert.equal(paired.x25519PublicKey, toBase64Url(pcContent.publicKey));
  });

  test('a wrong join token is refused', async () => {
    const identity = generateIdentityKeyPair();
    const content = generateContentKeyPair();
    await assert.rejects(
      () => new InkpipeClient({ baseUrl }).post('/pair/register-pc', {
        joinToken: 'wrong-token-aaaaaaaaaaaaaa',
        ed25519PublicKey: toBase64Url(identity.publicKey),
        x25519PublicKey: toBase64Url(content.publicKey),
        label: 'attacker',
      }),
      (e: ApiError) => e.status === 401,
    );
  });

  test('a pairing token is single use', async () => {
    const { pc, anonymous } = await setupPairedAccount();
    const pairing = await pc.post<{ pairingToken: string }>('/pair/create', { ttlSeconds: 300 });
    const second = generateIdentityKeyPair();

    await anonymous.post('/pair/complete', {
      pairingToken: pairing.pairingToken,
      ed25519PublicKey: toBase64Url(second.publicKey),
      label: 'first use',
    });

    const third = generateIdentityKeyPair();
    await assert.rejects(
      () => anonymous.post('/pair/complete', {
        pairingToken: pairing.pairingToken,
        ed25519PublicKey: toBase64Url(third.publicKey),
        label: 'replay',
      }),
      (e: ApiError) => e.status === 401,
    );
  });

  test('an expired pairing token is refused', async () => {
    const { pc, anonymous } = await setupPairedAccount();
    const pairing = await pc.post<{ pairingToken: string }>('/pair/create', { ttlSeconds: 60 });

    clock = new Date(clock.getTime() + 61_000);

    const phone = generateIdentityKeyPair();
    await assert.rejects(
      () => anonymous.post('/pair/complete', {
        pairingToken: pairing.pairingToken,
        ed25519PublicKey: toBase64Url(phone.publicKey),
        label: 'too late',
      }),
      (e: ApiError) => e.status === 401,
    );
  });

  test('an unknown pairing token is refused', async () => {
    const { anonymous } = await setupPairedAccount();
    const phone = generateIdentityKeyPair();
    await assert.rejects(
      () => anonymous.post('/pair/complete', {
        pairingToken: 'a'.repeat(32),
        ed25519PublicKey: toBase64Url(phone.publicKey),
        label: 'guess',
      }),
      (e: ApiError) => e.status === 401,
    );
  });
});

describe('authentication', () => {
  test('an unsigned request is refused', async () => {
    await setupPairedAccount();
    await assert.rejects(
      () => new InkpipeClient({ baseUrl }).get('/blobs'),
      (e: ApiError) => e.status === 401 && /missing authentication/.test(e.message),
    );
  });

  test('a signature from the wrong key is refused', async () => {
    const { paired } = await setupPairedAccount();
    const attacker = generateIdentityKeyPair();
    const forged = new InkpipeClient({
      baseUrl,
      now: () => clock,
      credentials: { deviceId: paired.deviceId, ed25519PrivateKey: attacker.privateKey },
    });
    await assert.rejects(
      () => forged.get('/blobs'),
      (e: ApiError) => e.status === 401 && /bad signature/.test(e.message),
    );
  });

  test('an unknown device id is refused', async () => {
    const identity = generateIdentityKeyPair();
    const client = new InkpipeClient({
      baseUrl,
      now: () => clock,
      credentials: { deviceId: randomUUID(), ed25519PrivateKey: identity.privateKey },
    });
    await assert.rejects(
      () => client.get('/blobs'),
      (e: ApiError) => e.status === 401 && /unknown device/.test(e.message),
    );
  });

  test('a stale signature is refused, so a captured request cannot be replayed', async () => {
    const { phone } = await setupPairedAccount();
    const stale = new InkpipeClient({
      baseUrl,
      now: () => new Date(clock.getTime() - (LIMITS.signatureSkewSeconds + 60) * 1000),
      credentials: (phone as unknown as { options: { credentials: never } }).options.credentials,
    });
    await assert.rejects(
      () => stale.post('/blobs', uploadBody(new Uint8Array([1, 2, 3]))),
      (e: ApiError) => e.status === 401 && /window/.test(e.message),
    );
  });

  test('a phone cannot call a pc-only endpoint', async () => {
    const { phone } = await setupPairedAccount();
    await assert.rejects(
      () => phone.get('/blobs'),
      (e: ApiError) => e.status === 403,
    );
  });

  test('a pc cannot upload as if it were a phone', async () => {
    const { pc } = await setupPairedAccount();
    await assert.rejects(
      () => pc.post('/blobs', uploadBody(new Uint8Array([1, 2, 3]))),
      (e: ApiError) => e.status === 403,
    );
  });
});

describe('blob upload', () => {
  test('a phone uploads and the pc lists it', async () => {
    const { phone, pc, pcContent } = await setupPairedAccount();
    const sealed = seal(new TextEncoder().encode('page one'), pcContent.publicKey);
    const body = uploadBody(sealed);

    const uploaded = await phone.post<{ duplicate: boolean }>('/blobs', body);
    assert.equal(uploaded.duplicate, false);

    const pending = await pc.get<{ blobs: { blobId: string }[] }>('/blobs');
    assert.ok(pending.blobs.some((b) => b.blobId === body.blobId));
  });

  test('re-uploading the same blobId is idempotent', async () => {
    const { phone, pc, pcContent } = await setupPairedAccount();
    const sealed = seal(new TextEncoder().encode('page one'), pcContent.publicKey);
    const body = uploadBody(sealed);

    await phone.post('/blobs', body);
    const second = await phone.post<{ duplicate: boolean }>('/blobs', body);
    assert.equal(second.duplicate, true);

    const pending = await pc.get<{ blobs: { blobId: string }[] }>('/blobs');
    assert.equal(pending.blobs.filter((b) => b.blobId === body.blobId).length, 1);
  });

  test('a mismatched sizeBytes is refused, so the quota cannot be bypassed', async () => {
    const { phone, pcContent } = await setupPairedAccount();
    const sealed = seal(new Uint8Array(1000), pcContent.publicKey);
    await assert.rejects(
      () => phone.post('/blobs', uploadBody(sealed, { sizeBytes: 1 })),
      (e: ApiError) => e.status === 400 && /does not match/.test(e.message),
    );
  });

  test('a malformed body is refused', async () => {
    const { phone } = await setupPairedAccount();
    await assert.rejects(
      () => phone.post('/blobs', { blobId: 'not-a-uuid' }),
      (e: ApiError) => e.status === 400,
    );
  });

  test('a negative seq is refused', async () => {
    const { phone, pcContent } = await setupPairedAccount();
    const sealed = seal(new Uint8Array(10), pcContent.publicKey);
    await assert.rejects(
      () => phone.post('/blobs', uploadBody(sealed, { seq: -1 })),
      (e: ApiError) => e.status === 400,
    );
  });
});

describe('blob download and ack', () => {
  test('the pc downloads ciphertext and decrypts it', async () => {
    const { phone, pc, pcContent } = await setupPairedAccount();
    const plaintext = new TextEncoder().encode('the actual page bytes');
    const body = uploadBody(seal(plaintext, pcContent.publicKey));
    await phone.post('/blobs', body);

    const downloaded = await pc.get<{ ciphertext: string }>(`/blobs/${body.blobId}`);
    const opened = open(fromBase64(downloaded.ciphertext), pcContent.privateKey);
    assert.equal(new TextDecoder().decode(opened), 'the actual page bytes');
  });

  test('acking deletes the blob', async () => {
    const { phone, pc, pcContent } = await setupPairedAccount();
    const body = uploadBody(seal(new Uint8Array([1, 2, 3]), pcContent.publicKey));
    await phone.post('/blobs', body);

    const acked = await pc.post<{ deleted: number }>('/blobs/ack', { blobIds: [body.blobId] });
    assert.equal(acked.deleted, 1);

    await assert.rejects(
      () => pc.get(`/blobs/${body.blobId}`),
      (e: ApiError) => e.status === 404,
    );
  });

  test('acking an already-acked blob deletes nothing and does not error', async () => {
    const { phone, pc, pcContent } = await setupPairedAccount();
    const body = uploadBody(seal(new Uint8Array([1]), pcContent.publicKey));
    await phone.post('/blobs', body);
    await pc.post('/blobs/ack', { blobIds: [body.blobId] });

    const again = await pc.post<{ deleted: number }>('/blobs/ack', { blobIds: [body.blobId] });
    assert.equal(again.deleted, 0);
  });

  test('downloading an unknown blob is a 404', async () => {
    const { pc } = await setupPairedAccount();
    await assert.rejects(
      () => pc.get(`/blobs/${randomUUID()}`),
      (e: ApiError) => e.status === 404,
    );
  });
});

describe('account isolation', () => {
  test('one account cannot list, download or delete another account blobs', async () => {
    const alice = await setupPairedAccount();
    const bob = await setupPairedAccount();

    const body = uploadBody(seal(new TextEncoder().encode('alice secret'), alice.pcContent.publicKey));
    await alice.phone.post('/blobs', body);

    const bobPending = await bob.pc.get<{ blobs: { blobId: string }[] }>('/blobs');
    assert.equal(bobPending.blobs.some((b) => b.blobId === body.blobId), false);

    await assert.rejects(
      () => bob.pc.get(`/blobs/${body.blobId}`),
      (e: ApiError) => e.status === 404,
    );

    const bobAck = await bob.pc.post<{ deleted: number }>('/blobs/ack', { blobIds: [body.blobId] });
    assert.equal(bobAck.deleted, 0, 'bob must not be able to delete alice blobs');

    // And alice still has it.
    const alicePending = await alice.pc.get<{ blobs: { blobId: string }[] }>('/blobs');
    assert.ok(alicePending.blobs.some((b) => b.blobId === body.blobId));
  });
});

describe('session grouping', () => {
  test('pages come back ordered by session then seq', async () => {
    const { phone, pc, pcContent } = await setupPairedAccount();
    const sessionId = randomUUID();

    // Upload out of order on purpose.
    for (const seq of [2, 0, 1]) {
      await phone.post('/blobs', uploadBody(
        seal(new TextEncoder().encode(`page ${seq}`), pcContent.publicKey),
        { sessionId, seq },
      ));
    }

    const pending = await pc.get<{ blobs: { sessionId: string; seq: number }[] }>('/blobs');
    const ours = pending.blobs.filter((b) => b.sessionId === sessionId);
    assert.deepEqual(ours.map((b) => b.seq), [0, 1, 2]);
  });
});

describe('recovery (issue #4)', () => {
  test('re-registering the same identity returns the SAME device, not a new account', async () => {
    // The restore path: a desktop derives identical keys from its recovery
    // phrase. It must find the account it already owns, otherwise it creates a
    // second one and cannot see its own pending pages.
    const identity = generateIdentityKeyPair();
    const content = generateContentKeyPair();
    const anonymous = new InkpipeClient({ baseUrl, now: () => clock });

    const body = {
      joinToken: JOIN_TOKEN,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      x25519PublicKey: toBase64Url(content.publicKey),
      label: 'desktop',
    };

    const first = await anonymous.post<{ accountId: string; deviceId: string; restored: boolean }>(
      '/pair/register-pc', body,
    );
    assert.equal(first.restored, false);

    const second = await anonymous.post<{ accountId: string; deviceId: string; restored: boolean }>(
      '/pair/register-pc', body,
    );
    assert.equal(second.restored, true, 'a repeat registration must be flagged as restored');
    assert.equal(second.deviceId, first.deviceId, 'the device id must survive a restore');
    assert.equal(second.accountId, first.accountId, 'the account must survive a restore');
  });

  test('a restored desktop can still read pages uploaded before the loss', async () => {
    const identity = generateIdentityKeyPair();
    const content = generateContentKeyPair();
    const anonymous = new InkpipeClient({ baseUrl, now: () => clock });

    const registered = await anonymous.post<{ deviceId: string }>('/pair/register-pc', {
      joinToken: JOIN_TOKEN,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      x25519PublicKey: toBase64Url(content.publicKey),
      label: 'desktop',
    });

    const pc = new InkpipeClient({
      baseUrl, now: () => clock,
      credentials: { deviceId: registered.deviceId, ed25519PrivateKey: identity.privateKey },
    });
    const pairing = await pc.post<{ pairingToken: string }>('/pair/create', { ttlSeconds: 300 });

    const phoneIdentity = generateIdentityKeyPair();
    const paired = await anonymous.post<{ deviceId: string; x25519PublicKey: string }>('/pair/complete', {
      pairingToken: pairing.pairingToken,
      ed25519PublicKey: toBase64Url(phoneIdentity.publicKey),
      label: 'phone',
    });
    const phone = new InkpipeClient({
      baseUrl, now: () => clock,
      credentials: { deviceId: paired.deviceId, ed25519PrivateKey: phoneIdentity.privateKey },
    });

    const plaintext = new TextEncoder().encode('a page uploaded before the disk died');
    const uploaded = uploadBody(seal(plaintext, content.publicKey));
    await phone.post('/blobs', uploaded);

    // ... the desktop dies and is restored from its phrase, deriving the same
    // keys, so this is the same client from the server's point of view ...
    const restored = await anonymous.post<{ deviceId: string; restored: boolean }>('/pair/register-pc', {
      joinToken: JOIN_TOKEN,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      x25519PublicKey: toBase64Url(content.publicKey),
      label: 'replacement desktop',
    });
    assert.equal(restored.restored, true);

    const restoredPc = new InkpipeClient({
      baseUrl, now: () => clock,
      credentials: { deviceId: restored.deviceId, ed25519PrivateKey: identity.privateKey },
    });

    const pending = await restoredPc.get<{ blobs: { blobId: string }[] }>('/blobs');
    assert.ok(pending.blobs.some((b) => b.blobId === uploaded.blobId), 'the waiting page must still be visible');

    const downloaded = await restoredPc.get<{ ciphertext: string }>(`/blobs/${uploaded.blobId}`);
    const opened = open(fromBase64(downloaded.ciphertext), content.privateKey);
    assert.equal(new TextDecoder().decode(opened), 'a page uploaded before the disk died',
      'and it must still decrypt');
  });

  test('refuses a different content key for an existing identity', async () => {
    // Accepting it would orphan every blob already sealed to the old key.
    const identity = generateIdentityKeyPair();
    const anonymous = new InkpipeClient({ baseUrl, now: () => clock });

    await anonymous.post('/pair/register-pc', {
      joinToken: JOIN_TOKEN,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      x25519PublicKey: toBase64Url(generateContentKeyPair().publicKey),
      label: 'desktop',
    });

    await assert.rejects(
      () => anonymous.post('/pair/register-pc', {
        joinToken: JOIN_TOKEN,
        ed25519PublicKey: toBase64Url(identity.publicKey),
        x25519PublicKey: toBase64Url(generateContentKeyPair().publicKey),
        label: 'desktop',
      }),
      (e: ApiError) => e.status === 409 && e.code === 'content_key_mismatch',
    );
  });

  test('a restore still needs the join token', async () => {
    const identity = generateIdentityKeyPair();
    const content = generateContentKeyPair();
    const anonymous = new InkpipeClient({ baseUrl, now: () => clock });

    await anonymous.post('/pair/register-pc', {
      joinToken: JOIN_TOKEN,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      x25519PublicKey: toBase64Url(content.publicKey),
      label: 'desktop',
    });

    await assert.rejects(
      () => anonymous.post('/pair/register-pc', {
        joinToken: 'wrong-token-aaaaaaaaaaaa',
        ed25519PublicKey: toBase64Url(identity.publicKey),
        x25519PublicKey: toBase64Url(content.publicKey),
        label: 'desktop',
      }),
      (e: ApiError) => e.status === 401,
    );
  });
});
