// The desktop pipeline: collect, decrypt, transcribe, and build a draft note.
//
// Deliberately stops before writing. It returns a Draft, which the preview
// screen renders and the user edits (decision 21). Only an explicit approval
// calls into vault.writeNote. CLAUDE.md rule 7: nothing reaches the vault
// without a human.

import { open } from '@inkpipe/crypto';
import { prepForModel, prepForVault, cropRegion } from '@inkpipe/imaging';
import type { InkpipeClient } from '@inkpipe/client';
import type { BlobMeta, PendingBlobsResponse } from '@inkpipe/protocol';
import { transcribePage, type TranscribeOptions, type PromptVariant } from './transcribe.ts';
import { inertMarkdown, sanitizeSegment } from './sanitize.ts';
import { formatMarkdown, type FormatOptions } from './format.ts';
import {
  extractTerms, expandTerms, renderExpansions,
  type Expansion, type ResearchOptions,
} from './expand.ts';
import type { ModelFn } from './evidence.ts';
import { checkArithmetic, renderArithmeticFlags, type ArithmeticProblem } from './arithmetic.ts';
import { cleanNotes } from './clean.ts';
import { completeOpenLists } from './complete.ts';
import { detectDiagrams, type Diagram } from './diagram.ts';

export interface PageDraft {
  blobId: string;
  seq: number;
  /** Empty when transcription failed. The image is still present, so the page
   *  is never lost, only untranscribed (decision 8). */
  markdown: string;
  ok: boolean;
  variantUsed: PromptVariant | null;
  failureReason: string | null;
  /** Compressed copy destined for the vault. */
  vaultImage: Uint8Array;
  imageFilename: string;
  /** What the sanitiser changed, so the preview can show it. */
  sanitiserChanges: string[];
  /** What the formatter tidied. Shown separately because these are cosmetic,
   *  whereas a sanitiser change means something was potentially unsafe. */
  formatterChanges: string[];
  /** The tidied version, or null when cleaning was off or rejected. The raw
   *  transcript above is always kept: it is the record of what was on the
   *  paper, and the preview shows both side by side. */
  cleanMarkdown: string | null;
  /** Why there is no clean version, when there is none. */
  cleanReason: string | null;
  /** Hand-drawn diagrams cut out of the photograph.
   *
   *  A drawing survives transcription badly: it becomes a paragraph about
   *  arrows, longer than the drawing and worse than it. The crop is exactly
   *  what was on the paper and cannot be wrong. */
  diagrams: Array<{ filename: string; caption: string; bytes: Uint8Array }>;
}

export interface Draft {
  sessionId: string;
  /** Model-proposed, user-editable in the preview. */
  suggestedTitle: string;
  course: string;
  pages: PageDraft[];
  blobIds: string[];
  /** Empty when expansion is switched off. Per note rather than per page: the
   *  note is what a reader revises from, and a term introduced on page one is
   *  usually explained by page two. */
  expansions: Expansion[];
  /** Set when expansion was asked for and could not run. Surfaced rather than
   *  swallowed, so "no explanations" is never ambiguous. */
  expansionError: string | null;
  /** Sums on the page that do not add up. Checked in code, never corrected:
   *  the note records what was on the paper. */
  arithmetic: ArithmeticProblem[];
}

/** ADR 0003 and ADR 0004. Off unless supplied. */
export interface ExpansionOptions {
  /** A TEXT model, separate from the vision one. They run sequentially, so
   *  both fit on one card. */
  model: ModelFn;
  samples?: number;
  agreementThreshold?: number;
  maxTermsPerNote?: number;
  /** ADR 0004. Omit to expand with no network at all. */
  research?: ResearchOptions;
}

export interface CollectOptions extends TranscribeOptions {
  client: InkpipeClient;
  contentPrivateKey: Uint8Array;
  course: string;
  /** Which tidy-up passes to run. Omit for the defaults. */
  formatting?: Partial<FormatOptions>;
  /** Degrees clockwise. The real app derives this from the phone's orientation
   *  metadata; the slice takes it as a parameter. */
  rotate?: number;
  expansion?: ExpansionOptions;
  /** Cut hand-drawn diagrams out of each page. Off by default: it costs a
   *  second vision pass per page and most pages have no diagram. */
  detectDiagrams?: boolean;
  /** Called as each stage starts and finishes.
   *
   *  A page can take a minute and a note with expansion several, during which
   *  the old interface said nothing at all and was indistinguishable from a
   *  hang. Progress is not decoration here, it is the difference between
   *  waiting and restarting. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  stage: 'collect' | 'decrypt' | 'transcribe' | 'clean' | 'terms' | 'expand' | 'done';
  message: string;
  /** Which page, when the stage is per page. */
  page?: number;
  totalPages?: number;
}

