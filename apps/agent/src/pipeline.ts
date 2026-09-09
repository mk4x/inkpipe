// The desktop pipeline: collect, decrypt, transcribe, and build a draft note.
//
// Deliberately stops before writing. It returns a Draft, which the preview
// screen renders and the user edits (decision 21). Only an explicit approval
// calls into vault.writeNote. CLAUDE.md rule 7: nothing reaches the vault
// without a human.

import { open } from '@inkpipe/crypto';
import { prepForModel, prepForVault } from '@inkpipe/imaging';
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
  const pending = await options.client.get<PendingBlobsResponse>('/blobs');
  const sessions = groupBySession(pending.blobs);
  const drafts: Draft[] = [];

  for (const [sessionId, metas] of sessions) {
    const pages: PageDraft[] = [];

    for (const meta of metas) {
      const downloaded = await options.client.get<{ ciphertext: string }>(`/blobs/${meta.blobId}`);
      const sealed = new Uint8Array(Buffer.from(downloaded.ciphertext, 'base64'));
      const original = open(sealed, options.contentPrivateKey);

      const forModel = await prepForModel(original, { rotate: options.rotate });
      const vaultImage = await prepForVault(original, { rotate: options.rotate });

      const result = await transcribePage(forModel, options);

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
      });
    }

    const firstGood = pages.find((p) => p.ok);
    const { expansions, expansionError } = await expandDraft(pages, options);

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
    });
  }

  return drafts;
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
  const notes = pages.filter((p) => p.ok).map((p) => p.markdown).join('\n\n').trim();
  if (notes.length === 0) return { expansions: [], expansionError: null };

  const { model, samples, agreementThreshold, maxTermsPerNote, research } = options.expansion;

  try {
    const terms = await extractTerms({
      notes,
      course: options.course,
      model,
      limit: maxTermsPerNote ?? 12,
    });
    if (terms.length === 0) return { expansions: [], expansionError: null };

    const expansions = await expandTerms(terms, {
      notes,
      course: options.course,
      model,
      samples,
      agreementThreshold,
      research,
    });
    return { expansions, expansionError: null };
  } catch (error) {
    return { expansions: [], expansionError: (error as Error).message };
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

  for (const page of draft.pages) {
    if (draft.pages.length > 1) {
      lines.push(`## Page ${page.seq + 1}`, '');
    }

    if (page.ok) {
      lines.push(page.markdown, '');
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
