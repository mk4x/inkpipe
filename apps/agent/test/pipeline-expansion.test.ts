// Expansion inside the pipeline.
//
// expand.test.ts and expand-research.test.ts cover the checks. This covers the
// wiring: that a draft actually gets expanded, that the terms come from the
// transcript, that a failure during expansion never costs the transcribed page,
// and that the explanations reach the rendered note.
//
// The client and both models are fakes. The crypto and the image handling are
// real, because a draft that decodes wrongly would make the rest meaningless.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateContentKeyPair, seal, toBase64 } from '@inkpipe/crypto';
import { collectDrafts, renderNote, type Draft } from '../src/pipeline.ts';
import type { Expansion } from '../src/expand.ts';

const CORPUS = join(import.meta.dirname, '../../../packages/corpus/images');
const IMAGE = readFileSync(join(CORPUS, 'page-a-virtual-machines.jpg'));

const TRANSCRIPT = [
  '# Compiler Construction',
  '- front end: lexical analysis',
  '- IR: LLVM language',
].join('\n');

/** A client that serves one sealed page and nothing else. */
function fakeClient(publicKey: Uint8Array) {
  const sessionId = randomUUID();
  const blobId = randomUUID();
  const sealed = seal(new Uint8Array(IMAGE), publicKey);

  return {
    sessionId,
    client: {
      async get<T>(path: string): Promise<T> {
        if (path === '/blobs') {
          return {
            blobs: [{ blobId, sessionId, seq: 0, length: sealed.length }],
          } as T;
        }
        return { ciphertext: toBase64(sealed) } as T;
      },
      async post<T>(): Promise<T> {
        return {} as T;
      },
    },
  };
}

/** A vision model that returns a fixed transcript. */
const visionModel = async () => TRANSCRIPT;

/** A text model scripted by which stage is asking. */
function textModel(script: {
  terms?: string;
  explain?: string;
  page?: string;
  fail?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    model: async (prompt: string) => {
      if (script.fail) throw new Error('the expansion model fell over');
      if (prompt.includes('One term per line')) {
        calls.push('extract');
        return script.terms ?? 'lexical analysis';
      }
      if (prompt.includes('CONTRADICTS or CONSISTENT')) {
        calls.push('page');
        return script.page ?? 'CONSISTENT';
      }
      if (prompt.includes('AGREE or DISAGREE')) {
        calls.push('agreement');
        return 'AGREE';
      }
      calls.push('explain');
      return script.explain ?? 'Lexical analysis turns characters into tokens.';
    },
  };
}

async function collect(expansion?: Parameters<typeof collectDrafts>[0]['expansion']) {
  const keys = generateContentKeyPair();
  const { client } = fakeClient(keys.publicKey);

  return collectDrafts({
    client: client as never,
    contentPrivateKey: keys.privateKey,
    course: 'Compiler Construction',
    model: visionModel,
    expansion,
  });
}

