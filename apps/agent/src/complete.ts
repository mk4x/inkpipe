// Finishing a list the page leaves open.
//
// The owner wrote "MoSCoW method (must have, should have ...)" and expected the
// other two. That is fair: the page names a fixed, well known set and then
// trails off. Completing it is clarifying what is already there. Writing a
// paragraph about what MoSCoW is would be adding, and is not this.
//
// WHY THIS IS ITS OWN PASS
//
// It was tried inside the cleaning prompt first and did not work. "Do NOT add
// new information" is the strongest rule in that prompt, and an exception
// underneath it loses every time: the model left the ellipsis alone on every
// run. The same model completes MoSCoW correctly and instantly when asked on
// its own, with nothing competing.
//
// That generalises, and it is the reason the pipeline is a chain of small
// focused calls rather than one big one. A prompt carrying two rules that pull
// in opposite directions gets the stronger rule, not a considered balance.
//
// EVERYTHING ADDED IS MARKED
//
// Decision 20: content the student did not write is always distinguishable.
// Additions are wrapped in ==highlight==, which Obsidian renders natively, so
// it is visible in the vault rather than only in the preview.

/** A list the page starts and does not finish. */
export interface OpenList {
  /** The line exactly as written. */
  line: string;
  /** 1-based line number. */
  index: number;
}

export interface Completion {
  /** The line as written. */
  before: string;
  /** The line with the missing items added and marked. */
  after: string;
  index: number;
}

/**
 * Lines that visibly trail off.
 *
 * Deliberately narrow: an explicit ellipsis, "etc", or a trailing "and so on".
 * A list without one of those is a list the student considered finished, and
 * completing it would be inventing rather than clarifying. Being conservative
 * here is the whole safety margin.
 */
export function findOpenLists(markdown: string): OpenList[] {
  const out: OpenList[] = [];
  const lines = markdown.split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || /^\s*>/.test(line)) continue;

    // The line has to both trail off AND already list something, otherwise
    // "etc" in ordinary prose becomes an invitation to invent a list.
    const trailsOff = /(\.\.\.|…|\betc\b\.?|\band so on\b|\bosv\b\.?)\s*[)\]]?\s*$/i.test(line);
    if (!trailsOff) continue;
    if (!/[,;]/.test(line)) continue;

    out.push({ line, index: i + 1 });
  }
  return out;
}

/**
 * Ask only for the items that are missing.
 *
 * An earlier version asked the model to rewrite the line with its own additions
 * marked. That is two jobs, and it did both badly: on "MoSCoW method (must
 * have, should have ...)" it returned "must have, ==must==, ==should==,
 * ==could==, ==won't== this time", duplicating one item and losing another.
 *
 * Asking for the missing items alone is one job. The code does the splicing and
 * the marking, so neither can be got wrong by a model.
 */
export function completePrompt(line: string, course?: string): string {
  return [
    course ? `A student taking ${course} wrote this in their notes:` : 'A student wrote this in their notes:',
    '',
    line,
    '',
    'It names a standard set and then trails off.',
    '',
    'List ONLY the items that are missing from the end, separated by commas.',
    'Do not repeat the items already written. Do not explain them. Do not write',
    'anything else at all.',
    '',
    'If you are not certain of the complete standard set, or this does not name',
    'a standard set, reply with exactly: LEAVE AS IS',
  ].join('\n');
}

const LEAVE = 'LEAVE AS IS';

export interface CompleteOptions {
  course?: string;
  model: (prompt: string, options?: { temperature?: number; maxTokens?: number }) => Promise<string>;
  /** How much longer a completed line may be. A standard set adds a few items,
   *  not a paragraph. */
  maxGrowth?: number;
}

const words = (text: string) => text.split(/\s+/).filter((w) => /\w/.test(w)).length;

/**
 * Turn the model's answer into the items to splice in.
 *
 * Anything already on the line is dropped, which is the guard against the
 * duplication the previous design produced. A model told not to repeat items
 * still repeats them, so it is checked rather than requested.
 */
export function parseMissing(answer: string, line: string): string[] {
  const already = line.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of answer.split('\n')[0].split(',')) {
    const item = raw
      .replace(/^[\s\-*\d.)]+/, '')
      .replace(/[.]+$/, '')
      .trim();

    if (item.length === 0 || item.length > 40) continue;

    const key = item.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
    if (key.length === 0 || seen.has(key)) continue;

    // Already on the line, in whole or as its first word. "must have" must not
    // come back when the student already wrote it.
    const head = key.split(' ')[0];
    if (already.includes(key) || new RegExp(`\\b${head}\\b`).test(already)) continue;

    seen.add(key);
    out.push(item);
    // A standard set is small. More than this and it is listing something else.
    if (out.length >= 6) break;
  }

  return out;
}

/**
 * Complete the open lists on a page.
 *
 * Returns the markdown unchanged when nothing qualifies, which is the common
 * case. Never throws: a failure here must not cost the tidy-up it runs after.
 */
export async function completeOpenLists(
  markdown: string,
  options: CompleteOptions,
): Promise<{ markdown: string; completions: Completion[] }> {
  const open = findOpenLists(markdown);
  if (open.length === 0) return { markdown, completions: [] };

  const maxGrowth = options.maxGrowth ?? 2.5;
  const lines = markdown.split('\n');
  const completions: Completion[] = [];

  for (const candidate of open) {
    let answer: string;
    try {
      answer = (await options.model(
        completePrompt(candidate.line, options.course),
        // One line in, one line out. A large budget here would only invite the
        // definition the prompt just forbade.
        { temperature: 0, maxTokens: 160 },
      )).trim();
    } catch {
      continue;
    }

    if (answer.length === 0 || answer.toUpperCase().includes(LEAVE)) continue;

    const missing = parseMissing(answer, candidate.line);
    if (missing.length === 0) continue;

    // The splice is mechanical: the trailing ellipsis becomes the missing
    // items, each marked. Nothing the model wrote reaches the note unmarked,
    // and nothing already on the line is touched.
    const marked = missing.map((item) => `==${item}==`).join(', ');
    const after = candidate.line.replace(
      /\s*(\.\.\.|…|\betc\b\.?|\band so on\b|\bosv\b\.?)/i,
      `, ${marked}`,
    );

    // A standard set adds a few items, not a paragraph.
    if (words(after) > words(candidate.line) * maxGrowth) continue;

    lines[candidate.index - 1] = after;
    completions.push({ before: candidate.line, after, index: candidate.index });
  }

  return { markdown: lines.join('\n'), completions };
}
