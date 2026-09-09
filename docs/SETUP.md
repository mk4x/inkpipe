# Desktop setup and configuration

**This document and the config schema move together.** A change to
`apps/desktop/service/src/config.ts` without a change here fails
`scripts/check-doc-drift.sh`, in CI and in the pre-push hook.

---

## Before you start

You need three things:

1. **A server.** Yours, on a VPS you control. See [VPS_SETUP.md](VPS_SETUP.md).
   It prints a join token when you bootstrap it.
2. **An Obsidian vault that is a git repository.** inkpipe commits every note it
   writes, and it refuses to run against a plain folder.
3. **Ollama**, with a vision model pulled. `ollama pull qwen2.5vl:7b` is the
   measured default (see [adr/0001](adr/0001-local-first-transcription.md)).

## Running it

```bash
npm install
npm run ui:build
npm run desktop
```

The wizard walks six steps: server, vault, courses, model, recovery phrase, and
pairing. The model step checks whether Ollama is installed and running, offers
the exact install command for your platform if it is not, downloads the model
with a progress readout, and then **probes a real prepared page against the
context size** you chose. That last check exists because image token cost varies
more than fourfold between models, so a page that overflows fails mid-session
rather than degrading.

The service prints a URL with a one-time token in the fragment:

```
inkpipe desktop service listening on 127.0.0.1:5272
open: http://127.0.0.1:5272/#token=...
```

The token is generated per launch and is not stored. It exists because this
process holds your content private key and can write to your vault, so any other
local process must not be able to drive it.

For UI development, run the service and the Vite dev server side by side:

```bash
npm run desktop        # terminal one
npm run ui:dev         # terminal two, proxies /api to the service
```

## Where things live

| | Windows | Linux |
|---|---|---|
| Config | `%APPDATA%\inkpipe\config.json` | `$XDG_CONFIG_HOME/inkpipe/config.json` |
| Keys | `%APPDATA%\inkpipe\keys.json` | `$XDG_CONFIG_HOME/inkpipe/keys.json` |

**`keys.json` holds both private keys**, and they are **derived from your
recovery phrase**. That means the file is replaceable: type the phrase on a new
machine and the identical keys come back. Nothing needs backing up except the
phrase itself.

Storage today is a mode-0600 file, which is honest rather than ideal: anything
running as your user can read it. Moving to the OS keyring is still open.

## The recovery phrase

The wizard shows 24 words once, at setup, and never again. They are **not stored
anywhere**: not on this computer, not on your server. Nobody can retrieve them
for you.

They are worth writing on paper. Without them, if this machine dies, every page
still waiting on the server becomes permanently unreadable.

The same phrase also adds a second computer to the same account. Choose
**Restore from a recovery phrase** in the wizard on the second machine, and it
derives the identical keys and rejoins the existing account rather than creating
a new one.

Two things the wizard deliberately refuses to do:

- It will not let you past the phrase screen without ticking the confirmation.
- It will not overwrite an existing `keys.json` during a restore. A mistyped
  phrase derives valid-looking keys that open nothing, and overwriting good keys
  with them would turn a recoverable situation into a permanent loss. Move the
  file aside yourself if you really mean to.

If a restore reports that the server has no record of your phrase, you almost
certainly typed the wrong server address. Nothing was recovered, and a new empty
account was created instead.

## The config file

```jsonc
{
  "version": 1,

  "serverUrl": "https://inkpipe.example.com",
  "deviceId": "uuid, assigned by the server during setup",

  "vault": {
    "root": "C:\\Users\\you\\vault",   // must be a git repository
    "notesPath": "School/Semesters/Semester 5",
    "attachmentsPath": "Images",
    "autoPush": false,                 // decision 7: pushing is a separate step
    "remote": "origin",
    "branch": "main"
  },

  "courses": [
    { "name": "Algorithms and Data Structures", "glossary": ["leftist heap", "meld"] }
  ],
  "defaultCourse": "General",

  "model": {
    "name": "qwen2.5vl:7b",
    "host": "http://127.0.0.1:11434",
    "numCtx": 4096,
    "timeoutMs": 180000
  },

  "formatting": {
    "math": true,
    "tables": true,
    "lists": true,
    "headings": true,
    "whitespace": true
  },

  "expansion": {
    "enabled": false,
    "model": "qwen2.5:14b",
    "samples": 3,
    "agreementThreshold": 0.5,
    "maxTermsPerNote": 12
  },

  "pollSeconds": 60,
  "verbosity": "cleaned",
  "cloudEscalationEnabled": false
}
```

### Fields that deserve explanation

**`courses[].glossary`** is not cosmetic. ADR 0001 finding 4 measured that
course vocabulary is what stops the model collapsing into a repetition loop on a
dense page: the same image went from a 593 line loop to a clean transcript
purely by adding a course glossary. It grows automatically from your corrections
in the preview editor, so it gets better with use.

