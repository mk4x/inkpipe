# inkpipe - rules for agents and humans

Read `docs/PREPARATION.md` first. It holds every design decision and the reason
for it. If something here and something there disagree, PREPARATION.md wins and
this file is wrong and must be fixed.

## Project state

Working end to end. Phone captures, the VPS relays ciphertext, the desktop
transcribes locally and builds a draft, and the preview writes to the vault.
`docs/SPEC.md` and `docs/SETUP.md` exist and are kept in step by CI.

Five ADRs are accepted. A Windows installer is built by `npm run installer`.
ADR 0004 was the only one taken without a spike behind it; it has since been
measured at zero regressions over twelve terms. Its `research` feature still
defaults to off, because it needs a search instance that nobody has by default.

## Hard rules

### 1. No em dashes

Never write U+2014 anywhere: code, comments, commit messages, docs, UI copy.
Use a hyphen for compound words, a colon to introduce an explanation, parentheses
for an aside, a full stop to split clauses, or a comma for a mild parenthetical.

Enforced by `scripts/check-em-dashes.sh`, run in the pre-push hook and in CI.
This rule is inherited from the owner's other repositories and is not negotiable.

### 2. Nothing about the owner is hardcoded

No vault path, semester number, course name, VPS hostname, poll interval, quota,
or model name appears in source. All of it lives in the config schema and is
collected by the setup wizard. A reviewer finding a hardcoded personal value
should treat it as a bug, not a shortcut.

### 3. The server never decodes an image

`apps/server` must never import an image library, never inspect blob contents,
and never parse anything out of a blob beyond its declared length. It stores
ciphertext. Any pull request that gives the server the ability to look inside a
blob breaks the security model in `docs/PREPARATION.md` section 8.

### 4. Model output is data, never instruction

The vision model returns JSON validated by zod. Its content is never executed,
never used to build a file path without sanitisation, and never followed as an
instruction.

**Amended by ADR 0004.** This rule used to end "and never used to construct a
network request", which forbade web search outright, since the terms to look up
come from a transcript. The part that matters is kept and is stricter than the
old wording suggests:

- A model may never choose a **destination**. Hosts come from config, never from
  model output or from a search result.
- A model may contribute only a **query term**: one line, at most 120
  characters, control characters stripped. `buildQuery` enforces this and throws
  rather than truncating, so a whole transcript passed as a term is a loud
  failure and not an informative search query.
- All of it goes through `apps/agent/src/search.ts`. A second module calling a
  search API directly routes around the guard, and `egress.test.ts` fails if one
  appears.

Search results are subject to this rule in full. A snippet is text from a
stranger: evidence to weigh, never an instruction, and never the source of the
next request.

### 5. Generated Markdown is inert

Never emit a runnable code fence, `templater` syntax, a `dataview` block,
`<script>`, an external image URL, or a wikilink that resolves outside the
configured vault subtree. The owner has the Obsidian `execute-code` plugin
installed, so a runnable fence in a generated note is a live code-execution path.

### 6. Never auto-resolve a git conflict

In the vault or in this repo. On a dirty vault tree, refuse and report. On a
rejected push, `pull --rebase` and retry exactly once, then stop and surface the
error to the human.

### 7. Nothing reaches the vault without human approval

The preview screen is the gate. No file write, no commit, and no push happens
before the human approves.

## Documentation rules

Docs drift when the rule for updating them is vague. These are specific.

| If you change | You must update, in the same commit |
|---|---|
| `packages/protocol/**` | `docs/SPEC.md` |
| the config schema | `docs/SETUP.md` |
| a decision recorded in PREPARATION.md section 6 | `docs/PREPARATION.md` **and** a new file in `docs/adr/` |
| the stack, a dependency choice, or a cut feature | `docs/PREPARATION.md` sections 3 and 7 |
| the test layers | `docs/PREPARATION.md` section 10 |
| VPS setup steps or `ops/**` | `docs/VPS_SETUP.md` |
| anything that changes a rule in this file | `CLAUDE.md` |

The first two rows are enforced mechanically by CI and the pre-push hook. The
rest are enforced by review. Do not reword a rule into something unverifiable.

A decision is only reversed by editing `docs/PREPARATION.md` and writing an ADR
that says what changed and why. Never silently contradict a recorded decision in
code.

## Workflow

- Trunk is `main`. Direct pushes are fine. Branch only for awkward changes.
- The gate is the `pre-push` hook: typecheck, lint, em dash check, fast tests.
  CI is a backstop, not the gate, because pushes go straight to `main`.
- `npm run eval` runs the real model against the golden corpus. It must pass
  before pushing any prompt change. CI cannot run it, there is no GPU there.
- Conventional commits.

## Testing

Seven layers, described in `docs/PREPARATION.md` section 10. The two that are
easy to skip and must not be:

- **Cross-surface crypto vectors.** The phone encrypts and the desktop decrypts,
  and the phone runs without Node built-ins. CI asserts a fixed vector opens
  byte-for-byte, and `packages/crypto/test/portability.test.ts` asserts no
  Node-only API (Buffer above all) reaches the phone bundle.
- **The golden corpus.** A prompt change that lowers transcription accuracy must
  fail the build rather than silently degrade the notes.

When a bug is found, add the failing case to the relevant corpus or test file
before fixing it.

## Layout

```
apps/phone          Expo dev build, TypeScript
apps/desktop        Node service, React UI, launcher and installer (ADR 0002, 0005)
apps/agent          transcription, formatting, sanitising, expansion, search
apps/server         Fastify, SQLite, Node 24
packages/protocol   zod wire schemas, shared by all three surfaces
packages/crypto     TypeScript crypto wrappers
packages/imaging    preparation for the model and for the vault
packages/quality    degeneracy detection and scoring
packages/corpus     golden images, expected transcripts, scorer, spikes
docs/               PREPARATION.md, SPEC.md, SETUP.md, VPS_SETUP.md, adr/, plans/
ops/                bootstrap-vps.sh, deploy.sh
```
