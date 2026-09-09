// The model is faked here on purpose.
//
// Whether a real 7B is any good at these judgements was measured separately, in
// packages/corpus/*-spike.mjs, against hand-labelled claims. These tests cover
// the thing those spikes cannot: that the CONTROL FLOW does the right thing
// with whatever the model says. A refusal must never reach the note. A
// contradiction must never reach the note. Those are absolute, so they are
// asserted against a scripted model rather than a probabilistic one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandTerm, expandTerms, renderExpansions,
  explainPrompt, contradictionPrompt,
  type Expansion,
} from '../src/expand.ts';

const NOTES = [
  'Leftist Heap',
  '- rank is distance to nil (closest empty node)',
  '- Leftist: u.left().rank >= u.right().rank()',
].join('\n');

/** A model scripted by which kind of prompt it receives. */
function scripted(behaviour: {
  explain?: string | string[];
  contradiction?: string;
  agreement?: string;
}) {
  const explanations = Array.isArray(behaviour.explain)
    ? [...behaviour.explain]
    : behaviour.explain !== undefined ? [behaviour.explain] : ['An explanation.'];
  let next = 0;
  const calls = { explain: 0, contradiction: 0, agreement: 0 };

  const model = async (prompt: string) => {
    if (prompt.includes('CONTRADICTS or CONSISTENT')) {
      calls.contradiction++;
      return behaviour.contradiction ?? 'CONSISTENT';
    }
    if (prompt.includes('AGREE or DISAGREE')) {
      calls.agreement++;
      return behaviour.agreement ?? 'AGREE';
    }
    calls.explain++;
    return explanations[Math.min(next++, explanations.length - 1)];
  };
  return { model, calls };
}

describe('the contradiction gate', () => {
  test('a contradicted explanation never reaches the note', async () => {
    // The measured failure: the model consistently said rank was a node count,
    // which the page contradicts. Consistency passed it. This gate must not.
    const { model } = scripted({
      explain: 'The rank of a node is the number of nodes in its subtree.',
      contradiction: 'CONTRADICTS',
    });

    const result = await expandTerm('rank', { notes: NOTES, model });

    assert.equal(result.confidence, 'contradicted');
    assert.equal(result.text, '', 'contradicted text must not be carried forward');
    assert.match(result.reason!, /conflicted/);
  });

  test('a contradicted term is excluded from the rendered note', async () => {
    const { model } = scripted({ explain: 'wrong thing', contradiction: 'CONTRADICTS' });
    const rendered = renderExpansions([await expandTerm('rank', { notes: NOTES, model })]);
    assert.ok(!rendered.includes('wrong thing'), 'the rejected text must not appear anywhere');
    assert.match(rendered, /Not explained/);
  });

  test('the gate runs even when every sample agrees', async () => {
    // Consistency must never be able to short-circuit the gate: three identical
    // wrong answers is exactly the case that motivated it.
    const { model, calls } = scripted({
      explain: ['same wrong claim', 'same wrong claim', 'same wrong claim'],
      contradiction: 'CONTRADICTS',
      agreement: 'AGREE',
    });

    const result = await expandTerm('rank', { notes: NOTES, model, samples: 3 });
    assert.equal(result.confidence, 'contradicted');
    assert.ok(calls.contradiction >= 1, 'the contradiction check must have run');
  });
});

describe('refusal', () => {
  test('a refused term produces no text', async () => {
    const { model } = scripted({ explain: 'I do not know this term' });
    const result = await expandTerm('Zorbian heap', { notes: NOTES, model, samples: 3 });

    assert.equal(result.confidence, 'refused');
    assert.equal(result.text, '');
  });

  test('a refusal skips the contradiction check, since there is nothing to check', async () => {
    const { model, calls } = scripted({ explain: 'I do not know this term' });
    await expandTerm('Zorbian heap', { notes: NOTES, model, samples: 2 });
    assert.equal(calls.contradiction, 0);
  });

  test('a partial refusal is answered but marked low confidence', async () => {
    const { model } = scripted({
      explain: ['I do not know this term', 'A real explanation of the term.', 'A real explanation.'],
    });
    const result = await expandTerm('meld', { notes: NOTES, model, samples: 3 });

    assert.equal(result.confidence, 'low');
    assert.match(result.reason!, /only sometimes/);
    assert.ok(result.text.length > 0);
  });
});

