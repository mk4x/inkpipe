// The desktop service against a real inkpipe server, a real vault, and a real
// phone upload. Only the model is faked.
//
// This is the whole user journey: setup, pair, phone uploads, refresh, edit,
// approve, push.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createServer } from '../../server/src/server.ts';
import { createService } from '../service/src/api.ts';
import { loadConfig, glossaryFor } from '../service/src/config.ts';
import { InkpipeClient } from '@inkpipe/client';
import { generateIdentityKeyPair, seal, toBase64Url, toBase64 } from '@inkpipe/crypto';

const JOIN_TOKEN = 'desktop-test-join-token-0123456789';

let server: ReturnType<typeof createServer>;
let serverUrl: string;
let serverDir: string;

let service: ReturnType<typeof createService>;
let serviceUrl: string;
let uiToken: string;

let workDir: string;
let configPath: string;
let keystorePath: string;
let vaultRoot: string;
let vaultRemote: string;

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

/** Calls the desktop service the way the UI does. */
async function ui<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${serviceUrl}${path}`, {
    method,
    headers: {
      'x-inkpipe-ui-token': uiToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

before(async () => {
  serverDir = mkdtempSync(join(tmpdir(), 'inkpipe-dt-server-'));
  server = createServer({ dataDir: serverDir, joinToken: JOIN_TOKEN });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const a = server.server.address();
  serverUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(async () => {
  // The desktop service must be closed too. Leaving the last one listening
  // keeps the event loop alive and node --test never exits.
  if (service) await service.app.close();
  await server.close();
  for (const dir of [serverDir, workDir, vaultRoot, vaultRemote]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  if (service) await service.app.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
  if (vaultRemote) rmSync(vaultRemote, { recursive: true, force: true });

  workDir = mkdtempSync(join(tmpdir(), 'inkpipe-dt-work-'));
  configPath = join(workDir, 'config.json');
  keystorePath = join(workDir, 'keys.json');

  vaultRemote = mkdtempSync(join(tmpdir(), 'inkpipe-dt-remote-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', vaultRemote]);
  vaultRoot = mkdtempSync(join(tmpdir(), 'inkpipe-dt-vault-'));
  execFileSync('git', ['init', '-b', 'main', vaultRoot]);
  git(vaultRoot, 'config', 'user.email', 't@example.com');
  git(vaultRoot, 'config', 'user.name', 'T');
  writeFileSync(join(vaultRoot, 'README.md'), '# vault\n');
  git(vaultRoot, 'add', '.');
  git(vaultRoot, 'commit', '-m', 'initial');
  git(vaultRoot, 'remote', 'add', 'origin', vaultRemote);
  git(vaultRoot, 'push', '-u', 'origin', 'main');

  service = createService({
    configPath,
    keystorePath,
    modelFactory: () => async () => '# Leftist Heaps\n\nrank is distance to nil.\n',
  });
  uiToken = service.token;
  await service.app.listen({ port: 0, host: '127.0.0.1' });
  const b = service.app.server.address();
  serviceUrl = `http://127.0.0.1:${typeof b === 'object' && b ? b.port : 0}`;
});

const setupBody = () => ({
  serverUrl,
  joinToken: JOIN_TOKEN,
  label: 'test desktop',
  vault: { root: vaultRoot, notesPath: 'School/Semester 5', attachmentsPath: 'Images' },
  courses: [{ name: 'Algorithms', glossary: ['leftist heap', 'meld'] }],
  defaultCourse: 'Algorithms',
});

