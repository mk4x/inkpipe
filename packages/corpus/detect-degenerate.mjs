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
// Both signals are needed: line repetition catches the block-level loop, ngram
// repetition catches a loop that runs on inside a single long line.

/** Longest run of consecutive identical non-empty lines. */
function maxConsecutiveLineRepeat(lines) {
  let best = 1;
  let run = 1;
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return lines.length ? best : 0;
}

/** Highest occurrence count of any word-level n-gram. */
function maxNgramRepeat(words, n) {
  if (words.length < n) return 0;
  const counts = new Map();
  let best = 0;
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(' ');
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next > best) best = next;
  }
  return best;
}

export function detectDegenerate(text, {
  maxLineRepeatRatio = 0.5,
  maxConsecutive = 4,
  maxNgram = 5,
  ngramSize = 5,
} = {}) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '```' && l !== '```markdown');

  const distinct = new Set(lines);
  const lineRepeatRatio = lines.length ? 1 - distinct.size / lines.length : 0;
  const consecutive = maxConsecutiveLineRepeat(lines);

  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const ngram = maxNgramRepeat(words, ngramSize);

  const reasons = [];
  if (lineRepeatRatio > maxLineRepeatRatio) {
    reasons.push(`${Math.round(lineRepeatRatio * 100)}% of lines are duplicates`);
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
    maxConsecutiveLines: consecutive,
    maxNgramRepeat: ngram,
    lines: lines.length,
  };
}
