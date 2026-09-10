// Finding diagrams and refusing bad boxes.
//
// A vision model asked for coordinates will confidently return coordinates,
// including for a page with no diagram on it. So every box is validated against
// the real image rather than trusted, and these tests are almost entirely about
// the refusals.
//
// The asymmetry that sets the thresholds: missing a diagram costs a crop, and a
// wrong crop puts a meaningless fragment into the vault and makes the note
// worse than having nothing. So the bias is heavily towards dropping.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagrams, detectDiagrams, diagramPrompt } from '../src/diagram.ts';

const W = 1600;
const H = 2000;

const answer = (diagrams: unknown[]) => JSON.stringify({ diagrams });

describe('a good box', () => {
  test('becomes a full width band around the diagram', () => {
    const found = parseDiagrams(
      answer([{ caption: 'network tiers', x: 0.1, y: 0.2, w: 0.5, h: 0.3 }]),
      W, H,
    );
    assert.equal(found.length, 1);
    assert.deepEqual(
      { left: found[0].left, top: found[0].top, width: found[0].width, height: found[0].height },
      // The model box is 0.1,0.2 by 0.5,0.3. The vertical band comes from the
      // model and gains PAD on each side; the width comes from the page.
      // Measured on the diagram test page, the right hand edge is where a 7B
      // is consistently wrong, and on lined notes a drawing occupies the
      // writing area anyway.
      { left: 0, top: 280, width: 1600, height: 840 },
    );
    assert.equal(found[0].caption, 'network tiers');
  });

  test('survives the fences models wrap JSON in', () => {
    const wrapped = '```json\n' + answer([{ caption: 'tree', x: 0.1, y: 0.1, w: 0.4, h: 0.4 }]) + '\n```';
    assert.equal(parseDiagrams(wrapped, W, H).length, 1);
  });

  test('survives commentary around the JSON', () => {
    const chatty = `Here is what I found:\n${answer([{ caption: 'tree', x: 0.1, y: 0.1, w: 0.4, h: 0.4 }])}\nHope that helps.`;
    assert.equal(parseDiagrams(chatty, W, H).length, 1);
  });
});

describe('boxes that are refused', () => {
  test('a page with no diagrams yields nothing', () => {
    assert.deepEqual(parseDiagrams('{"diagrams":[]}', W, H), []);
  });

  test('a box STARTING off the edge was invented', () => {
    assert.deepEqual(parseDiagrams(answer([{ x: -0.1, y: 0.1, w: 0.3, h: 0.3 }]), W, H), []);
    assert.deepEqual(parseDiagrams(answer([{ x: 1.2, y: 0.1, w: 0.3, h: 0.3 }]), W, H), []);
  });

  test('a box that OVERRUNS the edge is clamped, not dropped', () => {
    // Measured on the diagram test page: the model gave y 0.8 with h 0.3 for
    // the third drawing, a correct position with a sloppy height. Refusing it
    // lost a diagram that was really there.
    const found = parseDiagrams(answer([{ caption: 'third', x: 0.2, y: 0.8, w: 0.6, h: 0.3 }]), W, H);
    assert.equal(found.length, 1);
    assert.equal(found[0].top + found[0].height, H, 'clamped to the bottom edge');
  });

  test('a box covering the page is refused, since the page is already embedded', () => {
    assert.deepEqual(parseDiagrams(answer([{ x: 0, y: 0, w: 1, h: 1 }]), W, H), []);
    assert.deepEqual(parseDiagrams(answer([{ x: 0.02, y: 0.02, w: 0.95, h: 0.95 }]), W, H), []);
  });

  test('a sliver is a line of text, not a drawing', () => {
    // Full width and a few percent tall is exactly what a heading looks like.
    assert.deepEqual(parseDiagrams(answer([{ x: 0, y: 0.4, w: 0.9, h: 0.01 }]), W, H), []);
    assert.deepEqual(parseDiagrams(answer([{ x: 0.4, y: 0.1, w: 0.01, h: 0.5 }]), W, H), []);
  });

  test('nonsense numbers are refused', () => {
    assert.deepEqual(parseDiagrams(answer([{ x: 'a', y: 0.1, w: 0.3, h: 0.3 }]), W, H), []);
    assert.deepEqual(parseDiagrams(answer([{ x: 0.1, y: 0.1, w: 0, h: 0.3 }]), W, H), []);
  });

  test('unparseable output yields nothing rather than throwing', () => {
    assert.deepEqual(parseDiagrams('I could not find any diagrams.', W, H), []);
    assert.deepEqual(parseDiagrams('', W, H), []);
    assert.deepEqual(parseDiagrams('{broken', W, H), []);
  });

  test('a tiny crop on a small image is refused', () => {
    // Valid as a fraction, useless as pixels.
    assert.deepEqual(parseDiagrams(answer([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }]), 200, 200), []);
  });
});

