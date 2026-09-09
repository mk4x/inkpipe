// Deterministic scoring for transcription quality.
//
// Two independent measures, because each fails in a way the other catches:
//
//   CER/WER  : how close the transcript is character by character. Catches
//              general degradation, but a model that outputs fluent nonsense
//              about the right topic can still score mediocre rather than bad.
//   coverage : did the required domain terms survive. Catches the failure that
//              actually matters for study notes, where "rank" becoming "vamk"
//              makes the page useless even at a decent CER.
//
// See docs/PREPARATION.md section 10.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Strip YAML frontmatter, returning { meta, body }. Minimal parser: this only
 *  needs to handle the small subset our own expected files use. */
export function parseExpected(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };

  const meta = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey) {
      (meta[currentKey] ||= []).push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      const value = kv[2].trim();
      // `>` and `|` introduce a block scalar we do not need the body of.
      meta[currentKey] = value === '' || value === '>' || value === '|'
        ? []
        : stripQuotes(value);
    }
  }
  return { meta, body: m[2] };
}

const stripQuotes = (s) => s.replace(/^["'](.*)["']$/, '$1');

/** Normalise for comparison: this is an OCR benchmark, not a formatting one, so
 *  case, punctuation and whitespace are not what we are measuring. */
export function normalise(text) {
  return text
    .replace(/^---[\s\S]*?---/, '')      // frontmatter
    .replace(/^#+\s*/gm, '')             // heading markers
    .replace(/[*_`>]/g, '')              // inline markdown
    .toLowerCase()
    .replace(/[^a-z0-9()^+\-. ]+/g, ' ') // keep maths-ish chars, drop the rest
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, two-row rolling buffer so long pages stay cheap. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Score one model transcript against a hand-written reference.
 * Lower cer/wer is better, higher coverage is better.
 */
export function score(actualRaw, expectedRaw) {
  const { meta, body } = parseExpected(expectedRaw);

  const expected = normalise(body);
  const actual = normalise(actualRaw);

  const cer = expected.length === 0
    ? 1
    : levenshtein(actual, expected) / expected.length;

  const expectedWords = expected.split(' ').filter(Boolean);
  const actualWords = actual.split(' ').filter(Boolean);
  const wer = expectedWords.length === 0
    ? 1
    : levenshtein(actualWords, expectedWords) / expectedWords.length;

  const required = Array.isArray(meta.requiredTerms) ? meta.requiredTerms : [];
  const found = required.filter((t) => actual.includes(normalise(t)));
  const missing = required.filter((t) => !actual.includes(normalise(t)));

  return {
    cer: round(cer),
    wer: round(wer),
    coverage: required.length ? round(found.length / required.length) : null,
    found: found.length,
    total: required.length,
    missing,
    expectedChars: expected.length,
    actualChars: actual.length,
    partial: meta.partial === 'true' || meta.partial === true,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// CLI: node score.mjs <actual.txt> <expected.md>
// pathToFileURL rather than string building: on Windows a path is `C:\x` and the
// URL is `file:///C:/x`, so a hand-rolled comparison silently never matches.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [actualPath, expectedPath] = process.argv.slice(2);
  if (!actualPath || !expectedPath) {
    console.error('usage: node score.mjs <actual.txt> <expected.md>');
    process.exit(2);
  }
  const result = score(
    readFileSync(actualPath, 'utf8'),
    readFileSync(expectedPath, 'utf8'),
  );
  console.log(JSON.stringify(result, null, 2));
}