describe('expansion in the pipeline', () => {
  test('a draft has no expansions when expansion is off', async () => {
    const [draft] = await collect();
    assert.deepEqual(draft.expansions, []);
    assert.equal(draft.expansionError, null);
  });

  test('terms are taken from the transcript and expanded', async () => {
    const { model, calls } = textModel({});
    const [draft] = await collect({ model, samples: 1 });

    assert.equal(calls[0], 'extract', 'terms are chosen before anything is explained');
    assert.equal(draft.expansions.length, 1);
    assert.equal(draft.expansions[0].term, 'lexical analysis');
    assert.equal(draft.expansions[0].confidence, 'high');
  });

  test('a term the model invents is never expanded', async () => {
    // The extraction guard, exercised through the real pipeline: the term has
    // to be on the page.
    const { model } = textModel({ terms: 'lexical analysis\nquantum register folding' });
    const [draft] = await collect({ model, samples: 1 });

    assert.deepEqual(draft.expansions.map((e) => e.term), ['lexical analysis']);
  });

  test('the cap is honoured, since each term costs model time and a query', async () => {
    const { model } = textModel({ terms: 'lexical analysis\nIR\nLLVM' });
    const [draft] = await collect({ model, samples: 1, maxTermsPerNote: 2 });

    assert.equal(draft.expansions.length, 2);
  });

  test('an expansion failure does not cost the transcribed page', async () => {
    // The property that matters most here. Transcription is the expensive part
    // and the part the user actually needs; expansion is a bonus on top.
    const { model } = textModel({ fail: true });
    const [draft] = await collect({ model, samples: 1 });

    assert.equal(draft.pages.length, 1);
    assert.equal(draft.pages[0].ok, true);
    assert.match(draft.pages[0].markdown, /lexical analysis/);
    assert.deepEqual(draft.expansions, []);
    assert.match(draft.expansionError ?? '', /fell over/);
  });

  test('expansion without research cites nothing and classifies nothing', async () => {
    const { model, calls } = textModel({});
    const [draft] = await collect({ model, samples: 1, research: undefined });

    assert.deepEqual(draft.expansions[0].sources, []);
    assert.ok(
      !calls.includes('snippet'),
      'no snippet is classified, because none was fetched',
    );
    // The pre-ADR-0004 outcome set, unchanged when research is off.
    assert.ok(['high', 'low', 'contradicted', 'refused'].includes(draft.expansions[0].confidence));
  });

  test('research is consulted once per term when it is configured', async () => {
    const terms: string[] = [];
    const { model } = textModel({});

    const [draft] = await collect({
      model,
      samples: 1,
      research: {
        async lookup(term: string) {
          terms.push(term);
          return { results: [], reason: null };
        },
      },
    });

    assert.deepEqual(terms, ['lexical analysis']);
    for (const term of terms) {
      assert.ok(!term.includes('IR: LLVM'), 'note content must never reach a lookup');
    }
    assert.equal(draft.expansions.length, 1);
  });
});

describe('rendering a note with explanations', () => {
  const draft = (over: Partial<Draft>): Draft => ({
    sessionId: 's', suggestedTitle: 'Compilers', course: 'Compiler Construction',
    blobIds: [], expansions: [], expansionError: null,
    pages: [{
      blobId: 'b', seq: 0, markdown: TRANSCRIPT, ok: true, variantUsed: 'minimal',
      failureReason: null, vaultImage: new Uint8Array([1]), imageFilename: 's-p00.webp',
      sanitiserChanges: [], formatterChanges: [],
    }],
    ...over,
  });

  const expansion = (over: Partial<Expansion>): Expansion => ({
    term: 'lexical analysis', text: 'It turns characters into tokens.',
    confidence: 'high', reason: null, agreement: 1, sources: [], ...over,
  });

  test('explanations come after the pages and the image', async () => {
    const note = renderNote(draft({ expansions: [expansion({})] }), 'Images');

    assert.ok(note.indexOf('![[Images/') < note.indexOf('## Explanations'),
      'the photograph belongs with the page, not after the commentary');
    assert.match(note, /Added by the model, not on the page/);
  });

  test('a note with no expansions gains no section', async () => {
    const note = renderNote(draft({}), 'Images');
    assert.ok(!note.includes('## Explanations'));
  });

  test('a failed expansion is stated in the note rather than left silent', async () => {
    // A missing section is indistinguishable from the feature not running.
    const note = renderNote(draft({ expansionError: 'ollama returned 500' }), 'Images');
    assert.match(note, /Explanations were not generated/);
    assert.match(note, /ollama returned 500/);
  });

  test('a disputed explanation is flagged in the written note', async () => {
    const note = renderNote(draft({
      expansions: [expansion({
        confidence: 'disputed',
        reason: 'this conflicts with the page, but the sources below support it',
        sources: [{ title: 'Leftist tree', url: 'https://en.wikipedia.org/wiki/Leftist_tree', snippet: '' }],
      })],
    }), 'Images');

    assert.match(note, /Check these yourself/);
    assert.match(note, /disputed/);
    assert.match(note, /Sources: en\.wikipedia\.org/);
    assert.ok(!/\]\(https?:/.test(note), 'citations stay inert, per rule 5');
  });
});
