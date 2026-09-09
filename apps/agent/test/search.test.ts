// The boundary tests.
//
// search.ts is the only module in the project that sends anything anywhere the
// user did not point it at, so its guards are asserted rather than trusted.
// Nothing here touches the network: the fetcher is injected everywhere.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery, cacheKey, lookup, memoryCache, dailyBudget,
  googleProvider, providerFromConfig, SearchError,
  MAX_TERM_LENGTH,
  type SearchProvider, type SearchResult,
} from '../src/search.ts';

/** A fetch that records what it was asked for and answers from a script. */
function fakeFetch(body: unknown, status = 200) {
  const calls: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const RESULT: SearchResult = {
  title: 'Leftist tree',
  url: 'https://en.wikipedia.org/wiki/Leftist_tree',
  snippet: 'The rank of a node is the distance to the nearest leaf.',
};

/** A provider that counts calls, for the cache and budget tests. */
function countingProvider(results: SearchResult[] = [RESULT]) {
  const calls: string[] = [];
  const provider: SearchProvider = {
    name: 'fake',
    async search(query) {
      calls.push(query);
      return results;
    },
  };
  return { provider, calls };
}

describe('buildQuery, the leak boundary', () => {
  test('a plain term becomes the query', () => {
    assert.equal(buildQuery('Kleene star'), 'Kleene star');
  });

  test('the course is appended, because terms are ambiguous across courses', () => {
    // "rank" means one thing in linear algebra and another in a leftist heap.
    assert.equal(buildQuery('rank', 'Algorithms'), 'rank Algorithms');
  });

  test('a multiline term is refused outright', () => {
    // The guard that matters. A term arrives from model output, and a model
    // handing back a paragraph instead of a term must not become a query.
    assert.throws(
      () => buildQuery('Kleene star\nand also the pumping lemma'),
      (error: SearchError) => error.code === 'term_not_a_term',
    );
  });

  test('a whole transcript passed as a term throws rather than searching', () => {
    const transcript = [
      '# Formal Languages',
      '- sigma is the alphabet',
      '- L is a subset of sigma star',
      '- epsilon is the empty word',
    ].join('\n');

    assert.throws(() => buildQuery(transcript), SearchError);
  });

  test('a single line longer than a term is refused', () => {
    const long = 'a'.repeat(MAX_TERM_LENGTH + 1);
    assert.throws(
      () => buildQuery(long),
      (error: SearchError) => error.code === 'term_too_long',
    );
  });

  test('a term of exactly the maximum length is allowed', () => {
    // Off by one in the strict direction would silently disable expansion for
    // long but legitimate terms, so the boundary is pinned.
    const exact = 'a'.repeat(MAX_TERM_LENGTH);
    assert.equal(buildQuery(exact), exact);
  });

  test('an empty or whitespace term is refused', () => {
    assert.throws(() => buildQuery(''), (e: SearchError) => e.code === 'empty_term');
    assert.throws(() => buildQuery('   '), (e: SearchError) => e.code === 'empty_term');
  });

  test('control characters are stripped rather than sent', () => {
    const query = buildQuery('Kleene \u0007 \u001b star');
    assert.equal(query, 'Kleene star');
  });

  test('the query is capped even after the course is appended', () => {
    const term = 'a'.repeat(MAX_TERM_LENGTH);
    const course = 'b'.repeat(MAX_TERM_LENGTH);
    assert.ok(buildQuery(term, course).length <= 200);
  });
});

describe('cacheKey', () => {
  test('case and spacing do not cost a second query', () => {
    assert.equal(cacheKey('Kleene  Star'), cacheKey('kleene star'));
  });

  test('the same term in two courses is looked up separately', () => {
    assert.notEqual(cacheKey('rank', 'Algorithms'), cacheKey('rank', 'Linear Algebra'));
  });
});

describe('the google provider', () => {
  test('sends the query, the key and the search engine id', async () => {
    const { fetcher, calls } = fakeFetch({
      items: [{ title: 'T', link: 'https://example.org/a', snippet: 'S' }],
    });
    const provider = googleProvider({ apiKey: 'KEY', cx: 'CX', fetch: fetcher });
    const results = await provider.search('Kleene star', 5);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin + calls[0].pathname, 'https://www.googleapis.com/customsearch/v1');
    assert.equal(calls[0].searchParams.get('q'), 'Kleene star');
    assert.equal(calls[0].searchParams.get('key'), 'KEY');
    assert.equal(calls[0].searchParams.get('cx'), 'CX');
    assert.deepEqual(results, [{ title: 'T', url: 'https://example.org/a', snippet: 'S' }]);
  });

  test('num is clamped to the range the API accepts', async () => {
    const { fetcher, calls } = fakeFetch({ items: [] });
    await googleProvider({ apiKey: 'K', cx: 'C', fetch: fetcher }).search('q', 50);
    assert.equal(calls[0].searchParams.get('num'), '10');
  });

  test('a result with no snippet is dropped, since the snippet is all we read', async () => {
    const { fetcher } = fakeFetch({
      items: [
        { title: 'A', link: 'https://example.org/a', snippet: '' },
        { title: 'B', link: 'https://example.org/b', snippet: 'real' },
      ],
    });
    const results = await googleProvider({ apiKey: 'K', cx: 'C', fetch: fetcher }).search('q', 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'B');
  });

  test('an empty response is not an error', async () => {
    const { fetcher } = fakeFetch({});
    const results = await googleProvider({ apiKey: 'K', cx: 'C', fetch: fetcher }).search('q', 5);
    assert.deepEqual(results, []);
  });

  test('a spent quota is reported as its own code, not a generic failure', async () => {
    const { fetcher } = fakeFetch({}, 429);
    await assert.rejects(
      googleProvider({ apiKey: 'K', cx: 'C', fetch: fetcher }).search('q', 5),
      (e: SearchError) => e.code === 'rate_limited',
    );
  });

  test('a bad key is reported as a bad key, so setup can be fixed', async () => {
    const { fetcher } = fakeFetch({}, 403);
    await assert.rejects(
      googleProvider({ apiKey: 'bad', cx: 'C', fetch: fetcher }).search('q', 5),
      (e: SearchError) => e.code === 'forbidden',
    );
  });

  test('being offline is a SearchError, not a raw network throw', async () => {
    const fetcher = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await assert.rejects(
      googleProvider({ apiKey: 'K', cx: 'C', fetch: fetcher }).search('q', 5),
      (e: SearchError) => e.code === 'unreachable',
    );
  });
});