/** "1 page", "2 pages". A status line that reads "1 page(s)" is a status line
 *  nobody proofread. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Group pending blobs into capture sessions (decision 9: one note per session). */
export function groupBySession(blobs: BlobMeta[]): Map<string, BlobMeta[]> {
  const sessions = new Map<string, BlobMeta[]>();
  for (const blob of blobs) {
    const existing = sessions.get(blob.sessionId);
    if (existing) existing.push(blob);
    else sessions.set(blob.sessionId, [blob]);
  }
  for (const pages of sessions.values()) pages.sort((a, b) => a.seq - b.seq);
  return sessions;
}

/**
 * Derive a note title from the transcript.
 *
 * A first-line heading is the best signal available without a second model
 * call. Always sanitised, because it is model output being used as a filename.
 */
export function suggestTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{1,3}\s+(.{2,80})$/);
    if (heading) return sanitizeSegment(heading[1], fallback);
    const plain = line.trim();
    if (plain.length >= 3 && plain.length <= 80 && !plain.startsWith('>')) {
      return sanitizeSegment(plain, fallback);
    }
  }
  return fallback;
}

/** Collect every pending session and build drafts. Acks nothing: blobs are only
 *  released after the note is safely written. */
export async function collectDrafts(options: CollectOptions): Promise<Draft[]> {
  const report = (event: ProgressEvent) => options.onProgress?.(event);

  report({ stage: 'collect', message: 'asking the server what is waiting' });
  const pending = await options.client.get<PendingBlobsResponse>('/blobs');
  const sessions = groupBySession(pending.blobs);
  const drafts: Draft[] = [];
  report({
    stage: 'collect',
    message: `${plural(pending.blobs.length, 'page')} in ${plural(sessions.size, 'session')}`,
  });

  for (const [sessionId, metas] of sessions) {
    const pages: PageDraft[] = [];

    for (const meta of metas) {
      report({
        stage: 'decrypt',
        message: 'downloading and decrypting',
        page: meta.seq + 1,
        totalPages: metas.length,
      });
      const downloaded = await options.client.get<{ ciphertext: string }>(`/blobs/${meta.blobId}`);
      const sealed = new Uint8Array(Buffer.from(downloaded.ciphertext, 'base64'));
      const original = open(sealed, options.contentPrivateKey);

      const forModel = await prepForModel(original, { rotate: options.rotate });
      const vaultImage = await prepForVault(original, { rotate: options.rotate });

      report({
        stage: 'transcribe',
        message: 'reading the handwriting, this is the slow part',
        page: meta.seq + 1,
        totalPages: metas.length,
      });
      const result = await transcribePage(forModel, options);
      report({
        stage: 'transcribe',
        message: result.ok
          ? `done with the "${result.variantUsed}" prompt`
          : 'every prompt variant produced degenerate output',
        page: meta.seq + 1,
        totalPages: metas.length,
      });

      // Format first, sanitise last. Security gets the final word: whatever the
      // formatter produces still has to pass the inerting pass before it can
      // reach the vault.
      const formatted = formatMarkdown(result.markdown, options.formatting);
      const inerted = inertMarkdown(formatted.text);

      pages.push({
        blobId: meta.blobId,
        seq: meta.seq,
        markdown: inerted.text,
        ok: result.ok,
        variantUsed: result.variantUsed,
        failureReason: result.ok
          ? null
          : `every prompt variant produced degenerate output: ${
              result.attempts.map((a) => `${a.variant} (${a.reasons.join('; ')})`).join(', ')
            }`,
        vaultImage,
        imageFilename: `${sessionId}-p${String(meta.seq).padStart(2, '0')}.webp`,
        sanitiserChanges: inerted.changes,
        formatterChanges: formatted.changes,
        cleanMarkdown: null,
        cleanReason: null,
        diagrams: await cropDiagrams(original, forModel, meta, sessionId, metas.length, options),
      });
    }

    await cleanPages(pages, options);

    const firstGood = pages.find((p) => p.ok);
    const { expansions, expansionError } = await expandDraft(pages, options);

    // Checked across the whole note, since a sum can be written on one page and
    // its answer on the next.
    const arithmetic = checkArithmetic(
      pages.filter((page) => page.ok).map((page) => page.markdown).join(`
`),
    );

    drafts.push({
      sessionId,
      suggestedTitle: firstGood
        ? suggestTitle(firstGood.markdown, 'Untitled note')
        : 'Untitled note',
      course: options.course,
      pages,
      blobIds: metas.map((m) => m.blobId),
      expansions,
      expansionError,
      arithmetic,
    });
  }

  report({ stage: 'done', message: `${drafts.length} note(s) ready to review` });
  return drafts;
}

/** Dimensions of an encoded image, or null when it cannot be read. */
async function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(bytes).metadata();
  return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
}

