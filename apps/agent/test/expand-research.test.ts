// The outcome matrix when sources are in play (ADR 0004).
//
// expand.test.ts covers expansion with no network at all. This file covers the
// combination rule: what happens when the page and the sources disagree, which
// is the case the page-as-ground-truth gate handles badly and the case the
// owner set out to test by writing notes that are deliberately wrong.
//
// The model and the search are both scripted. Whether a real 14B classifies a
// real snippet correctly is a question for a spike; whether a given pair of
// verdicts produces the right outcome is a question for here, and it is the
// place a wrong answer turns into a wrong note.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expandTerm, renderExpansions, type ExpandOptions } from '../src/expand.ts';
import type { SearchResult } from '../src/search.ts';

const NOTES = [
  'Leftist Heap',
  '- rank is distance to nil (closest empty node)',
  '- Leftist: u.left().rank >= u.right().rank()',
].join('\n');

const supporting: SearchResult = {
  title: 'Leftist tree',
  url: 'https://en.wikipedia.org/wiki/Leftist_tree',
  snippet: 'The rank of a node is the length of the shortest path to a leaf.',
};

const refuting: SearchResult = {
  title: 'Heaps explained',
  url: 'https://blog.example.org/heaps',
  snippet: 'Rank is simply the number of nodes contained in the subtree.',
};

const offTopic: SearchResult = {
  title: 'Sourdough',
  url: 'https://baking.example.org/sourdough',
  snippet: 'Let the starter rest for twelve hours before the first fold.',
};

interface Script {
  explain?: string;
  /** The page gate verdict. */
  page?: 'CONTRADICTS' | 'CONSISTENT';
  /** Snippet verdicts keyed by a fragment of the source URL. */
  snippets?: Record<string, string>;
  /** What the model writes when asked to work from sources alone. */
  fromSources?: string;
}

function harness(script: Script) {
  const calls = { explain: 0, page: 0, agreement: 0, snippet: 0, fromSources: 0 };

  const model = async (prompt: string) => {
    if (prompt.includes('SUPPORTS, REFUTES, or IRRELEVANT')) {
      calls.snippet++;
      const key = Object.keys(script.snippets ?? {}).find((k) => prompt.includes(k));
      return key ? script.snippets![key] : 'IRRELEVANT';
    }
    if (prompt.includes('CONTRADICTS or CONSISTENT')) {
      calls.page++;
      return script.page ?? 'CONSISTENT';
    }
    if (prompt.includes('AGREE or DISAGREE')) {
      calls.agreement++;
      return 'AGREE';
    }
    if (prompt.includes('Using only the snippets above')) {
      calls.fromSources++;
      return script.fromSources ?? 'An explanation drawn from the sources.';
    }
    calls.explain++;
    return script.explain ?? 'An explanation.';
  };

  return { model, calls };
}

/** A lookup that records the terms it was asked for. */
function lookupOf(results: SearchResult[], reason: string | null = null) {
  const terms: string[] = [];
  return {
    terms,
    research: {
      async lookup(term: string) {
        terms.push(term);
        return { results, reason };
      },
    } satisfies ExpandOptions['research'],
  };
}

const base = { notes: NOTES, samples: 1 };

describe('the page agrees or is silent', () => {
  test('sources that support it give high confidence and cite themselves', async () => {
    const { model } = harness({ snippets: { 'wikipedia.org': 'SUPPORTS' } });
    const { research } = lookupOf([supporting, offTopic]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'high');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, supporting.url);
  });

  test('sources that argue against it mark it, and never delete it', async () => {
    // The regression this feature must avoid is a content farm outranking a
    // correct explanation. Sources get a vote, not a veto, so the text stays
    // and the reader is told to check it.
    const { model } = harness({ snippets: { 'blog.example.org': 'REFUTES' } });
    const { research } = lookupOf([refuting]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'unsupported');
    assert.ok(result.text.length > 0, 'sources may qualify an explanation, not remove it');
    assert.match(result.reason ?? '', /argue against/);
  });

  test('sources that disagree with each other are reported as disagreement', async () => {
    const { model } = harness({
      snippets: { 'wikipedia.org': 'SUPPORTS', 'blog.example.org': 'REFUTES' },
    });
    const { research } = lookupOf([supporting, refuting]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'unsupported');
    assert.match(result.reason ?? '', /disagree with each other/);
    assert.equal(result.sources.length, 2, 'both sides are cited');
  });

  test('no relevant source leaves it unverified rather than wrong', async () => {
    const { model } = harness({ snippets: { 'baking.example.org': 'IRRELEVANT' } });
    const { research } = lookupOf([offTopic]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'low');
    assert.match(result.reason ?? '', /unverified/);
  });

  test('a search that could not run says so, and does not read as no evidence', async () => {
    const { model, calls } = harness({});
    const { research } = lookupOf([], 'the daily search budget is spent');

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(calls.snippet, 0, 'nothing to classify when nothing was searched');
    assert.equal(result.confidence, 'low');
    assert.match(result.reason ?? '', /not checked against sources/);
    assert.match(result.reason ?? '', /budget/);
  });
});