/** Pair a phone and upload one page, as the Expo app will. */
async function phoneUploads(pages = 1) {
  const pairing = await ui<{ qr: string }>('POST', '/api/pairing');
  const qr = JSON.parse(pairing.body.qr) as {
    serverUrl: string; pairingToken: string; x25519PublicKey: string;
  };

  const identity = generateIdentityKeyPair();
  const paired = await new InkpipeClient({ baseUrl: qr.serverUrl })
    .post<{ deviceId: string; x25519PublicKey: string }>('/pair/complete', {
      pairingToken: qr.pairingToken,
      ed25519PublicKey: toBase64Url(identity.publicKey),
      label: 'phone',
    });

  const phone = new InkpipeClient({
    baseUrl: qr.serverUrl,
    credentials: { deviceId: paired.deviceId, ed25519PrivateKey: identity.privateKey },
  });

  const recipient = new Uint8Array(Buffer.from(paired.x25519PublicKey, 'base64url'));
  const image = new Uint8Array(readFileSync(join(
    import.meta.dirname, '../../../packages/corpus/images/page-b-meldable-priority-queues.jpg',
  )));
  const sessionId = randomUUID();

  for (let seq = 0; seq < pages; seq++) {
    const sealed = seal(image, recipient);
    await phone.post('/blobs', {
      blobId: randomUUID(),
      sessionId,
      seq,
      sizeBytes: sealed.length,
      capturedAt: new Date().toISOString(),
      ciphertext: toBase64(sealed),
    });
  }
  return { sessionId, qr };
}

describe('ui token', () => {
  test('rejects a request with no token', async () => {
    const response = await fetch(`${serviceUrl}/api/status`);
    assert.equal(response.status, 401);
  });

  test('rejects a wrong token', async () => {
    const response = await fetch(`${serviceUrl}/api/status`, {
      headers: { 'x-inkpipe-ui-token': 'x'.repeat(uiToken.length) },
    });
    assert.equal(response.status, 401);
  });

  test('health is reachable without a token, for liveness checks', async () => {
    assert.equal((await fetch(`${serviceUrl}/api/health`)).status, 200);
  });
});

