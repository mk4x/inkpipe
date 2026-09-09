// Does search help, or does it make things worse?
//
// ADR 0004 shipped with status "Accepted, unmeasured", and said the number that
// decides whether research ships enabled is REGRESSIONS: terms that were
// correct without search and wrong with it. This is the harness that produces
// that number.
//
// Each term is run twice against the same model and the same page, once with
// research and once without, and the two verdicts are printed side by side for
// hand grading. Nothing here decides correctness on its own. A model judging
// whether a model was right is the exact circularity ADR 0003 was written to
// avoid, so the last column is left for a human.
//
// Run the baseline before you have search credentials:
//
//   node research-ab.mjs --page page-e-compiler-construction --baseline
//
// Then the comparison once the API is enabled:
//
//   node research-ab.mjs --page page-e-compiler-construction
//
// The baseline is written to results/ so the two runs can be compared even
// though they happen days apart.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandTerms, extractTerms } from '../../apps/agent/src/expand.ts';
import { lookup, googleProvider, memoryCache, dailyBudget } from '../../apps/agent/src/search.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const PAGE = arg('page', 'page-e-compiler-construction');
const MODEL = arg('model', 'qwen2.5:14b');
const SAMPLES = Number(arg('samples', 3));
const BASELINE_ONLY = args.includes('--baseline');
const LIMIT = Number(arg('limit', 8));

// --- the page --------------------------------------------------------------

const raw = readFileSync(join(HERE, 'expected', `${PAGE}.md`), 'utf8');
const notes = raw.replace(/^---[\s\S]*?---\n/, '').trim();

const course = /compiler/i.test(PAGE) ? 'Compiler Construction'
  : /formal/i.test(PAGE) ? 'Compiler Construction'
    : 'Algorithms and Data Structures';

// --- the model -------------------------------------------------------------

async function model(prompt, options = {}) {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: options.temperature ?? 0, num_predict: 320, top_p: 0.95 },
    }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 160)}`);
  return (await response.json()).response ?? '';
}

// --- research, when credentials exist ---------------------------------------

function credentials() {
  const base = process.env.APPDATA
    ? join(process.env.APPDATA, 'inkpipe')
    : join(process.env.HOME ?? '.', '.config', 'inkpipe');
  try {
    const config = JSON.parse(readFileSync(join(base, 'config.json'), 'utf8'));
    const secrets = JSON.parse(readFileSync(join(base, 'secrets.json'), 'utf8'));
    if (!secrets.searchApiKey || !config.research?.cx) return null;
    return { apiKey: secrets.searchApiKey, cx: config.research.cx };
  } catch {
    return null;
  }
}

function researchFrom(creds, budgetLimit) {
  const provider = googleProvider({ apiKey: creds.apiKey, cx: creds.cx });
  const cache = memoryCache();
  const budget = dailyBudget(budgetLimit);
  const queried = [];

  return {
    queried,
    research: {
      async lookup(term) {
        queried.push(term);
        const result = await lookup(term, { provider, cache, budget, limit: 5 });
        return { results: result.results, reason: result.reason };
      },
    },
  };
}

// --- run -------------------------------------------------------------------

console.log(`page    ${PAGE}`);
console.log(`model   ${MODEL}, ${SAMPLES} samples per term`);

const terms = await extractTerms({ notes, course, model, limit: LIMIT });
console.log(`terms   ${terms.length} extracted from the page\n`);
for (const term of terms) console.log(`        ${term}`);
console.log();

if (terms.length === 0) {
  console.log('nothing to expand. The extractor found no term written verbatim on the page.');
  process.exit(0);
}

const started = Date.now();
console.log('running WITHOUT research...');
const before = await expandTerms(terms, { notes, course, model, samples: SAMPLES });
console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

mkdirSync(RESULTS, { recursive: true });
const baselinePath = join(RESULTS, `${PAGE}.baseline.json`);

if (BASELINE_ONLY) {
  writeFileSync(baselinePath, `${JSON.stringify({ page: PAGE, model: MODEL, terms, before }, null, 2)}\n`);
  report(before, null);
  console.log(`\nbaseline written to ${baselinePath}`);
  console.log('Grade the explanations by hand, then rerun without --baseline once search works.');
  process.exit(0);
}

const creds = credentials();
if (!creds) {
  console.log('No search credentials found. Run with --baseline, or finish the Google setup.');
  process.exit(1);
}

// One query per term, plus headroom. Deliberately small: this is a measurement,
// not a reason to spend the day's quota.
const { research, queried } = researchFrom(creds, terms.length + 2);

const secondStart = Date.now();
console.log('running WITH research...');
let after;
try {
  after = await expandTerms(terms, { notes, course, model, samples: SAMPLES, research });
} catch (error) {
  console.log(`research run failed: ${error.message}`);
  process.exit(1);
}
console.log(`done in ${((Date.now() - secondStart) / 1000).toFixed(0)}s`);
console.log(`queries spent: ${queried.length}\n`);

report(before, after);

// If a baseline was recorded earlier, say whether the model itself drifted,
// since these runs sample at non-zero temperature and are not deterministic.
if (existsSync(baselinePath)) {
  const saved = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const changed = saved.before.filter((b, i) => before[i] && b.confidence !== before[i].confidence);
  if (changed.length > 0) {
    console.log(`\nnote: ${changed.length} term(s) changed verdict between baseline runs with no`);
    console.log('research involved at all. That is sampling noise and it is the floor on any');
    console.log('difference the table above can claim.');
  }
}

writeFileSync(
  join(RESULTS, `${PAGE}.compare.json`),
  `${JSON.stringify({ page: PAGE, model: MODEL, terms, before, after }, null, 2)}\n`,
);

function report(withoutResearch, withResearch) {
  const line = '='.repeat(100);
  console.log(line);
  console.log(`${'term'.padEnd(42)} ${'without'.padEnd(14)} ${withResearch ? 'with' : ''}`);
  console.log(line);

  for (let i = 0; i < withoutResearch.length; i++) {
    const a = withoutResearch[i];
    const b = withResearch?.[i];
    const flag = b && a.confidence !== b.confidence ? '  <- changed' : '';
    console.log(
      `${a.term.slice(0, 40).padEnd(42)} ${a.confidence.padEnd(14)} ${(b?.confidence ?? '').padEnd(14)}${flag}`,
    );
  }
  console.log(line);

  if (withResearch) {
    const changed = withResearch.filter((b, i) => b.confidence !== withoutResearch[i].confidence);
    const cited = withResearch.filter((b) => b.sources.length > 0);
    console.log(`\nchanged verdict : ${changed.length} of ${withResearch.length}`);
    console.log(`carried sources : ${cited.length} of ${withResearch.length}`);
    console.log('\nHAND GRADING. For each row, was the explanation factually correct?');
    console.log('A REGRESSION is a term that was correct without research and is now');
    console.log('wrong, or was correct and is now discarded. That count decides whether');
    console.log('research ships enabled by default.');
  }

  console.log('\n--- full text ---\n');
  for (let i = 0; i < withoutResearch.length; i++) {
    const a = withoutResearch[i];
    const b = withResearch?.[i];
    console.log(`### ${a.term}`);
    console.log(`without [${a.confidence}] ${a.text || `(none: ${a.reason})`}`);
    if (b) {
      console.log(`with    [${b.confidence}] ${b.text || `(none: ${b.reason})`}`);
      if (b.sources.length > 0) {
        console.log(`sources ${b.sources.map((s) => new URL(s.url).hostname).join(', ')}`);
      }
    }
    console.log();
  }
}
