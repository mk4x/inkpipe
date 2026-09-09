// Retention policy for the phone's local backup (decision 15).
//
// Pure on purpose: no Expo, no filesystem, no clock. The rules here decide
// whether a page the desktop has never seen gets deleted, so they need real
// tests, and a function that reaches for FileSystem cannot have them.

export type CaptureState = 'pending' | 'uploaded' | 'failed';

export interface CaptureRecord {
  blobId: string;
  bytes: number;
  capturedAt: string;
  state: CaptureState;
}

export interface RetentionLimits {
  days: number;
  bytes: number;
}

export const DEFAULT_RETENTION: RetentionLimits = {
  days: 90,
  bytes: 2 * 1024 * 1024 * 1024,
};

export interface PrunePlan<T extends CaptureRecord> {
  keep: T[];
  remove: T[];
}

/**
 * Decide what to evict.
 *
 * The invariant that matters more than any limit: **a capture that has not been
 * uploaded is never removed.** It is the only copy of that page in existence,
 * so evicting it to save space would silently lose the user's notes. A phone
 * full of pending pages is a problem to surface, not to solve by deleting them.
 *
 * `failed` counts as not uploaded, because a failed upload will be retried.
 */
export function planPrune<T extends CaptureRecord>(
  captures: T[],
  now: Date,
  limits: RetentionLimits = DEFAULT_RETENTION,
): PrunePlan<T> {
  const cutoff = now.getTime() - limits.days * 86_400_000;
  const keep: T[] = [];
  const remove: T[] = [];

  // Age first.
  for (const capture of captures) {
    const expired = Date.parse(capture.capturedAt) < cutoff;
    if (expired && capture.state === 'uploaded') remove.push(capture);
    else keep.push(capture);
  }

  // Then size, evicting oldest uploaded first so recent work survives.
  const newestFirst = [...keep].sort(
    (a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt),
  );

  let total = 0;
  const survivors: T[] = [];
  for (const capture of newestFirst) {
    if (total + capture.bytes > limits.bytes && capture.state === 'uploaded') {
      remove.push(capture);
      continue;
    }
    // A pending capture is counted but never dropped, so the total can exceed
    // the limit. That is deliberate: the alternative is losing a page.
    total += capture.bytes;
    survivors.push(capture);
  }

  survivors.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  return { keep: survivors, remove };
}

/** Bytes currently held, for the warning the capture screen shows. */
export function bytesUsed(captures: CaptureRecord[]): number {
  return captures.reduce((total, c) => total + c.bytes, 0);
}

/** True once the user should be warned, at 80 percent of the limit. */
export function shouldWarn(captures: CaptureRecord[], limits = DEFAULT_RETENTION): boolean {
  return bytesUsed(captures) > limits.bytes * 0.8;
}
