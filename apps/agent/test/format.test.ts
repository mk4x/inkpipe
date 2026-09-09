import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMarkdown, demoteHeadings, normaliseLists, normaliseMath,
  repairTables, normaliseWhitespace, splitFences,
} from '../src/format.ts';

describe('splitFences', () => {
  test('preserves every character when rejoined', () => {
    const inputs = [
      'plain text',
      '```js\ncode\n```',
      'before\n```\ncode\n```\nafter',
      '```\nunterminated',
      'a\n~~~py\nb\n~~~\nc',
      '',
    ];
    for (const input of inputs) {
      assert.equal(splitFences(input).map((s) => s.text).join(''), input, `lost data for ${JSON.stringify(input)}`);
    }
  });

  test('marks fenced runs as fenced', () => {
    const segments = splitFences('before\n```js\ncode\n```\nafter');
    assert.equal(segments.some((s) => s.fenced && s.text.includes('code')), true);
  });
});

describe('demoteHeadings', () => {
  test('demotes an H1 so it does not compete with the note title', () => {
    assert.equal(demoteHeadings('# Leftist Heap'), '## Leftist Heap');
  });

  test('leaves deeper headings alone', () => {
    assert.equal(demoteHeadings('## Already\n### Deeper'), '## Already\n### Deeper');
  });

  test('does not touch a hash that is not a heading', () => {
    assert.equal(demoteHeadings('C# is a language'), 'C# is a language');
    assert.equal(demoteHeadings('issue #4'), 'issue #4');
  });
});

describe('normaliseLists', () => {
  test('unifies bullet characters', () => {
    const input = '* one\n• two\n- three\n‣ four';
    assert.equal(normaliseLists(input), '- one\n- two\n- three\n- four');
  });

  test('normalises indentation to two spaces per level', () => {
    assert.equal(normaliseLists('   - deep'), '  - deep');
    assert.equal(normaliseLists('\t- tabbed'), '  - tabbed');
  });

  test('normalises ordered list punctuation', () => {
    assert.equal(normaliseLists('1) first\n2) second'), '1. first\n2. second');
  });

  test('leaves a hyphen inside prose alone', () => {
    // "trap-and-emulate" must survive: it is a compound word, not a bullet.
    const input = 'runs slower due to trap-and-emulate';
    assert.equal(normaliseLists(input), input);
  });

  test('leaves a minus sign in maths alone', () => {
    assert.equal(normaliseLists('$2^r - 1$ nodes'), '$2^r - 1$ nodes');
  });
});

describe('normaliseMath', () => {
  test('wraps complexity notation', () => {
    assert.equal(normaliseMath('meld is O(log n) time'), 'meld is $O(logn)$ time');
  });

  test('does not double wrap maths that is already wrapped', () => {
    const input = 'meld is $O(\\log n)$ time';
    assert.equal(normaliseMath(input).match(/\$/g)?.length, 2, 'must not add extra delimiters');
  });

  test('converts Unicode operators inside an existing maths span', () => {
    assert.match(normaliseMath('$u.left ≥ u.right$'), /\\ge/);
    assert.match(normaliseMath('$a ≤ b$'), /\\le/);
    assert.match(normaliseMath('$x ∈ S$'), /\\in/);
  });

  test('leaves Unicode arrows in prose alone', () => {
    // This is the transform most likely to damage real notes: an arrow in prose
    // is prose, and turning it into \to would be wrong.
    const input = 'trap → emulate is the mechanism';
    assert.equal(normaliseMath(input), input);
  });

  test('wraps exponent expressions', () => {
    assert.match(normaliseMath('at least 2^r - 1 nodes'), /\$2\^\{r\}\$/);
  });

  test('converts Unicode superscripts and subscripts', () => {
    assert.match(normaliseMath('n² nodes'), /\$n\^\{2\}\$/);
    assert.match(normaliseMath('h₁ + h₂ = n'), /\$h_\{1\}\$/);
  });

  test('leaves ordinary prose completely untouched', () => {
    const prose = [
      'rank is distance to nil (closest empty node)',
      'Destructive: p and Q may not exist afterwards',
      'Skew Heaps are leftist without rank',
      'Container: docker, lightweight, less flexible',
    ].join('\n');
    assert.equal(normaliseMath(prose), prose);
  });
});

