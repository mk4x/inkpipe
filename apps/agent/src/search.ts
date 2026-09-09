// Web search: the only place anything about a note leaves this machine.
//
// ADR 0004. Expansion used to reason purely from the model's own weights, gated
// by "does this contradict the page". That catches an explanation conflicting
// with the notes and catches nothing at all when the page is silent, which is
// most of the time because the owner writes keywords. There was no external
// authority anywhere in the loop.
//
// There is one now, and this module is the boundary. Everything about it is
// deliberately narrow.
//
//   ONE TERM PER QUERY.  Not the note, not the transcript, not a paragraph.
//   buildQuery enforces single line and length capped rather than trusting its
//   caller, because the caller is passing along model output and models
//   occasionally hand back far more than they were asked for.
//
//   NO PROVIDER IS COMPILED IN.  There is no default search engine. If the user
//   did not configure one, research does not run.
//
//   SNIPPETS ONLY.  Result pages are never fetched. The engine's own extract is
//   the relevant passage already pulled out, and skipping the fetch removes
//   HTML parsing, redirects, timeouts, paywalls and bot walls in one go.
//
//   RESULTS ARE DATA.  A snippet is text from a stranger. It is evidence to be
//   weighed in evidence.ts, never an instruction, and never a source of the
//   next request to make.

export interface SearchResult {
  title: string;
  url: string;
  /** The engine's own extract. This is all we ever read. */
  snippet: string;
}

