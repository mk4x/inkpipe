// Issue #1: can a local vision model on 16 GB of VRAM read these pages?
//
// This harness exists to answer one question cheaply, before any product code
// depends on the answer. It is not the production pipeline. It deliberately
// asks for plain Markdown rather than the structured JSON the real system will
// use, so that it measures transcription ability and not JSON compliance.
//
//   node spike.mjs                          run every model on both pages
//   node spike.mjs --model qwen2.5vl:7b     one model
//   node spike.mjs --primed                 add the course-glossary prompt
//   node spike.mjs --raw                    skip image prep, feed the original
//
// Results land in recordings/ (gitignored) and a summary table is printed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score } from './score.mjs';
import { prepForModel } from './prep.mjs';
import { detectDegenerate } from './detect-degenerate.mjs';
import { checkInjection, INJECTIONS } from './adversarial.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

// Page A needs 270 degrees to read upright. Verified visually: 90 puts it upside
// down. Worth stating because getting this wrong silently produces garbage
// scores that look like a bad model rather than a bad pipeline.
const PAGES = [
  { id: 'page-a-virtual-machines', rotate: 270, course: 'Operating Systems' },
  { id: 'page-b-meldable-priority-queues', rotate: 0, course: 'Algorithms and Data Structures' },
  { id: 'page-c-max-flow-min-cut', rotate: 0, course: 'Network Flow' },
  { id: 'page-d-adversarial-test-page', rotate: 0, course: 'General' },
];

// Three prompt variants. The spike showed these are not interchangeable, so the
// prompt is a retry lever rather than a fixed constant. See ADR 0001.
const PROMPTS = {
  minimal: [
    'Transcribe this handwritten page of notes into Markdown.',
    'Output only the transcription, with no commentary.',
  ],
  base: [
    'Transcribe this handwritten page of university computer science notes into Markdown.',
    '',
    'Rules:',
    '- Output only the transcription. No preamble, no commentary, no summary.',
    '- Preserve the structure: headings, bullets, and indentation.',
    '- Use LaTeX for mathematics, for example $O(\\log n)$.',
    '- Do not add any content that is not written on the page.',
    '- If a word is genuinely illegible, write [?] rather than guessing.',
  ],
  strict: [
    'Transcribe this handwritten page of university computer science notes into Markdown.',
    '',
    'Rules:',
    '- Output only the transcription. No preamble, no commentary, no summary.',
    '- Preserve the structure: headings, bullets, and indentation.',
    '- Output Markdown, never a LaTeX document. Use # for headings.',
    '  Do not use \\section, \\begin, \\item or any other LaTeX document command.',
    '- Use $...$ only for inline mathematics, for example $O(\\log n)$.',
    '- Do not add any content that is not written on the page.',
    '- If a word is genuinely illegible, write [?] rather than guessing.',
  ],
};

let BASE_PROMPT = PROMPTS.strict.join('\n');

// Course-level vocabulary, the kind a user would configure once per course.
// Deliberately NOT the answer key from the expected file: that would inflate the
// coverage metric and prove nothing. These are terms a student would list for
// the course as a whole.
const GLOSSARY = {
  'Operating Systems': [
    'hypervisor', 'virtual machine', 'VMM', 'vCPU', 'guest', 'host', 'kernel',
    'page table', 'TLB', 'trap and emulate', 'binary translation', 'container',
    'emulator', 'snapshot', 'migration', 'dirty bit', 'userland',
  ],
  'Algorithms and Data Structures': [
    'priority queue', 'binary heap', 'leftist heap', 'skew heap', 'meld',
    'rank', 'amortized', 'subtree', 'node', 'nil', 'invariant',
    'asymptotic', 'insert', 'delete minimum', 'singleton',
  ],
  'Network Flow': [
    'capacity constraint', 'flow conservation', 'arc', 'source', 'sink',
    'maximum flow', 'minimum cut', 'residual capacity', 'augmenting path',
    'forward edge', 'backward edge', 'bounded', 'saturated', 'cut',
  ],
  // Deliberately empty: the adversarial page is not course material, and
  // priming it would confound what that page is measuring.
  'General': [],
};

const primedPrompt = (course) => {
  const terms = GLOSSARY[course] ?? [];
  if (terms.length === 0) return BASE_PROMPT;
  return [
    BASE_PROMPT,
    '',
    `These notes are from a course on ${course}. Terms that appear in this course include:`,
    terms.join(', ') + '.',
    'Use this vocabulary to resolve ambiguous handwriting, but never invent content.',
  ].join('\n');
};

async function listModels() {
  const res = await fetch(`${OLLAMA}/api/tags`);
  if (!res.ok) throw new Error(`ollama /api/tags failed: ${res.status}`);
  const { models } = await res.json();
  return models.map((m) => m.name);
}

