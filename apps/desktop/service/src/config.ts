// Desktop configuration.
//
// Decision 2 in CLAUDE.md: nothing about the owner is hardcoded. Every personal
// value lives here, is collected by the setup wizard, and is validated on load
// so a hand-edited file fails loudly rather than half-working.
//
// Per the doc-drift rule, changing this schema requires updating docs/SETUP.md
// in the same commit. scripts/check-doc-drift.sh enforces it.

import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const Verbosity = z.enum(['verbatim', 'cleaned', 'expanded']);
export type Verbosity = z.infer<typeof Verbosity>;

export const CourseConfig = z.object({
  name: z.string().min(1).max(64),
  /** Vocabulary injected into the prompt. ADR 0001 finding 4 showed this is
   *  what suppresses the repetition loop on dense pages, so it is not
   *  cosmetic. Grows from the user's corrections over time. */
  glossary: z.array(z.string().min(1).max(64)).default([]),
});
export type CourseConfig = z.infer<typeof CourseConfig>;

export const Config = z.object({
  version: z.literal(1),

  // --- server ---
  serverUrl: z.string().url(),
  deviceId: z.string().uuid(),

  // --- vault ---
  vault: z.object({
    /** Absolute path to the Obsidian vault, which must be a git repo. */
    root: z.string().min(1),
    /** Where notes land, relative to root. Supports no templating on purpose:
     *  a literal path is checkable, a template is not. */
    notesPath: z.string().min(1),
    attachmentsPath: z.string().min(1).default('Images'),
    /** Whether to push after committing. Decision 7 asks before pushing. */
    autoPush: z.boolean().default(false),
    remote: z.string().min(1).default('origin'),
    branch: z.string().min(1).default('main'),
  }),

  // --- courses ---
  courses: z.array(CourseConfig).default([]),
  /** Used when the model cannot infer a course. */
  defaultCourse: z.string().min(1).default('General'),

  // --- model ---
  model: z.object({
    /** ADR 0001: qwen2.5vl:7b is the measured default. */
    name: z.string().min(1).default('qwen2.5vl:7b'),
    host: z.string().url().default('http://127.0.0.1:11434'),
    /** ADR 0001 finding 3b: image token cost varies more than 4x between
     *  models, so this is validated per model rather than assumed. */
    numCtx: z.number().int().min(2048).max(131072).default(4096),
    timeoutMs: z.number().int().min(10_000).max(900_000).default(180_000),
  }).default({}),

  // --- formatting ---
  /** Tidy-up passes applied to the transcript before it reaches the preview.
   *  All are conservative and reversible in meaning: the formatter normalises,
   *  it never invents. Each can be switched off if it gets in your way. */
  formatting: z.object({
    /** Wrap high-confidence maths in $...$ and convert Unicode operators */
    math: z.boolean().default(true),
    /** Add the alignment row Obsidian needs, pad ragged columns */
    tables: z.boolean().default(true),
    /** One bullet character, two-space indent levels */
    lists: z.boolean().default(true),
    /** Demote stray H1s so they do not compete with the note title */
    headings: z.boolean().default(true),
    /** Collapse blank line runs, strip trailing spaces */
    whitespace: z.boolean().default(true),
  }).default({}),

  // --- expansion (ADR 0003) ---
  /** Turning terse keywords back into prose, with a contradiction gate.
   *  Off by default: verbatim transcription is the safe baseline, and a page
   *  you only want transcribed should never be embellished. */
  expansion: z.object({
    enabled: z.boolean().default(false),
    /** A TEXT model, separate from the vision one. They run sequentially, so
     *  both fit on one card. qwen2.5:14b was the measured choice. */
    model: z.string().min(1).default('qwen2.5:14b'),
    /** Samples per term for the consistency signal. More costs time linearly
     *  and only detects wobble, never systematic error.
     *
     *  Do not set this to 1. It does not merely disable the consistency
     *  signal: a term is refused when EVERY sample refuses, so at one sample a
     *  single unlucky roll discards a term the model knows perfectly well.
     *  Measured on corpus page E, where one sample refused two of six terms and
     *  three samples refused none. */
    samples: z.number().int().min(1).max(7).default(3),
    /** Below this agreement, an explanation is kept but marked uncertain. */
    agreementThreshold: z.number().min(0).max(1).default(0.5),
    /** Cap per note, so one dense page cannot run for an hour. */
    maxTermsPerNote: z.number().int().min(1).max(50).default(12),
  }).default({}),

  /** Cut hand-drawn diagrams out of each page and embed the crops.
   *
   *  Off by default: it costs a second vision pass per page, and most pages of
   *  written notes contain no diagram at all. */
  detectDiagrams: z.boolean().default(false),

  // --- research (ADR 0004) ---
  /** Checking expansions against web search snippets.
   *
   *  Off by default, and not only for privacy. Retrieval helps on obscure
   *  material and hurts on well known material, so it stays off until a side by
   *  side run on the corpus shows it does not cause regressions.
   *
   *  The API key is deliberately NOT here. It lives in the secrets file beside
   *  the keystore, because a config holding vault paths and course names is the
   *  file someone pastes into an issue when asking for help. */
  research: z.object({
    enabled: z.boolean().default(false),
    /** `searxng` is a metasearch instance you host yourself. It queries Google
     *  underneath, so the index is the same, and it needs no API key, no
     *  account, no quota and no billing. ADR 0004 records why it is the
     *  default: Google's JSON API refused four keys across two projects with
     *  the API provably enabled and receiving the requests. */
    provider: z.enum(['google', 'searxng']).default('searxng'),
    /** Programmable Search Engine id, for the google provider. Not a secret. */
    cx: z.string().default(''),
    /** Base URL of a SearXNG instance. Must be https unless it is loopback,
     *  since the access token travels in a header. */
    host: z.string().default(''),
    /** Google's free tier is 100 a day, so the cap protects a real limit
     *  there. A self-hosted instance has no quota, and this still bounds a
     *  runaway loop, so it is kept for both. */
    maxQueriesPerDay: z.number().int().min(0).max(10_000).default(100),
    /** Snippets read per term. Each one is a small model call. */
    snippetsPerTerm: z.number().int().min(1).max(10).default(5),
    /** A term means the same thing next week, and a semester of notes repeats
     *  terms heavily, so the cache is what keeps the free tier sufficient.
     *  Zero means never expire. */
    cacheMaxAgeDays: z.number().int().min(0).max(3650).default(90),
  }).default({}),

  // --- behaviour ---
  /** Decision 13: 60 second default, configurable. */
  pollSeconds: z.number().int().min(10).max(3600).default(60),
  verbosity: Verbosity.default('cleaned'),
  /** Decision 6: cloud is opt-in and never spends money without asking. Even
   *  when enabled, each escalation is confirmed per note. */
  cloudEscalationEnabled: z.boolean().default(false),
});

