// Persisting the search cache and the daily budget.
//
// ADR 0004. The agent package is deliberately free of file paths and platform
// details, so it takes a cache and a budget as interfaces. This supplies the
// file-backed ones, and builds the lookup function that expansion calls.
//
// The cache is the reason 100 queries a day is enough. A semester of notes
// repeats terms heavily: "AST" turns up in half the compiler lectures, and
// looking it up once a term rather than once a note is the whole difference.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  lookup, providerFromConfig, SearchError,
  type SearchCache, type CacheEntry, type Budget, type SearchProvider,
} from '../../../agent/src/search.ts';
import type { ResearchOptions } from '../../../agent/src/expand.ts';
import { defaultConfigPath, type Config } from './config.ts';
import { loadSecrets } from './secrets.ts';

/** Entries are dropped oldest first past this. A term cache does not need to
 *  be complete, only warm, and an unbounded JSON file read on every lookup
 *  becomes the slowest part of the pipeline eventually. */
const MAX_ENTRIES = 5000;

const StoredResult = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});

const StoredState = z.object({
  version: z.literal(1),
  /** ISO date. The budget resets when this stops matching today. */
  day: z.string().default(''),
  used: z.number().int().min(0).default(0),
  entries: z.record(z.string(), z.object({
    results: z.array(StoredResult),
    storedAt: z.number(),
  })).default({}),
});

type StoredState = z.infer<typeof StoredState>;

const EMPTY: StoredState = { version: 1, day: '', used: 0, entries: {} };

export function defaultResearchPath(): string {
  return join(dirname(defaultConfigPath()), 'research.json');
}

function read(path: string): StoredState {
  if (!existsSync(path)) return { ...EMPTY, entries: {} };
  try {
    const parsed = StoredState.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : { ...EMPTY, entries: {} };
  } catch {
    // A corrupt cache costs queries, never correctness. Starting over is the
    // right response, and it must not stop the pipeline.
    return { ...EMPTY, entries: {} };
  }
}

function write(path: string, state: StoredState): void {
  const entries = Object.entries(state.entries);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].storedAt - a[1].storedAt);
    state = { ...state, entries: Object.fromEntries(entries.slice(0, MAX_ENTRIES)) };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export interface ResearchStore {
  cache: SearchCache;
  budget: Budget;
  /** For the status endpoint, so the UI can show what is left. */
  remaining(): number;
}

/**
 * A cache and a budget backed by one JSON file.
 *
 * Read and written per operation rather than held in memory: the file is small,
 * the service is single user, and a cache that survives a crash is worth more
 * than one that saves a few milliseconds.
 */
export function fileResearchStore(
  limit: number,
  path = defaultResearchPath(),
  now = () => new Date(),
): ResearchStore {
  const today = () => now().toISOString().slice(0, 10);

  const rolled = (state: StoredState): StoredState =>
    state.day === today() ? state : { ...state, day: today(), used: 0 };

  return {
    cache: {
      get(key) {
        return read(path).entries[key];
      },
      set(key, entry: CacheEntry) {
        const state = read(path);
        write(path, {
          ...state,
          entries: { ...state.entries, [key]: { results: entry.results, storedAt: entry.storedAt } },
        });
      },
    },
    budget: {
      remaining() {
        const state = rolled(read(path));
        return Math.max(0, limit - state.used);
      },
      spend() {
        const state = rolled(read(path));
        write(path, { ...state, used: state.used + 1 });
      },
    },
    remaining() {
      return Math.max(0, limit - rolled(read(path)).used);
    },
  };
}

export class ResearchUnavailable extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResearchUnavailable';
    this.code = code;
  }
}

/**
 * Why research cannot run, or null when it can.
 *
 * Separated from building it so the setup UI can explain what is missing
 * without having to trigger a failure to find out.
 */
export function researchBlocker(config: Config, secretsPath?: string): string | null {
  if (!config.research.enabled) return 'research is switched off';

  if (config.research.provider === 'google') {
    if (!config.research.cx) return 'no Programmable Search Engine id is configured';
    if (!loadSecrets(secretsPath).searchApiKey) return 'no search API key has been saved';
    return null;
  }

  if (!config.research.host) return 'no SearXNG instance URL is configured';
  // A remote instance without a token is an open search proxy for anyone who
  // finds the hostname, so refuse rather than quietly publishing one.
  const remote = !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(config.research.host);
  if (remote && !loadSecrets(secretsPath).searxngToken) {
    return 'no SearXNG token has been saved, and a remote instance requires one';
  }
  return null;
}

export interface BuildOptions {
  secretsPath?: string;
  researchPath?: string;
  /** Injected in tests, so no network and no real provider are needed. */
  provider?: SearchProvider;
  now?: () => Date;
}

/**
 * Build the lookup expansion needs, or null when research is not available.
 *
 * Null rather than throwing: research being off is the default state, not an
 * error, and expansion without it is exactly the pre-ADR-0004 behaviour.
 */
export function buildResearch(
  config: Config,
  options: BuildOptions = {},
): (ResearchOptions & { remaining(): number }) | null {
  if (researchBlocker(config, options.secretsPath)) return null;

  const secrets = loadSecrets(options.secretsPath);
  const provider = options.provider ?? providerFromConfig({
    provider: config.research.provider,
    apiKey: secrets.searchApiKey,
    cx: config.research.cx,
    host: config.research.host,
    token: secrets.searxngToken,
  });

  const store = fileResearchStore(
    config.research.maxQueriesPerDay,
    options.researchPath,
    options.now,
  );

  const maxAgeMs = config.research.cacheMaxAgeDays * 24 * 60 * 60 * 1000;

  return {
    remaining: store.remaining,
    async lookup(term: string, course?: string) {
      try {
        const result = await lookup(term, {
          provider,
          cache: store.cache,
          budget: store.budget,
          // Measured on page F: without this, "Epsilon" searches for the Greek
          // letter and the brand, and four of six terms found no relevant
          // source at all. The course is a configured value, never model output.
          course,
          limit: config.research.snippetsPerTerm,
          maxAgeMs,
        });
        return { results: result.results, reason: result.reason };
      } catch (error) {
        // A malformed term is a bug worth surfacing, not worth losing a note
        // over. It becomes "could not be looked up" like any other failure.
        if (error instanceof SearchError) return { results: [], reason: error.message };
        throw error;
      }
    },
  };
}
