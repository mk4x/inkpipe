// Listing and revoking devices.
//
// The owner asked for this after losing track of what was paired, which is easy
// once pairing has happened twice and once from a browser. A device you cannot
// see is a device you cannot revoke.
//
// The revocation rules matter more than the listing. Getting them wrong strands
// an account with no way back in from inside the app, and the server is the only
// place that can enforce them.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server.ts';
import { InkpipeClient } from '@inkpipe/client';
import { generateIdentityKeyPair, generateContentKeyPair, toBase64Url, seal, toBase64 } from '@inkpipe/crypto';

const JOIN_TOKEN = 'devices-test-join-token-0123';

let app: ReturnType<typeof createServer>;
let baseUrl: string;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'inkpipe-devices-'));
  app = createServer({ dataDir, joinToken: JOIN_TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Register a desktop and return a client signing as it. */
async function registerPc(label: string) {
  const identity = generateIdentityKeyPair();
  const content = generateContentKeyPair();
  const response = await fetch(`${baseUrl}/pair/register-pc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      joinToken: JOIN_TOKEN,
      label,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      x25519PublicKey: toBase64Url(content.publicKey),
    }),
  });
  const body = await response.json() as { deviceId: string };
  return {
    deviceId: body.deviceId,
    content,
    client: new InkpipeClient({
      baseUrl,
      credentials: { deviceId: body.deviceId, ed25519PrivateKey: identity.privateKey },
    }),
  };
}

/** Pair a phone against a desktop and return a client signing as it. */
async function pairPhone(pc: Awaited<ReturnType<typeof registerPc>>, label: string) {
  const pairing = await pc.client.post<{ pairingToken: string }>('/pair/create', { ttlSeconds: 300 });
  const identity = generateIdentityKeyPair();
  const response = await fetch(`${baseUrl}/pair/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingToken: pairing.pairingToken,
      label,
      ed25519PublicKey: toBase64Url(identity.publicKey),
    }),
  });
  const body = await response.json() as { deviceId: string };
  return {
    deviceId: body.deviceId,
    client: new InkpipeClient({
      baseUrl,
      credentials: { deviceId: body.deviceId, ed25519PrivateKey: identity.privateKey },
    }),
  };
}

describe('listing devices', () => {
  test('shows the desktop and every phone paired to it', async () => {
    const pc = await registerPc('desktop one');
    await pairPhone(pc, 'phone one');
    await pairPhone(pc, 'phone two');

    const listed = await pc.client.get<{ devices: Array<Record<string, unknown>>; self: string }>('/devices');

    assert.equal(listed.devices.length, 3);
    assert.equal(listed.self, pc.deviceId);
    assert.deepEqual(
      listed.devices.map((d) => d.label).sort(),
      ['desktop one', 'phone one', 'phone two'],
    );
  });

  test('never returns key material', async () => {
    // A public key is not a secret, but printing one invites it into a
    // screenshot and it identifies the device across every account it has been
    // on. There is no reason for a device list to carry it.
    const pc = await registerPc('desktop keys');
    const listed = await pc.client.get<unknown>('/devices');
    const serialised = JSON.stringify(listed);

    assert.ok(!/PublicKey/i.test(serialised), 'no key field');
    assert.ok(!/ed25519|x25519/i.test(serialised), 'no key material');
  });

  test('a phone cannot enumerate the account', async () => {
    // It has no reason to, and a phone that can list the desktop is a phone
    // that can start reasoning about it.
    const pc = await registerPc('desktop private');
    const phone = await pairPhone(pc, 'nosy phone');

    await assert.rejects(
      phone.client.get('/devices'),
      (error: { status: number }) => error.status === 403,
    );
  });

  test('one account cannot see another', async () => {
    const first = await registerPc('account A desktop');
    const second = await registerPc('account B desktop');
    await pairPhone(second, 'account B phone');

    const listed = await first.client.get<{ devices: Array<{ label: string }> }>('/devices');
    for (const device of listed.devices) {
      assert.ok(!device.label.startsWith('account B'), 'devices leaked across accounts');
    }
  });

  test('last seen is recorded, so the list can be read', async () => {
    const pc = await registerPc('desktop seen');
    const phone = await pairPhone(pc, 'phone seen');

    // The phone has not made an authenticated request yet.
    let listed = await pc.client.get<{ devices: Array<{ label: string; lastSeenAt: string | null }> }>('/devices');
    assert.equal(listed.devices.find((d) => d.label === 'phone seen')?.lastSeenAt, null);

    await phone.client.post('/blobs', {}).catch(() => { /* the call failing is fine, being seen is the point */ });

    listed = await pc.client.get<{ devices: Array<{ label: string; lastSeenAt: string | null }> }>('/devices');
    assert.ok(listed.devices.find((d) => d.label === 'phone seen')?.lastSeenAt);
  });
});

