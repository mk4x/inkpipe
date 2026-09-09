// Expanding terse notes, without inventing things.
//
// Handwritten lecture notes are keywords. "IR: LLVM language" means something
// to you in the room and very little a month later. Expansion turns that back
// into prose. The obvious way to do it is to ask a model, and the obvious way
// fails: a 7B asked to explain a term produces fluent, plausible, sometimes
// wrong text, and wrong text in study notes is worse than no text.
//
// Three checks, measured in packages/corpus/*-spike.mjs before this was built:
//
//   REFUSAL       The model may say it does not know. Measured 3/3 invented
//                 terms refused on both qwen2.5:7b and 14b. This works.
//
//   CONTRADICTION Does the explanation conflict with the page it came from?
//                 Measured 8/8 on hand-labelled claims: caught all four wrong
//                 ones, passed all four correct ones. This is the real gate.
//
//   CONSISTENCY   Same question asked N times. Measured to catch a model that
//                 is UNSURE, and measured to MISS a model that is reliably
//                 wrong: 14b said three times that a leftist heap rank is "the
//                 number of nodes in the subtree", which is wrong, and a
//                 consistency judge passed it. So this is a secondary signal
//                 only, never the gate.
//
// The ordering matters. Contradiction is checked against the transcript because
// the transcript is what the student actually wrote down in the lecture, which
// is the only ground truth available for material too new to be in their notes.

export type Confidence = 'high' | 'low' | 'refused' | 'contradicted';

export interface Expansion {
  term: string;
  /** Empty when refused or contradicted. */
  text: string;
  confidence: Confidence;
  /** Why it was rejected, shown in the preview rather than hidden. */
  reason: string | null;
  /** Agreement across samples, null when there was nothing to compare. */
  agreement: number | null;
}

export interface ExpandOptions {
  /** The page transcript. Ground truth for the contradiction check. */
  notes: string;
  course?: string;
  /** Injected, so tests need no model and the fixture layer can sit in front. */
  model: (prompt: string, options?: { temperature?: number }) => Promise<string>;
  /** Samples per term. 1 disables the consistency signal. */
  samples?: number;
  /** Terms whose agreement falls below this are marked low confidence. */
  agreementThreshold?: number;
}

const REFUSAL = 'I do not know this term';
const refuses = (text: string) => new RegExp(REFUSAL, 'i').test(text);

// ---------------------------------------------------------------------------
// Prompts. Each is deliberately narrow: one term, or one binary judgement.
// Small models are poor at open generation and much better at bounded tasks,
// which is the entire reason this is split into steps rather than one call.
// ---------------------------------------------------------------------------

export function explainPrompt(term: string, notes: string, course?: string): string {
  return [
    course ? `These are notes from a course on ${course}.` : 'These are lecture notes.',
    '',
    notes,
    '',
    `Explain in two or three sentences: ${term}`,
    '',
    'Be precise and factual. Do not contradict the notes.',
    `If you are not certain the concept exists, or you do not know it, say exactly "${REFUSAL}" and nothing else.`,
  ].join('\n');
}

export function contradictionPrompt(claim: string, notes: string): string {
  return [
    "Here are a student's lecture notes:",
    '',
    notes,
    '',
    'Here is a statement generated to explain those notes:',
    '',
    claim,
    '',
    'Does the statement CONTRADICT anything in the notes?',
    'Adding detail the notes do not mention is not a contradiction.',
    'Only a direct conflict with what the notes say counts.',
    '',
    'Answer with exactly one word: CONTRADICTS or CONSISTENT.',
  ].join('\n');
}

export function agreementPrompt(a: string, b: string): string {
  return [
    'Two explanations of the same term are below.',
    '',
    `A: ${a}`,
    '',
    `B: ${b}`,
    '',
    'Do A and B make the same factual claims? Differences in wording, length or',
    'detail do not matter. Only contradictions or incompatible claims matter.',
    '',
    'Answer with exactly one word: AGREE or DISAGREE.',
  ].join('\n');
}

// ---------------------------------------------------------------------------

