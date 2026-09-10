// Checking the arithmetic the student actually wrote.
//
// Corpus page G carries "36 + 45 = 71" and "3 + 9 = 13", both wrong, followed
// by "I am confident this is correct." Nothing in the pipeline noticed, and the
// reason is structural rather than an oversight: every check built so far
// treats THE PAGE as ground truth. The contradiction gate asks whether the
// model's explanation conflicts with the page. Nothing ever asks whether the
// page conflicts with reality.
//
// Arithmetic is the part of that question with an exact answer, so it is
// answered in code. No model, no sampling, no judgement. A model asked to check
// sums is a model that will occasionally agree with a wrong one, and there is
// no reason to accept that when the alternative is a subtraction.
//
// NOTHING IS CORRECTED. The note records what the student wrote, and silently
// fixing it would destroy the only copy of what was on the paper. A wrong sum
// is flagged next to itself and left alone.

export interface ArithmeticProblem {
  /** The expression as written on the page. */
  written: string;
  /** What the page claims the answer is. */
  claimed: number;
  /** What it actually is. */
  actual: number;
  /** 1-based line number in the transcript. */
  line: number;
}

/** Numbers as a student writes them: optional sign, digits, optional decimal. */
const NUMBER = String.raw`-?\d+(?:[.,]\d+)?`;

/**
 * Simple two-operand arithmetic, which is what appears in handwritten notes.
 *
 * Deliberately narrow. A general expression evaluator would have to parse
 * precedence, functions and variables, and every one of those is a chance to
 * mark correct work as wrong. A false alarm on a student's own notes is worse
 * than a missed error: it teaches them to ignore the flags.
 */
const PATTERN = new RegExp(
  String.raw`(${NUMBER})\s*([+\-*/x×·÷])\s*(${NUMBER})\s*=\s*(${NUMBER})`,
  'g',
);

function toNumber(text: string): number {
  // A comma is a decimal separator in Danish, which is the notes this reads.
  return Number(text.replace(',', '.'));
}

function apply(left: number, operator: string, right: number): number | null {
  switch (operator) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': case 'x': case '×': case '·': return left * right;
    case '/': case '÷': return right === 0 ? null : left / right;
    default: return null;
  }
}

/**
 * Every wrong sum on the page.
 *
 * Correct ones are not reported. The output is a list of things to look at, and
 * padding it with things that are fine makes it useless.
 */
export function checkArithmetic(markdown: string): ArithmeticProblem[] {
  const problems: ArithmeticProblem[] = [];
  const lines = markdown.split('\n');
  let inFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    // Fence state has to be tracked, not pattern matched. The interesting text
    // is INSIDE the block, and those lines look like any other.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    // Code is not the student's working, and "a = 2 + 2" in a snippet is an
    // assignment rather than a claim. A callout is something this pipeline
    // wrote, so checking it would mean checking ourselves.
    if (inFence || /^\s*>/.test(line)) continue;

    for (const match of line.matchAll(PATTERN)) {
      const [written, leftText, operator, rightText, claimedText] = match;
      const left = toNumber(leftText);
      const right = toNumber(rightText);
      const claimed = toNumber(claimedText);
      const actual = apply(left, operator, right);

      if (actual === null || !Number.isFinite(claimed)) continue;

      // A tolerance, because a rounded division written by hand is not an
      // error. 0.005 keeps two decimal places honest without flagging them.
      if (Math.abs(actual - claimed) <= 0.005) continue;

      problems.push({
        written: written.trim(),
        claimed,
        actual: Math.round(actual * 1e6) / 1e6,
        line: index + 1,
      });
    }
  }

  return problems;
}

/**
 * A callout listing what does not add up.
 *
 * Placed near the top of the note rather than at the end: the point is to be
 * seen while revising, and nobody reads the bottom of a page of notes.
 */
export function renderArithmeticFlags(problems: ArithmeticProblem[]): string {
  if (problems.length === 0) return '';

  const lines = [
    '> [!warning] Check this arithmetic',
    `> ${problems.length === 1 ? 'One sum does' : `${problems.length} sums do`} not add up. `
    + 'Your page is left exactly as written.',
  ];
  for (const problem of problems) {
    lines.push(`> - \`${problem.written}\` (line ${problem.line}), which comes to **${problem.actual}**`);
  }
  lines.push('');
  return lines.join('\n');
}
