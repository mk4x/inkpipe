# inkpipe - Preparation and Planning

**Status:** DRAFT, awaiting approval. No spec and no code exist yet.
**Written:** 2026-09-09
**Method:** produced by a structured grilling session. Every decision below was
put to the owner as an explicit question with a recommendation, and every answer
is recorded. Nothing here is an assumption.

---

## 1. What this is

inkpipe turns photographs of handwritten notes into formatted Markdown in an
Obsidian vault, using a local vision model on a machine that is only powered on
some of the time.

The loop:

```
phone (Expo)          VPS (Fastify)         PC (Tauri + Ollama)      vault (git)
-----------           --------------        -------------------      -----------
capture pages    -->  hold opaque      -->  poll, decrypt,      -->  write .md
encrypt to PC         ciphertext            transcribe, preview      commit, push
keep local copy       delete on ack         approve or edit
```

The VPS never sees a plaintext byte. It is a queue, not a service.

## 2. Goals

1. Photograph a lecture's worth of pages on a phone and hit upload once.
2. Have the pages waiting when the desktop machine next comes online.
3. Get accurate Markdown, with maths as LaTeX and diagrams preserved.
4. Review and correct everything before a single file is written.
5. Corrections improve future output, and simultaneously become test cases.
6. Another person can install the whole system on their own hardware.

## 3. Non-goals

Explicitly cut, and recorded here so they are not silently re-added:

- **Multi-tenant hosted service.** Each person self-hosts their own VPS. There
  are no strangers' images on anyone else's box.
- **Fine-tuning or LoRA.** The feedback loop is in-context only. See section 9.
- **Automatic prompt optimisation.** Future work.
- **Cloud processing as a requirement.** It is opt-in, per-note, and never
  spends money without asking. The system is fully functional without it.
- **Real-time push delivery.** The PC polls.
- **iOS.** Android only.

## 4. Evidence: the handwriting reality check

Two real sample pages were assessed before any technology was chosen. This is
the single most important input to the design.

**Page B (Meldable Priority Queues, linear prose plus maths):** transcribed at
roughly 95 percent accuracy. Subscripts, inequalities, `O(log n)`, and method
call notation all recovered.

**Page A (Virtual Machines, diagram-heavy tree):** roughly 60 percent, and the
lost 40 percent carried the meaning. The page was photographed rotated 90
degrees, had a hard shadow band and glare across the top third, used two ink
colours, and roughly 60 percent of its information was spatial (nested brackets,
arrows, a Host 1 to Host 2 migration diagram) rather than textual.

**Three conclusions that shaped everything downstream:**

1. Grid paper is fine. The problems are lighting and rotation, both fixable for
   free at capture time. No new notebooks needed.
2. The good transcription of Page B leaned heavily on **domain knowledge**.
   Recognising "Meldable" and "Leftist" came partly from the strokes and partly
   from knowing the data structures. A local 7B model has far less of that prior.
   **Per-course context priming is therefore load-bearing, not a nice-to-have.**
3. ~~A local model on 16 GB of VRAM is unlikely to handle Page A acceptably.~~
   **RESOLVED 2026-09-09 by issue #1, see [adr/0001](adr/0001-local-first-transcription.md).**
   Local-first survives. Page B reached CER 0.099 with 91 percent term coverage,
   which is a usable draft. Page A reached only CER 0.567 even at its best, so
   the pessimism was correct for diagram-dense pages and wrong for linear ones.
   Two findings changed the design: the dominant failure mode is **degenerate
   repetition** rather than misreading, and **course priming is what prevents
   it** (Page A went from a 593 line loop to a clean pass purely by adding a
   course glossary). Conclusion 2 above is therefore measured, not argued.

## 5. Target hardware and environment

Verified on the owner's machine, 2026-09-08:

| | |
|---|---|
| GPU | NVIDIA RTX 5070 Ti, 16 GB VRAM |
| CPU | AMD Ryzen 7 9800X3D, 8 cores |
| RAM | 31 GB |
| OS | Windows 11 (primary target), Linux (secondary) |
| Present | Node 24.19, Python 3.14.7, Rust/cargo 1.97, git 2.55, gh 2.97 |
| Absent | Ollama, Docker, JDK, Android SDK, pnpm, bun |