async function transcribe(model, imageB64, prompt, numCtx, temperature = 0) {
  const started = Date.now();
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [imageB64],
      stream: false,
      options: { temperature, num_predict: 2048, num_ctx: numCtx },
    }),
  });
  if (!res.ok) {
    throw new Error(`generate failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  return { text: body.response ?? '', seconds: Math.round((Date.now() - started) / 1000) };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
  const primed = args.includes('--primed');
  const raw = args.includes('--raw');
  // A full resolution page is ~4200 image tokens, which overflows the 4096
  // default. Raising it is the fair comparison: otherwise "raw fails" would be
  // measuring the context limit rather than the image.
  const numCtx = args.includes('--ctx') ? Number(args[args.indexOf('--ctx') + 1]) : 4096;
  const pageFilter = args.includes('--page') ? args[args.indexOf('--page') + 1] : null;
  // Repeat each cell N times. Ollama at temperature 0 is not bit-deterministic,
  // and a page that swings between usable and degenerate across runs is a very
  // different engineering problem from one that is merely inaccurate.
  const repeat = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 1;
  const temperature = args.includes('--temp') ? Number(args[args.indexOf('--temp') + 1]) : 0;
  const promptName = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : 'strict';
  if (!PROMPTS[promptName]) { console.error('unknown prompt: ' + promptName); process.exit(2); }
  BASE_PROMPT = PROMPTS[promptName].join('\n');

  const recordings = join(HERE, 'recordings');
  if (!existsSync(recordings)) mkdirSync(recordings, { recursive: true });

  const available = await listModels();
  const models = only ? [only] : available;
  if (only && !available.includes(only)) {
    console.error(`model ${only} not pulled. available: ${available.join(', ')}`);
    process.exit(2);
  }
  if (models.length === 0) {
    console.error('no models pulled yet');
    process.exit(2);
  }

  const rows = [];

  for (const page of PAGES) {
    if (pageFilter && !page.id.includes(pageFilter)) continue;
    const imagePath = join(HERE, 'images', `${page.id}.jpg`);
    const expected = readFileSync(join(HERE, 'expected', `${page.id}.md`), 'utf8');

    const buffer = raw
      ? readFileSync(imagePath)
      : await prepForModel(imagePath, { rotate: page.rotate });
    const imageB64 = buffer.toString('base64');

    const prompt = primed ? primedPrompt(page.course) : BASE_PROMPT;
    const variant = `${raw ? 'raw' : 'prepped'}-${primed ? 'primed' : 'plain'}-ctx${numCtx}-t${temperature}-${promptName}`;

    for (const model of models) {
     for (let attempt = 1; attempt <= repeat; attempt++) {
      const label = `${model} | ${page.id} | ${variant}${repeat > 1 ? ` | run ${attempt}` : ''}`;
      process.stdout.write(`running ${label} ... `);
      try {
        const { text, seconds } = await transcribe(model, imageB64, prompt, numCtx, temperature);
        const suffix = repeat > 1 ? `__run${attempt}` : '';
        const file = join(recordings, `${page.id}__${model.replace(/[:/]/g, '_')}__${variant}${suffix}.md`);
        writeFileSync(file, text, 'utf8');

        const s = score(text, expected);
        const degen = detectDegenerate(text);
        const injection = INJECTIONS[page.id]
          ? checkInjection(text, INJECTIONS[page.id])
          : null;

        rows.push({
          model, page: page.id, variant, seconds, ...s,
          degenerate: degen.degenerate,
          degenerateReason: degen.reasons[0] ?? null,
          injection,
        });

        let line = `cer ${s.cer} coverage ${s.coverage} (${seconds}s)`;
        if (degen.degenerate) line += `  [DEGENERATE: ${degen.reasons[0]}]`;
        if (injection) {
          line += injection.pass
            ? `  [injection RESISTED, "${injection.trigger}" x${injection.occurrences}]`
            : `  [INJECTION OBEYED, "${injection.trigger}" x${injection.occurrences}]`;
        }
        console.log(line);
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        rows.push({ model, page: page.id, variant, error: err.message });
      }
     }
    }
  }

  console.log('\n' + '='.repeat(96));
  console.log('model                          page      variant          CER    WER   cover  secs');
  console.log('='.repeat(96));
  for (const r of rows.sort((a, b) => (a.cer ?? 9) - (b.cer ?? 9))) {
    if (r.error) {
      console.log(`${pad(r.model, 30)} ${pad(r.page.slice(5, 13), 9)} ${pad(r.variant, 16)} ERROR  ${r.error.slice(0, 30)}`);
      continue;
    }
    console.log(
      `${pad(r.model, 30)} ${pad(r.page.slice(5, 13), 9)} ${pad(r.variant, 16)} ` +
      `${pad(r.cer, 6)} ${pad(r.wer, 6)} ${pad(r.coverage, 6)} ${r.seconds}`,
    );
  }
  console.log('='.repeat(96));
  console.log('CER and WER: lower is better. cover: fraction of required terms present, higher is better.');

  writeFileSync(join(recordings, 'summary.json'), JSON.stringify(rows, null, 2), 'utf8');
}

const pad = (v, n) => String(v ?? '-').padEnd(n).slice(0, n);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
