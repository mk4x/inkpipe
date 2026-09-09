// Full pipeline against the REAL local model, not a fake.
//
// The e2e test uses a fake model because CI has no GPU. This script is the
// counterpart you run on the machine that does: it exercises the identical code
// path with Ollama actually transcribing, and leaves a real committed note in a
// throwaway vault you can open in Obsidian.
//
//   node tools/demo-real.ts [--page page-b-meldable-priority-queues] [--keep]
//
// Prints the note it produced. Cleans up unless --keep is passed.

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createServer } from '../apps/server/src/server.ts';
import { InkpipeClient } from '@inkpipe/client';
import { generateIdentityKeyPair, generateContentKeyPair, seal, toBase64Url, toBase64 } from '@inkpipe/crypto';
import { collectDrafts, renderNote } from '../apps/agent/src/pipeline.ts';
import { writeNote, type VaultConfig } from '../apps/agent/src/vault.ts';
import { ollamaModel } from '../apps/agent/src/transcribe.ts';

const args = process.argv.slice(2);
const pageId = args.includes('--page') ? args[args.indexOf('--page') + 1] : 'page-b-meldable-priority-queues';
const keep = args.includes('--keep');

// Rotation and course per corpus page, matching the spike harness.
const PAGE_CONFIG: Record<string, { rotate: number; course: string; glossary: string[] }> = {
  'page-a-virtual-machines': {
    rotate: 270,
    course: 'Operating Systems',
    glossary: ['hypervisor', 'virtual machine', 'VMM', 'vCPU', 'guest', 'host', 'kernel',
      'page table', 'TLB', 'trap and emulate', 'binary translation', 'container',
      'emulator', 'snapshot', 'migration', 'dirty bit', 'userland'],
  },
  'page-b-meldable-priority-queues': {
    rotate: 0,
    course: 'Algorithms and Data Structures',
    glossary: ['priority queue', 'binary heap', 'leftist heap', 'skew heap', 'meld',
      'rank', 'amortized', 'subtree', 'node', 'nil', 'invariant', 'asymptotic',
      'insert', 'delete minimum', 'singleton'],
  },
  'page-c-max-flow-min-cut': {
    rotate: 0,
    course: 'Network Flow',
    glossary: ['capacity constraint', 'flow conservation', 'arc', 'source', 'sink',
      'maximum flow', 'minimum cut', 'residual capacity', 'augmenting path',
      'forward edge', 'backward edge', 'bounded', 'saturated', 'cut'],
  },
  'page-d-adversarial-test-page': { rotate: 0, course: 'General', glossary: [] },
};

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const config = PAGE_CONFIG[pageId];
if (!config) {
  console.error(`unknown page ${pageId}. Known: ${Object.keys(PAGE_CONFIG).join(', ')}`);
  process.exit(2);
}

const serverDir = mkdtempSync(join(tmpdir(), 'inkpipe-demo-server-'));
const vaultRoot = mkdtempSync(join(tmpdir(), 'inkpipe-demo-vault-'));

const app = createServer({ dataDir: serverDir, joinToken: 'demo-join-token-0123456789' });
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

execFileSync('git', ['init', '-b', 'main', vaultRoot]);
git(vaultRoot, 'config', 'user.email', 'demo@example.com');
git(vaultRoot, 'config', 'user.name', 'inkpipe demo');
writeFileSync(join(vaultRoot, 'README.md'), '# demo vault\n');
git(vaultRoot, 'add', '.');
git(vaultRoot, 'commit', '-m', 'initial');

const vaultConfig: VaultConfig = {
  root: vaultRoot,
  notesPath: 'School/Semester 5',
  attachmentsPath: 'Images',
};

console.log(`page      ${pageId}`);
console.log(`course    ${config.course}`);
console.log(`server    ${baseUrl}`);
console.log(`vault     ${vaultRoot}`);
console.log('');

// --- pair a desktop and a phone, exactly as the real apps will --------------
const pcIdentity = generateIdentityKeyPair();
const pcContent = generateContentKeyPair();
const anonymous = new InkpipeClient({ baseUrl });