Notes are in **English**, handwritten on grid paper, university computer science
material, diagram and maths heavy. The owner is in semester 5, but semester and
course names are configuration, never hardcoded.

## 6. Decisions

Every row was an explicit question with a recommendation and an answer.

| # | Decision | Chosen | Why |
|---|---|---|---|
| 1 | Audience | Each person self-hosts their own instance | A hosted multi-tenant service is where this project dies. A user id exists everywhere from day one so nothing is hardcoded. |
| 2 | Repo | One public monorepo, `mk4x/inkpipe`, MIT | A shared wire schema across phone, server and PC is what prevents protocol desync. Public because a private repo cannot be shown in an interview. |
| 3 | VPS | Reuse the owner's existing idle Hetzner box | It runs nothing. The deliverable is still a bootstrap script that works on a stranger's fresh Ubuntu box. |
| 4 | VPS role | Dumb encrypted queue | The server never decodes an image, so image-parsing CVEs and prompt injection are structurally impossible there rather than merely mitigated. |
| 5 | Identity | QR code device pairing | No passwords, no email, no reset flow, no user table worth attacking. The pairing exchange is also the key exchange. |
| 6 | Inference | Local first, explicit opt-in cloud escalation per note | Never spends money without asking. Cloud access is optional and the system works without it. |
| 7 | Vault writes | App writes files and runs its own git commit and push | Never touches files it did not create. Distinct commit prefix so its work is revertible in one command. |
| 8 | Diagrams | Crop and embed the original, plus an unverified Mermaid attempt in a collapsed callout | A wrong diagram is worse than no diagram, because you will study from it. The crop is correct by construction. |
| 9 | Note unit | One note per capture session, not per photo | A lecture is one document. Splitting destroys continuity. |
| 10 | Backend | Node 24 + Fastify + SQLite + zod | Reuses existing PM2 and nginx ops knowledge. Shared zod schemas with the clients. |
| 11 | Phone | Expo dev build (TypeScript) | ML Kit document scanner via plugin gives free deskew and shadow removal, which is the actual fix for Page A. One audited crypto library (`@noble`) runs identically on all three surfaces. |
| 12 | Desktop | Tauri v2 (Rust core, React + TS UI) | 10 MB binary versus 150 MB. Rust handles git, image cropping and Ollama supervision. UI stays TypeScript so schemas are still shared. |
| 13 | Delivery | PC polls over HTTPS, 60s default, configurable | No inbound port on the PC, works behind any NAT, survives sleep. |
| 14 | Retention | Delete on ack, 30 day TTL, 2 GB per-device quota, UUIDv7 idempotency | A stuck phone cannot fill the disk. A retried upload never duplicates a note. |
| 15 | Phone backup | App-private storage, compressed, 90 days or 2 GB | Survives a PC or keyring loss. Gives offline capture for free. Not in the camera roll. |
| 16 | Crypto | Phone Ed25519 identity, PC X25519 content key, sealed box per blob | Server sees ciphertext and a device id only. |
| 17 | Key recovery | One-time recovery phrase shown at setup | Without it, a dead PC means every pending blob is permanently unreadable, and a second PC can never be paired. |
| 18 | Setup | Wizard does everything except VPS provisioning and the elevation prompt | Silent privilege escalation and piping remote scripts into a shell are not acceptable, so those stay visible. |
| 19 | Verbosity | Three named levels: Verbatim, Cleaned, Expanded | A slider has no testable semantics. Three levels do. |
| 20 | Added content | Anything the model added that is not on the page is marked in the Markdown | Non negotiable for study notes. You must always know what you wrote versus what a machine invented. |
| 21 | Preview | Full editor, not approve-or-reject | Corrections are the training signal and the test cases. Approve-only throws that away. |
| 22 | Branching | Push straight to `main`, gated by a `pre-push` hook | Solo project. The gate moves to the machine so it runs before the breakage lands. |
| 23 | Doc drift | Mechanically enforced for two pairs, written rules for the rest | A vague "keep docs updated" is a rule nobody follows. |
| 24 | Vault images | Aggressive compression, no Git LFS | Roughly 200 KB per page, greyscale, 1600px long edge, WebP q80. A thousand pages is 200 MB. LFS adds a dependency every self-hoster must install. |
| 25 | Tooling | npm workspaces, plain scripts | Turborepo noted as a later option if CI becomes slow. |
| 26 | Default model | `qwen2.5vl:7b`. `minicpm-v:8b` rejected | Measured in [adr/0001](adr/0001-local-first-transcription.md). minicpm produced degenerate output on both pages. |
| 27 | Image prep and priming | Both are required pipeline stages, not settings | Raw pages hard-fail the default context, prep halves CER on the hard page, and priming is what stops the repetition loop. |
| 28 | Degeneracy gate | Every transcript is checked for repetition loops before it reaches the preview | The failure mode is confidently wrong output returned with HTTP 200. **Retry must vary the prompt, not repeat it**: the failure is deterministic (5 identical runs), so a plain retry reproduces it exactly. Escalate to a simpler prompt, then surface as a failed page with the cropped original. Never write it silently. |
| 29 | Prompt | `minimal` (two lines) is the default, and prompt complexity is a retry lever | Measured across 4 pages x 3 variants: fewer instructions gave better transcription on 3 of 4 pages, and were the only way to keep the hardest page out of a repetition loop. Instruction volume competes with the image for attention. |
| 30 | Paper | Keep the grid paper. Do not buy blank paper | All 4 corpus pages are the same paper and span CER 0.110 to 0.485. The variance tracks layout, rotation and maths density, never the ruling. Grid also helps deskewing. |
| 31 | Fact checking | Expansions are checked against web search snippets. Sources may label an explanation, and may only write one when the model refused. Only the page can delete an explanation. Off by default | ADR 0003 gates on "does this contradict the page", and the pages are keywords, so usually nothing contradicts and the gate passes whatever the model believed. Search adds the first check that is not the model grading itself. It is capped rather than trusted because retrieval helps on obscure material and **hurts on well known material**, which is most of an undergraduate syllabus. Snippets only, never fetched pages: the snippet is the extracted passage already, and five of them fit in a 4096 token context where five pages do not. See [adr/0004](adr/0004-sources-vote-they-do-not-veto.md). |

