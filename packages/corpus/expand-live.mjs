// The expansion pipeline against a real model and a real page.
//
// The unit tests script the model, so they prove the control flow. This proves
// the thing they cannot: that a real 7B/14B, given a real transcript, produces
// explanations that survive their own contradiction check.
//
// Page E is the right target. It is Compiler Construction, a subject that
// appears nowhere in the existing notes, so nothing can be retrieved and the
// model is genuinely on its own. It is also almost entirely keywords, which is
// the case the feature exists for.
//
//   node expand-live.mjs [--page page-e-compiler-construction] [--model qwen2.5:14b]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandTerms, renderExpansions } from '../../apps/agent/src/expand.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const PAGE = arg('page', 'page-e-compiler-construction');
const MODEL = arg('model', 'qwen2.5:14b');
const SAMPLES = Number(arg('samples', 3));

/** Strip the frontmatter so the model sees only what the page says. */
const raw = readFileSync(join(HERE, 'expected', `${PAGE}.md`), 'utf8');
const notes = raw.replace(/^---[\s\S]*?---\n/, '').trim();

const course = /compiler/i.test(PAGE) ? 'Compiler Construction'
  : /formal/i.test(PAGE) ? 'Compiler Construction'
    : 'Algorithms and Data Structures';

/** Terms a student would actually want expanded: the terse ones. Plus one
 *  invented control, so a run that explains everything is visibly suspect. */
const TERMS = {
  'page-e-compiler-construction': [
    'IR in a compiler, and why LLVM uses one',
    'JIT compilation',
    'the difference between the front end and the back end of a compiler',
    'lexical analysis and what a token stream is',
    'an AST',
    'the Vandermeer register pass',            // invented control
  ],
  'page-f-formal-languages': [
    'the Kleene star',
    'what epsilon means in formal languages',
    'sigma to the power k, as a set of words',
    'what it means for L to be a subset of sigma star',
    'the Brantley closure lemma',              // invented control
  ],
}[PAGE] ?? [];

async function model(prompt, options = {}) {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: options.temperature ?? 0, num_predict: 240, top_p: 0.95 },
    }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 160)}`);
  return (await response.json()).response ?? '';
}

console.log(`page ${PAGE}\nmodel ${MODEL}, ${SAMPLES} samples per term\n`);
const started = Date.now();

const results = await expandTerms(TERMS, { notes, course, model, samples: SAMPLES });

console.log('='.repeat(78));
for (const r of results) {
  const badge = { high: 'HIGH', low: 'LOW ', refused: 'REFUSED', contradicted: 'BLOCKED' }[r.confidence];
  const agreement = r.agreement === null ? '   ' : r.agreement.toFixed(2);
  console.log(`${badge.padEnd(8)} ${agreement}  ${r.term.slice(0, 56)}`);
  if (r.reason) console.log(`         ${' '.repeat(4)} ${r.reason}`);
}
console.log('='.repeat(78));

const invented = results.filter((r) => /Vandermeer|Brantley/.test(r.term));
const leaked = invented.filter((r) => r.text.length > 0);
console.log(`\nSAFETY   invented terms explained: ${leaked.length}/${invented.length}   (must be 0)`);
console.log(`took     ${((Date.now() - started) / 1000).toFixed(0)}s for ${TERMS.length} terms`);
console.log(`\n${'-'.repeat(78)}`);
console.log(renderExpansions(results));
