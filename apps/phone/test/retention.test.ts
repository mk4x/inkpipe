import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPrune, bytesUsed, shouldWarn, DEFAULT_RETENTION,
  type CaptureRecord,
} from '../src/retention.ts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const capture = (over: Partial<CaptureRecord> = {}): CaptureRecord => ({
  blobId: `blob-${Math.random().toString(36).slice(2)}`,
  bytes: 1024,
  capturedAt: daysAgo(1),
  state: 'uploaded',
  ...over,
});

describe('planPrune, age', () => {
  test('keeps a recent uploaded capture', () => {
    const { keep, remove } = planPrune([capture({ capturedAt: daysAgo(10) })], NOW);
    assert.equal(keep.length, 1);
    assert.equal(remove.length, 0);
  });

  test('removes an uploaded capture past the retention window', () => {
    const { keep, remove } = planPrune([capture({ capturedAt: daysAgo(91) })], NOW);
    assert.equal(keep.length, 0);
    assert.equal(remove.length, 1);
  });

  test('keeps one exactly at the boundary', () => {
    const { remove } = planPrune([capture({ capturedAt: daysAgo(89) })], NOW);
    assert.equal(remove.length, 0);
  });
});

describe('planPrune, the invariant that matters', () => {
  test('NEVER removes a pending capture, however old', () => {
    // It is the only copy of that page anywhere. Evicting it to save space
    // would silently lose the user's notes.
    const { keep, remove } = planPrune(
      [capture({ capturedAt: daysAgo(9999), state: 'pending' })],
      NOW,
    );
    assert.equal(keep.length, 1, 'a pending capture must survive any age');
    assert.equal(remove.length, 0);
  });

  test('NEVER removes a failed capture, because it will be retried', () => {
    const { keep, remove } = planPrune(
      [capture({ capturedAt: daysAgo(9999), state: 'failed' })],
      NOW,
    );
    assert.equal(keep.length, 1);
    assert.equal(remove.length, 0);
  });

  test('exceeds the size limit rather than dropping pending captures', () => {
    // Three gigabytes of pending work against a two gigabyte limit. The right
    // answer is to blow the limit and warn, not to delete pages.
    const huge = Array.from({ length: 3 }, (_, i) =>
      capture({ bytes: 1024 ** 3, state: 'pending', capturedAt: daysAgo(i) }));

    const { keep, remove } = planPrune(huge, NOW);
    assert.equal(keep.length, 3, 'all pending captures must survive');
    assert.equal(remove.length, 0);
    assert.ok(bytesUsed(keep) > DEFAULT_RETENTION.bytes, 'the limit is deliberately exceeded');
  });
});

describe('planPrune, size', () => {
  test('evicts the oldest uploaded captures when over the limit', () => {
    const big = 700 * 1024 * 1024;
    const captures = [
      capture({ blobId: 'oldest', bytes: big, capturedAt: daysAgo(5) }),
      capture({ blobId: 'middle', bytes: big, capturedAt: daysAgo(3) }),
      capture({ blobId: 'newest', bytes: big, capturedAt: daysAgo(1) }),
      capture({ blobId: 'newer', bytes: big, capturedAt: daysAgo(0) }),
    ];

    const { keep, remove } = planPrune(captures, NOW);
    assert.ok(remove.some((c) => c.blobId === 'oldest'), 'oldest must go first');
    assert.ok(keep.some((c) => c.blobId === 'newer'), 'newest must survive');
    assert.ok(bytesUsed(keep) <= DEFAULT_RETENTION.bytes);
  });

  test('mixed pending and uploaded evicts only the uploaded ones', () => {
    const big = 800 * 1024 * 1024;
    const captures = [
      capture({ blobId: 'old-uploaded', bytes: big, capturedAt: daysAgo(5), state: 'uploaded' }),
      capture({ blobId: 'old-pending', bytes: big, capturedAt: daysAgo(4), state: 'pending' }),
      capture({ blobId: 'new-uploaded', bytes: big, capturedAt: daysAgo(1), state: 'uploaded' }),
    ];

    const { keep, remove } = planPrune(captures, NOW);
    assert.ok(keep.some((c) => c.blobId === 'old-pending'), 'pending survives regardless');
    assert.equal(remove.every((c) => c.state === 'uploaded'), true);
  });

  test('returns keep in chronological order, so the queue reads naturally', () => {
    const captures = [
      capture({ blobId: 'c', capturedAt: daysAgo(1) }),
      capture({ blobId: 'a', capturedAt: daysAgo(3) }),
      capture({ blobId: 'b', capturedAt: daysAgo(2) }),
    ];
    assert.deepEqual(planPrune(captures, NOW).keep.map((c) => c.blobId), ['a', 'b', 'c']);
  });
});

describe('planPrune, edges', () => {
  test('handles an empty store', () => {
    const { keep, remove } = planPrune([], NOW);
    assert.deepEqual(keep, []);
    assert.deepEqual(remove, []);
  });

  test('never loses a capture: keep plus remove equals the input', () => {
    const captures = [
      capture({ capturedAt: daysAgo(200), state: 'uploaded' }),
      capture({ capturedAt: daysAgo(1), state: 'pending' }),
      capture({ capturedAt: daysAgo(95), state: 'failed' }),
      capture({ bytes: 1024 ** 3 * 3, capturedAt: daysAgo(2), state: 'uploaded' }),
    ];
    const { keep, remove } = planPrune(captures, NOW);
    assert.equal(keep.length + remove.length, captures.length, 'a capture went missing');
    const ids = new Set([...keep, ...remove].map((c) => c.blobId));
    assert.equal(ids.size, captures.length, 'a capture was duplicated');
  });

  test('is idempotent: pruning twice changes nothing the second time', () => {
    const captures = Array.from({ length: 10 }, (_, i) =>
      capture({ bytes: 300 * 1024 * 1024, capturedAt: daysAgo(i) }));
    const first = planPrune(captures, NOW);
    const second = planPrune(first.keep, NOW);
    assert.equal(second.remove.length, 0, `second pass removed ${second.remove.length} more`);
  });
});

describe('warning threshold', () => {
  test('warns above 80 percent of the limit', () => {
    const at85 = [capture({ bytes: Math.floor(DEFAULT_RETENTION.bytes * 0.85) })];
    assert.equal(shouldWarn(at85), true);
  });

  test('stays quiet below the threshold', () => {
    const at50 = [capture({ bytes: Math.floor(DEFAULT_RETENTION.bytes * 0.5) })];
    assert.equal(shouldWarn(at50), false);
  });
});