describe('consistency, as a secondary signal only', () => {
  test('disagreement lowers confidence but does not reject', async () => {
    const { model } = scripted({
      explain: ['First answer here.', 'A completely different answer.'],
      agreement: 'DISAGREE',
    });
    const result = await expandTerm('meld', { notes: NOTES, model, samples: 2 });

    assert.equal(result.confidence, 'low');
    assert.equal(result.agreement, 0);
    assert.ok(result.text.length > 0, 'unstable is a warning, not a rejection');
  });

  test('agreement across samples gives high confidence', async () => {
    const { model } = scripted({
      explain: ['A stable answer.', 'A stable answer, worded differently.'],
      agreement: 'AGREE',
    });
    const result = await expandTerm('meld', { notes: NOTES, model, samples: 2 });

    assert.equal(result.confidence, 'high');
    assert.equal(result.agreement, 1);
  });

  test('a single sample skips the consistency check entirely', async () => {
    const { model, calls } = scripted({ explain: 'One answer.' });
    const result = await expandTerm('meld', { notes: NOTES, model, samples: 1 });

    assert.equal(calls.agreement, 0);
    assert.equal(result.agreement, null);
    assert.equal(result.confidence, 'high');
  });
});

describe('prompts', () => {
  test('the explanation prompt carries the notes, so the model can avoid conflicting', async () => {
    const prompt = explainPrompt('rank', NOTES, 'Algorithms');
    assert.ok(prompt.includes('rank is distance to nil'));
    assert.ok(prompt.includes('Algorithms'));
    assert.match(prompt, /I do not know this term/);
  });

  test('the contradiction prompt allows extra detail', async () => {
    // Otherwise every genuinely useful addition gets rejected for not being on
    // the page, which would make the feature pointless.
    const prompt = contradictionPrompt('some claim', NOTES);
    assert.match(prompt, /Adding detail the notes do not mention is not a contradiction/);
  });
});

describe('rendering', () => {
  const expansion = (over: Partial<Expansion>): Expansion => ({
    term: 'meld', text: 'Meld merges two heaps.', confidence: 'high',
    reason: null, agreement: 1, sources: [], ...over,
  });

  test('marks everything as model-added, per decision 20', async () => {
    const rendered = renderExpansions([expansion({})]);
    assert.match(rendered, /Added by the model, not on the page/);
  });

  test('marks low confidence differently from high', async () => {
    const high = renderExpansions([expansion({ confidence: 'high' })]);
    const low = renderExpansions([expansion({ confidence: 'low' })]);
    assert.ok(!high.includes('uncertain'));
    assert.match(low, /uncertain/);
  });

  test('lists what it refused, rather than hiding it', async () => {
    // A silently missing term looks like the feature did not run. Saying "I did
    // not know this" is information.
    const rendered = renderExpansions([
      expansion({ term: 'Zorbian heap', text: '', confidence: 'refused', reason: 'the model said it does not know this term' }),
    ]);
    assert.match(rendered, /Not explained/);
    assert.match(rendered, /Zorbian heap/);
    assert.match(rendered, /does not know/);
  });

  test('renders nothing at all when there is nothing usable and nothing rejected', async () => {
    assert.equal(renderExpansions([]), '');
  });
});

describe('expandTerms', () => {
  test('handles a mix without one failure affecting the others', async () => {
    let call = 0;
    const model = async (prompt: string) => {
      if (prompt.includes('CONTRADICTS or CONSISTENT')) {
        return prompt.includes('bad claim') ? 'CONTRADICTS' : 'CONSISTENT';
      }
      if (prompt.includes('AGREE or DISAGREE')) return 'AGREE';
      call++;
      if (prompt.includes('good')) return 'a good explanation';
      if (prompt.includes('unknown')) return 'I do not know this term';
      return 'bad claim';
    };

    const results = await expandTerms(['good', 'unknown', 'wrong'], {
      notes: NOTES, model, samples: 1,
    });

    assert.equal(results.length, 3);
    assert.equal(results[0].confidence, 'high');
    assert.equal(results[1].confidence, 'refused');
    assert.equal(results[2].confidence, 'contradicted');
    assert.ok(call > 0);
  });
});