const registered = await anonymous.post<{ deviceId: string }>('/pair/register-pc', {
  joinToken: 'demo-join-token-0123456789',
  ed25519PublicKey: toBase64Url(pcIdentity.publicKey),
  x25519PublicKey: toBase64Url(pcContent.publicKey),
  label: 'demo desktop',
});
const pc = new InkpipeClient({
  baseUrl,
  credentials: { deviceId: registered.deviceId, ed25519PrivateKey: pcIdentity.privateKey },
});
const pairing = await pc.post<{ pairingToken: string }>('/pair/create', { ttlSeconds: 300 });

const phoneIdentity = generateIdentityKeyPair();
const paired = await anonymous.post<{ deviceId: string; x25519PublicKey: string }>('/pair/complete', {
  pairingToken: pairing.pairingToken,
  ed25519PublicKey: toBase64Url(phoneIdentity.publicKey),
  label: 'demo phone',
});
const phone = new InkpipeClient({
  baseUrl,
  credentials: { deviceId: paired.deviceId, ed25519PrivateKey: phoneIdentity.privateKey },
});
console.log('paired    phone and desktop, key exchanged via pairing token');

// --- phone uploads a real photograph ---------------------------------------
const original = new Uint8Array(readFileSync(join(import.meta.dirname, '../packages/corpus/images', `${pageId}.jpg`)));
const sealed = seal(original, new Uint8Array(Buffer.from(paired.x25519PublicKey, 'base64url')));
await phone.post('/blobs', {
  blobId: randomUUID(),
  sessionId: randomUUID(),
  seq: 0,
  sizeBytes: sealed.length,
  capturedAt: new Date().toISOString(),
  ciphertext: toBase64(sealed),
});
console.log(`uploaded  ${(original.length / 1048576).toFixed(1)} MB original, sealed to ${sealed.length} bytes`);

// --- desktop collects and transcribes with the REAL model -------------------
console.log('running   qwen2.5vl:7b (this is the slow part)');
const started = Date.now();
const drafts = await collectDrafts({
  client: pc,
  contentPrivateKey: pcContent.privateKey,
  course: config.course,
  glossary: config.glossary,
  rotate: config.rotate,
  model: ollamaModel({ model: 'qwen2.5vl:7b' }),
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const draft = drafts[0];
const page = draft.pages[0];
console.log(`done      ${seconds}s, prompt variant "${page.variantUsed ?? 'none succeeded'}"`);
console.log(`title     ${draft.suggestedTitle}`);
console.log(`ok        ${page.ok}${page.ok ? '' : `  (${page.failureReason})`}`);
if (page.sanitiserChanges.length > 0) {
  console.log(`sanitised ${page.sanitiserChanges.join('; ')}`);
}

// --- write and commit -------------------------------------------------------
const markdown = renderNote(draft, vaultConfig.attachmentsPath);
const result = await writeNote(vaultConfig, {
  course: draft.course,
  title: draft.suggestedTitle,
  markdown,
  images: draft.pages.map((p) => ({ filename: p.imageFilename, bytes: p.vaultImage })),
});

console.log(`written   ${result.notePath.replace(vaultRoot, '<vault>')}`);
console.log(`image     ${(page.vaultImage.length / 1024).toFixed(0)} KB webp`);
console.log(`commit    ${git(vaultRoot, 'log', '-1', '--pretty=%h %s')}`);
console.log(`clean     ${git(vaultRoot, 'status', '--porcelain') === '' ? 'yes' : 'NO'}`);

console.log(`\n${'='.repeat(76)}\n`);
console.log(readFileSync(result.notePath, 'utf8'));
console.log('='.repeat(76));

await app.close();
if (keep) {
  console.log(`\nvault kept at ${vaultRoot}`);
} else {
  rmSync(serverDir, { recursive: true, force: true });
  rmSync(vaultRoot, { recursive: true, force: true });
}