describe('providerFromConfig', () => {
  test('missing credentials fail loudly rather than silently doing nothing', () => {
    assert.throws(
      () => providerFromConfig({ provider: 'google', apiKey: 'K' }),
      (e: SearchError) => e.code === 'not_configured',
    );
    assert.throws(
      () => providerFromConfig({ provider: 'google', cx: 'C' }),
      (e: SearchError) => e.code === 'not_configured',
    );
  });

  test('an unknown provider is rejected', () => {
    assert.throws(
      () => providerFromConfig({ provider: 'yahoo' as 'google', apiKey: 'K', cx: 'C' }),
      (e: SearchError) => e.code === 'unknown_provider',
    );
  });
});

describe('lookup: cache and budget', () => {
  test('a cached term costs no query', async () => {
    const { provider, calls } = countingProvider();
    const cache = memoryCache();

    const first = await lookup('Kleene star', { provider, cache });
    const second = await lookup('kleene  STAR', { provider, cache });

    assert.equal(calls.length, 1, 'the second lookup must not reach the provider');
    assert.equal(first.fromCache, false);
    assert.equal(second.fromCache, true);
    assert.deepEqual(second.results, first.results);
  });

  test('an expired entry is fetched again', async () => {
    const { provider, calls } = countingProvider();
    const cache = memoryCache();
    let clock = 1_000;

    await lookup('AST', { provider, cache, maxAgeMs: 100, now: () => clock });
    clock += 500;
    await lookup('AST', { provider, cache, maxAgeMs: 100, now: () => clock });

    assert.equal(calls.length, 2);
  });

  test('maxAgeMs of zero means never expire', async () => {
    const { provider, calls } = countingProvider();
    const cache = memoryCache();
    let clock = 1_000;

    await lookup('AST', { provider, cache, maxAgeMs: 0, now: () => clock });
    clock += 10_000_000;
    const again = await lookup('AST', { provider, cache, maxAgeMs: 0, now: () => clock });

    assert.equal(calls.length, 1);
    assert.equal(again.fromCache, true);
  });

  test('the daily budget stops queries and says so, rather than degrading silently', async () => {
    const { provider, calls } = countingProvider();
    const budget = dailyBudget(2);

    await lookup('a', { provider, budget });
    await lookup('b', { provider, budget });
    const third = await lookup('c', { provider, budget });

    assert.equal(calls.length, 2, 'the third lookup must not reach the provider');
    assert.deepEqual(third.results, []);
    assert.match(third.reason ?? '', /budget/);
  });

  test('a cached term is served even when the budget is spent', async () => {
    // Otherwise a full cache becomes useless the moment the quota runs out,
    // which is exactly when it is most valuable.
    const { provider } = countingProvider();
    const cache = memoryCache();
    const budget = dailyBudget(1);

    await lookup('AST', { provider, cache, budget });
    const again = await lookup('AST', { provider, cache, budget });

    assert.equal(again.fromCache, true);
    assert.equal(again.reason, null);
    assert.equal(again.results.length, 1);
  });

  test('the budget resets on a new day', () => {
    let day = '2026-09-09T10:00:00.000Z';
    const budget = dailyBudget(1, undefined, () => new Date(day));

    budget.spend();
    assert.equal(budget.remaining(), 0);

    day = '2026-09-10T10:00:00.000Z';
    assert.equal(budget.remaining(), 1);
  });

  test('a malformed term throws even when the budget is spent', async () => {
    // The guard is about what may leave the machine, so it must not be
    // reachable only on the paths that happen to have quota left.
    const { provider } = countingProvider();
    const budget = dailyBudget(0);
    await assert.rejects(
      lookup('line one\nline two', { provider, budget }),
      SearchError,
    );
  });

  test('a provider failure becomes a reason, never a thrown error', async () => {
    // Being offline must not lose the note. It degrades to "not verified".
    const provider: SearchProvider = {
      name: 'fake',
      async search() { throw new SearchError('unreachable', 'could not reach google'); },
    };
    const result = await lookup('AST', { provider });

    assert.deepEqual(result.results, []);
    assert.match(result.reason ?? '', /could not reach/);
  });

  test('a failed query is not cached, so it retries when the network returns', async () => {
    let fail = true;
    const provider: SearchProvider = {
      name: 'fake',
      async search() {
        if (fail) throw new SearchError('unreachable', 'offline');
        return [RESULT];
      },
    };
    const cache = memoryCache();

    await lookup('AST', { provider, cache });
    fail = false;
    const second = await lookup('AST', { provider, cache });

    assert.equal(second.results.length, 1);
    assert.equal(second.reason, null);
  });
});
