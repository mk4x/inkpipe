// Is a model a better consistency judge than word overlap?
//
// expert-spike measured agreement with Jaccard over content words. That scored
// three CORRECT, identically-meaning explanations of a skew heap at 0.38 and
// labelled them unstable, because they were paraphrases. Lexical overlap
// measures wording, and wording is not what we care about.
//
// So this asks the model itself, as a narrow binary question, which is the kind
// of task small models are actually good at:
//
//     Statement A: ...
//     Statement B: ...
//     Do they make the same factual claims? AGREE or DISAGREE.
//
// It reuses the samples expert-spike already saved, so nothing is regenerated
// and the two measures are compared on identical data.
//
//   node judge-spike.mjs [--model qwen2.5:14b]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'recordings', 'expert-spike');
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const args = process.argv.slice(2);
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'qwen2.5:14b';

/** Deliberately narrow: one comparison, two allowed answers, no explanation.
 *  Asking for reasoning invites the model to talk itself into a verdict. */
const JUDGE = (a, b) => [
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

async function ask(prompt) {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      // Temperature 0: this is a judgement, not a sample. It should be stable.
      options: { temperature: 0, num_predict: 8 },
    }),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return ((await response.json()).response ?? '').trim().toUpperCase();
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.txt'));
console.log(`judge ${MODEL}, over ${files.length} saved term files\n`);

const results = [];
for (const file of files) {
  const samples = readFileSync(join(DIR, file), 'utf8')
    .split(/--- sample \d+ ---/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Refusals carry no claims to compare.
  const answered = samples.filter((s) => !/i do not know this term/i.test(s));
  const kind = file.split('-')[0];
  const term = file.replace(/^\w+-/, '').replace(/\.txt$/, '').replace(/-/g, ' ');

  if (answered.length < 2) {
    results.push({ kind, term, verdict: 'REFUSED', agree: null, pairs: 0 });
    console.log(`${kind.padEnd(5)} ${term.slice(0, 42).padEnd(44)} REFUSED (nothing to judge)`);
    continue;
  }

  let agreements = 0;
  let pairs = 0;
  for (let i = 0; i < answered.length; i++) {
    for (let j = i + 1; j < answered.length; j++) {
      const answer = await ask(JUDGE(answered[i], answered[j]));
      if (answer.startsWith('AGREE')) agreements++;
      pairs++;
    }
  }

  const ratio = agreements / pairs;
  const verdict = ratio === 1 ? 'CONSISTENT' : ratio >= 0.5 ? 'PARTIAL' : 'CONTRADICTORY';
  results.push({ kind, term, verdict, agree: ratio, pairs });
  console.log(`${kind.padEnd(5)} ${term.slice(0, 42).padEnd(44)} ${verdict.padEnd(14)} ${agreements}/${pairs} pairs agree`);
}

console.log(`\n${'='.repeat(76)}`);
console.log('kind   verdict         agree  term');
console.log('='.repeat(76));
for (const r of results) {
  console.log(`${r.kind.padEnd(6)} ${r.verdict.padEnd(15)} ${(r.agree === null ? ' n/a' : r.agree.toFixed(2)).padStart(5)}  ${r.term.slice(0, 42)}`);
}
console.log('='.repeat(76));
console.log('\nWanted: real terms CONSISTENT, the trap term flagged, fakes REFUSED.');