## 7. Stack summary

```
apps/phone          Expo (dev build), TypeScript, ML Kit document scanner,
                    @noble/curves + @noble/ciphers, expo-secure-store
apps/desktop        Tauri v2. Rust: git2, image, Ollama supervision,
                    decryption, OS keyring. UI: React + TypeScript
apps/server         Node 24, Fastify, SQLite, zod. PM2 behind nginx
packages/protocol   zod wire schemas, shared by all three
packages/crypto     TypeScript crypto wrappers
packages/corpus     golden images, expected transcripts, scorer
```

## 8. Security model

The VPS is the untrusted component and is designed so that compromising it
yields nothing.

- It stores opaque ciphertext under a size cap. It never decodes an image.
- Device authentication is an Ed25519 challenge signature. There are no
  passwords and no email addresses on the box.
- GitHub credentials live only on the PC and never touch the VPS.

All content defence lives on the PC, which is the only place it can work:

1. The model returns **structured JSON validated by zod**, never free prose that
   could carry an instruction. Model output is data, never instruction.
2. Generated Markdown **never emits a runnable code fence**. The owner has the
   Obsidian `execute-code` plugin installed, which makes a generated runnable
   code block a real code-execution path inside the vault. Fences are downgraded
   to plain `text`.
3. No `templater` syntax, no `dataview` blocks, no `<script>`, no external image
   URLs, no wikilinks resolving outside the configured vault subtree.
