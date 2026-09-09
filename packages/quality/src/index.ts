// Detect degenerate repetition in a model transcript.
//
// Discovered during the issue #1 spike: the dominant failure mode of local
// vision models on a dense page is not misreading, it is collapsing into a
// loop. qwen2.5vl:7b emitted "VM / Guest OS / Hypervisor / VM1 / VM2 / VM3"
// for 593 lines. minicpm-v:8b emitted "with (p, q)" several hundred times.
//
// This matters because such output is confidently wrong, arrives with no error,
// and would otherwise be written into a study note. It is cheap to detect, so
// the pipeline should refuse it rather than show it to the user as a result.
//
// Three signals are needed, each catching a loop the others miss:
//
//   line repetition     : the block-level loop, identical lines repeated.
//   ngram repetition    : a loop running on inside a single very long line.
//   template repetition : an INCREMENTING loop, where every line is technically
//                         distinct. granite3.2-vision:2b emitted "(in p. 1)",
//                         "(in p. 2)" ... "(in p. 60)". Dedup and ngram both
//                         score that as healthy, because it is only repetitive
//                         once you normalise the numbers away.

/** Longest run of consecutive identical non-empty lines. */
function maxConsecutiveLineRepeat(lines: string[]): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return lines.length ? best : 0;
}

/** Highest occurrence count of any word-level n-gram. */
function maxNgramRepeat(words: string[], n: number): number {
  if (words.length < n) return 0;
  const counts = new Map<string, number>();
  let best = 0;
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(' ');
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next > best) best = next;
  }
  return best;
}

/** Collapse the varying parts of a line so that an incrementing sequence
 *  reduces to a single repeated template. */
const toTemplate = (line: string): string => line.replace(/\d+/g, '#').toLowerCase();

export interface DegeneracyOptions {
  maxLineRepeatRatio?: number;
  maxTemplateRepeatRatio?: number;
  maxConsecutive?: number;
  maxNgram?: number;
  ngramSize?: number;
}

export interface DegeneracyResult {
  degenerate: boolean;
  reasons: string[];
  lineRepeatRatio: number;
  templateRepeatRatio: number;
  maxConsecutiveLines: number;
  maxNgramRepeat: number;
  lines: number;
}

export function detectDegenerate(text: string, {
  maxLineRepeatRatio = 0.5,
  maxTemplateRepeatRatio = 0.6,
  maxConsecutive = 4,
  maxNgram = 5,
  ngramSize = 5,
}: DegeneracyOptions = {}): DegeneracyResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '```' && l !== '```markdown');

  const distinct = new Set(lines);
  const lineRepeatRatio = lines.length ? 1 - distinct.size / lines.length : 0;
  const consecutive = maxConsecutiveLineRepeat(lines);

  const distinctTemplates = new Set(lines.map(toTemplate));
  const templateRepeatRatio = lines.length
    ? 1 - distinctTemplates.size / lines.length
    : 0;

  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const ngram = maxNgramRepeat(words, ngramSize);

  const reasons: string[] = [];
  if (lineRepeatRatio > maxLineRepeatRatio) {
    reasons.push(`${Math.round(lineRepeatRatio * 100)}% of lines are duplicates`);
  }
  if (templateRepeatRatio > maxTemplateRepeatRatio) {
    reasons.push(`${Math.round(templateRepeatRatio * 100)}% of lines share one template`);
  }
  if (consecutive > maxConsecutive) {
    reasons.push(`${consecutive} identical lines in a row`);
  }
  if (ngram > maxNgram) {
    reasons.push(`a ${ngramSize}-word phrase repeats ${ngram} times`);
  }

  return {
    degenerate: reasons.length > 0,
    reasons,
    lineRepeatRatio: Math.round(lineRepeatRatio * 1000) / 1000,
    templateRepeatRatio: Math.round(templateRepeatRatio * 1000) / 1000,
    maxConsecutiveLines: consecutive,
    maxNgramRepeat: ngram,
    lines: lines.length,
  };
}
