// Can the model catch an expansion that contradicts the page it came from?
//
// This is the check that matters. The previous two experiments established:
//
//   refusal        works. 3/3 invented terms refused, on both 7b and 14b.
//   self-agreement FAILS on systematic error. Asked about the leftist property,
//                  14b said three times that rank is "the number of nodes in
//                  the subtree". That is wrong, it is the same wrong every
//                  time, and a consistency judge called it CONSISTENT.
//
// The page itself holds the correction: "rank is distance to nil (closest
// empty node)". So the test is whether a narrow contradiction check, given the
// transcript as ground truth, catches what consistency missed.
//
// Ground truth is hand-labelled below, so this measures the checker rather than
// asking a model to grade itself.
//
//   node contradiction-spike.mjs [--model qwen2.5:14b]

const OLLAMA = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const args = process.argv.slice(2);
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'qwen2.5:14b';

/** The relevant part of corpus page B, as the pipeline would have it. */
const NOTES = [
  'Leftist Heap',
  '- Annotated binary tree (e,p,r), r is rank',
  '- rank is distance to nil (closest empty node)',
  '- Leftist: u.left().rank >= u.right().rank()',
  '- parent = min(children) + 1 if 2 children, 1 if 1 child',
  'Meld() O(log n) where n1 + n2 = n',
  '- Look at rightmost path according to prio via right child',
  '- Adjust ranks bottom up',
  'Each subtree has at least 2^r - 1 nodes',
  'Skew Heaps: leftist without rank',
].join('\n');

/** Hand-labelled. `contradicts: true` means the checker SHOULD flag it. */
const CLAIMS = [
  {
    label: 'rank as node count (the real failure from the last experiment)',
    text: 'The rank of a node is the number of nodes in its subtree.',
    contradicts: true,
  },
  {
    label: 'leftist property reversed',
    text: 'In a leftist heap the right child always has a rank greater than or equal to the left child.',
    contradicts: true,
  },
  {
    label: 'wrong complexity',
    text: 'The meld operation on a leftist heap runs in constant time O(1).',
    contradicts: true,
  },
  {
    label: 'skew heaps described as using rank',
    text: 'Skew heaps maintain an explicit rank on every node, exactly like leftist heaps.',
    contradicts: true,
  },
  {
    label: 'rank defined correctly',
    text: 'The rank of a node is the distance to the nearest empty position below it.',
    contradicts: false,
  },
  {
    label: 'leftist property stated correctly',
    text: 'A leftist heap keeps the left child rank at least as large as the right child rank.',
    contradicts: false,
  },
  {
    label: 'correct and adds detail the page does not mention',
    text: 'Leftist heaps were introduced by Clark Crane and support merging in logarithmic time.',
    contradicts: false,
  },
  {
    label: 'correct restatement of the subtree bound',
    text: 'A subtree whose root has rank r contains at least 2^r - 1 nodes.',
    contradicts: false,
  },
];

const PROMPT = (claim) => [
  'Here are a student\'s lecture notes:',
  '',
  NOTES,
  '',
  'Here is a statement that was generated to explain those notes:',
  '',
  claim,
  '',
  'Does the statement CONTRADICT anything in the notes?',
  'Adding detail the notes do not mention is not a contradiction.',
  'Only a direct conflict with what the notes say counts.',
  '',
  'Answer with exactly one word: CONTRADICTS or CONSISTENT.',
].join('\n');

async function ask(prompt) {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 8 },
    }),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return ((await response.json()).response ?? '').trim().toUpperCase();
}

console.log(`model ${MODEL}, ${CLAIMS.length} hand-labelled claims\n`);

let truePositives = 0;
let falseNegatives = 0;
let trueNegatives = 0;
let falsePositives = 0;

for (const claim of CLAIMS) {
  const answer = await ask(PROMPT(claim.text));
  const flagged = answer.startsWith('CONTRADICT');
  const correct = flagged === claim.contradicts;

  if (claim.contradicts && flagged) truePositives++;
  if (claim.contradicts && !flagged) falseNegatives++;
  if (!claim.contradicts && !flagged) trueNegatives++;
  if (!claim.contradicts && flagged) falsePositives++;

  console.log(
    `${correct ? 'ok  ' : 'MISS'}  expected ${(claim.contradicts ? 'CONTRADICTS' : 'CONSISTENT').padEnd(11)}` +
    ` got ${(flagged ? 'CONTRADICTS' : 'CONSISTENT').padEnd(11)}  ${claim.label}`,
  );
}

const wrong = CLAIMS.filter((c) => c.contradicts).length;
const fine = CLAIMS.length - wrong;

console.log(`\n${'='.repeat(70)}`);
console.log(`caught ${truePositives}/${wrong} wrong claims       (missed ${falseNegatives})`);
console.log(`passed ${trueNegatives}/${fine} correct claims     (falsely flagged ${falsePositives})`);
console.log('='.repeat(70));
console.log('\nA usable checker catches most wrong claims without flagging correct ones.');
console.log('False negatives let a wrong claim into the note. False positives are');
console.log('merely annoying, so if one must be traded, trade toward flagging.');
