// Checking the page's own arithmetic.
//
// Corpus page G carries two wrong sums and a line saying "I am confident this
// is correct." Nothing noticed, because every check in the project treats the
// page as ground truth: the contradiction gate asks whether the model conflicts
// with the page, never whether the page conflicts with reality.
//
// This is done in code rather than by a model. A model asked to check sums will
// occasionally agree with a wrong one, and there is no reason to accept that
// when the alternative is a subtraction.
//
// The bias throughout is against FALSE ALARMS. A wrong flag on a student's own
// notes teaches them to ignore all the flags, which costs more than the misses.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkArithmetic, renderArithmeticFlags } from '../src/arithmetic.ts';

describe('the errors corpus page G actually contains', () => {
  const PAGE_G = [
    'I am now doing some math',
    '',
    '36 + 45 = 71',
    '81 + 22 = 103',
    '3 + 9 = 13',
    '',
    'I am confident this is correct.',
  ].join('\n');

  test('finds both wrong sums and neither correct one', () => {
    const problems = checkArithmetic(PAGE_G);
    assert.deepEqual(problems.map((p) => p.written), ['36 + 45 = 71', '3 + 9 = 13']);
  });

  test('reports what the answer actually is', () => {
    const problems = checkArithmetic(PAGE_G);
    assert.equal(problems[0].actual, 81);
    assert.equal(problems[0].claimed, 71);
    assert.equal(problems[1].actual, 12);
  });

  test('reports the line, so it can be found on a long page', () => {
    const problems = checkArithmetic(PAGE_G);
    assert.equal(problems[0].line, 3);
    assert.equal(problems[1].line, 5);
  });
});

describe('operators', () => {
  test('handles the four operations', () => {
    assert.equal(checkArithmetic('10 - 3 = 8').length, 1);
    assert.equal(checkArithmetic('6 * 7 = 43').length, 1);
    assert.equal(checkArithmetic('20 / 4 = 6').length, 1);
    assert.equal(checkArithmetic('10 - 3 = 7').length, 0);
  });

  test('accepts the multiplication signs handwriting produces', () => {
    // A vision model transcribes a handwritten cross as any of these.
    for (const sign of ['x', '×', '·', '*']) {
      assert.equal(checkArithmetic(`3 ${sign} 3 = 10`).length, 1, `${sign} not recognised`);
      assert.equal(checkArithmetic(`3 ${sign} 3 = 9`).length, 0, `${sign} false alarm`);
    }
  });

  test('division by zero is skipped rather than flagged', () => {
    assert.deepEqual(checkArithmetic('5 / 0 = 0'), []);
  });

  test('negative numbers work', () => {
    assert.equal(checkArithmetic('-5 + 3 = -2').length, 0);
    assert.equal(checkArithmetic('-5 + 3 = 2').length, 1);
  });
});

describe('not raising false alarms', () => {
  test('a rounded division is not an error', () => {
    // 1/3 written by hand is 0.33, and flagging that would be pedantic noise.
    assert.deepEqual(checkArithmetic('1 / 3 = 0.33'), []);
  });

  test('a comma decimal is understood, since these notes are Danish', () => {
    assert.deepEqual(checkArithmetic('1,5 + 1,5 = 3'), []);
    assert.equal(checkArithmetic('1,5 + 1,5 = 4').length, 1);
  });

  test('code fences are left alone', () => {
    // Code is not the student's working, and "x = 1 + 1" in a snippet is an
    // assignment rather than a claim.
    const markdown = ['```', 'let a = 2 + 2 = 5', '```'].join('\n');
    assert.deepEqual(checkArithmetic(markdown), []);
  });

  test('callouts are left alone, since the pipeline writes those', () => {
    assert.deepEqual(checkArithmetic('> [!warning] 2 + 2 = 5'), []);
  });

  test('prose that merely contains numbers is not arithmetic', () => {
    assert.deepEqual(checkArithmetic('Tier 1 ISP peering at 10 exchanges'), []);
    assert.deepEqual(checkArithmetic('Performance: 10000 queries in 5 sec'), []);
  });

  test('an empty page yields nothing', () => {
    assert.deepEqual(checkArithmetic(''), []);
  });

  test('several sums on one line are all checked', () => {
    const problems = checkArithmetic('2 + 2 = 4 and 3 + 3 = 7');
    assert.equal(problems.length, 1);
    assert.equal(problems[0].actual, 6);
  });
});

describe('rendering the flags', () => {
  test('nothing renders when the arithmetic is fine', () => {
    assert.equal(renderArithmeticFlags([]), '');
  });

  test('says the page was left as written', () => {
    // The note is a record of what was on the paper. Silently correcting it
    // would destroy the only copy of what the student actually wrote.
    const rendered = renderArithmeticFlags(checkArithmetic('36 + 45 = 71'));
    assert.match(rendered, /left exactly as written/);
    assert.match(rendered, /36 \+ 45 = 71/);
    assert.match(rendered, /81/);
  });

  test('counts correctly in singular and plural', () => {
    assert.match(renderArithmeticFlags(checkArithmetic('2 + 2 = 5')), /One sum does/);
    assert.match(renderArithmeticFlags(checkArithmetic('2 + 2 = 5\n3 + 3 = 7')), /2 sums do/);
  });
});