describe('setup', () => {
  test('reports unconfigured before setup', async () => {
    const { body } = await ui<{ configured: boolean }>('GET', '/api/status');
    assert.equal(body.configured, false);
  });

  test('registers, writes config and keys', async () => {
    const created = await ui<{ deviceId: string }>('POST', '/api/setup', setupBody());
    assert.equal(created.status, 201);
    assert.ok(existsSync(configPath));
    assert.ok(existsSync(keystorePath));

    const config = loadConfig(configPath);
    assert.equal(config.serverUrl, serverUrl);
    assert.equal(config.vault.root, vaultRoot);
    assert.equal(config.model.name, 'qwen2.5vl:7b', 'ADR 0001 default must be applied');
    assert.equal(config.pollSeconds, 60, 'decision 13 default');
    assert.equal(config.cloudEscalationEnabled, false, 'decision 6: cloud is opt-in');
  });

  test('refuses a vault that is not a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'inkpipe-dt-plain-'));
    try {
      const result = await ui<{ error: string }>('POST', '/api/setup', {
        ...setupBody(),
        vault: { root: plain, notesPath: 'Notes', attachmentsPath: 'Images' },
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'bad_vault');
      assert.equal(existsSync(keystorePath), false, 'must not create keys for a bad setup');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('refuses a bad join token', async () => {
    const result = await ui<{ error: string }>('POST', '/api/setup', {
      ...setupBody(), joinToken: 'wrong-token-aaaaaaaa',
    });
    assert.equal(result.status, 502);
  });

  test('refuses to run setup twice', async () => {
    await ui('POST', '/api/setup', setupBody());
    const second = await ui<{ error: string }>('POST', '/api/setup', setupBody());
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'already_configured');
  });
});

describe('the full journey', () => {
  test('setup, pair, upload, refresh, approve, push', async () => {
    await ui('POST', '/api/setup', setupBody());
    await phoneUploads(1);

    const status = await ui<{ pending: number }>('GET', '/api/status');
    assert.equal(status.body.pending, 1, 'the desktop must see the uploaded page');

    const refreshed = await ui<{ drafts: number }>('POST', '/api/refresh');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.drafts, 1);

    const listed = await ui<{ drafts: { sessionId: string; suggestedTitle: string; pages: { imageDataUrl: string; ok: boolean }[] }[] }>(
      'GET', '/api/drafts',
    );
    const draft = listed.body.drafts[0];
    assert.equal(draft.suggestedTitle, 'Leftist Heaps');
    assert.equal(draft.pages[0].ok, true);
    assert.match(draft.pages[0].imageDataUrl, /^data:image\/webp;base64,/,
      'the preview needs the photograph beside the text');

    // The user edits the title, as decision 21 requires them to be able to.
    const approved = await ui<{ notePath: string; commitSha: string; acked: number }>(
      'POST', `/api/drafts/${draft.sessionId}/approve`,
      { title: 'Leftist and Skew Heaps', course: 'Algorithms', glossaryTerms: ['rank', 'nil'] },
    );
    assert.equal(approved.status, 200);
    assert.match(approved.body.notePath, /Leftist and Skew Heaps\.md$/);
    assert.equal(approved.body.acked, 1);

    const written = readFileSync(approved.body.notePath, 'utf8');
    assert.match(written, /rank is distance to nil/);
    assert.match(written, /title: "Leftist and Skew Heaps"/, 'the user edit must win');

    // Blobs released only after the note is safe.
    const afterStatus = await ui<{ pending: number; drafts: number }>('GET', '/api/status');
    assert.equal(afterStatus.body.pending, 0);
    assert.equal(afterStatus.body.drafts, 0);

    // Corrections fed the glossary.
    const config = loadConfig(configPath);
    const glossary = glossaryFor(config, 'Algorithms');
    assert.ok(glossary.includes('rank'), `expected rank in ${JSON.stringify(glossary)}`);
    assert.ok(glossary.includes('leftist heap'), 'existing terms must survive');

    const pushed = await ui<{ outcome: string }>('POST', '/api/push');
    assert.equal(pushed.body.outcome, 'pushed');
  });

  test('page edits from the preview override the model', async () => {
    await ui('POST', '/api/setup', setupBody());
    await phoneUploads(1);
    await ui('POST', '/api/refresh');
    const listed = await ui<{ drafts: { sessionId: string; pages: { blobId: string }[] }[] }>('GET', '/api/drafts');
    const draft = listed.body.drafts[0];

    const approved = await ui<{ notePath: string }>(
      'POST', `/api/drafts/${draft.sessionId}/approve`,
      {
        title: 'Corrected',
        course: 'Algorithms',
        pages: [{ blobId: draft.pages[0].blobId, markdown: '# Corrected\n\nu.left().rank >= u.right().rank()\n' }],
      },
    );

    const written = readFileSync(approved.body.notePath, 'utf8');
    assert.match(written, />= u\.right\(\)\.rank/, 'the human correction must be what lands');
    assert.ok(!written.includes('rank is distance to nil'), 'the model text must be replaced');
  });

  test('a dirty vault blocks approval with a clear reason', async () => {
    await ui('POST', '/api/setup', setupBody());
    await phoneUploads(1);
    await ui('POST', '/api/refresh');
    const listed = await ui<{ drafts: { sessionId: string }[] }>('GET', '/api/drafts');

    writeFileSync(join(vaultRoot, 'my-own-work.md'), 'in progress');

    const result = await ui<{ error: string; message: string }>(
      'POST', `/api/drafts/${listed.body.drafts[0].sessionId}/approve`,
      { title: 'Anything', course: 'Algorithms' },
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'dirty_tree');

    // And the blobs were NOT acked, so nothing is lost.
    const status = await ui<{ pending: number }>('GET', '/api/status');
    assert.equal(status.body.pending, 1);
  });

  test('a multi-page session becomes one draft', async () => {
    await ui('POST', '/api/setup', setupBody());
    await phoneUploads(3);
    await ui('POST', '/api/refresh');
    const listed = await ui<{ drafts: { pages: unknown[] }[] }>('GET', '/api/drafts');
    assert.equal(listed.body.drafts.length, 1);
    assert.equal(listed.body.drafts[0].pages.length, 3);
  });
});

describe('pairing', () => {
  test('the QR payload carries exactly what the phone needs', async () => {
    await ui('POST', '/api/setup', setupBody());
    const pairing = await ui<{ qr: string; expiresAt: string }>('POST', '/api/pairing');
    const payload = JSON.parse(pairing.body.qr);
    assert.deepEqual(Object.keys(payload).sort(), ['pairingToken', 'serverUrl', 'v', 'x25519PublicKey']);
    assert.equal(payload.v, 1);
  });

  test('pairing before setup is refused', async () => {
    const result = await ui<{ error: string }>('POST', '/api/pairing');
    assert.equal(result.status, 409);
  });
});
