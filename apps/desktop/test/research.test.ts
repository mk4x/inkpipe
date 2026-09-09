// The parts of ADR 0004 that live in the desktop service: where the API key is
// kept, and how the cache and the daily budget survive a restart.
//
// The cache is not a performance detail. Google's free tier is 100 queries a
// day and a semester of notes repeats terms heavily, so a cache that forgets
// everything on restart is the difference between the free tier working and
// not. It is asserted across separate store instances for that reason.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, saveSecrets, setSearchApiKey, setSearxngToken, hasSearchApiKey } from '../service/src/secrets.ts';
import { fileResearchStore, researchBlocker, buildResearch } from '../service/src/research.ts';
import { Config } from '../service/src/config.ts';
import type { SearchProvider, SearchResult } from '../../agent/src/search.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'inkpipe-research-'));
}

/** A config with research switched on, built through the schema so defaults
 *  are the real ones rather than a hand-written guess. */
function configWith(research: Record<string, unknown> = {}) {
  return Config.parse({
    version: 1,
    serverUrl: 'https://inkpipe.example.com',
    deviceId: '00000000-0000-4000-8000-000000000000',
    vault: { root: 'C:/vault', notesPath: 'Notes' },
    // Explicit, because the shipped default is searxng. These tests predate
    // that and are about the google path.
    research: { enabled: true, provider: 'google', cx: 'CX', ...research },
  });
}

/** The shipped default: a self-hosted instance behind a token. */
function searxngConfig(research: Record<string, unknown> = {}) {
  return configWith({ provider: 'searxng', host: 'https://inkpipe.example.com/searx/', ...research });
}

const RESULT: SearchResult = {
  title: 'Leftist tree',
  url: 'https://en.wikipedia.org/wiki/Leftist_tree',
  snippet: 'Rank is the length of the shortest path to a leaf.',
};

function countingProvider() {
  const calls: string[] = [];
  const provider: SearchProvider = {
    name: 'fake',
    async search(query) {
      calls.push(query);
      return [RESULT];
    },
  };
  return { provider, calls };
}