**`model.numCtx`** is per model, not universal. ADR 0001 finding 3b measured the
same prepared page costing `qwen2.5vl:7b` about 1600 image tokens and
`granite3.2-vision:2b` 7529. If you change the model, check this: a page that
overflows the context fails with an HTTP 400 rather than degrading gracefully.

**`formatting`** controls how the raw transcript is tidied before you see it.
The model returns serviceable but scruffy Markdown: mixed bullet characters,
tables missing their alignment row, Unicode maths that renders inconsistently,
and stray H1s that fight the note title.

| pass | what it does |
|---|---|
| `math` | wraps high-confidence expressions in `$...$` and converts Unicode operators to LaTeX, so `O(log n)`, `2^r - 1`, `n2` and `h1 + h2` render properly |
| `tables` | adds the alignment row Obsidian needs, without which a table shows as raw pipes, and pads ragged rows |
| `lists` | one bullet character, indentation in clean two-space levels |
| `headings` | demotes stray H1s so the note has exactly one |
| `whitespace` | collapses blank line runs, strips trailing spaces, ensures a final newline |

The governing rule is **normalise, never invent**. Every pass is conservative
and reversible in meaning, because a formatter that guesses at mathematics and
gets it wrong is worse than one that leaves the text alone: a mangled formula in
a study note reads as authoritative. Unicode arrows in prose are left alone,
ordinary sentences are never wrapped in maths delimiters, and **nothing inside a
code fence is ever touched**.

The formatter runs before the safety pass, never after, so sanitisation always
has the final word on what reaches your vault.

If a pass gets in your way, switch it off. A tidy note passed through the
formatter comes out byte-identical, which is asserted by a test.

**`verbosity`** has three values, not a slider, because three have testable
meanings and a slider does not.

| value | behaviour |
|---|---|
| `verbatim` | transcribe only, add nothing |
| `cleaned` | transcribe, expand abbreviations, format properly |
| `expanded` | add short explanations where the notes are only keywords |

Anything the model adds that is not on the page is marked with a callout in the
note. That is decision 20 and it is not configurable: with study notes you must
always be able to tell what you wrote from what a machine inferred.

**`expansion`** turns terse keywords back into prose. Off by default.

Handwritten notes are keywords, and "IR: LLVM language" means little a month
later. The obvious implementation asks a model to explain it, and the obvious
implementation is dangerous: a small model produces fluent, plausible,
occasionally wrong text, and wrong text in study notes is worse than no text.

So every explanation passes a gate: **does it contradict the page it came
from?** That check scored 8/8 on hand-labelled claims, catching an error that a
consistency check had passed three times running. See
[adr/0003](adr/0003-expansion-is-gated-by-contradiction.md) for the measurements.

| outcome | what happens |
|---|---|
| **contradicted** | discarded, and listed as not explained |
| **refused** | the model said it does not know the term. Listed, not hidden |
| **low** | kept, marked *(uncertain)*: the model wavered across samples |
| **high** | kept, marked as model-added per decision 20 |

`model` is a **text** model, separate from the vision one. They run
sequentially, so a 9 GB text model and a 6 GB vision model coexist on a 16 GB
card. `samples` controls the consistency signal only: raising it costs time
linearly and detects wobble, never systematic error, so 3 is plenty.

Budget roughly 8 to 12 seconds per term. A page of 10 terms is about two
minutes, which is why `maxTermsPerNote` exists.

One limit worth knowing: the check compares an explanation against the
transcript. If the transcript itself is wrong, an explanation that agrees with
it passes. The preview editor is the last line of defence, which is a third
independent reason it is a full editor rather than approve-or-reject.

**`cloudEscalationEnabled`** defaults to `false` and stays opt-in. Even when
enabled, each escalation is confirmed per note, so nothing spends money without
asking.

**`autoPush`** defaults to `false`. Writing and committing is one step, pushing
is another, deliberately.

## Editing the config by hand

It is validated on load. A bad value fails loudly with the exact field path
rather than silently falling back to a default, because a silently wrong vault
path would write your notes somewhere you never look.

## Troubleshooting

**"is not a git repository"** during setup. inkpipe commits notes, so the vault
must be a repo. `git init` in the vault folder, commit once, and retry.

**The vault pill is red.** The path is wrong, or the folder stopped being a repo.

**The clean tree pill is red.** You have uncommitted changes in the vault.
inkpipe refuses to commit alongside your own work, because that would make its
commits impossible to revert cleanly. Commit or stash, then retry.

**The model pill is red.** Ollama is not running, or is not on the configured
host. Start it with `ollama serve`.

**A page says it could not be transcribed.** The degeneracy gate rejected the
output, which means the model looped rather than read. The photograph is still
in the note. Retry with a better-lit or straighter shot, and see ADR 0001 for
what actually drives accuracy: rotation, single-column layout, and larger
mathematical subscripts. Paper ruling is not a factor.
