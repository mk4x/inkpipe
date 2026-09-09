// Learning from corrections, without touching the weights.
//
// Issue #8, PREPARATION section 9. The owner asked early whether the training
// data goes into the model. It does not: everything here is in-context only.
// Corrections accumulate into a per-course glossary, which is injected into the
// transcription prompt, and ADR 0001 finding 4 measured that this is what stops
// a dense page collapsing into a repetition loop. A page went from a 593 line
// loop to a clean transcript purely by adding course vocabulary.
//
// The important design point is that corrections are DERIVED, not typed. The
// preview already has the model's transcript and the user's edited version.
// Asking someone to also fill in a glossary field is asking them to do work the
// diff can do, and a feedback mechanism that requires extra effort is one that
// gets used twice and then never again.

/** What the reader thought of a page. */
export type Verdict = 'good' | 'bad';

export interface FeedbackRecord {
  /** SHA-256 of the original image, so a page can be recognised again without
   *  storing the image twice or trusting a filename. */
  imageHash: string;
  sessionId: string;
  seq: number;
  course: string;
  verdict: Verdict;
  /** Terms the user introduced while editing. These feed the glossary. */
  corrections: string[];
  /** Whether this page is worth adding to the golden corpus. Every thumbs down
   *  is a candidate: it is a page the pipeline got wrong, which is exactly what
   *  the corpus is short of. */
  corpusCandidate: boolean;
  at: string;
}

/** Words that carry no vocabulary signal, so they never reach the glossary. */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were',
  'for', 'on', 'at', 'by', 'with', 'as', 'it', 'this', 'that', 'these', 'those',
  'be', 'has', 'have', 'had', 'not', 'but', 'if', 'then', 'else', 'from',
]);

/** Split into comparable words, dropping Markdown punctuation and case. */
function words(text: string): string[] {
  return text
    .replace(/[#*_`>|~\-[\]()]/g, ' ')
    .split(/[^A-Za-z0-9+.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length >= 2);
}

/**
 * Terms the user added while editing.
 *
 * A word present in the edited text and absent from the model's is, by
 * definition, something the model failed to produce. On a handwriting
 * transcript that is overwhelmingly domain vocabulary it misread, which is
 * exactly what the glossary is for.
 *
 * Deliberately one directional. Words the user DELETED are not interesting:
 * they are the model's mistakes, and feeding a mistake into the prompt that is
 * meant to prevent it would be precisely wrong.
 */
export function deriveCorrections(original: string, edited: string, limit = 12): string[] {
  const before = new Set(words(original).map((w) => w.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const word of words(edited)) {
    const key = word.toLowerCase();
    if (before.has(key) || seen.has(key) || NOISE.has(key)) continue;
    // Pure numbers are page specific and teach the model nothing.
    if (/^[0-9.]+$/.test(word)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Build a feedback record from a page and its edit.
 *
 * A thumbs down is always a corpus candidate. A thumbs up is one only if the
 * user still had to correct something, because a page that needed fixing
 * despite looking acceptable is a more interesting corpus entry than one that
 * was simply right.
 */
export function recordFor(input: {
  imageHash: string;
  sessionId: string;
  seq: number;
  course: string;
  verdict: Verdict;
  original: string;
  edited: string;
  now?: () => Date;
}): FeedbackRecord {
  const corrections = deriveCorrections(input.original, input.edited);
  return {
    imageHash: input.imageHash,
    sessionId: input.sessionId,
    seq: input.seq,
    course: input.course,
    verdict: input.verdict,
    corrections,
    corpusCandidate: input.verdict === 'bad' || corrections.length > 0,
    at: (input.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * Which pages the corpus should grow by, worst first.
 *
 * Issue #8 notes the corpus has too few pages to tune a prompt against, and
 * that the degeneracy thresholds are currently tuned in sample. This is how the
 * shortlist gets built from real use rather than from whichever pages happened
 * to be photographed first.
 */
export function corpusCandidates(records: FeedbackRecord[]): FeedbackRecord[] {
  return records
    .filter((r) => r.corpusCandidate)
    .slice()
    .sort((a, b) => {
      // A rejected page outranks an accepted one that merely needed edits.
      if (a.verdict !== b.verdict) return a.verdict === 'bad' ? -1 : 1;
      // Then by how much correcting it took, as a proxy for how wrong it was.
      if (b.corrections.length !== a.corrections.length) {
        return b.corrections.length - a.corrections.length;
      }
      return a.at < b.at ? 1 : -1;
    });
}
