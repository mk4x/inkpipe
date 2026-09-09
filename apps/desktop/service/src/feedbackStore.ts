// Where feedback is kept.
//
// Issue #8. One JSON file beside the config, holding one record per page the
// user has approved. It is small: a record is a hash, a verdict and a handful
// of words, so a year of daily use is a few hundred kilobytes.
//
// Local only, and it never leaves the machine. The whole point of the project
// is that pages stay on the owner's hardware, and a feedback file that phoned
// home would be a strange exception to that.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { defaultConfigPath } from './config.ts';
import type { FeedbackRecord } from '../../../agent/src/feedback.ts';

const StoredFeedback = z.object({
  version: z.literal(1),
  records: z.array(z.object({
    imageHash: z.string(),
    sessionId: z.string(),
    seq: z.number().int(),
    course: z.string(),
    verdict: z.enum(['good', 'bad']),
    corrections: z.array(z.string()),
    corpusCandidate: z.boolean(),
    at: z.string(),
  })).default([]),
});

/** Enough to keep a semester of pages. Oldest are dropped first. */
const MAX_RECORDS = 2000;

export function defaultFeedbackPath(): string {
  return join(dirname(defaultConfigPath()), 'feedback.json');
}

export function loadFeedback(path = defaultFeedbackPath()): FeedbackRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = StoredFeedback.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data.records : [];
  } catch {
    // Losing feedback costs future prompt quality, never a note. Starting over
    // is the right response and must not stop an approval going through.
    return [];
  }
}

/**
 * Add a record, replacing any earlier one for the same image.
 *
 * Replacing matters: a page can be re-reviewed after a model change, and two
 * contradictory records for one image would make the corpus shortlist lie.
 */
export function appendFeedback(record: FeedbackRecord, path = defaultFeedbackPath()): void {
  const kept = loadFeedback(path).filter((r) => r.imageHash !== record.imageHash);
  kept.push(record);

  const records = kept.length > MAX_RECORDS ? kept.slice(kept.length - MAX_RECORDS) : kept;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf8');
}