describe('duplicates and limits', () => {
  test('the same drawing returned twice is cropped once', () => {
    const found = parseDiagrams(answer([
      { caption: 'tree', x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      { caption: 'tree again', x: 0.12, y: 0.11, w: 0.4, h: 0.4 },
    ]), W, H);
    assert.equal(found.length, 1);
  });

  test('an overlapping box is MERGED, so no detected drawing is lost', () => {
    // Measured on corpus page I: the model's box for the second drawing is
    // tall enough to swallow the third. Dropping the third meant a diagram the
    // model had correctly found vanished because of how generous the box above
    // it happened to be. That is a loss, not a duplicate.
    const found = parseDiagrams(answer([
      { caption: 'flow', x: 0.1, y: 0.5, w: 0.5, h: 0.4 },
      { caption: 'graph', x: 0.1, y: 0.8, w: 0.5, h: 0.2 },
    ]), W, H);

    assert.equal(found.length, 1);
    assert.equal(found[0].top + found[0].height, H, 'the crop reaches the lower drawing');
    assert.match(found[0].caption, /flow/);
    assert.match(found[0].caption, /graph/, 'the caption names both');
  });

  test('two separate diagrams are both kept', () => {
    const found = parseDiagrams(answer([
      { caption: 'top', x: 0.05, y: 0.05, w: 0.4, h: 0.2 },
      { caption: 'bottom', x: 0.05, y: 0.6, w: 0.4, h: 0.2 },
    ]), W, H);
    assert.equal(found.length, 2);
  });

  test('a page does not get nine diagrams', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      caption: `d${i}`, x: 0.05, y: 0.02 + i * 0.1, w: 0.3, h: 0.08,
    }));
    assert.ok(parseDiagrams(answer(many), W, H).length <= 4);
  });
});

describe('the caption', () => {
  test('is stripped of anything that could act in a note', () => {
    // It becomes alt text in the vault, so it is model output reaching Obsidian
    // and gets the same treatment as everything else.
    const found = parseDiagrams(answer([
      { caption: '[[evil]] ![img](x) `code`', x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
    ]), W, H);
    assert.ok(!/[[\]()`*]/.test(found[0].caption));
  });

  test('falls back when missing or empty', () => {
    const found = parseDiagrams(answer([{ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }]), W, H);
    assert.equal(found[0].caption, 'diagram');
  });

  test('is capped in length', () => {
    const found = parseDiagrams(answer([
      { caption: 'x'.repeat(200), x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
    ]), W, H);
    assert.ok(found[0].caption.length <= 60);
  });
});

describe('detectDiagrams', () => {
  test('a model failure costs nothing', async () => {
    // The transcription already succeeded. A diagram pass falling over must not
    // take the page with it.
    const model = async () => { throw new Error('ollama fell over'); };
    assert.deepEqual(await detectDiagrams(new Uint8Array([1]), { model, imageWidth: W, imageHeight: H }), []);
  });

  test('the prompt says text is not a diagram', () => {
    // Without this it boxes headings and bullet lists, which is most of a page.
    const prompt = diagramPrompt();
    assert.match(prompt, /Ordinary written text is NOT a diagram/);
    assert.match(prompt, /fractions of the page/);
    assert.match(prompt, /\{"diagrams":\[\]\}/);
  });
});

describe('answer shapes the model actually produces', () => {
  // qwen2.5vl answers a bare array rather than the object it was shown, so
  // both forms are accepted. Observed on corpus pages B and C.
  test('a bare empty array is understood', () => {
    assert.deepEqual(parseDiagrams('[]', W, H), []);
    assert.deepEqual(parseDiagrams('```json [] ```', W, H), []);
  });

  test('a bare array of boxes is understood', () => {
    const found = parseDiagrams('[{"caption":"tree","x":0.1,"y":0.1,"w":0.4,"h":0.4}]', W, H);
    assert.equal(found.length, 1);
    assert.equal(found[0].caption, 'tree');
  });

  test('an object is still understood', () => {
    assert.equal(parseDiagrams(answer([{ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }]), W, H).length, 1);
  });
});

describe('the crop takes the page width', () => {
  // Measured across several runs on the diagram test page: vertical placement
  // is reliable and the right hand edge is consistently short. At 0.03 padding
  // the mind map lost its right hand node, at 0.06 the flow chart still lost
  // "Succeed". Taking the width from the page fixes it outright.
  test('a narrow box still becomes a full width band', () => {
    const found = parseDiagrams(answer([{ x: 0.4, y: 0.3, w: 0.2, h: 0.2 }]), W, H);
    assert.equal(found[0].left, 0);
    assert.equal(found[0].width, W);
  });

  test('the vertical band still comes from the model', () => {
    const top = parseDiagrams(answer([{ x: 0.1, y: 0.05, w: 0.3, h: 0.2 }]), W, H)[0];
    const bottom = parseDiagrams(answer([{ x: 0.1, y: 0.7, w: 0.3, h: 0.2 }]), W, H)[0];
    assert.ok(top.top < bottom.top, 'a diagram lower on the page crops lower');
  });

  test('a sliver is still refused, since width is judged before the page width applies', () => {
    // Otherwise every heading becomes a full width crop.
    assert.deepEqual(parseDiagrams(answer([{ x: 0.1, y: 0.4, w: 0.02, h: 0.4 }]), W, H), []);
  });
});
