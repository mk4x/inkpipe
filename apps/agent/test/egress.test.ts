// Guard: the pipeline must not talk to anything the user did not configure.
//
// The whole privacy claim rests on a short list of destinations:
//
//   the user's own server      configured, holds only ciphertext
//   Ollama on loopback         configured, on their machine
//   their own git remote       via git, when they press push
//
// Nothing else. No search engine, no analytics, no telemetry, no model API.
// That is easy to state and easy to erode: one convenience call to fetch a
// definition, check for updates, or report an error, and the claim quietly
// stops being true while every other test still passes.
//
// So it is asserted statically. A new outbound destination has to be added here
// deliberately, which is the point.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Shipped code. Tests, tools and spike harnesses are excluded on purpose:
 *  they are development scaffolding and never run on a user's machine. */
const SHIPPED = [
  'apps/agent/src',
  'apps/server/src',
  'apps/desktop/service/src',
  'apps/desktop/ui/src',
  'apps/phone/src',
  'packages/crypto/src',
  'packages/protocol/src',
  'packages/client/src',
  'packages/quality/src',
  'packages/imaging/src',
];

/**
 * Hosts allowed to appear as a literal in shipped source.
 *
 * Loopback is the model and the local service. `ollama.com` appears only as
 * text shown to the user so they can run the installer themselves: decision 18
 * says the wizard never pipes a remote script into a shell, so it prints the
 * command rather than executing it. `example.com` is placeholder text in a form.
 */
const ALLOWED = [
  /^https?:\/\/127\.0\.0\.1(:\d+)?/,
  /^https?:\/\/localhost(:\d+)?/,
  /^https:\/\/ollama\.com\/install\.sh$/,
  /^https:\/\/inkpipe\.example\.com$/,
  /^https:\/\/github\.com\/mk4x\/inkpipe$/,
  // ADR 0004. The one deliberate addition, and the reason this guard exists:
  // it forced the change to be argued for rather than slipped in. This is the
  // Programmable Search JSON API endpoint and nothing else on that host. It is
  // reached only when the user has configured a key, only with a single line
  // length capped term, and never with note content. Those are asserted in
  // search.test.ts and expand-research.test.ts, not here.
  /^https:\/\/www\.googleapis\.com\/customsearch\/v1$/,
];

/** Shipped files permitted to name the search endpoint. Exactly one. */
const SEARCH_MODULES = ['apps/agent/src/search.ts'];

/** Destinations that would break the claim outright. */
const FORBIDDEN = [
  { name: 'a search engine', pattern: /google\.com|bing\.com|duckduckgo|serpapi|brave\.com\/search/i },
  { name: 'a hosted model API', pattern: /api\.openai|api\.anthropic|generativelanguage|api\.cohere|huggingface\.co\/api/i },
  // Domains, not bare words. An earlier version matched "plausible" and flagged
  // the word in a code comment, which is the kind of false positive that gets a
  // guard disabled rather than fixed.
  { name: 'analytics or telemetry', pattern: /google-analytics\.com|segment\.io|mixpanel\.com|sentry\.io|posthog\.com|plausible\.io/i },
];

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(absolute, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(join(dir, entry)));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = SHIPPED.flatMap(sourceFiles);

describe('network egress', () => {
  test('there is shipped source to check', () => {
    // Without this, a renamed directory would make every assertion below pass
    // by checking nothing, the same way the em dash checker once did.
    assert.ok(files.length > 8, `expected many source files, found ${files.length}`);
  });

  for (const { name, pattern } of FORBIDDEN) {
    test(`no shipped file contacts ${name}`, () => {
      for (const file of files) {
        const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/');
        assert.equal(
          pattern.test(readFileSync(file, 'utf8')),
          false,
          `${relative} references ${name}. The pipeline must only talk to the user's own server and their local Ollama.`,
        );
      }
    });
  }

  test('every literal URL in shipped source is on the allow list', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      const urls = readFileSync(file, 'utf8').match(/https?:\/\/[a-zA-Z0-9.:_/-]+/g) ?? [];
      for (const url of urls) {
        if (!ALLOWED.some((allowed) => allowed.test(url))) offenders.push(`${relative}: ${url}`);
      }
    }

    assert.deepEqual(
      offenders, [],
      'new outbound destinations must be added to the allow list deliberately, with a reason',
    );
  });

  test('the allow list itself would reject a search engine', () => {
    // Negative control. An allow list that accepts everything protects nothing.
    // Still meaningful after ADR 0004: the configured JSON API is permitted,
    // scraping the search page itself is not.
    const url = 'https://www.google.com/search?q=leftist+heap';
    assert.equal(ALLOWED.some((a) => a.test(url)), false);
    assert.equal(FORBIDDEN.some((f) => f.pattern.test(url)), true);
  });

  test('only one shipped module knows how to reach the search endpoint', () => {
    // Containment. Every query has to pass buildQuery, which enforces single
    // line and length capped. A second module calling the API directly would
    // route around that guard while leaving every other test green.
    const offenders = files
      .map((file) => ({
        relative: file.slice(ROOT.length + 1).replace(/\\/g, '/'),
        text: readFileSync(file, 'utf8'),
      }))
      .filter(({ text }) => /googleapis\.com|customsearch/.test(text))
      .map(({ relative }) => relative)
      .filter((relative) => !SEARCH_MODULES.includes(relative));

    assert.deepEqual(offenders, [], 'search requests must go through apps/agent/src/search.ts');
  });

  test('the search module is present, so the check above is not vacuous', () => {
    const known = files.map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'));
    for (const module of SEARCH_MODULES) {
      assert.ok(known.includes(module), `${module} is missing, so containment proves nothing`);
    }
  });
});