/**
 * Move a box from the prepared image frame into the original one.
 *
 * The model sees a downscaled copy, so its coordinates are in that frame. The
 * crop comes from the original so the diagram keeps the resolution the camera
 * captured. Clamped, because a rounding error at the edge is an exception from
 * sharp rather than a slightly wrong crop.
 */
async function scaleToOriginal(
  box: Diagram,
  prepared: { width: number; height: number },
  original: Uint8Array,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const size = await imageSize(original);
  if (!size) return null;

  const scaleX = size.width / prepared.width;
  const scaleY = size.height / prepared.height;

  const left = Math.max(0, Math.round(box.left * scaleX));
  const top = Math.max(0, Math.round(box.top * scaleY));
  const width = Math.min(Math.round(box.width * scaleX), size.width - left);
  const height = Math.min(Math.round(box.height * scaleY), size.height - top);

  return width > 16 && height > 16 ? { left, top, width, height } : null;
}

/**
 * Cut any hand-drawn diagrams out of a page.
 *
 * Opt in, because it costs a second vision pass per page and most pages have no
 * diagram on them. Never throws: the transcription has already succeeded and a
 * diagram pass falling over must not take the page with it.
 */
async function cropDiagrams(
  original: Uint8Array,
  prepared: Uint8Array,
  meta: BlobMeta,
  sessionId: string,
  totalPages: number,
  options: CollectOptions,
): Promise<PageDraft['diagrams']> {
  if (!options.detectDiagrams) return [];

  try {
    const size = await imageSize(prepared);
    if (!size) return [];

    options.onProgress?.({
      stage: 'transcribe',
      message: 'looking for diagrams to cut out',
      page: meta.seq + 1,
      totalPages,
    });

    // Detection runs on the PREPARED image because that is what the model
    // sees, so its coordinates are in that frame. The crop is taken from the
    // ORIGINAL, so the diagram keeps the resolution the camera captured
    // rather than the downscale the model needed.
    const found = await detectDiagrams(prepared, {
      model: options.model,
      imageWidth: size.width,
      imageHeight: size.height,
    });

    const out: PageDraft['diagrams'] = [];
    for (const [index, diagram] of found.entries()) {
      const scaled = await scaleToOriginal(diagram, size, original);
      if (!scaled) continue;
      out.push({
        filename: `${sessionId}-p${String(meta.seq).padStart(2, '0')}-d${index}.webp`,
        caption: diagram.caption,
        bytes: await cropRegion(original, scaled, { rotate: options.rotate }),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Tidy each transcribed page.
 *
 * Per page rather than per note, because the preview shows the photograph, the
 * raw transcript and the tidied version side by side, and those columns line up
 * page by page.
 *
 * Uses the expansion model, since that text model is already loaded. Cleaning
 * is therefore off when expansion is off, which is the right coupling: both
 * need the same model and neither is the safe default.
 *
 * Never throws. The raw transcript is the fallback for every failure, so the
 * worst outcome is the note this pipeline produced before cleaning existed.
 */
async function cleanPages(pages: PageDraft[], options: CollectOptions): Promise<void> {
  if (!options.expansion) return;

  for (const page of pages) {
    if (!page.ok || page.markdown.trim().length === 0) continue;
    options.onProgress?.({
      stage: 'clean',
      message: 'tidying the transcript',
      page: page.seq + 1,
      totalPages: pages.length,
    });
    const result = await cleanNotes(page.markdown, {
      course: options.course,
      glossary: options.glossary,
      model: options.expansion.model,
    });
    if (!result.cleaned) {
      page.cleanMarkdown = null;
      page.cleanReason = result.reason;
      continue;
    }

    // Completing an open list runs AFTER tidying and on the tidied text, so it
    // sees the final wording. It is a separate pass because inside the clean
    // prompt it never fired: "do not add new information" is the strongest
    // rule there and an exception underneath it loses every time.
    const completed = await completeOpenLists(result.markdown, {
      course: options.course,
      model: options.expansion.model,
    });
    page.cleanMarkdown = completed.markdown;
    page.cleanReason = null;
  }
}

/**
 * Expand the terms on a note, when expansion is configured.
 *
 * Never throws. A model that falls over during expansion must not cost the user
 * a transcribed page: the draft survives with the failure recorded on it, and
 * the preview says why there are no explanations.
 */
async function expandDraft(
  pages: PageDraft[],
  options: CollectOptions,
): Promise<{ expansions: Expansion[]; expansionError: string | null }> {
  if (!options.expansion) return { expansions: [], expansionError: null };

  // Failed pages are excluded. Degenerate output is exactly the material that
  // would produce nonsense terms and waste a search query on each.
  const usable = pages.filter((p) => p.ok && p.markdown.trim().length > 0);
  if (usable.length === 0) return { expansions: [], expansionError: null };

  const { model, samples, agreementThreshold, maxTermsPerNote, research } = options.expansion;
  const perPage = maxTermsPerNote ?? 12;

  // PER PAGE, not per note.
  //
  // The cap used to apply to the whole session, so a three page note spent
  // every term on page one and the later pages were never looked up at all.
  // The owner noticed exactly that: "it only does google searches for a single
  // page". The cap is what bounds the work, so applying it per page is also
  // what makes the second and third page get any attention.
  //
  // Each page is expanded against ITS OWN transcript, so the contradiction gate
  // judges an explanation against the page it came from rather than against
  // four pages of unrelated material.
  const all: Expansion[] = [];
  const seen = new Set<string>();

  try {
    for (const page of usable) {
      const notes = page.markdown;
      options.onProgress?.({
        stage: 'terms',
        message: 'choosing terms worth looking up',
        page: page.seq + 1,
        totalPages: usable.length,
      });

      const terms = (await extractTerms({
        notes,
        course: options.course,
        model,
        limit: perPage,
        // A term explained on page one does not need explaining again on page
        // three, and looking it up twice spends a query for nothing.
      })).filter((term) => !seen.has(term.toLowerCase()));

      if (terms.length === 0) continue;
      for (const term of terms) seen.add(term.toLowerCase());

      options.onProgress?.({
        stage: 'expand',
        message: `checking ${terms.length} term(s): ${terms.join(', ')}`,
        page: page.seq + 1,
        totalPages: usable.length,
      });

      all.push(...await expandTerms(terms, {
        notes,
        course: options.course,
        model,
        samples,
        agreementThreshold,
        research,
      }));
    }
    return { expansions: all, expansionError: null };
  } catch (error) {
    // Whatever was finished is kept. Losing four pages of work because page
    // five timed out would be its own bug.
    return { expansions: all, expansionError: (error as Error).message };
  }
}

/**
 * Render a draft as the final note body.
 *
 * A failed page still appears, with its image and an explicit warning, because
 * silently dropping a page would mean losing notes without telling anyone.
 */
export function renderNote(draft: Draft, attachmentsPath: string): string {
  const lines: string[] = [
    '---',
    `title: ${JSON.stringify(draft.suggestedTitle)}`,
    `course: ${JSON.stringify(draft.course)}`,
    `source: inkpipe`,
    `session: ${draft.sessionId}`,
    '---',
    '',
    `# ${draft.suggestedTitle}`,
    '',
  ];

  const flags = renderArithmeticFlags(draft.arithmetic ?? []);
  if (flags) lines.push(flags);

  for (const page of draft.pages) {
    if (draft.pages.length > 1) {
      lines.push(`## Page ${page.seq + 1}`, '');
    }

    if (page.ok) {
      // The tidied version is the body, because a note you will actually reuse
      // is the point. The raw transcript stays underneath in a collapsed block:
      // it is the record of what was on the paper, and dropping it would make
      // the flags above unverifiable.
      if (page.cleanMarkdown) {
        lines.push(page.cleanMarkdown, '');
        lines.push(
          '> [!quote]- As written on the page',
          ...page.markdown.split('\n').map((line) => `> ${line}`),
          '',
        );
      } else {
        lines.push(page.markdown, '');
        if (page.cleanReason) {
          lines.push(`> [!info] Left as written: ${page.cleanReason}`, '');
        }
      }
    } else {
      lines.push(
        '> [!warning] This page could not be transcribed',
        '> The local model produced degenerate output on every attempt.',
        '> The original photograph is below, so nothing is lost.',
        '',
      );
    }

    if (page.sanitiserChanges.length > 0) {
      lines.push(
        '> [!info] inkpipe altered this page for safety',
        ...page.sanitiserChanges.map((c) => `> - ${c}`),
        '',
      );
    }

    // Diagram crops come BEFORE the full page image. They are the part worth
    // looking at, and burying them under the whole photograph would mean
    // scrolling past the thing that was cut out in order to find it.
    for (const diagram of page.diagrams ?? []) {
      lines.push(`![[${attachmentsPath}/${diagram.filename}]]`, `*${diagram.caption}*`, '');
    }

    lines.push(`![[${attachmentsPath}/${page.imageFilename}]]`, '');
  }

  // Explanations go last, after every page and image, because they are the part
  // the student did not write and should read as commentary on the note rather
  // than as part of it.
  // Tolerant of an absent list: this renders into the vault, and a crash here
  // would lose a whole note over a field that carries no meaning of its own.
  if ((draft.expansions ?? []).length > 0) {
    lines.push(renderExpansions(draft.expansions));
  } else if (draft.expansionError) {
    lines.push(
      '> [!info] Explanations were not generated',
      `> ${draft.expansionError}`,
      '',
    );
  }

  return lines.join('\n');
}
