// Expanding terse notes, without inventing things.
//
// Handwritten lecture notes are keywords. "IR: LLVM language" means something
// to you in the room and very little a month later. Expansion turns that back
// into prose. The obvious way to do it is to ask a model, and the obvious way
// fails: a 7B asked to explain a term produces fluent, plausible, sometimes
// wrong text, and wrong text in study notes is worse than no text.
//
// Checks, each measured in packages/corpus/*-spike.mjs before it was built:
//
//   REFUSAL       The model may say it does not know. Measured 3/3 invented
//                 terms refused on both qwen2.5:7b and 14b. This works.
//
//   CONTRADICTION Does the explanation conflict with the page it came from?
//                 Measured 8/8 on hand-labelled claims: caught all four wrong
//                 ones, passed all four correct ones. This is the page gate.
//
//   CONSISTENCY   Same question asked N times. Measured to catch a model that
//                 is UNSURE, and measured to MISS a model that is reliably
//                 wrong: 14b said three times that a leftist heap rank is "the
//                 number of nodes in the subtree", which is wrong, and a
//                 consistency judge passed it. Secondary signal only.
//
//   SOURCES       ADR 0004. Search snippets, read one at a time in evidence.ts.
//                 The first check in this list that is not the model grading
//                 its own homework.
//
// Why sources were added. The contradiction gate asks "does this conflict with
// the page", and the page is keywords, so usually there is nothing to conflict
// with and the gate passes whatever the model believed. There was no external
// authority anywhere in the loop.
//
// Why sources do not get the final say. Retrieval helps on obscure material and
// hurts on well known material, where the model's own knowledge is strong and
// the average search result is a content farm. So sources get a vote, not a
// veto: they can label an explanation, and they can only WRITE one in the
// single case where the model refused and there is nothing to corrupt.
//
// The one place sources outrank the page is the disputed outcome, and even
// there nothing is decided: both sides are shown to the human, because a page
// that is wrong is exactly the case the page-as-ground-truth gate handles
// badly.

import {
  readEvidence, citations, looksInvented, fromSourcesPrompt, SOURCES_INSUFFICIENT,
  type Evidence, type ModelFn,
} from './evidence.ts';
import type { SearchResult } from './search.ts';

export type Confidence =
  /** Explained, the page agrees or is silent, sources back it. */
  | 'high'
  /** Explained and kept, with a stated reservation. */
  | 'low'
  /** Explained, the page is silent, and the sources argue against it. */
  | 'unsupported'
  /** The page contradicts it but the sources back it. The page may be wrong. */
  | 'disputed'
  /** The page contradicts it and nothing rescues it. Discarded. */
  | 'contradicted'
  /** The model does not know it, and sources did not fill the gap. */
  | 'refused'
  /** The model did not know it. Written from sources alone. */
  | 'sourced';

export interface Expansion {
  term: string;
  /** Empty when refused or contradicted. */
  text: string;
  confidence: Confidence;
  /** Why it was rejected or qualified, shown in the preview rather than hidden. */
  reason: string | null;
  /** Agreement across samples, null when there was nothing to compare. */
  agreement: number | null;
  /** Search results that were judged relevant. Empty when research is off. */
  sources: SearchResult[];
}

export interface ResearchOptions {
  /** Injected, so expansion knows nothing about providers, caches or budgets.
   *  A reason means the search could not run, which is not the same as running
   *  and finding nothing, and the two are never conflated.
   *
   *  The course is passed because a bare term is often unsearchable. Measured
   *  on corpus page F: searching "Epsilon" alone returns the Greek letter and
   *  a dozen brand names, and four of six terms came back with no relevant
   *  source at all, downgrading correct explanations for no reason. The course
   *  comes from config, never from model output. */
  lookup: (term: string, course?: string) => Promise<{ results: SearchResult[]; reason: string | null }>;
}

