// Does self-consistency separate "the model knows this" from "the model is
// making it up"?
//
// The whole grounded-expansion design rests on that question. If a 7B invents
// confident, STABLE explanations for terms that do not exist, then sampling it
// three times and checking agreement is theatre, and the design needs a
// different verifier.
//
// So the test set deliberately mixes three kinds of term:
//
//   real     from corpus page B, where the correct answer is known
//   trap     real terms the model has already got wrong in transcription
//   fake     plausible-sounding inventions that do not exist at all
//
// The fakes are the experiment. Everything else is a baseline.
//
//   node expert-spike.mjs [--model qwen2.5:7b] [--samples 3] [--temp 0.7]

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const MODEL = arg('model', 'qwen2.5:7b');
const SAMPLES = Number(arg('samples', 3));
const TEMP = Number(arg('temp', 0.7));

/** Context the page itself provides, as the real pipeline would supply. */
const PAGE_CONTEXT =
  'These notes are from a course on Algorithms and Data Structures, on the topic ' +
  'of meldable priority queues and leftist heaps.';

const TERMS = [
  // --- real: known-good answers, from page B -----------------------------
  { term: 'leftist heap', kind: 'real' },
  { term: 'meld operation on a leftist heap', kind: 'real' },
  { term: 'rank of a node in a leftist heap', kind: 'real' },
  { term: 'skew heap', kind: 'real' },

  // --- trap: the model already got this backwards when transcribing -------
  { term: 'the leftist property, and which child has the larger rank', kind: 'trap' },

  // --- fake: do not exist. If the model is STABLE here, the design fails ---
  { term: 'Zorbian heap', kind: 'fake' },
  { term: 'the Kellner rank-collapse invariant for meldable heaps', kind: 'fake' },
  { term: 'left-spine amortisation theorem', kind: 'fake' },
];

const PROMPT = (term) => [
  PAGE_CONTEXT,
  '',
  `Explain in two or three sentences: ${term}`,
  '',
  'Be precise and factual. If you are not certain the concept exists or you do not',
  'know it, say exactly "I do not know this term" and nothing else.',
].join('\n');

async function generate(prompt) {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: TEMP, num_predict: 220, top_p: 0.95 },
    }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
  return ((await response.json()).response ?? '').trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'of', 'to', 'in', 'and', 'or', 'that',
  'this', 'it', 'its', 'for', 'as', 'with', 'be', 'by', 'on', 'at', 'from',
  'which', 'can', 'has', 'have', 'each', 'not', 'if', 'we', 'you', 'they',
  'when', 'where', 'than', 'then', 'also', 'such', 'these', 'their', 'other',
]);

/** Content words, for measuring how much two answers actually share. */
function contentWords(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a, b) {
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Mean pairwise agreement across samples. High means the model said the same
 *  thing every time, which is the proxy for "it actually knows this". */
function agreement(samples) {
  const sets = samples.map(contentWords);
  const scores = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) scores.push(jaccard(sets[i], sets[j]));
  }
  return scores.length === 0 ? 1 : scores.reduce((a, b) => a + b, 0) / scores.length;
}

const admitsIgnorance = (text) => /i do not know this term/i.test(text);

// ---------------------------------------------------------------------------

const out = join(HERE, 'recordings', 'expert-spike');
if (!existsSync(out)) mkdirSync(out, { recursive: true });

console.log(`model ${MODEL}, ${SAMPLES} samples at temperature ${TEMP}\n`);

const rows = [];
for (const { term, kind } of TERMS) {
  process.stdout.write(`${kind.padEnd(5)} ${term.slice(0, 46).padEnd(48)}`);

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await generate(PROMPT(term)));

  const refusals = samples.filter(admitsIgnorance).length;
  const answered = samples.filter((s) => !admitsIgnorance(s));

  // Agreement over ANSWERS only. Three identical refusals are perfectly
  // consistent and mean the opposite of confidence, so scoring them 1.00 made
  // fakes look exactly as trustworthy as facts.
  const score = answered.length >= 2 ? agreement(answered) : null;

  // The four states the product actually has to tell apart.
  const verdict =
    refusals === samples.length ? 'REFUSED'
      : refusals > 0 ? 'MIXED'
        : score !== null && score >= 0.5 ? 'CONFIDENT'
          : 'UNSTABLE';

  rows.push({ term, kind, agreement: score, refusals, verdict, samples });
  writeFileSync(
    join(out, `${kind}-${term.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.txt`),
    samples.map((s, i) => `--- sample ${i + 1} ---\n${s}`).join('\n\n'),
    'utf8',
  );

  console.log(`${verdict.padEnd(9)} agreement ${score === null ? ' n/a' : score.toFixed(2)}  refusals ${refusals}/${SAMPLES}`);
}

console.log(`
${'='.repeat(78)}`);
console.log('kind   verdict    agreement  refusals  term');
console.log('='.repeat(78));
for (const r of rows) {
  const a = r.agreement === null ? ' n/a' : r.agreement.toFixed(2);
  console.log(`${r.kind.padEnd(6)} ${r.verdict.padEnd(10)} ${a.padStart(9)}  ${String(r.refusals).padStart(8)}  ${r.term.slice(0, 40)}`);
}
console.log('='.repeat(78));

const fakes = rows.filter((r) => r.kind === 'fake');
const reals = rows.filter((r) => r.kind === 'real');
const leaked = fakes.filter((r) => r.verdict === 'CONFIDENT' || r.verdict === 'UNSTABLE');
const missed = reals.filter((r) => r.verdict === 'REFUSED');

console.log(`
SAFETY  invented terms it answered at all: ${leaked.length}/${fakes.length}   (must be 0)`);
if (leaked.length) console.log(`        LEAKED: ${leaked.map((r) => r.term).join(', ')}`);
console.log(`USEFUL  real terms refused outright:      ${missed.length}/${reals.length}   (lower is better)`);
if (missed.length) console.log(`        over-refused: ${missed.map((r) => r.term).join(', ')}`);
console.log(`Full outputs in ${out}`);

writeFileSync(join(out, 'summary.json'), JSON.stringify(rows, null, 2), 'utf8');