describe('the page contradicts the explanation', () => {
  test('supporting sources make it disputed, and the text is kept', async () => {
    // The owner's test plan: write notes that are wrong on purpose. With the
    // page as sole ground truth, a correct explanation is discarded. Here both
    // sides are surfaced and the human decides.
    const { model } = harness({
      page: 'CONTRADICTS',
      snippets: { 'wikipedia.org': 'SUPPORTS' },
    });
    const { research } = lookupOf([supporting]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'disputed');
    assert.ok(result.text.length > 0, 'the explanation survives so it can be judged');
    assert.match(result.reason ?? '', /the page may be wrong/);
    assert.equal(result.sources.length, 1);
  });

  test('sources that also refute it leave it contradicted and discarded', async () => {
    const { model } = harness({
      page: 'CONTRADICTS',
      snippets: { 'blog.example.org': 'REFUTES' },
    });
    const { research } = lookupOf([refuting]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'contradicted');
    assert.equal(result.text, '', 'nothing rescued it, so it does not reach the note');
  });

  test('sources that say nothing leave the page in charge', async () => {
    // Silence from the web is not a reason to overrule the notes.
    const { model } = harness({
      page: 'CONTRADICTS',
      snippets: { 'baking.example.org': 'IRRELEVANT' },
    });
    const { research } = lookupOf([offTopic]);

    const result = await expandTerm('rank', { ...base, model, research });

    assert.equal(result.confidence, 'contradicted');
    assert.equal(result.text, '');
  });
});

describe('the model refused, so sources may write', () => {
  test('an explanation written from sources is labelled as such', async () => {
    const { model, calls } = harness({
      explain: 'I do not know this term',
      fromSources: 'A shift reduce parser resolves conflicts with a lookahead token.',
      snippets: { 'wikipedia.org': 'SUPPORTS' },
    });
    const { research } = lookupOf([supporting]);

    const result = await expandTerm('shift reduce parser', { ...base, model, research });

    assert.equal(calls.fromSources, 1);
    assert.equal(result.confidence, 'sourced');
    assert.match(result.text, /shift reduce/);
    assert.equal(result.sources.length, 1);
  });

  test('a source-written explanation still has to clear the page', async () => {
    // Sources never outrank the notes silently, even on the one path where
    // they are allowed to write.
    const { model } = harness({
      explain: 'I do not know this term',
      page: 'CONTRADICTS',
      snippets: { 'wikipedia.org': 'SUPPORTS' },
    });
    const { research } = lookupOf([supporting]);

    const result = await expandTerm('rank', { ...base, model, research });
    assert.equal(result.confidence, 'disputed');
  });

  test('an invented term stays refused, now with a reason based on evidence', async () => {
    const { model } = harness({
      explain: 'I do not know this term',
      snippets: { 'baking.example.org': 'IRRELEVANT' },
    });
    const { research } = lookupOf([offTopic]);

    const result = await expandTerm('the Vandermeer register pass', { ...base, model, research });

    assert.equal(result.confidence, 'refused');
    assert.equal(result.text, '');
    assert.match(result.reason ?? '', /may not exist/);
  });

  test('the model admitting the sources do not explain it keeps it refused', async () => {
    const { model } = harness({
      explain: 'I do not know this term',
      fromSources: 'the sources do not explain this',
      snippets: { 'wikipedia.org': 'SUPPORTS' },
    });
    const { research } = lookupOf([supporting]);

    const result = await expandTerm('some term', { ...base, model, research });

    assert.equal(result.confidence, 'refused');
    assert.match(result.reason ?? '', /did not explain/);
  });

  test('sources contradicting the draft keep it refused rather than publishing it', async () => {
    const { model } = harness({
      explain: 'I do not know this term',
      snippets: { 'blog.example.org': 'REFUTES' },
    });
    const { research } = lookupOf([refuting]);

    const result = await expandTerm('some term', { ...base, model, research });

    assert.equal(result.confidence, 'refused');
    assert.equal(result.text, '');
  });

  test('a refusal with no search configured behaves exactly as before', async () => {
    const { model } = harness({ explain: 'I do not know this term' });
    const result = await expandTerm('Zorbian heap', { ...base, model });

    assert.equal(result.confidence, 'refused');
    assert.match(result.reason ?? '', /does not know/);
  });

  test('a refusal that could not be looked up says why', async () => {
    const { model } = harness({ explain: 'I do not know this term' });
    const { research } = lookupOf([], 'google rejected the API key');

    const result = await expandTerm('some term', { ...base, model, research });

    assert.equal(result.confidence, 'refused');
    assert.match(result.reason ?? '', /API key/);
  });
});