export interface ExpandOptions {
  /** The page transcript. The gate checks explanations against this. */
  notes: string;
  course?: string;
  /** Injected, so tests need no model and the fixture layer can sit in front. */
  model: ModelFn;
  /** Samples per term for the consistency signal. 1 disables it. */
  samples?: number;
  /** Terms whose agreement falls below this are marked low confidence. */
  agreementThreshold?: number;
  /** Omit to expand exactly as before ADR 0004, with no network at all. */
  research?: ResearchOptions;
}

const REFUSAL = 'I do not know this term';
const refuses = (text: string) => new RegExp(REFUSAL, 'i').test(text);

// ---------------------------------------------------------------------------
// Choosing what to expand
//
// Until now the terms were supplied by hand, by the spike harnesses. Running
// for real needs them picked off the page, and that pick is the input to every
// check that follows, so it is constrained hard.
//
// Terms must appear VERBATIM on the page. That is not tidiness. CLAUDE.md rule
// 4 lets a model contribute a query term and never choose one freely, and a
// term copied from the transcript is a term the student wrote down. A model
// that invents "quantum leftist heaps" gets it dropped here rather than
// searched for.
// ---------------------------------------------------------------------------

export function extractPrompt(notes: string, course?: string, limit = 12): string {
  return [
    course ? `These are notes from a course on ${course}.` : 'These are lecture notes.',
    '',
    notes,
    '',
    `List up to ${limit} technical terms from these notes that a student would`,
    'want explained later. Prefer terms written as bare keywords with no',
    'explanation, since those are the ones that will mean nothing in a month.',
    '',
    // Measured on corpus page F: three of eight extracted "terms" were
    // instructions off the page ("Remove redundancy", "Avoid division"). They
    // are correctly refused later, but each one costs a model round and a
    // search query, so they are worth excluding here.
    'A term must be the NAME OF A CONCEPT: a noun or noun phrase.',
    'Do not list instructions, advice, or actions. "Remove redundancy" and',
    '"Avoid division" are not terms. "Kleene star" and "register allocation" are.',
    '',
    // Page F also yielded "language", "set" and "nums", all genuinely on the
    // page and all useless. The stop list catches the worst, but asking is
    // cheaper than filtering and catches the ones no list anticipates.
    'The term must be specific to this subject. Skip ordinary words that would',
    'mean the same thing in any subject: "language" and "set" on their own are',
    'too general, while "formal language" and "set difference" are not.',
    '',
    // Also measured on page F: the page reads "Kleeny star", and copying that
    // verbatim would search for a word that does not exist. Handwriting is
    // misread and students misspell things, so a bounded correction is allowed.
    'Copy each term as it is written in the notes, EXCEPT that if the notes',
    'misspell a standard term you should write the standard spelling.',
    'Correct spelling only. Never replace a term with a different one.',
    '',
    'One term per line. No numbering, no bullets, no commentary.',
  ].join('\n');
}

/** Levenshtein distance, capped: anything past the cap is not a spelling fix. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Is this term on the page, allowing for a corrected spelling?
 *
 * Exact substring first, which is the common case and cheap. Failing that, the
 * term is compared against every same-length window of the page, and accepted
 * when it is within a small edit distance of one.
 *
 * The bound is what keeps the guard meaningful. "Kleeny star" to "Kleene star"
 * is one character and is exactly the case this exists for. "Kleene star" to
 * "the Vandermeer register pass" is not close to anything, so an invented term
 * still cannot get through by being called a correction.
 */
function appearsOnPage(term: string, haystack: string): boolean {
  if (haystack.includes(term)) return true;

  // One edit per eight characters, and NO budget below eight, so a short term
  // must match exactly.
  //
  // The minimum matters more than the ratio. "epsilon" and "upsilon" are one
  // edit apart and are different Greek letters, so any budget at all on a seven
  // character term lets a correction change the meaning. Longer terms are safe
  // to correct because a single edit cannot turn one concept into another:
  // "Kleeny star" to "Kleene star" is one edit in eleven characters.
  const cap = Math.floor(term.length / 8);
  if (cap === 0) return false;

  for (let start = 0; start + term.length - cap <= haystack.length; start++) {
    for (let width = term.length - cap; width <= term.length + cap; width++) {
      if (start + width > haystack.length) continue;
      if (editDistance(term, haystack.slice(start, start + width), cap) <= cap) return true;
    }
  }
  return false;
}