/**
 * Expand one term, with all three checks.
 *
 * Never throws for a term it cannot handle: a refused or contradicted term is a
 * normal outcome that the preview shows, not an error that aborts the page.
 */
export async function expandTerm(term: string, options: ExpandOptions): Promise<Expansion> {
  const samples = Math.max(1, options.samples ?? 3);
  const threshold = options.agreementThreshold ?? 0.5;

  const drafts: string[] = [];
  for (let i = 0; i < samples; i++) {
    // Non-zero temperature, otherwise every sample is identical and the
    // consistency signal measures nothing.
    drafts.push((await options.model(
      explainPrompt(term, options.notes, options.course),
      { temperature: 0.7 },
    )).trim());
  }

  const answered = drafts.filter((d) => !refuses(d) && d.length > 0);

  if (answered.length === 0) {
    return {
      term,
      text: '',
      confidence: 'refused',
      reason: 'the model said it does not know this term',
      agreement: null,
    };
  }

  // The longest answer is the candidate: it carries the most claims, so it is
  // the hardest to sneak an error through the contradiction check with.
  const candidate = answered.slice().sort((a, b) => b.length - a.length)[0];

  // THE GATE. Temperature 0: a judgement, not a sample.
  const verdict = (await options.model(
    contradictionPrompt(candidate, options.notes),
    { temperature: 0 },
  )).trim().toUpperCase();

  if (verdict.startsWith('CONTRADICT')) {
    return {
      term,
      text: '',
      confidence: 'contradicted',
      reason: 'the explanation conflicted with what the page says',
      agreement: null,
    };
  }

  // Secondary signal. Catches wobble, not systematic error.
  let agreement: number | null = null;
  if (answered.length >= 2) {
    let agreed = 0;
    let pairs = 0;
    for (let i = 0; i < answered.length; i++) {
      for (let j = i + 1; j < answered.length; j++) {
        const answer = (await options.model(
          agreementPrompt(answered[i], answered[j]),
          { temperature: 0 },
        )).trim().toUpperCase();
        if (answer.startsWith('AGREE')) agreed++;
        pairs++;
      }
    }
    agreement = pairs === 0 ? null : agreed / pairs;
  }

  const partiallyRefused = answered.length < drafts.length;
  const unstable = agreement !== null && agreement < threshold;

  return {
    term,
    text: candidate,
    confidence: partiallyRefused || unstable ? 'low' : 'high',
    reason: unstable ? 'the model gave different answers each time'
      : partiallyRefused ? 'the model only sometimes claimed to know this'
        : null,
    agreement,
  };
}

/** Expand several terms. Sequential on purpose: one model, one GPU. */
export async function expandTerms(terms: string[], options: ExpandOptions): Promise<Expansion[]> {
  const out: Expansion[] = [];
  for (const term of terms) out.push(await expandTerm(term, options));
  return out;
}

/**
 * Render accepted expansions as a Markdown section.
 *
 * Decision 20: anything the model added and is not on the page is marked. Low
 * confidence is marked differently from high, because "the model was unsure"
 * is information the reader needs while revising.
 */
export function renderExpansions(expansions: Expansion[]): string {
  const usable = expansions.filter((e) => e.text.length > 0);
  const rejected = expansions.filter((e) => e.text.length === 0);

  // Only truly empty input renders nothing. When everything was rejected the
  // section still appears, listing what could not be explained: a silently
  // missing term is indistinguishable from the feature not having run, and
  // "I did not know this" is information worth having while revising.
  if (usable.length === 0 && rejected.length === 0) return '';

  const lines: string[] = ['', '## Explanations', ''];

  if (usable.length > 0) {
    lines.push('> [!note] Added by the model, not on the page');
    lines.push('> Each entry was checked against the page and did not contradict it.');
    lines.push('');

    for (const e of usable) {
      const marker = e.confidence === 'low' ? ' *(uncertain)*' : '';
      lines.push(`**${e.term}**${marker}`, '', e.text, '');
    }
  }

  if (rejected.length > 0) {
    lines.push('> [!warning] Not explained');
    for (const e of rejected) lines.push(`> - **${e.term}**: ${e.reason}`);
    lines.push('');
  }

  return lines.join('\n');
}