export type Config = z.infer<typeof Config>;

/** Where the config lives, per platform. Overridable for tests. */
export function defaultConfigPath(): string {
  const base = process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'inkpipe', 'config.json');
}

export class ConfigError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError('missing', `no config at ${path}. Run setup first.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError('malformed', `${path} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    // Fail loudly with the exact field, because a silently wrong vault path
    // would write notes somewhere the user never looks.
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError('invalid', `config at ${path} is invalid:\n${issues}`);
  }
  return parsed.data;
}

export function saveConfig(config: Config, path = defaultConfigPath()): void {
  // Validate before writing, so a bad config can never reach disk.
  const parsed = Config.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

export function configExists(path = defaultConfigPath()): boolean {
  return existsSync(path);
}

/** The glossary for a course, empty when the course is unknown. */
export function glossaryFor(config: Config, course: string): string[] {
  return config.courses.find((c) => c.name === course)?.glossary ?? [];
}

/** Merge corrections into a course glossary without duplicating terms.
 *  PREPARATION section 9: this is the whole feedback mechanism. */
export function addGlossaryTerms(config: Config, course: string, terms: string[]): Config {
  const normalised = terms.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 64);
  const existing = config.courses.find((c) => c.name === course);

  if (!existing) {
    return {
      ...config,
      courses: [...config.courses, { name: course, glossary: dedupe(normalised) }],
    };
  }
  return {
    ...config,
    courses: config.courses.map((c) =>
      c.name === course ? { ...c, glossary: dedupe([...c.glossary, ...normalised]) } : c,
    ),
  };
}

/** Case-insensitive dedupe that keeps the first spelling seen. */
function dedupe(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}
