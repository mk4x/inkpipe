// Make a transcript look like a note someone wrote on purpose.
//
// The model returns serviceable but scruffy Markdown: mixed bullet characters,
// half-formed tables, Unicode maths that renders inconsistently, and stray H1s
// that fight the note title. This module tidies that deterministically.
//
// The governing rule, and the reason each transform below is narrow:
// NORMALISE, NEVER INVENT. Everything here must be reversible in meaning. A
// formatter that guesses at maths and gets it wrong is worse than one that
// leaves the text alone, because these are study notes and a mangled formula
// reads as authoritative.
//
// Anything genuinely uncertain is left exactly as written.

export interface FormatOptions {
  /** Normalise maths notation and wrap high-confidence expressions in $...$ */
  math: boolean;
  /** Repair pipe tables: add the missing alignment row, pad ragged columns */
  tables: boolean;
  /** One bullet character, consistent indentation */
  lists: boolean;
  /** Keep a single H1 (the note title) and demote the rest */
  headings: boolean;
  /** Collapse runs of blank lines, ensure blank lines around blocks */
  whitespace: boolean;
}

export const DEFAULT_FORMAT: FormatOptions = {
  math: true,
  tables: true,
  lists: true,
  headings: true,
  whitespace: true,
};

export interface FormatResult {
  text: string;
  changes: string[];
}

/**
 * Unicode maths to LaTeX. Applied ONLY inside a recognised maths span, never to
 * running prose, because an arrow in "trap -> emulate" is prose and the same
 * character inside $...$ is an operator.
 */
const UNICODE_TO_LATEX: [RegExp, string][] = [
  [/≤/g, '\\le '], [/≥/g, '\\ge '], [/≠/g, '\\neq '], [/≈/g, '\\approx '],
  [/∈/g, '\\in '], [/∉/g, '\\notin '], [/⊆/g, '\\subseteq '], [/⊂/g, '\\subset '],
  [/∑/g, '\\sum '], [/∏/g, '\\prod '], [/√/g, '\\sqrt'], [/∞/g, '\\infty '],
  [/×/g, '\\times '], [/÷/g, '\\div '], [/±/g, '\\pm '], [/·/g, '\\cdot '],
  [/→/g, '\\to '], [/←/g, '\\gets '], [/⌈/g, '\\lceil '], [/⌉/g, '\\rceil '],
  [/⌊/g, '\\lfloor '], [/⌋/g, '\\rfloor '], [/Θ/g, '\\Theta '], [/Ω/g, '\\Omega '],
  [/α/g, '\\alpha '], [/β/g, '\\beta '], [/λ/g, '\\lambda '], [/μ/g, '\\mu '],
  [/π/g, '\\pi '], [/σ/g, '\\sigma '], [/φ/g, '\\phi '], [/Δ/g, '\\Delta '],
];

/** Superscript and subscript digits the model emits for exponents and indices. */
const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', 'ⁿ': 'n',
};
const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₙ': 'n',
};

export function formatMarkdown(markdown: string, options: Partial<FormatOptions> = {}): FormatResult {
  const opts = { ...DEFAULT_FORMAT, ...options };
  const changes: string[] = [];

  // Code fences are sacred. Split them out first so no transform below can
  // reach inside one and rewrite something that is meant to be literal.
  const segments = splitFences(markdown);

  let out = segments
    .map((segment) => {
      if (segment.fenced) return segment.text;
      let body = segment.text;
      if (opts.headings) body = track(() => demoteHeadings(body), 'demoted a heading that competed with the title', changes, body);
      if (opts.lists) body = track(() => normaliseLists(body), 'normalised list bullets', changes, body);
      if (opts.math) body = track(() => normaliseMath(body), 'normalised mathematics', changes, body);
      if (opts.tables) body = track(() => repairTables(body), 'repaired a table', changes, body);
      return body;
    })
    .join('');

  if (opts.whitespace) {
    out = track(() => normaliseWhitespace(out), 'tidied blank lines', changes, out);
  }

  return { text: out, changes };
}

function track(fn: () => string, label: string, changes: string[], before: string): string {
  const after = fn();
  if (after !== before && !changes.includes(label)) changes.push(label);
  return after;
}

// ---------------------------------------------------------------------------
// Fence splitting
// ---------------------------------------------------------------------------

interface Segment { text: string; fenced: boolean }