describe('the secrets file', () => {
  test('a saved key comes back', () => {
    const dir = scratch();
    const path = join(dir, 'secrets.json');
    try {
      setSearchApiKey('AIza-not-a-real-key', path);
      assert.equal(loadSecrets(path).searchApiKey, 'AIza-not-a-real-key');
      assert.equal(hasSearchApiKey(path), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing file is empty rather than an error', () => {
    // Research is optional. No key means research stays off, never that the
    // whole service refuses to start.
    const dir = scratch();
    try {
      const path = join(dir, 'nothing.json');
      assert.equal(loadSecrets(path).searchApiKey, '');
      assert.equal(hasSearchApiKey(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt file is empty rather than an error', () => {
    const dir = scratch();
    const path = join(dir, 'secrets.json');
    try {
      writeFileSync(path, 'not json at all');
      assert.equal(loadSecrets(path).searchApiKey, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the key is trimmed, since it arrives pasted', () => {
    const dir = scratch();
    const path = join(dir, 'secrets.json');
    try {
      setSearchApiKey('  key-with-spaces  ', path);
      assert.equal(loadSecrets(path).searchApiKey, 'key-with-spaces');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the key is not written into the config file', () => {
    // The reason this module exists. config.json holds vault paths and course
    // names and is the file people paste into an issue when asking for help.
    const dir = scratch();
    const path = join(dir, 'secrets.json');
    try {
      saveSecrets({ version: 1, searchApiKey: 'SECRET-VALUE' }, path);
      const written = readFileSync(path, 'utf8');
      assert.ok(written.includes('SECRET-VALUE'));

      const config = JSON.stringify(configWith());
      assert.ok(!config.includes('SECRET-VALUE'), 'no key anywhere in the config');
      assert.ok(!config.includes('apiKey'), 'the config schema has no key field at all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the research store', () => {
  test('a cached term survives a restart', () => {
    const dir = scratch();
    const path = join(dir, 'research.json');
    try {
      fileResearchStore(100, path).cache.set('k', { results: [RESULT], storedAt: 1000 });

      // A second store, as if the service had been restarted.
      const reopened = fileResearchStore(100, path);
      assert.deepEqual(reopened.cache.get('k')?.results, [RESULT]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('spent queries survive a restart, so the budget cannot be reset by relaunching', () => {
    const dir = scratch();
    const path = join(dir, 'research.json');
    try {
      const store = fileResearchStore(3, path);
      store.budget.spend();
      store.budget.spend();

      assert.equal(fileResearchStore(3, path).remaining(), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the budget resets on a new day', () => {
    const dir = scratch();
    const path = join(dir, 'research.json');
    let day = '2026-09-09T08:00:00.000Z';
    try {
      const store = fileResearchStore(2, path, () => new Date(day));
      store.budget.spend();
      store.budget.spend();
      assert.equal(store.remaining(), 0);

      day = '2026-09-10T08:00:00.000Z';
      assert.equal(store.remaining(), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt store costs queries, never correctness', () => {
    const dir = scratch();
    const path = join(dir, 'research.json');
    try {
      writeFileSync(path, '{ this is not valid json');
      const store = fileResearchStore(100, path);
      assert.equal(store.cache.get('anything'), undefined);
      assert.equal(store.remaining(), 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing file is a cold cache, not a crash', () => {
    const dir = scratch();
    try {
      const store = fileResearchStore(100, join(dir, 'nested', 'research.json'));
      assert.equal(store.cache.get('k'), undefined);
      assert.equal(store.remaining(), 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('researchBlocker', () => {
  test('says research is off when it is off', () => {
    assert.match(researchBlocker(configWith({ enabled: false })) ?? '', /switched off/);
  });

  test('says which piece is missing, so setup can point at the step', () => {
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    try {
      assert.match(researchBlocker(configWith({ cx: '' }), secrets) ?? '', /Search Engine id/);

      // Engine id present, key missing.
      assert.match(researchBlocker(configWith(), secrets) ?? '', /API key/);

      setSearchApiKey('k', secrets);
      assert.equal(researchBlocker(configWith(), secrets), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the searxng provider, which is the shipped default', () => {
  test('a remote instance without a token is refused, not quietly published', () => {
    // An instance on a public hostname with no token is an open search proxy
    // for anyone who finds it, and it would be abused within days.
    const dir = scratch();
    try {
      const blocker = researchBlocker(searxngConfig(), join(dir, 'none.json'));
      assert.match(blocker ?? '', /token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a loopback instance needs no token', () => {
    const dir = scratch();
    try {
      const config = searxngConfig({ host: 'http://127.0.0.1:8888' });
      assert.equal(researchBlocker(config, join(dir, 'none.json')), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a token plus a remote instance is complete', () => {
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    try {
      setSearxngToken('t0ken', secrets);
      assert.equal(researchBlocker(searxngConfig(), secrets), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing host says so', () => {
    assert.match(researchBlocker(searxngConfig({ host: '' })) ?? '', /instance URL/);
  });

  test('the course qualifies the query, so bare terms are searchable', async () => {
    // Measured on corpus page F: without this, "Epsilon" searched alone
    // returns the Greek letter and brand names, and four of six terms found no
    // relevant source, downgrading correct explanations for nothing.
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    try {
      setSearxngToken('t0ken', secrets);
      const { provider, calls } = countingProvider();
      const built = buildResearch(searxngConfig(), {
        secretsPath: secrets, researchPath: join(dir, 'research.json'), provider,
      });

      await built!.lookup('Epsilon', 'Formal Languages');

      assert.deepEqual(calls, ['Epsilon Formal Languages']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same term in two courses is looked up separately', async () => {
    // Otherwise the cache would serve linear algebra results for a heap.
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    try {
      setSearxngToken('t0ken', secrets);
      const { provider, calls } = countingProvider();
      const built = buildResearch(searxngConfig(), {
        secretsPath: secrets, researchPath: join(dir, 'research.json'), provider,
      });

      await built!.lookup('rank', 'Algorithms');
      await built!.lookup('rank', 'Linear Algebra');

      assert.equal(calls.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildResearch', () => {
  test('returns nothing when research is not available', () => {
    const dir = scratch();
    try {
      assert.equal(buildResearch(configWith({ enabled: false })), null);
      assert.equal(buildResearch(configWith(), { secretsPath: join(dir, 'none.json') }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('looks a term up and spends from the persisted budget', async () => {
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    const research = join(dir, 'research.json');
    try {
      setSearchApiKey('k', secrets);
      const { provider, calls } = countingProvider();
      const built = buildResearch(configWith({ maxQueriesPerDay: 5 }), {
        secretsPath: secrets, researchPath: research, provider,
      });

      const result = await built!.lookup('Kleene star');

      assert.deepEqual(calls, ['Kleene star']);
      assert.deepEqual(result.results, [RESULT]);
      assert.equal(built!.remaining(), 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the second lookup of a term is free', async () => {
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    const research = join(dir, 'research.json');
    try {
      setSearchApiKey('k', secrets);
      const { provider, calls } = countingProvider();
      const built = buildResearch(configWith(), {
        secretsPath: secrets, researchPath: research, provider,
      });

      await built!.lookup('AST');
      await built!.lookup('AST');

      assert.equal(calls.length, 1);
      assert.equal(built!.remaining(), 99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a malformed term becomes a reason, never a thrown error', async () => {
    // A bug in term extraction must not lose a note.
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    try {
      setSearchApiKey('k', secrets);
      const { provider } = countingProvider();
      const built = buildResearch(configWith(), {
        secretsPath: secrets, researchPath: join(dir, 'research.json'), provider,
      });

      const result = await built!.lookup('line one\nline two');

      assert.deepEqual(result.results, []);
      assert.match(result.reason ?? '', /single line/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a spent budget reports itself rather than degrading silently', async () => {
    const dir = scratch();
    const secrets = join(dir, 'secrets.json');
    try {
      setSearchApiKey('k', secrets);
      const { provider, calls } = countingProvider();
      const built = buildResearch(configWith({ maxQueriesPerDay: 1 }), {
        secretsPath: secrets, researchPath: join(dir, 'research.json'), provider,
      });

      await built!.lookup('first');
      const second = await built!.lookup('second');

      assert.equal(calls.length, 1);
      assert.match(second.reason ?? '', /budget/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
