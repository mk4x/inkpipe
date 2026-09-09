// Deriving corrections from an edit.
//
// The point of this module is that the user never types a glossary. A feedback
// mechanism that asks for extra work gets used twice and then abandoned, so the
// diff has to carry it, and these tests are mostly about the diff being
// trustworthy enough to feed straight into a prompt.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCorrections, recordFor, corpusCandidates, type FeedbackRecord } from '../src/feedback.ts';

describe('deriveCorrections', () => {
  test('a word the user added is a correction', () => {
    const original = 'The lexical analyser produces a token stream.';
    const edited = 'The lexical analyser produces a token stream for the parser.';
    assert.deepEqual(deriveCorrections(original, edited), ['parser']);
  });

  test('the misread word is captured, which is the whole point', () => {
    // This is what the glossary is for: ADR 0001 finding 4 measured that course
    // vocabulary in the prompt is what stops a dense page looping.
    const original = 'Kleeny star means zero or more';
    const edited = 'Kleene star means zero or more';
    assert.deepEqual(deriveCorrections(original, edited), ['Kleene']);
  });

  test('deleted words are NOT corrections', () => {
    // A word the user removed is the model's mistake. Feeding a mistake into
    // the prompt meant to prevent it would be exactly backwards.
    const original = 'The Zorbian heap melds in log time';
    const edited = 'The heap melds in log time';
    assert.deepEqual(deriveCorrections(original, edited), []);
  });

  test('an unedited page yields nothing', () => {
    const text = '# Compiler Construction\n- lexical analysis\n- parsing';
    assert.deepEqual(deriveCorrections(text, text), []);
  });

  test('common words are not vocabulary', () => {
    const original = 'parser';
    const edited = 'the parser is not a lexer and it was in the front end';
    // "lexer" and "front" and "end" are real additions; "the", "is", "not",
    // "a", "and", "it", "was", "in" carry no signal.
    const terms = deriveCorrections(original, edited);
    assert.ok(terms.includes('lexer'));
    for (const noise of ['the', 'is', 'not', 'and', 'it', 'was', 'in']) {
      assert.ok(!terms.includes(noise), `${noise} should not reach the glossary`);
    }
  });

  test('Markdown punctuation is not mistaken for vocabulary', () => {
    const original = 'parsing';
    const edited = '## Parsing\n\n- **register allocation**\n- `IR`';
    const terms = deriveCorrections(original, edited);
    assert.ok(terms.includes('register'));
    assert.ok(terms.includes('IR'));
    for (const term of terms) {
      assert.ok(!/[#*`\-]/.test(term), `punctuation leaked into "${term}"`);
    }
  });

  test('bare numbers are page specific and teach nothing', () => {
    const terms = deriveCorrections('a', 'a 42 3.14 O(n) heap');
    assert.ok(!terms.includes('42'));
    assert.ok(!terms.includes('3.14'));
    assert.ok(terms.includes('heap'));
  });

  test('case differences alone are not corrections', () => {
    assert.deepEqual(deriveCorrections('the Parser runs', 'the parser runs'), []);
  });

  test('duplicates are collapsed', () => {
    const terms = deriveCorrections('a', 'lexer lexer LEXER');
    assert.equal(terms.length, 1);
  });

  test('the limit is honoured, because this goes into every future prompt', () => {
    const edited = Array.from({ length: 40 }, (_, i) => `term${i}x`).join(' ');
    assert.equal(deriveCorrections('a', edited, 5).length, 5);
  });
});

describe('recordFor', () => {
  const base = {
    imageHash: 'abc123', sessionId: 's1', seq: 0, course: 'Compiler Construction',
    now: () => new Date('2026-09-09T12:00:00Z'),
  };

  test('a rejected page is always a corpus candidate', () => {
    // A page the pipeline got wrong is exactly what the corpus is short of.
    const record = recordFor({ ...base, verdict: 'bad', original: 'x', edited: 'x' });
    assert.equal(record.corpusCandidate, true);
    assert.equal(record.corrections.length, 0);
  });

  test('an accepted page that still needed edits is a candidate', () => {
    const record = recordFor({
      ...base, verdict: 'good',
      original: 'Kleeny star', edited: 'Kleene star',
    });
    assert.equal(record.corpusCandidate, true);
    assert.deepEqual(record.corrections, ['Kleene']);
  });

  test('an accepted page that needed nothing is not a candidate', () => {
    const record = recordFor({ ...base, verdict: 'good', original: 'same', edited: 'same' });
    assert.equal(record.corpusCandidate, false);
  });

  test('the image hash identifies the page, not a filename', () => {
    const record = recordFor({ ...base, verdict: 'good', original: 'a', edited: 'a' });
    assert.equal(record.imageHash, 'abc123');
    assert.equal(record.at, '2026-09-09T12:00:00.000Z');
  });
});

describe('corpusCandidates', () => {
  const record = (over: Partial<FeedbackRecord>): FeedbackRecord => ({
    imageHash: 'h', sessionId: 's', seq: 0, course: 'c', verdict: 'good',
    corrections: [], corpusCandidate: true, at: '2026-09-09T12:00:00.000Z', ...over,
  });

  test('non candidates are excluded', () => {
    const out = corpusCandidates([record({ corpusCandidate: false })]);
    assert.equal(out.length, 0);
  });

  test('rejected pages outrank accepted ones', () => {
    const out = corpusCandidates([
      record({ imageHash: 'good', verdict: 'good', corrections: ['a', 'b', 'c'] }),
      record({ imageHash: 'bad', verdict: 'bad' }),
    ]);
    assert.equal(out[0].imageHash, 'bad');
  });

  test('within a verdict, the most corrected page comes first', () => {
    // A proxy for how wrong the page was, which is what makes it worth having.
    const out = corpusCandidates([
      record({ imageHash: 'few', corrections: ['a'] }),
      record({ imageHash: 'many', corrections: ['a', 'b', 'c'] }),
    ]);
    assert.equal(out[0].imageHash, 'many');
  });

  test('the input array is not mutated', () => {
    const input = [record({ imageHash: 'a' }), record({ imageHash: 'b', verdict: 'bad' })];
    corpusCandidates(input);
    assert.equal(input[0].imageHash, 'a');
  });
});