/** Split into fenced and unfenced runs, preserving every character. */
export function splitFences(markdown: string): Segment[] {
  const lines = markdown.split('\n');
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flush = (fenced: boolean) => {
    if (buffer.length > 0) {
      segments.push({ text: buffer.join('\n'), fenced });
      buffer = [];
    }
  };

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!inFence && fence) {
      flush(false);
      inFence = true;
      fenceMarker = fence[1][0];
      buffer.push(line);
    } else if (inFence && fence && fence[1][0] === fenceMarker) {
      buffer.push(line);
      flush(true);
      inFence = false;
    } else {
      buffer.push(line);
    }
  }
  flush(inFence);

  // Rejoin needs the newlines that split() consumed between segments.
  return segments.map((s, i) => ({
    ...s,
    text: i < segments.length - 1 ? `${s.text}\n` : s.text,
  }));
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/** The note already has an H1 (the title). A second one breaks the outline and
 *  Obsidian's table of contents, so any H1 in page content becomes an H2. */
export function demoteHeadings(text: string): string {
  return text.replace(/^# (?!#)/gm, '## ');
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** One bullet character throughout, and indentation in multiples of two. */
// Indentation and the gap after a bullet are matched with [ \t], never \s.
// \s includes \n, so a greedy \s* after ^ swallows the blank line above a list
// and silently glues it to the preceding heading.
export function normaliseLists(text: string): string {
  return text
    // Bullet characters the model picks at random.
    .replace(/^([ \t]*)[*\u2022\u2023\u2219\u00b7\u2013\u2014][ \t]+/gm, (_m, indent: string) => `${normaliseIndent(indent)}- `)
    .replace(/^([ \t]*)-[ \t]+/gm, (_m, indent: string) => `${normaliseIndent(indent)}- `)
    // "1)" is valid but inconsistent with "1." which Obsidian prefers.
    .replace(/^([ \t]*)(\d+)\)[ \t]+/gm, (_m, indent: string, n: string) => `${normaliseIndent(indent)}${n}. `);
}

function normaliseIndent(indent: string): string {
  // Tabs and odd space counts become clean two-space levels.
  const width = indent.replace(/\t/g, '  ').length;
  return '  '.repeat(Math.floor(width / 2));
}

// ---------------------------------------------------------------------------
// Mathematics
// ---------------------------------------------------------------------------

/**
 * Conservative on purpose. Only two things happen:
 *
 *   1. Inside an existing $...$ span, Unicode operators become LaTeX.
 *   2. A small set of high-confidence expressions get wrapped in $...$.
 *
 * Everything else is left alone. Wrapping prose in maths delimiters would make
 * Obsidian render it in italic serif, which looks broken and is hard to undo.
 */
export function normaliseMath(text: string): string {
  let out = text;

  // 1. Tidy inside spans that are already maths.
  out = out.replace(/\$([^$\n]+)\$/g, (_m, inner: string) => `$${toLatex(inner)}$`);

  // 2. Wrap complexity notation: O(...), Theta(...), Omega(...). Unambiguous in
  //    computer science notes and very common in these pages.
  out = out.replace(
    /(^|[\s(])((?:O|Θ|Ω|\\Theta|\\Omega)\s*\([^)\n]{1,40}\))/g,
    (match, lead: string, expr: string) => {
      if (isInsideMath(out, match)) return match;
      return `${lead}$${toLatex(expr.replace(/\s+/g, ''))}$`;
    },
  );

  // 3. Exponent expressions such as 2^r - 1 or n^2.
  out = out.replace(
    /(^|[\s(])(\d+|[a-zA-Z])\^(\{[^}\n]{1,20}\}|[a-zA-Z0-9]+)/g,
    (_m, lead: string, base: string, exp: string) => `${lead}$${base}^{${exp.replace(/[{}]/g, '')}}$`,
  );

  // 3b. Whole lines that are plainly equations written in running text.
  out = wrapMathLines(out);

  // 4. Unicode super and subscripts, which never render reliably in a vault.
  out = out.replace(/([a-zA-Z0-9])([⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ]+)/g,
    (_m, base: string, sup: string) => `$${base}^{${[...sup].map((c) => SUPERSCRIPTS[c] ?? c).join('')}}$`);
  out = out.replace(/([a-zA-Z0-9])([₀₁₂₃₄₅₆₇₈₉ₙ]+)/g,
    (_m, base: string, sub: string) => `$${base}_{${[...sub].map((c) => SUBSCRIPTS[c] ?? c).join('')}}$`);

  return out;
}

/** Function-ish names that are maths even though they are long words. */
const MATH_WORDS = new Set([
  'flow', 'min', 'max', 'log', 'sum', 'cap', 'rank', 'nil', 'meld', 'root',
  'left', 'right', 'sqrt', 'mod', 'gcd', 'lcm', 'exp', 'abs', 'deg', 'cost',
]);

const RELATIONAL = /[=≤≥≠<>∈∉⊆⊂]|\\le\b|\\ge\b|\\in\b|\\neq\b/;

/** English connectives short enough to slip past the prose-word count. */
const LEADING_CONNECTIVES = new Set([
  'so', 'if', 'then', 'and', 'but', 'thus', 'we', 'it', 'as', 'or',
  'is', 'be', 'let', 'now', 'here', 'each', 'all', 'any', 'the', 'a',
]);

/**
 * Wrap a whole line in $...$ when it is unambiguously an equation.
 *
 * The model writes maths as plain Unicode in running text, so the span-level
 * rules above never see it. This catches those lines without touching prose,
 * using a deliberately blunt test: a line qualifies only if it contains a
 * relational operator AND almost no ordinary English.
 *
 * Worked through against real corpus output:
 *
 *   "sum c(u,v) <= c(S,T)"                  -> wrapped, no English words
 *   "H = f(S,T) = flow(S,T)"                -> wrapped, "flow" is a maths word
 *   "0 <= f(u,v) <= c(u,v) for all arcs"    -> NOT wrapped, three English words
 *   "for all v - flow in = flow out"        -> NOT wrapped, five English words
 *   "Why is flow bounded? Because"          -> NOT wrapped, no relation
 *   "Under cap constraint: f(S,T) <= c(S,T)" -> only the part after the colon
 */
export function wrapMathLines(text: string): string {
  return text.split('\n').map((line) => {
    // Never touch a heading, a quote, a table row, or an existing maths line.
    if (/^\s*(#|>|\||\$)/.test(line)) return line;
    if (line.includes('$')) return line;

    const prefix = line.match(/^(\s*(?:[-*]\s+|\d+\.\s+)?)/)?.[1] ?? '';
    const rest = line.slice(prefix.length);
    if (rest.trim().length === 0) return line;

    // A label before a colon stays prose; only the tail is a candidate.
    const colon = rest.indexOf(': ');
    const label = colon === -1 ? '' : rest.slice(0, colon + 2);
    const candidate = colon === -1 ? rest : rest.slice(colon + 2);

    if (!RELATIONAL.test(candidate)) return line;
    if (countProseWords(candidate) > 1) return line;
    // A bare "a = b" with nothing else is more likely prose than an equation.
    if (candidate.trim().length < 5) return line;

    // Short connectives are English, but too short to be counted as prose
    // words. Left inside the span they render as italic serif, so "So max f =
    // H" becomes "$So max f = H$". Push them out in front instead.
    let body = candidate.trim();
    let lead = '';
    for (;;) {
      const match = body.match(/^([A-Za-z]{1,5})\s+/);
      if (!match || !LEADING_CONNECTIVES.has(match[1].toLowerCase())) break;
      lead += `${match[1]} `;
      body = body.slice(match[0].length);
    }
    if (body.length < 5) return line;

    return `${prefix}${label}${lead}$${toLatex(body)}$`;
  }).join('\n');
}

function countProseWords(text: string): number {
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  return words.filter((w) => !MATH_WORDS.has(w.toLowerCase())).length;
}

function toLatex(inner: string): string {
  let out = inner;
  for (const [pattern, replacement] of UNICODE_TO_LATEX) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Cheap guard so a wrap does not nest inside an existing span. */
function isInsideMath(haystack: string, needle: string): boolean {
  const at = haystack.indexOf(needle);
  if (at === -1) return false;
  const before = haystack.slice(0, at);
  // An odd number of unescaped $ before it means we are inside a span.
  return (before.match(/\$/g) ?? []).length % 2 === 1;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Repair pipe tables.
 *
 * The model produces these often, because handwritten notes are full of
 * comparison tables (page A of the corpus is a Type 0 / 1 / 2 table), but it
 * usually omits the alignment row, which means Obsidian renders the whole thing
 * as plain text with visible pipes.
 */
export function repairTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }

    // Collect the whole run of pipe rows.
    const block: string[] = [];
    while (i < lines.length && isTableRow(lines[i])) {
      block.push(lines[i]);
      i++;
    }

    // A single pipe row is not a table, it is a sentence with a pipe in it.
    if (block.length < 2) {
      out.push(...block);
      continue;
    }

    const rows = block.map(splitRow);
    const hasAlignment = isAlignmentRow(block[1]);
    const bodyRows = hasAlignment ? [rows[0], ...rows.slice(2)] : rows;
    const columns = Math.max(...bodyRows.map((r) => r.length));

    const padded = bodyRows.map((r) => {
      const copy = [...r];
      while (copy.length < columns) copy.push('');
      return copy;
    });

    out.push(renderRow(padded[0]));
    out.push(`|${' --- |'.repeat(columns)}`);
    for (const row of padded.slice(1)) out.push(renderRow(row));
  }

  return out.join('\n');
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

function isAlignmentRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

function renderRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

export function normaliseWhitespace(text: string): string {
  const trimmed = text
    .replace(/[ \t]+$/gm, '')      // trailing spaces, which git shows as noise
    .replace(/\n{3,}/g, '\n\n')    // at most one blank line
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  // Exactly one trailing newline. A file without one shows as "\ No newline at
  // end of file" in every diff the vault ever produces.
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}
