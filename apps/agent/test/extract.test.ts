// Choosing what to expand.
//
// This is the input to every check downstream, and it is also the point where
// a model would otherwise get to invent a search query. CLAUDE.md rule 4 says a
// model may contribute a term and never choose one freely, so the filter is
// asserted rather than trusted.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTerms, extractTerms, extractPrompt } from '../src/expand.ts';

const NOTES = [
  '# Compiler Construction',
  '- front end: lexical analysis, parsing',
  '- IR: LLVM language',
  '- back end: register allocation',
  '- JIT compilation happens at runtime',
].join('\n');

describe('parseTerms', () => {
  test('takes one term per line', () => {
    const terms = parseTerms('lexical analysis\nregister allocation', NOTES, 12);
    assert.deepEqual(terms, ['lexical analysis', 'register allocation']);
  });

  test('strips the numbering and bullets a model adds anyway', () => {
    // Models produce lists however firmly you ask them not to.
    const raw = '1. lexical analysis\n- register allocation\n* JIT compilation\n2) parsing';
    assert.deepEqual(
      parseTerms(raw, NOTES, 12),
      ['lexical analysis', 'register allocation', 'JIT compilation', 'parsing'],
    );
  });

  test('strips surrounding quotes and trailing punctuation', () => {
    assert.deepEqual(parseTerms('"lexical analysis",\n`parsing`.', NOTES, 12), ['lexical analysis', 'parsing']);
  });

  test('drops a term that is not on the page', () => {
    // The guard that matters. An invented term must never become a query.
    const raw = 'lexical analysis\nquantum leftist heaps\nthe Vandermeer register pass';
    assert.deepEqual(parseTerms(raw, NOTES, 12), ['lexical analysis']);
  });

  test('matching ignores case and spacing, since a model retypes rather than copies', () => {
    assert.deepEqual(parseTerms('Lexical   Analysis', NOTES, 12), ['Lexical   Analysis']);
  });

  test('deduplicates terms that differ only in case', () => {
    const terms = parseTerms('parsing\nParsing\nPARSING', NOTES, 12);
    assert.equal(terms.length, 1);
  });

  test('honours the limit, because each term costs model time and a query', () => {
    const raw = 'parsing\nlexical analysis\nregister allocation\nJIT compilation';
    assert.equal(parseTerms(raw, NOTES, 2).length, 2);
  });

  test('drops anything too long to be a term', () => {
    // A model handing back a paragraph must not reach search.ts at all, and the
    // limit is enforced here as well so it holds with research switched off.
    const long = 'a'.repeat(200);
    assert.deepEqual(parseTerms(long, `${NOTES}\n${long}`, 12), []);
  });

  test('drops empty lines and single characters', () => {
    assert.deepEqual(parseTerms('\n\n-\na\n\nparsing\n', NOTES, 12), ['parsing']);
  });

  test('commentary the model adds is dropped, since it is not on the page', () => {
    const raw = [
      'Here are the terms I found:',
      'parsing',
      'I hope this helps!',
    ].join('\n');
    assert.deepEqual(parseTerms(raw, NOTES, 12), ['parsing']);
  });
});

describe('corrected spellings, bounded', () => {
  // Measured on corpus page F: the page reads "Kleeny star". Copied verbatim
  // that searches for a word that does not exist, so a bounded correction is
  // allowed. The bound is what stops it becoming a licence to invent.
  const MISSPELLED = [
    '# Formal Languages',
    '- Kleeny star: zero or more',
    '- epsilon is the empty word',
  ].join('\n');

  test('a one character correction is accepted', () => {
    assert.deepEqual(parseTerms('Kleene star', MISSPELLED, 12), ['Kleene star']);
  });

  test('the page spelling is still accepted', () => {
    assert.deepEqual(parseTerms('Kleeny star', MISSPELLED, 12), ['Kleeny star']);
  });

  test('a different concept is not smuggled in as a correction', () => {
    assert.deepEqual(parseTerms('the Vandermeer register pass', MISSPELLED, 12), []);
    assert.deepEqual(parseTerms('pumping lemma', MISSPELLED, 12), []);
  });

  test('a short term gets no budget at all, so it cannot drift into another word', () => {
    // "epsilon" and "upsilon" are ONE edit apart and are different Greek
    // letters. Any budget on a seven character term lets a correction change
    // the meaning, so below eight characters the match must be exact.
    assert.deepEqual(parseTerms('upsilon', MISSPELLED, 12), []);
    assert.deepEqual(parseTerms('epsilon', MISSPELLED, 12), ['epsilon']);
  });

  test('a term that is nowhere near anything on the page is refused', () => {
    assert.deepEqual(parseTerms('quantum chromodynamics', MISSPELLED, 12), []);
  });
});

describe('extractTerms', () => {
  test('asks for terms and filters the answer', async () => {
    const prompts: string[] = [];
    const model = async (prompt: string) => {
      prompts.push(prompt);
      return 'parsing\nsomething invented\nJIT compilation';
    };

    const terms = await extractTerms({ notes: NOTES, course: 'Compiler Construction', model });

    assert.deepEqual(terms, ['parsing', 'JIT compilation']);
    assert.ok(prompts[0].includes('Compiler Construction'));
    assert.ok(prompts[0].includes('IR: LLVM language'), 'the notes are in the prompt');
  });

  test('an empty page costs no model call', async () => {
    let calls = 0;
    const model = async () => { calls++; return 'x'; };
    assert.deepEqual(await extractTerms({ notes: '   ', model }), []);
    assert.equal(calls, 0);
  });

  test('a model that answers with nothing usable yields no terms', async () => {
    const model = async () => 'I could not find any terms.';
    assert.deepEqual(await extractTerms({ notes: NOTES, model }), []);
  });
});

describe('the extraction prompt', () => {
  test('asks for bare keywords, which are the ones worth expanding', () => {
    const prompt = extractPrompt(NOTES, 'Compiler Construction', 5);
    assert.match(prompt, /bare keywords/);
    assert.match(prompt, /up to 5/);
  });

  test('asks for concepts, not instructions', () => {
    // Corpus page F extracted "Remove redundancy" and "Avoid division", which
    // are advice written on the page rather than anything to look up.
    const prompt = extractPrompt(NOTES);
    assert.match(prompt, /NAME OF A CONCEPT/);
    assert.match(prompt, /Do not list instructions/);
  });

  test('allows a corrected spelling and nothing more', () => {
    const prompt = extractPrompt(NOTES);
    assert.match(prompt, /misspell/);
    assert.match(prompt, /Correct spelling only/);
    assert.match(prompt, /Never replace a term with a different one/);
  });
});