4. Model-proposed titles and course names are sanitised against path traversal,
   Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`), and length, and
   are confined to the configured subtree.
5. Nothing is written to disk before the human approves the preview.

## 9. The feedback loop, stated honestly

Corrections are **in-context only. Model weights are never modified.**

| Tier | Mechanism | Used |
|---|---|---|
| In-context | Corrections become text injected into the prompt | Yes, v1 |
| Fine-tune (LoRA) | Trains an adapter onto the weights | No. Needs 500+ corrected pages, training outside Ollama, GGUF conversion. Under roughly 100 examples it overfits and makes output worse. |
| RAG glossary | Course vocabulary retrieved and injected | Yes, same mechanism as in-context |

True image few-shot is rejected: shipping example images plus transcripts inside
a prompt burns the context window of a 7B vision model. What accumulates instead
is text-only and cheap:

- **A per-course correction glossary.** The model reads `vamk`, you correct it to
  `rank`, and `rank` enters that course's term list. Given section 4's finding
  that domain priming is what makes the transcription work at all, this is the
  highest-leverage part of the loop.
- **Two or three short before-and-after snippets** capturing abbreviation habits.

The accurate description for a CV is "a correction loop that builds a per-course
glossary and few-shot prompt, with corrections doubling as regression tests".
Not "it learns". That second claim would not survive an interviewer's follow-up.

## 10. Testing strategy

Seven layers, all agreed. Layers 4 and 5 are the load-bearing ones.

1. **Deterministic unit and property tests**, no model: crypto round-trip, zod
   schema validation, Markdown emitter, filename and path sanitisation, git
   operations against a temp repo.
2. **Contract tests on `packages/protocol`**, executed by all three surfaces.
   This is what stops a phone-and-server desync reaching `main`.
3. **Cross-language crypto vectors.** The phone encrypts in TypeScript and the
   desktop decrypts in Rust, so there are two implementations. CI asserts TS
   encrypt to Rust decrypt byte-for-byte.
4. **Record and replay fixtures for the model layer.** Responses are cached on
   disk keyed by model id, prompt hash and image hash. CI replays them, needing
   no GPU and running in seconds. A `--record` flag refreshes them locally.
5. **Golden corpus with deterministic scoring.** Hand-written expected
   transcripts, scored by character error rate plus a required-terms list. A
   threshold gates the build, so a prompt change that degrades accuracy fails
   instead of silently making the notes worse.
6. **Adversarial corpus.** Photographs containing written prompt-injection text.
   Assert the injected instruction is never emitted and never acted on.
7. **One full end-to-end test** with a fake camera and a fake model: phone to
   server to PC to vault, asserting file contents and that a commit exists.

Every thumbs-down in the preview screen becomes a candidate corpus entry, so the
system generates its own regression tests as it is used.

## 11. Workflow

- Trunk is `main`. Direct pushes allowed. Branches only for awkward changes.
- The real gate is a **`pre-push` git hook**: typecheck, lint, em dash check,
  and the fast test suite. It refuses the push on failure. `--no-verify` is the
  documented escape hatch.
- GitHub Actions runs the same checks as a backstop, plus the slower
  cross-platform Tauri builds. Matrix: `ubuntu-latest` for server and packages,
  `windows-latest` for the desktop build.
- Model evals need a GPU, so CI runs replay fixtures only. `npm run eval` runs
  the real model locally and must pass before any prompt change is pushed.
- Conventional commits. Dependabot monthly.

## 12. Anti-drift rules

Mechanically enforced in CI and in the pre-push hook:

- A change under `packages/protocol/` **must** touch `docs/SPEC.md` in the same
  commit.
- A change to the config schema **must** touch `docs/SETUP.md` in the same commit.

Written rules with explicit paths and triggers live in `CLAUDE.md`. A rule that
cannot be checked by eye is not a rule.

## 13. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ~~Local model cannot read the handwriting well enough~~ | **RETIRED** | Answered by issue #1 on 2026-09-09. Linear pages work, diagram-dense pages need cloud escalation. See [adr/0001](adr/0001-local-first-transcription.md) |
| A good CER still hides semantic inversions | **High** | Measured: at CER 0.116 the model still flipped "not just violations" to "that just violate". Decision 21 (full preview editor) is the only mitigation, and decision 20 (mark added content) supports it |
| Corpus of two pages is too small to tune prompts against | Medium | Add pages before any prompt tuning is trusted. Decision 21 makes every correction a new corpus entry, so this fixes itself with use |
| Scope creep kills the project | **High** | `mk4x/Sort-Written-Notes`, created November 2025, is an empty repo. This exact idea has already failed once by never starting. The tracer bullet order in section 14 is the countermeasure |
| One month is optimistic for four surfaces | **High** | Section 3 non-goals are load-bearing. Cut further rather than half-finish |
| Diagram pages degrade badly | Medium | Decision 8 means the cropped original is always present and always correct |
| Vault repo bloat | Medium | Decision 24 |
| PC or keyring loss makes blobs unreadable | Medium | Decisions 15 and 17 |
| Expo native module friction (dev build required) | Medium | Verify the document scanner plugin builds before committing to it, during issue #1 |

## 14. Tracer bullet order

No UI work happens before the vertical slice is green.

Tracked as GitHub issues. Status as of 2026-09-09:

1. ~~**Model spike.**~~ **DONE** (#1). Local-first survives. See
   [adr/0001](adr/0001-local-first-transcription.md).
2. ~~**Vertical slice.**~~ **DONE** (#2). Fake phone, real server, real
   decryption, fake model, real vault with real git. 120 tests, CI green on
   Windows and Linux. Protocol documented in [SPEC.md](SPEC.md).
3. Cross-language crypto vectors, TypeScript encrypt to Rust decrypt (#3).
4. Recovery code for the desktop content key (#4).
5. Phone app: Expo capture, pairing, local backup (#5).
6. Desktop: Tauri shell and the preview editor (#6).
7. Setup wizard (#7).
8. Feedback loop and corpus growth (#8).

Note the Expo document-scanner plugin build check moved from step 1 to #5: the
spike answered the model question, which was the load-bearing unknown, and
verifying a native module build is better done when the phone app is scaffolded.

## 15. Open items

- ~~Sample photographs are not yet in the repo.~~ Added 2026-09-09, both pages
  present with hand-written references.
- ~~Default model choice is deliberately unset.~~ Resolved: `qwen2.5vl:7b`.
- ~~`llama3.2-vision:11b` is untested.~~ Resolved: it will not load on Ollama
  0.33.3 (`unknown model architecture: 'mllama'`). Recheck after an Ollama
  upgrade. `granite3.2-vision:2b` was also tested and rejected.
- **Degeneracy thresholds are tuned in-sample** on 10 recordings. Re-validate
  against held-out recordings once the corpus grows.
- **The corpus has four pages** (added page C, dense maths, and page D, an
  adversarial test page with a written prompt injection). Still small. Add more
  before trusting any tuning.
- **`prepForVault` currently emits 257 KB, against decision 24's roughly 200 KB
  target.** Either accept 257 KB or drop WebP quality from 80 to about 72. Not
  changed unilaterally because decision 24 names the number, and changing it
  means amending this document.
- **`prepForVault` emits 193 to 257 KB** depending on the page, against
  decision 24's roughly 200 KB target. The owner chose to keep WebP quality 80.
  Measured: page B 257 KB, page D 193 KB.
- `~/.gitconfig` has a typo: a `[uiser]` section alongside `[user]`. Harmless,
  worth fixing.

## 16. Lessons that cost real time

Recorded because each was a silent failure, which is the expensive kind.

- **A checker that cannot detect its own target protects nothing.** The em dash
  check passed on every run for four commits while matching nothing: Git Bash's
  `printf` does not interpret a `\u` escape, so the needle was a literal string.
  Every guard now needs a self-test proving it can fail. Wired into hook and CI.
- **Verify orientation before trusting a score.** Page A was first prepped with
  the wrong rotation, which would have read as a bad model rather than a bad
  pipeline.
- **A reference transcript can be wrong.** Page A's expected text was rewritten
  after contrast normalisation revealed the right-hand side was a table, not a
  free-form diagram. Scores against a wrong reference are worse than no scores.
- **Node strip-only TypeScript rejects parameter properties**, enums, namespaces
  and decorators. Assign fields explicitly.
