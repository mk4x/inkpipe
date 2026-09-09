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

**`keys.json` holds both private keys.** Losing the X25519 content key makes
every page still sitting on the server permanently unreadable. There is no
recovery code yet: that is issue #4, and until it lands, this file is worth
backing up somewhere you trust.

Storage today is a mode-0600 file, which is honest rather than ideal: anything
running as your user can read it. Moving to the OS keyring is tracked in the
same issue.

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
