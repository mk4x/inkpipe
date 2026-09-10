// Finishing a list the page leaves open.
//
// The owner wrote "MoSCoW method (must have, should have ...)" and expected the
// rest. Completing a standard set the page names and then abandons is
// clarifying what is already there. Writing a paragraph about MoSCoW is not,
// and the bounds below are what keep those apart.
//
// Two design decisions are load-bearing and both are tested here. The model is
// asked ONLY for the missing items, and the code does the splicing and the
// marking. An earlier version asked it to rewrite the line with its own
// additions marked, and it duplicated one item and lost another.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findOpenLists, parseMissing, completeOpenLists, completePrompt } from '../src/complete.ts';

describe('finding lists that trail off', () => {
  test('an ellipsis after a list qualifies', () => {
    const found = findOpenLists('- MoSCoW method (must have, should have ...)');
    assert.equal(found.length, 1);
    assert.equal(found[0].index, 1);
  });

  test('etc and and-so-on qualify', () => {
    assert.equal(findOpenLists('- STRIDE: spoofing, tampering, etc').length, 1);
    assert.equal(findOpenLists('- phases: lexing, parsing, and so on').length, 1);
  });

  test('a finished list does not qualify', () => {
    // A list with no ellipsis is one the student considered complete, and
    // finishing it would be inventing rather than clarifying.
    assert.deepEqual(findOpenLists('- ICE model (impact, confidence, ease)'), []);
  });

  test('prose containing "etc" does not qualify without a list', () => {
    // Otherwise "we ran out of time etc" becomes an invitation to invent one.
    assert.deepEqual(findOpenLists('we ran out of time etc'), []);
  });

  test('code and callouts are skipped', () => {
    assert.deepEqual(findOpenLists('```\na, b, ...\n```'), []);
    assert.deepEqual(findOpenLists('> [!note] a, b, ...'), []);
  });
});

describe('parseMissing', () => {
  const LINE = '- MoSCoW method (must have, should have ...)';

  test('takes the missing items as a list', () => {
    assert.deepEqual(parseMissing('could have, would have', LINE), ['could have', 'would have']);
  });

  test('drops items already on the line', () => {
    // The guard that matters. A model told not to repeat items still repeats
    // them, so it is checked rather than requested. This exact answer, with
    // "must" duplicated, is what the previous design produced.
    assert.deepEqual(
      parseMissing('must have, should have, could have, would have', LINE),
      ['could have', 'would have'],
    );
  });

  test('strips bullets and numbering a model adds anyway', () => {
    assert.deepEqual(parseMissing('1. could have, 2. would have', LINE), ['could have', 'would have']);
  });

  test('takes only the first line, since more means it started explaining', () => {
    assert.deepEqual(parseMissing('could have\n\nMoSCoW is a technique for...', LINE), ['could have']);
  });

  test('refuses anything too long to be an item', () => {
    const essay = 'a'.repeat(60);
    assert.deepEqual(parseMissing(essay, LINE), []);
  });

  test('caps the number of items, since a standard set is small', () => {
    assert.equal(parseMissing('a1, b2, c3, d4, e5, f6, g7, h8, i9', LINE).length, 6);
  });

  test('deduplicates', () => {
    assert.deepEqual(parseMissing('could have, could have', LINE), ['could have']);
  });
});

describe('completing a page', () => {
  const PAGE = [
    '## Prioritization',
    '- MoSCoW method (must have, should have ...)',
    '- ICE model (impact, confidence, ease)',
  ].join('\n');

  test('splices the missing items in, marked', async () => {
    const model = async () => 'could have, will not have';
    const result = await completeOpenLists(PAGE, { model });

    assert.equal(result.completions.length, 1);
    assert.match(result.markdown, /==could have==/);
    assert.match(result.markdown, /==will not have==/);
    // What the student wrote is untouched.
    assert.match(result.markdown, /must have, should have/);
    // And the finished list beside it is left alone.
    assert.match(result.markdown, /- ICE model \(impact, confidence, ease\)/);
  });

  test('everything added is marked, per decision 20', async () => {
    const model = async () => 'could have';
    const { markdown } = await completeOpenLists(PAGE, { model });
    const added = markdown.match(/==[^=]+==/g) ?? [];
    assert.equal(added.length, 1);
  });

  test('LEAVE AS IS changes nothing', async () => {
    const model = async () => 'LEAVE AS IS';
    const result = await completeOpenLists(PAGE, { model });
    assert.equal(result.markdown, PAGE);
    assert.deepEqual(result.completions, []);
  });

  test('a runaway answer is refused', async () => {
    const model = async () => 'could have, would have, and here is why MoSCoW matters for teams';
    const result = await completeOpenLists(PAGE, { model, maxGrowth: 1.4 });
    assert.equal(result.markdown, PAGE);
  });

  test('a model failure leaves the page alone', async () => {
    const model = async () => { throw new Error('ollama fell over'); };
    const result = await completeOpenLists(PAGE, { model });
    assert.equal(result.markdown, PAGE);
  });

  test('a page with no open list costs no model call', async () => {
    let called = false;
    const model = async () => { called = true; return 'x'; };
    const result = await completeOpenLists('- ICE model (impact, confidence, ease)', { model });
    assert.equal(called, false);
    assert.deepEqual(result.completions, []);
  });
});

describe('the prompt', () => {
  test('asks only for what is missing', () => {
    const prompt = completePrompt('- MoSCoW method (must have, should have ...)', 'Software Engineering');
    assert.match(prompt, /ONLY the items that are missing/);
    assert.match(prompt, /Do not repeat the items already written/);
    assert.match(prompt, /Do not explain them/);
    assert.match(prompt, /LEAVE AS IS/);
    assert.ok(prompt.includes('Software Engineering'));
  });
});