describe('repairTables', () => {
  test('adds the missing alignment row, without which Obsidian shows raw pipes', () => {
    const input = '| Type 0 | Type 1 |\n| cloud | personal |';
    const output = repairTables(input);
    assert.equal(output.split('\n')[1], '| --- | --- |');
    assert.equal(output.split('\n').length, 3);
  });

  test('keeps an alignment row that is already correct', () => {
    const input = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    assert.equal(repairTables(input).split('\n').length, 3);
  });

  test('pads ragged rows so the table stays rectangular', () => {
    const input = '| a | b | c |\n| 1 |';
    const lines = repairTables(input).split('\n');
    assert.equal(lines[1], '| --- | --- | --- |');
    assert.equal(lines[2], '| 1 |  |  |');
  });

  test('ignores a single line containing a pipe', () => {
    // One pipe row is a sentence, not a table.
    const input = '| this is just a line |';
    assert.equal(repairTables(input), input);
  });

  test('leaves surrounding prose in place', () => {
    const input = 'before\n| a | b |\n| 1 | 2 |\nafter';
    const output = repairTables(input);
    assert.match(output, /^before\n/);
    assert.match(output, /\nafter$/);
  });

  test('handles two separate tables', () => {
    const input = '| a | b |\n| 1 | 2 |\n\ntext\n\n| c | d |\n| 3 | 4 |';
    const output = repairTables(input);
    assert.equal((output.match(/\| --- \| --- \|/g) ?? []).length, 2);
  });
});

describe('normaliseWhitespace', () => {
  test('collapses runs of blank lines', () => {
    // Output always ends with exactly one newline, so a vault diff never shows
    // "No newline at end of file".
    assert.equal(normaliseWhitespace('a\n\n\n\nb'), 'a\n\nb\n');
  });

  test('strips trailing spaces, which git renders as noise', () => {
    assert.equal(normaliseWhitespace('a   \nb\t\n'), 'a\nb\n');
  });

  test('trims leading blank lines and ends with exactly one newline', () => {
    assert.equal(normaliseWhitespace('\n\na\n\n\n'), 'a\n');
  });
});