describe('what actually leaves the machine', () => {
  test('nothing is looked up when research is not configured', async () => {
    const { model, calls } = harness({});
    const result = await expandTerm('rank', { ...base, model });

    assert.equal(calls.snippet, 0);
    assert.equal(result.sources.length, 0);
    assert.equal(result.confidence, 'high');
  });

  test('the term is looked up, never the notes', async () => {
    // The single assertion the whole privacy claim rests on.
    const { model } = harness({});
    const { terms, research } = lookupOf([supporting]);

    await expandTerm('rank', { ...base, model, research });

    assert.deepEqual(terms, ['rank']);
    for (const term of terms) {
      assert.ok(!term.includes('distance to nil'), 'note content must never reach a query');
      assert.ok(!term.includes('\n'), 'a query is one line');
    }
  });

  test('one term costs at most one lookup', async () => {
    const { model } = harness({ page: 'CONTRADICTS', snippets: { 'wikipedia.org': 'SUPPORTS' } });
    const { terms, research } = lookupOf([supporting]);

    await expandTerm('rank', { ...base, model, research });
    assert.equal(terms.length, 1);
  });
});

describe('rendering the new outcomes', () => {
  test('disputed entries are separated from settled ones and flagged', async () => {
    const { model } = harness({ page: 'CONTRADICTS', snippets: { 'wikipedia.org': 'SUPPORTS' } });
    const { research } = lookupOf([supporting]);

    const rendered = renderExpansions([await expandTerm('rank', { ...base, model, research })]);

    assert.match(rendered, /Check these yourself/);
    assert.match(rendered, /disputed/);
    assert.match(rendered, /the page may be wrong/);
  });

  test('sources are cited by host, as inert text rather than a link', async () => {
    // CLAUDE.md rule 5: generated Markdown is inert. These URLs came from a
    // search engine, so they are named, not linked.
    const { model } = harness({ snippets: { 'wikipedia.org': 'SUPPORTS' } });
    const { research } = lookupOf([supporting]);

    const rendered = renderExpansions([await expandTerm('rank', { ...base, model, research })]);

    assert.match(rendered, /Sources: en\.wikipedia\.org/);
    assert.ok(!/\]\(https?:/.test(rendered), 'no Markdown links');
    assert.ok(!rendered.includes('<a '), 'no HTML links');
  });

  test('an unsupported entry keeps its text but carries the warning', async () => {
    const { model } = harness({ snippets: { 'blog.example.org': 'REFUTES' } });
    const { research } = lookupOf([refuting]);

    const rendered = renderExpansions([await expandTerm('rank', { ...base, model, research })]);

    assert.match(rendered, /unsupported/);
    assert.match(rendered, /An explanation\./);
    assert.match(rendered, /Check these yourself/);
  });

  test('a settled entry does not drag in the warning callout', async () => {
    const { model } = harness({ snippets: { 'wikipedia.org': 'SUPPORTS' } });
    const { research } = lookupOf([supporting]);

    const rendered = renderExpansions([await expandTerm('rank', { ...base, model, research })]);

    assert.ok(!rendered.includes('Check these yourself'));
    assert.match(rendered, /Added by the model, not on the page/);
  });
});