/** Normalised for comparison: case, spacing and surrounding punctuation. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Single words too general to be worth explaining on their own.
 *
 * Measured on corpus page F, which yielded "language", "set" and "nums". All
 * three are genuinely written on the page, so the on-page guard passes them,
 * and all three are useless: no source defines the bare word "language", and an
 * explanation of what a "set" is belongs in nobody's revision notes.
 *
 * This is a judgement encoded as data, which is why it is a short list of
 * SINGLE words only. "Formal language" and "set difference" are real terms and
 * are unaffected, because the rule below applies only when the whole term is
 * one of these words. Erring small is deliberate: a wrongly dropped term is
 * invisible, whereas the cost of a wrongly kept one is a few seconds and a line
 * of noise in the note.
 */
const TOO_GENERAL = new Set([
  'language', 'languages', 'set', 'sets', 'number', 'numbers', 'nums', 'value',
  'values', 'type', 'types', 'example', 'examples', 'note', 'notes', 'thing',
  'things', 'data', 'system', 'code', 'file', 'files', 'list', 'lists', 'name',
  'names', 'word', 'words', 'string', 'strings', 'part', 'parts', 'problem',
  'problems', 'result', 'results', 'method', 'methods', 'case', 'cases',
  'point', 'points', 'line', 'lines', 'time', 'size', 'form', 'level',
]);

/** Whether a term is a bare general word rather than the name of a concept. */
export function isTooGeneral(term: string): boolean {
  const key = normalise(term).replace(/[^a-z0-9 ]/g, '');
  // Only single words. A multi-word term containing a general word is fine:
  // "formal language" and "context free language" are exactly what we want.
  return !key.includes(' ') && TOO_GENERAL.has(key);
}

/**
 * Parse a term list and keep only terms actually present on the page.
 *
 * Pure and exported so the filtering rules can be tested without a model.
 */