export interface SearchProvider {
  /** For the note's source list, logs, and error messages. */
  name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/** Injected everywhere, so tests never touch the network. */
export type Fetcher = typeof fetch;

export class SearchError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/** Longer than this is not a term, it is a chunk of the note. */
export const MAX_TERM_LENGTH = 120;
export const MAX_QUERY_LENGTH = 200;

/**
 * Turn a term into a query string.
 *
 * Throws rather than truncating on anything that does not look like a term. A
 * caller that accidentally passes a whole transcript should get a loud failure,
 * not a very informative search query.
 */
export function buildQuery(term: string, course?: string): string {
  // Any line break at all means this was never a single term.
  if (/[\r\n]/.test(term.trim())) {
    throw new SearchError('term_not_a_term', 'a search term must be a single line');
  }

  const flattened = term
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (flattened.length === 0) {
    throw new SearchError('empty_term', 'refusing to search for an empty term');
  }
  if (flattened.length > MAX_TERM_LENGTH) {
    throw new SearchError(
      'term_too_long',
      `a search term may be at most ${MAX_TERM_LENGTH} characters, got ${flattened.length}. `
      + 'This guard exists so note content cannot reach a search engine by accident.',
    );
  }

  // The course disambiguates homonyms: "rank" means different things in linear
  // algebra and in heaps. It is a configured value, never model output.
  const qualified = course ? `${flattened} ${course}` : flattened;
  return qualified.slice(0, MAX_QUERY_LENGTH);
}

/** Cache key. Case and spacing should not cost a query. */
export function cacheKey(term: string, course?: string): string {
  return `${(course ?? '').trim().toLowerCase()}::${term.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Google Programmable Search, the JSON API
//
// The owner's choice. 100 queries a day on the free tier, which is why the
// cache and the budget below are not optional extras.
// ---------------------------------------------------------------------------

export interface GoogleOptions {
  apiKey: string;
  /** Programmable Search Engine id. Configure it to search the entire web. */
  cx: string;
  fetch?: Fetcher;
}

export function googleProvider(options: GoogleOptions): SearchProvider {
  const doFetch = options.fetch ?? fetch;
  return {
    name: 'google',
    async search(query, limit) {
      const url = new URL('https://www.googleapis.com/customsearch/v1');
      url.searchParams.set('key', options.apiKey);
      url.searchParams.set('cx', options.cx);
      url.searchParams.set('q', query);
      // The API caps num at 10 and errors outside 1 to 10.
      url.searchParams.set('num', String(Math.min(Math.max(limit, 1), 10)));

      let response: Response;
      try {
        response = await doFetch(url, { headers: { accept: 'application/json' } });
      } catch (error) {
        // Offline is normal on a laptop. It must degrade to "not verified",
        // never to an unhandled rejection that loses the whole page.
        throw new SearchError('unreachable', `could not reach google: ${(error as Error).message}`);
      }

      if (response.status === 429) {
        throw new SearchError('rate_limited', 'google search quota is exhausted for today');
      }
      if (response.status === 403) {
        throw new SearchError('forbidden', 'google rejected the API key or the search engine id');
      }
      if (!response.ok) {
        throw new SearchError('provider_error', `google search returned ${response.status}`);
      }

      const body = await response.json() as { items?: Array<Record<string, unknown>> };
      return (body.items ?? [])
        .slice(0, limit)
        .map((item) => ({
          title: String(item.title ?? ''),
          url: String(item.link ?? ''),
          snippet: String(item.snippet ?? ''),
        }))
        .filter((r) => r.url.length > 0 && r.snippet.length > 0);
    },
  };
}

export interface ProviderConfig {
  provider: 'google';
  apiKey?: string;
  cx?: string;
}

/**
 * Build the configured provider.
 *
 * Fails loudly on missing credentials. The alternative is research quietly
 * doing nothing, which looks identical to the feature being broken.
 */
export function providerFromConfig(config: ProviderConfig, fetcher?: Fetcher): SearchProvider {
  if (config.provider !== 'google') {
    throw new SearchError('unknown_provider', `unknown search provider: ${String(config.provider)}`);
  }
  if (!config.apiKey || !config.cx) {
    throw new SearchError(
      'not_configured',
      'the google provider needs both an API key and a search engine id (cx). Run setup.',
    );
  }
  return googleProvider({ apiKey: config.apiKey, cx: config.cx, fetch: fetcher });
}

// ---------------------------------------------------------------------------
// Cache and budget
//
// A semester of notes repeats terms heavily: "AST" turns up in half the
// compiler lectures. Caching by term is the difference between the free tier
// being ample and being spent by Wednesday.
// ---------------------------------------------------------------------------

export interface CacheEntry {
  results: SearchResult[];
  /** Epoch millis, so a stale entry can be recognised. */
  storedAt: number;
}

export interface SearchCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
}

/** In memory, for tests and for a single run. */
export function memoryCache(seed?: Record<string, CacheEntry>): SearchCache {
  const map = new Map<string, CacheEntry>(Object.entries(seed ?? {}));
  return {
    get: (key) => map.get(key),
    set: (key, entry) => { map.set(key, entry); },
  };
}

export interface Budget {
  /** Remaining queries. */
  remaining(): number;
  /** Record one spent query. */
  spend(): void;
}

/** A simple per day budget over an injected clock. */
export function dailyBudget(limit: number, state?: { day: string; used: number }, now = () => new Date()): Budget {
  let day = state?.day ?? today();
  let used = state?.used ?? 0;

  function today(): string {
    return now().toISOString().slice(0, 10);
  }
  function roll(): void {
    const current = today();
    if (current !== day) {
      day = current;
      used = 0;
    }
  }

  return {
    remaining() {
      roll();
      return Math.max(0, limit - used);
    },
    spend() {
      roll();
      used += 1;
    },
  };
}

export interface LookupOptions {
  provider: SearchProvider;
  cache?: SearchCache;
  budget?: Budget;
  course?: string;
  limit?: number;
  /** Entries older than this are refetched. Zero means never expire. */
  maxAgeMs?: number;
  now?: () => number;
}

export interface Lookup {
  results: SearchResult[];
  /** Why there are no results, when there are none. Surfaced, never swallowed. */
  reason: string | null;
  fromCache: boolean;
}

/**
 * Look a term up, honouring the cache and the budget.
 *
 * Never throws for an ordinary failure. Being offline, out of quota, or holding
 * a bad key all produce an empty result with a reason, because none of them
 * should lose the note. Only a malformed term throws, since that is a bug in
 * the caller rather than a condition of the world.
 */
export async function lookup(term: string, options: LookupOptions): Promise<Lookup> {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? 5;
  const key = cacheKey(term, options.course);

  const cached = options.cache?.get(key);
  if (cached) {
    const age = now() - cached.storedAt;
    const fresh = !options.maxAgeMs || age < options.maxAgeMs;
    if (fresh) return { results: cached.results, reason: null, fromCache: true };
  }

  // Built before the budget check so a malformed term fails loudly even when
  // there was no quota left to spend on it.
  const query = buildQuery(term, options.course);

  if (options.budget && options.budget.remaining() <= 0) {
    return {
      results: [],
      reason: 'the daily search budget is spent, so this term was not verified against sources',
      fromCache: false,
    };
  }

  try {
    const results = await options.provider.search(query, limit);
    options.budget?.spend();
    options.cache?.set(key, { results, storedAt: now() });
    return { results, reason: null, fromCache: false };
  } catch (error) {
    if (error instanceof SearchError) {
      // A spent quota still counts as a spent query on the provider's side.
      if (error.code === 'rate_limited') options.budget?.spend();
      return { results: [], reason: error.message, fromCache: false };
    }
    throw error;
  }
}
