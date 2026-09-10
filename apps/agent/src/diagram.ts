// Finding the diagrams on a page and cutting them out.
//
// A hand-drawn diagram survives transcription badly. It becomes a paragraph
// describing arrows, which is longer than the drawing and worse than it. The
// owner asked for the drawing itself: "diagram reader and takes crops of the
// diagram that it then throws into the .md file (with obsidian syntax)".
//
// A crop is strictly better than a description here. It is exactly what was on
// the paper, it costs no model tokens once cut, and it cannot be wrong.
//
// WHY THIS IS BOUNDED HARD
//
// A vision model asked for coordinates will confidently return coordinates,
// including for pages with no diagram at all. Every box is therefore validated
// against the image rather than trusted:
//
//   inside the image        a box off the edge is a hallucination
//   not the whole page      the full page is already embedded, so a box that
//                           covers most of it adds nothing and hides the crop
//   not a sliver            a few pixels tall is a line of text, not a drawing
//   few per page            a page of notes has one or two diagrams, not nine
//
// A box that fails any of these is dropped silently. Missing a diagram costs a
// crop; a wrong crop puts a meaningless fragment in the vault and makes the
// note worse than having nothing.

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Diagram extends Region {
  /** What the model called it, sanitised, for the image alt text. */
  caption: string;
}

export function diagramPrompt(): string {
  return [
    'Look at this page of handwritten notes.',
    '',
    'Find any DRAWN diagrams: boxes and arrows, graphs, trees, tables drawn by',
    'hand, flow charts, or sketches. Ordinary written text is NOT a diagram, and',
    'neither is a heading, a bullet list, or an underline.',
    '',
    'For each one, give its bounding box as fractions of the page, where 0,0 is',
    'the top left and 1,1 is the bottom right.',
    '',
    'Answer as JSON and nothing else:',
    '{"diagrams":[{"caption":"short name","x":0.1,"y":0.2,"w":0.5,"h":0.3}]}',
    '',
    'If there are no drawn diagrams, answer exactly: {"diagrams":[]}',
  ].join('\n');
}

/** Smallest fraction of the page a real diagram occupies. Below this it is a
 *  line of text or a stray mark. */
const MIN_FRACTION = 0.02;

/** Largest. Above this the box is essentially the page, which is already
 *  embedded whole, so a crop of it is a duplicate. */
const MAX_FRACTION = 0.85;

const MAX_DIAGRAMS = 4;

/**
 * Parse the model's answer into regions in pixels.
 *
 * Everything is validated against the real image size. Fractions are used in
 * the prompt because a model does not know the pixel dimensions and asking for
 * pixels invites numbers that look plausible and are not.
 */
export function parseDiagrams(
  answer: string,
  imageWidth: number,
  imageHeight: number,
): Diagram[] {
  let items: Array<Record<string, unknown>>;
  try {
    // Models wrap JSON in fences however firmly you ask them not to, and
    // qwen2.5vl answers a bare "[]" rather than the object it was shown when
    // there is nothing to report. Both forms are accepted.
    const text = answer.replace(/```(?:json)?/g, '').trim();

    const objectStart = text.indexOf('{');
    const arrayStart = text.indexOf('[');

    if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
      const end = text.lastIndexOf('}');
      if (end === -1) return [];
      items = (JSON.parse(text.slice(objectStart, end + 1)) as {
        diagrams?: Array<Record<string, unknown>>;
      }).diagrams ?? [];
    } else if (arrayStart !== -1) {
      const end = text.lastIndexOf(']');
      if (end === -1) return [];
      items = JSON.parse(text.slice(arrayStart, end + 1)) as Array<Record<string, unknown>>;
    } else {
      return [];
    }

    if (!Array.isArray(items)) return [];
  } catch {
    return [];
  }

  const out: Diagram[] = [];

  for (const raw of items) {
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w);
    const h = Number(raw.h);

    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;

    // Inside the page. A box that runs off the edge was invented.
    if (x < 0 || y < 0 || w <= 0 || h <= 0) continue;
    if (x + w > 1.001 || y + h > 1.001) continue;

    const area = w * h;
    if (area < MIN_FRACTION || area > MAX_FRACTION) continue;

    // A diagram is not a hairline. Either dimension being tiny means a rule or
    // a line of text was picked up.
    if (w < 0.05 || h < 0.03) continue;

    const left = Math.round(x * imageWidth);
    const top = Math.round(y * imageHeight);
    const width = Math.min(Math.round(w * imageWidth), imageWidth - left);
    const height = Math.min(Math.round(h * imageHeight), imageHeight - top);
    if (width < 32 || height < 32) continue;

    out.push({
      left,
      top,
      width,
      height,
      caption: cleanCaption(String(raw.caption ?? 'diagram')),
    });

    if (out.length >= MAX_DIAGRAMS) break;
  }

  return dropOverlapping(out);
}

/** The caption becomes alt text in a note, so it is model output reaching the
 *  vault and gets the same treatment as everything else: plain, short, inert. */
function cleanCaption(text: string): string {
  const cleaned = text
    .replace(/[[\]()|`*_#>\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'diagram';
}

/**
 * Drop boxes that mostly repeat an earlier one.
 *
 * A model asked for several diagrams will often return the same drawing twice
 * with slightly different edges, and two crops of one picture in a note is
 * worse than one.
 */
function dropOverlapping(diagrams: Diagram[]): Diagram[] {
  const kept: Diagram[] = [];

  for (const candidate of diagrams) {
    const duplicate = kept.some((existing) => {
      const overlapWidth = Math.max(0,
        Math.min(existing.left + existing.width, candidate.left + candidate.width)
        - Math.max(existing.left, candidate.left));
      const overlapHeight = Math.max(0,
        Math.min(existing.top + existing.height, candidate.top + candidate.height)
        - Math.max(existing.top, candidate.top));
      const overlap = overlapWidth * overlapHeight;
      const smaller = Math.min(existing.width * existing.height, candidate.width * candidate.height);
      return smaller > 0 && overlap / smaller > 0.5;
    });

    if (!duplicate) kept.push(candidate);
  }

  return kept;
}

export interface DetectOptions {
  /** The vision model, same signature as transcription. */
  model: (prompt: string, image: Uint8Array) => Promise<string>;
  imageWidth: number;
  imageHeight: number;
}

/**
 * Ask where the diagrams are.
 *
 * Never throws. A page with no diagrams is the common case and returns an empty
 * list, which is indistinguishable from a failure on purpose: neither should
 * cost the transcription that already succeeded.
 */
export async function detectDiagrams(
  image: Uint8Array,
  options: DetectOptions,
): Promise<Diagram[]> {
  try {
    const answer = await options.model(diagramPrompt(), image);
    return parseDiagrams(answer, options.imageWidth, options.imageHeight);
  } catch {
    return [];
  }
}