describe('formatMarkdown', () => {
  test('never reaches inside a code fence', () => {
    // The single most important property here: a fence is literal, and
    // rewriting a bullet or a caret inside one would corrupt real code.
    const input = '```py\n* not a bullet\nx = 2^3\n| a | b |\n```';
    const { text } = formatMarkdown(input);
    // Identical apart from the guaranteed trailing newline: nothing inside the
    // fence may be rewritten.
    assert.equal(text, `${input}\n`);
    assert.ok(text.includes('* not a bullet'), 'a bullet inside a fence must survive');
    assert.ok(text.includes('x = 2^3'), 'a caret inside a fence must not become maths');
    assert.ok(!text.includes('--- |'), 'pipes inside a fence must not become a table');
  });

  test('formats around a fence but not within it', () => {
    const input = '* outside\n\n```\n* inside\n```\n\n* after';
    const { text } = formatMarkdown(input);
    assert.match(text, /^- outside/);
    assert.match(text, /\* inside/, 'fence content must survive verbatim');
    assert.match(text, /- after/);
  });

  test('reports what it changed, so the preview can show it', () => {
    const { changes } = formatMarkdown('# Title\n* item\n| a | b |\n| 1 | 2 |');
    assert.ok(changes.length >= 2, `expected several changes, got ${JSON.stringify(changes)}`);
  });

  test('a well-formed note passes through unchanged', () => {
    // If tidy input is modified, the formatter is too aggressive and will
    // eventually damage something real.
    const input = [
      '## Leftist Heap',
      '',
      '- rank is distance to nil (closest empty node)',
      '- parent = min(children) + 1',
      '',
      '| Type 1 | Type 2 |',
      '| --- | --- |',
      '| cloud | personal |',
      '',
      'Each subtree has at least $2^{r} - 1$ nodes.',
    ].join('\n');
    const { text, changes } = formatMarkdown(`${input}\n`);
    assert.equal(text, `${input}\n`);
    assert.deepEqual(changes, [], 'a tidy note must not be touched at all');
  });

  test('individual transforms can be switched off', () => {
    const input = '* item';
    assert.equal(formatMarkdown(input, { lists: false }).text.trim(), '* item');
    assert.equal(formatMarkdown(input, { lists: true }).text.trim(), '- item');
  });

  test('end to end on realistic scruffy model output', () => {
    const input = [
      '# Meldable Priority Queues',
      '',
      '* Q.insert(e,p)',
      '• Q.findmin()',
      '',
      '',
      '',
      'meld() is O(log n) where h₁ + h₂ = n',
      'Each subtree has at least 2^r - 1 nodes',
      '',
      '| Type 0 | Type 1 | Type 2 |',
      '| built for hypervisor | cloud | personal |',
    ].join('\n');

    const { text } = formatMarkdown(input);

    assert.match(text, /^## Meldable/m, 'H1 demoted');
    assert.match(text, /^- Q\.insert/m, 'bullets unified');
    assert.match(text, /^- Q\.findmin/m);
    assert.match(text, /\$O\(logn\)\$/, 'complexity wrapped');
    assert.match(text, /\$h_\{1\}\$/, 'subscripts converted');
    assert.match(text, /\$2\^\{r\}\$/, 'exponent wrapped');
    assert.match(text, /\| --- \| --- \| --- \|/, 'table alignment row added');
    assert.ok(!text.includes('\n\n\n'), 'blank line runs collapsed');
  });
});

describe('wrapMathLines', () => {
  const wrap = (s: string) => normaliseMath(s);

  test('wraps a line that is purely an equation', () => {
    assert.match(wrap('∑ c(u,v) ≤ c(S,T)'), /^\$.*\$$/);
    // Escaped: /\sum/ would mean "whitespace then um", not a LaTeX command.
    assert.match(wrap('∑ c(u,v) ≤ c(S,T)'), /\\sum/);
    assert.match(wrap('∑ c(u,v) ≤ c(S,T)'), /\\le/);
  });

  test('treats function-ish names as maths, not prose', () => {
    assert.match(wrap('H = f(S,T) = flow(S,T)'), /^\$.*\$$/);
  });

  test('leaves an equation embedded in a sentence alone', () => {
    // Three English words means this is a sentence that happens to contain
    // maths, and wrapping the whole line would italicise the prose.
    const input = '0 ≤ f(u,v) ≤ c(u,v) for all arcs';
    assert.equal(wrap(input), input);
  });

  test('leaves prose with an equals sign alone', () => {
    const input = 'for all v - flow in = flow out';
    assert.equal(wrap(input), input);
  });

  test('leaves prose with no relation alone', () => {
    for (const input of [
      'Why is flow bounded? Because',
      'Min cap along path - all will have that cap',
      'rank is distance to nil (closest empty node)',
      'Residual',
    ]) {
      assert.equal(wrap(input), input, `damaged: ${input}`);
    }
  });

  test('keeps a label before a colon as prose', () => {
    const output = wrap('Under cap constraint: f(S,T) ≤ c(S,T)');
    assert.match(output, /^Under cap constraint: \$/);
    assert.ok(!output.startsWith('$'), 'the label must not be inside the maths span');
  });

  test('preserves a list marker outside the maths span', () => {
    const output = wrap('- ∑ c(u,v) ≤ c(S,T)');
    assert.match(output, /^- \$/);
  });

  test('never touches headings, quotes, table rows or existing maths', () => {
    for (const input of [
      '# H = f(S,T)',
      '> H = f(S,T)',
      '| a ≤ b | c |',
      'already $a \\le b$ here',
    ]) {
      assert.equal(wrap(input), input, `damaged: ${input}`);
    }
  });

  test('ignores a trivially short relation', () => {
    assert.equal(wrap('a=b'), 'a=b');
  });
});

describe('wrapMathLines leading connectives', () => {
  test('keeps a short English connective outside the maths span', () => {
    // "So" is two letters, so the prose-word count never sees it. Left inside
    // the span it renders as italic serif, which looks broken.
    const output = normaliseMath('So max f = H ∈ min c(S,T)');
    assert.match(output, /^So \$/, `got: ${output}`);
    assert.ok(!output.startsWith('$So'), 'the connective must not be inside the maths');
  });

  test('strips several stacked connectives', () => {
    const output = normaliseMath('So then max f = H ∈ min c(S,T)');
    assert.match(output, /^So then \$/, `got: ${output}`);
  });

  test('does not strip a genuine maths identifier that looks short', () => {
    const output = normaliseMath('f(x) = g(x) + h(x)');
    assert.match(output, /^\$/, 'a pure equation still starts with the delimiter');
  });
});
