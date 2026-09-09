// The queue server.
//
// HARD RULE, from CLAUDE.md rule 3: this file must never decode an image. It
// stores opaque ciphertext under a size cap. There is deliberately no image
// library anywhere in this app's dependency tree, so an image-parsing CVE has
// nothing to attack here.

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  AUTH_HEADERS, LIMITS, signingString,
  RegisterPcRequest, CreatePairingRequest, CompletePairingRequest,
  UploadBlobRequest, AckBlobsRequest,
} from '@inkpipe/protocol';
import { verify, fromBase64Url, fromBase64, toBase64, sha256Hex } from '@inkpipe/crypto';
import { Store, type Device } from './db.ts';

export const VERSION = '0.1.0';

export interface ServerOptions {
  dataDir: string;
  /** Printed by the VPS bootstrap and pasted into the desktop setup wizard. */
  joinToken: string;
  /** Injectable so tests can control time rather than sleeping. */
  now?: () => Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    device?: Device;
  }
}

export function createServer(options: ServerOptions): FastifyInstance {
  const store = new Store(options.dataDir);
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger: false,
    // Ciphertext arrives base64 in JSON, so the JSON limit must exceed the raw
    // blob cap. base64 is 4/3, plus room for the rest of the envelope.
    bodyLimit: Math.ceil(LIMITS.maxBlobBytes * 1.4),
  });

  // Raw body is needed for signature verification, since the signature covers a
  // hash of exactly the bytes that arrived, not a re-serialised object.
  app.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    (request as FastifyRequest & { rawBody: Buffer }).rawBody = raw;

    const stream = new (await import('node:stream')).Readable();
    stream.push(raw);
    stream.push(null);
    return stream;
  });

  // -------------------------------------------------------------------------
  // Authentication (decision 5)
  // -------------------------------------------------------------------------

  function authenticate(request: FastifyRequest): Device | { error: string; message: string } {
    const deviceId = request.headers[AUTH_HEADERS.deviceId];
    const timestamp = request.headers[AUTH_HEADERS.timestamp];
    const signature = request.headers[AUTH_HEADERS.signature];

    if (typeof deviceId !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
      return { error: 'unauthenticated', message: 'missing authentication headers' };
    }

    const device = store.getDevice(deviceId);
    if (!device) {
      return { error: 'unauthenticated', message: 'unknown device' };
    }

    // Timestamp window first: it is the cheap check, and it is what stops a
    // captured request being replayed tomorrow.
    const sent = Date.parse(timestamp);
    if (Number.isNaN(sent)) {
      return { error: 'unauthenticated', message: 'malformed timestamp' };
    }
    const skew = Math.abs(now().getTime() - sent) / 1000;
    if (skew > LIMITS.signatureSkewSeconds) {
      return { error: 'unauthenticated', message: 'timestamp outside the accepted window' };
    }

    const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const message = new TextEncoder().encode(
      signingString({
        method: request.method,
        // request.url carries the query string, and it must be signed too:
        // otherwise a signature for one query could be replayed against another.
        path: request.url,
        timestamp,
        bodySha256Hex: sha256Hex(new Uint8Array(rawBody)),
      }),
    );

    let signatureBytes: Uint8Array;
    let publicKey: Uint8Array;
    try {
      signatureBytes = fromBase64Url(signature);
      publicKey = fromBase64Url(device.ed25519PublicKey);
    } catch {
      return { error: 'unauthenticated', message: 'malformed signature encoding' };
    }

    if (!verify(signatureBytes, message, publicKey)) {
      return { error: 'unauthenticated', message: 'bad signature' };
    }

    return device;
  }

  function requireAuth(role?: 'phone' | 'pc') {
    return async (request: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      const result = authenticate(request);
      if ('error' in result) {
        reply.code(401).send(result);
        return;
      }
      if (role && result.role !== role) {
        reply.code(403).send({ error: 'forbidden', message: `this endpoint requires a ${role} device` });
        return;
      }
      request.device = result;
    };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get('/health', async () => ({
    ok: true as const,
    version: VERSION,
    devices: store.countDevices(),
    pendingBlobs: store.countPendingBlobs(),
  }));

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  app.post('/pair/register-pc', async (request, reply) => {
    const parsed = RegisterPcRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message });
    }
    if (parsed.data.joinToken !== options.joinToken) {
      return reply.code(401).send({ error: 'unauthenticated', message: 'bad join token' });
    }

    // Recovery (issue #4). A desktop restored from its phrase derives the same
    // identity key, so it must find the device it already owns rather than
    // create a second account that cannot see its own pending pages.
    const existing = store.getDeviceByIdentityKey(parsed.data.ed25519PublicKey);
    if (existing) {
      if (existing.x25519PublicKey !== parsed.data.x25519PublicKey) {
        // Same identity, different content key. Accepting it would orphan every
        // blob already sealed to the old one, so refuse rather than guess.
        return reply.code(409).send({
          error: 'content_key_mismatch',
          message:
            'this device is already registered with a different content key. ' +
            'Accepting a new one would make every page still waiting on the server unreadable.',
        });
      }
      return reply.code(200).send({
        accountId: existing.accountId,
        deviceId: existing.id,
        restored: true,
      });
    }

    const timestamp = now().toISOString();
    const accountId = randomUUID();
    const deviceId = randomUUID();

    store.createAccount(accountId, timestamp);
    store.insertDevice({
      id: deviceId,
      accountId,
      role: 'pc',
      ed25519PublicKey: parsed.data.ed25519PublicKey,
      x25519PublicKey: parsed.data.x25519PublicKey,
      label: parsed.data.label,
    }, timestamp);

    return reply.code(201).send({ accountId, deviceId, restored: false });
  });

  app.post('/pair/create', { preHandler: requireAuth('pc') }, async (request, reply) => {
    const parsed = CreatePairingRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message });
    }

    const device = request.device!;
    const pairingToken = randomUUID().replace(/-/g, '');
    const expiresAt = new Date(now().getTime() + parsed.data.ttlSeconds * 1000).toISOString();
    store.insertPairing(pairingToken, device.accountId, expiresAt);

    return reply.code(201).send({
      pairingToken,
      expiresAt,
      serverUrl: `${request.protocol}://${request.hostname}`,
      x25519PublicKey: device.x25519PublicKey,
    });
  });

  app.post('/pair/complete', async (request, reply) => {
    const parsed = CompletePairingRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message });
    }

    const timestamp = now().toISOString();
    const accountId = store.redeemPairing(parsed.data.pairingToken, timestamp);
    if (!accountId) {
      return reply.code(401).send({
        error: 'unauthenticated',
        message: 'pairing token is unknown, expired or already used',
      });
    }

    const contentKey = store.getPcContentKey(accountId);
    if (!contentKey) {
      return reply.code(409).send({ error: 'conflict', message: 'account has no pc content key' });
    }

    const deviceId = randomUUID();
    store.insertDevice({
      id: deviceId,
      accountId,
      role: 'phone',
      ed25519PublicKey: parsed.data.ed25519PublicKey,
      x25519PublicKey: null,
      label: parsed.data.label,
    }, timestamp);

    return reply.code(201).send({ accountId, deviceId, x25519PublicKey: contentKey });
  });

  // -------------------------------------------------------------------------
  // Blobs
  // -------------------------------------------------------------------------

  app.post('/blobs', { preHandler: requireAuth('phone') }, async (request, reply) => {
    const parsed = UploadBlobRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message });
    }
    const device = request.device!;
    const body = parsed.data;

    // Idempotency (decision 14): a retried upload must never create a second
    // copy of a page, so this is checked before anything is written.
    if (store.hasBlob(body.blobId)) {
      return reply.code(200).send({ blobId: body.blobId, duplicate: true });
    }

    let ciphertext: Uint8Array;
    try {
      ciphertext = fromBase64(body.ciphertext);
    } catch {
      return reply.code(400).send({ error: 'bad_request', message: 'ciphertext is not valid base64' });
    }

    // The declared size must match what actually arrived. Otherwise a client
    // could declare 1 byte and upload 12 MB, defeating the quota.
    if (ciphertext.length !== body.sizeBytes) {
      return reply.code(400).send({
        error: 'bad_request',
        message: `sizeBytes ${body.sizeBytes} does not match the ${ciphertext.length} bytes received`,
      });
    }
    if (ciphertext.length > LIMITS.maxBlobBytes) {
      return reply.code(413).send({ error: 'too_large', message: 'blob exceeds the size limit' });
    }

    const used = store.bytesUsedByDevice(device.id);
    if (used + ciphertext.length > LIMITS.maxBytesPerDevice) {
      return reply.code(507).send({
        error: 'quota_exceeded',
        message: 'device quota exceeded, collect pending blobs first',
      });
    }

    const timestamp = now().toISOString();
    store.insertBlob({
      blobId: body.blobId,
      accountId: device.accountId,
      fromDeviceId: device.id,
      sessionId: body.sessionId,
      seq: body.seq,
      sizeBytes: ciphertext.length,
      capturedAt: body.capturedAt,
      createdAt: timestamp,
    }, ciphertext);

    return reply.code(201).send({ blobId: body.blobId, duplicate: false });
  });

  app.get('/blobs', { preHandler: requireAuth('pc') }, async (request, reply) => {
    const device = request.device!;
    const blobs = store.pendingBlobs(device.accountId);
    return reply.send({
      blobs: blobs.map(({ blobId, sessionId, seq, sizeBytes, capturedAt }) => ({
        blobId, sessionId, seq, sizeBytes, capturedAt,
      })),
      bytesUsed: blobs.reduce((n, b) => n + b.sizeBytes, 0),
      bytesQuota: LIMITS.maxBytesPerDevice,
    });
  });

  app.get<{ Params: { blobId: string } }>(
    '/blobs/:blobId',
    { preHandler: requireAuth('pc') },
    async (request, reply) => {
      const device = request.device!;
      const found = store.getBlob(request.params.blobId, device.accountId);
      if (!found) {
        return reply.code(404).send({ error: 'not_found', message: 'no such blob' });
      }
      const { row, ciphertext } = found;
      return reply.send({
        blobId: row.blobId,
        sessionId: row.sessionId,
        seq: row.seq,
        sizeBytes: row.sizeBytes,
        capturedAt: row.capturedAt,
        ciphertext: toBase64(ciphertext),
      });
    },
  );

  app.post('/blobs/ack', { preHandler: requireAuth('pc') }, async (request, reply) => {
    const parsed = AckBlobsRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: parsed.error.message });
    }
    const device = request.device!;
    return reply.send({ deleted: store.deleteBlobs(parsed.data.blobIds, device.accountId) });
  });

  app.addHook('onClose', async () => store.close());
  (app as FastifyInstance & { store: Store }).store = store;
  return app;
}