export function parseTerms(raw: string, notes: string, limit: number): string[] {
  const haystack = normalise(notes);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of raw.split('\n')) {
    const term = line
      // Models produce numbered or bulleted lists however firmly you ask them not to.
      .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')
      .replace(/^["'`]+|["'`:,.]+$/g, '')
      .trim();

    if (term.length < 2 || term.length > MAX_TERM_CHARS) continue;

    const key = normalise(term);
    if (seen.has(key)) continue;
    if (isTooGeneral(term)) continue;
    // The guard that matters: it has to be on the page, give or take a
    // corrected spelling.
    if (!appearsOnPage(key, haystack)) continue;

    seen.add(key);
    out.push(term);
    if (out.length >= limit) break;
  }

  return out;
}

/** Kept in step with search.MAX_TERM_LENGTH, and enforced independently so
 *  extraction is safe even when research is switched off. */
const MAX_TERM_CHARS = 120;

export interface ExtractOptions {
  notes: string;
  course?: string;
  model: ModelFn;
  limit?: number;
}

/** Ask the model which terms are worth expanding, then discard its inventions. */
export async function extractTerms(options: ExtractOptions): Promise<string[]> {
  const limit = options.limit ?? 12;
  if (options.notes.trim().length === 0) return [];

  const raw = await options.model(
    extractPrompt(options.notes, options.course, limit),
    { temperature: 0 },
  );
  return parseTerms(raw, options.notes, limit);
}

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

function refused(term: string, reason: string): Expansion {
  return { term, text: '', confidence: 'refused', reason, agreement: null, sources: [] };
}

/**
 * The model refused, so there is no explanation to protect.
 *
 * This is the only path where sources may write rather than judge. It is also
 * where retrieval is most likely to help: a term the model does not know is by
 * definition not one where its own knowledge was strong.
 */
async function explainFromSources(term: string, options: ExpandOptions): Promise<Expansion> {
  if (!options.research) {
    return refused(term, 'the model said it does not know this term');
  }

  const { results, reason } = await options.research.lookup(term, options.course);
  if (reason) {
    return refused(term, `the model does not know this term, and it could not be looked up: ${reason}`);
  }
  if (results.length === 0) {
    return refused(term, 'the model does not know this term, and no sources were found for it');
  }

  const draft = (await options.model(
    fromSourcesPrompt(term, results, options.course),
    { temperature: 0 },
  )).trim();

  if (draft.length === 0 || draft.toLowerCase().includes(SOURCES_INSUFFICIENT)) {
    return refused(term, 'the model does not know this term, and the sources did not explain it');
  }

  // The snippets are read against the draft, not against the term, so a draft
  // that drifted past what the sources actually said is caught here.
  const evidence = await readEvidence(draft, results, { model: options.model });
  if (looksInvented(evidence)) {
    return refused(term, 'no source discusses this term, so it may not exist');
  }
  if (evidence.verdict === 'refuted') {
    return refused(term, 'the sources contradicted every explanation of this term');
  }

  // Still has to clear the page. Sources never outrank the notes silently.
  const verdict = (await options.model(
    contradictionPrompt(draft, options.notes),
    { temperature: 0 },
  )).trim().toUpperCase();

  if (verdict.startsWith('CONTRADICT')) {
    return {
      term,
      text: draft,
      confidence: 'disputed',
      reason: 'written from sources, but it conflicts with what the page says',
      agreement: null,
      sources: citations(evidence),
    };
  }

  return {
    term,
    text: draft,
    confidence: 'sourced',
    reason: 'the model did not know this term, so this was written from the sources listed',
    agreement: null,
    sources: citations(evidence),
  };
}

/** Combine the page verdict and the source verdict into an outcome. */
function combine(
  term: string,
  text: string,
  pageContradicts: boolean,
  evidence: Evidence | null,
  agreement: number | null,
  softReason: string | null,
): Expansion {
  const sources = evidence ? citations(evidence) : [];

  // No research configured. Exactly the pre-ADR-0004 behaviour.
  if (!evidence) {
    if (pageContradicts) {
      return {
        term, text: '', confidence: 'contradicted',
        reason: 'the explanation conflicted with what the page says',
        agreement: null, sources: [],
      };
    }
    return {
      term, text, confidence: softReason ? 'low' : 'high',
      reason: softReason, agreement, sources: [],
    };
  }

  if (pageContradicts) {
    // The interesting case. The page says one thing, the sources say another.
    // Nothing is resolved here: both are surfaced and the human decides, which
    // is the only honest handling of a page that might itself be wrong.
    if (evidence.verdict === 'supported') {
      return {
        term, text, confidence: 'disputed',
        reason: 'this conflicts with the page, but the sources below support it, so the page may be wrong',
        agreement, sources,
      };
    }
    return {
      term, text: '', confidence: 'contradicted',
      reason: 'the explanation conflicted with what the page says',
      agreement: null, sources: [],
    };
  }

  // The page is silent or agrees. Sources may qualify, never delete: a content
  // farm outranking a correct explanation is the regression this feature has to
  // avoid, so a refutation is shown to the human rather than acted on.
  if (evidence.verdict === 'refuted') {
    return {
      term, text, confidence: 'unsupported',
      reason: 'the sources below argue against this, and the page does not settle it',
      agreement, sources,
    };
  }
  if (evidence.verdict === 'mixed') {
    return {
      term, text, confidence: 'unsupported',
      reason: 'the sources below disagree with each other about this',
      agreement, sources,
    };
  }
  // Nothing relevant came back. That is NOT a reason to doubt the explanation,
  // and treating it as one made research a net negative.
  //
  // Measured on corpus page F: four of six terms were downgraded from high to
  // low purely because no snippet discussed them, and every one of those four
  // was a correct explanation. The terms were generic words like "Language",
  // which no page defines in isolation. Meanwhile "Kleene star", an actual
  // named concept, found three sources and held its confidence.
  //
  // So an unverified term behaves exactly as if research were switched off.
  // Absence of evidence is not evidence, and ADR 0004 says sources vote rather
  // than veto: silently downgrading on silence was a veto in disguise.
  if (evidence.verdict === 'unverified') {
    return {
      term, text, confidence: softReason ? 'low' : 'high',
      reason: softReason, agreement, sources,
    };
  }

  // Supported. A soft reason from the consistency signal still applies.
  return {
    term, text, confidence: softReason ? 'low' : 'high',
    reason: softReason, agreement, sources,
  };
}

/**
 * Expand one term, with every check.
 *
 * Never throws for a term it cannot handle: a refused, contradicted or disputed
 * term is a normal outcome that the preview shows, not an error that aborts the
 * page.
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
  if (answered.length === 0) return explainFromSources(term, options);

  // The longest answer is the candidate: it carries the most claims, so it is
  // the hardest to sneak an error through the checks with.
  const candidate = answered.slice().sort((a, b) => b.length - a.length)[0];

  // The page gate. Temperature 0: a judgement, not a sample.
  const verdict = (await options.model(
    contradictionPrompt(candidate, options.notes),
    { temperature: 0 },
  )).trim().toUpperCase();
  const pageContradicts = verdict.startsWith('CONTRADICT');

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
  const softReason = unstable ? 'the model gave different answers each time'
    : partiallyRefused ? 'the model only sometimes claimed to know this'
      : null;

  // Sources. Run even on a contradicted term, because a page the owner wrote
  // wrongly is precisely the case that needs a second opinion.
  let evidence: Evidence | null = null;
  if (options.research) {
    const { results, reason } = await options.research.lookup(term, options.course);
    evidence = await readEvidence(candidate, results, {
      model: options.model,
      unavailable: reason,
    });
  }

  return combine(term, candidate, pageContradicts, evidence, agreement, softReason);
}

/** Expand several terms. Sequential on purpose: one model, one GPU. */
export async function expandTerms(terms: string[], options: ExpandOptions): Promise<Expansion[]> {
  const out: Expansion[] = [];
  for (const term of terms) out.push(await expandTerm(term, options));
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Bare hostname, so a citation reads as a source rather than a URL. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Render expansions as a Markdown section.
 *
 * Decision 20: anything the model added and is not on the page is marked, with
 * each level of doubt marked differently, because "the model was unsure" and
 * "the sources disagree with your notes" are things a reader needs while
 * revising and cannot recover later.
 *
 * Links are plain text, not Markdown links. CLAUDE.md rule 5: generated
 * Markdown is inert, and these URLs came from a search engine.
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

  const settled = usable.filter((e) => e.confidence === 'high' || e.confidence === 'low');
  const flagged = usable.filter((e) => e.confidence !== 'high' && e.confidence !== 'low');

  const entry = (e: Expansion, marker: string): string[] => {
    const out = [`**${e.term}**${marker}`, '', e.text, ''];
    if (e.reason && marker !== '') out.push(`*${e.reason}*`, '');
    // Tolerant of an absent list rather than typed-and-trusted: this renders
    // into the vault, and a crash here would lose a whole note over a missing
    // field that carries no meaning of its own.
    const sources = e.sources ?? [];
    if (sources.length > 0) {
      out.push(`Sources: ${sources.map((s) => host(s.url)).join(', ')}`, '');
    }
    return out;
  };

  if (settled.length > 0) {
    lines.push('> [!note] Added by the model, not on the page');
    lines.push('> Each entry was checked against the page and did not contradict it.');
    lines.push('');
    for (const e of settled) {
      lines.push(...entry(e, e.confidence === 'low' ? ' *(uncertain)*' : ''));
    }
  }

  if (flagged.length > 0) {
    lines.push('> [!warning] Check these yourself');
    lines.push('> The page and the sources did not agree, or the sources argued against it.');
    lines.push('');
    for (const e of flagged) {
      const marker = e.confidence === 'disputed' ? ' *(disputed)*'
        : e.confidence === 'unsupported' ? ' *(unsupported)*'
          : ' *(from sources)*';
      lines.push(...entry(e, marker));
    }
  }

  if (rejected.length > 0) {
    lines.push('> [!warning] Not explained');
    for (const e of rejected) lines.push(`> - **${e.term}**: ${e.reason}`);
    lines.push('');
  }

  return lines.join('\n');
}