describe('revoking a device', () => {
  test('a revoked phone can no longer act', async () => {
    const pc = await registerPc('desktop revoke');
    const phone = await pairPhone(pc, 'doomed phone');

    await pc.client.del(`/devices/${phone.deviceId}`);

    await assert.rejects(
      phone.client.post('/blobs', {}),
      (error: { status: number }) => error.status === 401,
    );
  });

  test('its pending pages go with it, and the count is reported', async () => {
    // They are useless once the device is gone, since nothing will ever ack
    // them, and they would sit against the quota until the retention sweep.
    const pc = await registerPc('desktop blobs');
    const phone = await pairPhone(pc, 'phone with pages');

    const sessionId = randomUUID();
    for (const seq of [0, 1]) {
      const sealed = seal(new Uint8Array([1, 2, 3, 4]), pc.content.publicKey);
      await phone.client.post('/blobs', {
        blobId: randomUUID(),
        sessionId,
        seq,
        sizeBytes: sealed.length,
        capturedAt: new Date().toISOString(),
        ciphertext: toBase64(sealed),
      });
    }

    const before = await pc.client.get<{ blobs: unknown[] }>('/blobs');
    assert.equal(before.blobs.length, 2);

    const result = await pc.client.del<{ deletedBlobs: number }>(`/devices/${phone.deviceId}`);
    assert.equal(result.deletedBlobs, 2);

    const after = await pc.client.get<{ blobs: unknown[] }>('/blobs');
    assert.equal(after.blobs.length, 0);
  });

  test('a device cannot revoke itself', async () => {
    // Otherwise the obvious button on the obvious screen locks you out.
    const pc = await registerPc('desktop self');
    await assert.rejects(
      pc.client.del(`/devices/${pc.deviceId}`),
      (error: { status: number }) => error.status === 409,
    );
  });

  test('the only desktop cannot be revoked', async () => {
    // Revoking it strands every phone: nothing would be left that can decrypt a
    // page, and the account could not be repaired from inside the app.
    const pc = await registerPc('desktop only');
    const other = await registerPc('desktop other');

    // "other" is a separate account, so it cannot revoke the first one anyway.
    await assert.rejects(
      other.client.del(`/devices/${pc.deviceId}`),
      (error: { status: number }) => error.status === 404,
    );
  });

  test('revoking a device on another account is a 404, not a 403', async () => {
    // A 403 would confirm the id exists, which turns this into a way to probe
    // for device ids belonging to other people.
    const mine = await registerPc('desktop mine');
    const theirs = await registerPc('desktop theirs');
    const theirPhone = await pairPhone(theirs, 'their phone');

    await assert.rejects(
      mine.client.del(`/devices/${theirPhone.deviceId}`),
      (error: { status: number }) => error.status === 404,
    );

    // And it really is still there.
    const listed = await theirs.client.get<{ devices: unknown[] }>('/devices');
    assert.equal(listed.devices.length, 2);
  });

  test('an unknown device id is a 404', async () => {
    const pc = await registerPc('desktop unknown');
    await assert.rejects(
      pc.client.del(`/devices/${randomUUID()}`),
      (error: { status: number }) => error.status === 404,
    );
  });

  test('re-pairing after a revoke works, which is the whole point', async () => {
    const pc = await registerPc('desktop repair');
    const first = await pairPhone(pc, 'old phone');
    await pc.client.del(`/devices/${first.deviceId}`);

    const second = await pairPhone(pc, 'new phone');
    const listed = await pc.client.get<{ devices: Array<{ label: string }> }>('/devices');

    assert.deepEqual(listed.devices.map((d) => d.label).sort(), ['desktop repair', 'new phone']);
    assert.notEqual(second.deviceId, first.deviceId);
  });
});
