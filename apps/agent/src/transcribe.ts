// Transcription, with the guards that ADR 0001 showed are necessary.
//
// The measured facts this encodes, all from the issue #1 spike:
//
//   - The dominant failure is a degenerate repetition loop, returned with a 200.
//   - It is DETERMINISTIC: page A under the strict prompt gave byte-identical
//     degenerate output on 5 consecutive runs, and raising temperature did not
//     help. So a retry must change the prompt, never just repeat the request.
//   - Prompt complexity hurts. `minimal` won or tied on 3 of 4 corpus pages and
//     was the only variant that kept the hardest page out of a loop.
//   - The per-course glossary is what suppresses the loop on dense pages.

import { detectDegenerate } from './degenerate.ts';

export type PromptVariant = 'minimal' | 'base';

/** Ordered by measured quality on the corpus, best first. This IS the retry
 *  ladder: on degeneracy we move to the next entry rather than repeating. */
export const PROMPT_LADDER: PromptVariant[] = ['minimal', 'base'];

const PROMPTS: Record<PromptVariant, string[]> = {
  minimal: [
    'Transcribe this handwritten page of notes into Markdown.',
    // Underlining by hand is deliberate. The owner: "when some word is
    // underlined, there is a high chance its a word to remember (term) and
    // probably should google it." Marking it costs one line of prompt and
    // turns a visual signal into a machine-readable one that survives into
    // term extraction. Bold is the Markdown for emphasis and renders in
    // Obsidian, so the note reads correctly even if nothing downstream cares.
    'If a word or phrase is underlined, write it in **bold**.',
    'Output only the transcription, with no commentary.',
  ],
  base: [
    'Transcribe this handwritten page of university notes into Markdown.',
    '',
    'Rules:',
    '- Output only the transcription. No preamble, no commentary, no summary.',
    '- Preserve the structure: headings, bullets, and indentation.',
    '- Write any underlined word or phrase in **bold**.',
    '- Do not add any content that is not written on the page.',
    '- If a word is genuinely illegible, write [?] rather than guessing.',
  ],
};

export interface TranscribeOptions {
  /** Course vocabulary. ADR 0001 finding 4: this is what stops the loop. */
  glossary?: string[];
  course?: string;
  /** Injected so tests never need a GPU, and so the record/replay fixture layer
   *  can sit in front of a real model unchanged. */
  model: (prompt: string, image: Uint8Array) => Promise<string>;
}

export interface TranscribeResult {
  ok: boolean;
  /** Empty when every ladder rung produced degenerate output. */
  markdown: string;
  variantUsed: PromptVariant | null;
  attempts: { variant: PromptVariant; degenerate: boolean; reasons: string[] }[];
}

export function buildPrompt(variant: PromptVariant, options: { course?: string; glossary?: string[] }): string {
  const lines = [...PROMPTS[variant]];
  const glossary = options.glossary ?? [];
  if (glossary.length > 0 && options.course) {
    lines.push(
      '',
      `These notes are from a course on ${options.course}. Terms that appear in this course include:`,
      `${glossary.join(', ')}.`,
      'Use this vocabulary to resolve ambiguous handwriting, but never invent content.',
    );
  }
  return lines.join('\n');
}

/**
 * Transcribe one page, walking the prompt ladder on degeneracy.
 *
 * Returns ok:false rather than throwing, because a failed page is a normal
 * outcome the preview must show (with the cropped original, decision 8) rather
 * than an error that aborts the whole session.
 */
export async function transcribePage(
  image: Uint8Array,
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const attempts: TranscribeResult['attempts'] = [];

  for (const variant of PROMPT_LADDER) {
    const prompt = buildPrompt(variant, options);
    const raw = await options.model(prompt, image);
    const markdown = stripCodeFenceWrapper(raw);
    const check = detectDegenerate(markdown);

    attempts.push({ variant, degenerate: check.degenerate, reasons: check.reasons });

    if (!check.degenerate) {
      return { ok: true, markdown, variantUsed: variant, attempts };
    }
  }

  return { ok: false, markdown: '', variantUsed: null, attempts };
}

/** Models habitually wrap the whole answer in ```markdown ... ```. That is
 *  packaging, not content, and leaving it in would nest fences in the note. */
export function stripCodeFenceWrapper(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  return (match ? match[1] : trimmed).trim();
}

/** Talk to a local Ollama. Kept deliberately thin so the record/replay fixture
 *  layer can substitute for it in CI, which has no GPU. */
export function ollamaModel(options: {
  model: string;
  host?: string;
  numCtx?: number;
  timeoutMs?: number;
}) {
  const host = options.host ?? 'http://127.0.0.1:11434';
  const numCtx = options.numCtx ?? 4096;
  const timeoutMs = options.timeoutMs ?? 180_000;

  return async (prompt: string, image: Uint8Array): Promise<string> => {
    // A per-page timeout, so one bad photograph never stalls the whole session.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: options.model,
          prompt,
          images: [Buffer.from(image).toString('base64')],
          stream: false,
          options: { temperature: 0, num_predict: 2048, num_ctx: numCtx },
        }),
      });
      if (!response.ok) {
        throw new Error(`ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      return ((await response.json()) as { response?: string }).response ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The same, without an image, for expansion (ADR 0003).
 *
 * A separate function rather than an optional image argument, because it is a
 * separate model. Text-only inference is far cheaper than vision, so a 9 GB
 * text model and a 6 GB vision model coexist on a 16 GB card as long as they
 * run sequentially, which they do.
 *
 * Temperature is per call rather than fixed: expansion samples at 0.7 to
 * measure consistency and judges at 0, and collapsing that to one value would
 * make the consistency signal measure nothing.
 */
export function ollamaTextModel(options: {
  model: string;
  host?: string;
  numCtx?: number;
  timeoutMs?: number;
  numPredict?: number;
}) {
  const host = options.host ?? 'http://127.0.0.1:11434';
  const numCtx = options.numCtx ?? 4096;
  const timeoutMs = options.timeoutMs ?? 180_000;
  // Short on purpose. Every prompt in the expansion chain asks for either two
  // sentences or a single word, so a large budget only buys rambling.
  const numPredict = options.numPredict ?? 320;

  return async (
    prompt: string,
    callOptions?: { temperature?: number; maxTokens?: number },
  ): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: options.model,
          prompt,
          stream: false,
          options: {
            temperature: callOptions?.temperature ?? 0,
            // Per call, because the stages differ by an order of magnitude:
            // a snippet verdict is one word, rewriting a page is hundreds.
            num_predict: callOptions?.maxTokens ?? numPredict,
            num_ctx: numCtx,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      return ((await response.json()) as { response?: string }).response ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}
