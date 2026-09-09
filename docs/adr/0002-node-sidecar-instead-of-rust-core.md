# ADR 0002: the desktop uses a Node sidecar, not a Rust core

**Date:** 2026-09-09
**Status:** Accepted
**Amends:** PREPARATION.md decisions 12 and 16
**Closes:** issue #3 as unnecessary rather than as done

## Context

Decision 12 said the desktop would be Tauri v2 with a Rust core handling git,
image cropping and Ollama supervision, and a React UI. Decision 16 put content
decryption in Rust so the private key never enters a webview.

Building it exposed a problem that was not visible at planning time.

**A Tauri webview is not Node.** The pipeline built for issue #2 is TypeScript
and depends on `sharp` for image preparation, which is a native Node module. It
cannot run in a webview. So the pipeline must either be rewritten in Rust, or
run in a Node process that Tauri spawns as a sidecar.

## Options

**A. Rewrite the pipeline in Rust.** Smallest binary, roughly 10 MB. Requires
reimplementing image prep, the Ollama client, the degeneracy gate, the
sanitiser, the vault writer, and the sealed box. Roughly 1500 lines of already
tested TypeScript becomes new, untested Rust.

**B. Node sidecar.** Tauri spawns the existing agent as a child process and the
UI talks to it over loopback. Binary grows to roughly 60 MB with a bundled Node
runtime, still far below Electron's 150 MB.

## Decision

**Option B.**

The deciding factor is not effort, it is correctness. Option A means the sealed
box exists twice, in TypeScript on the phone and in Rust on the desktop. Issue
#3 existed specifically to manage that risk with cross-language test vectors,
because two implementations of one cryptographic construction can silently
diverge and produce a system that appears to work until a specific input fails
to decrypt.

Option B **deletes that entire class of bug** rather than testing for it. One
`@noble` implementation runs on the phone, the server and the desktop. Issue #3
is therefore closed as unnecessary.

Secondary benefits: the 120 tests written for issue #2 keep their value instead
of becoming a reference implementation for a rewrite, and `sharp` keeps doing
the image work it already does correctly.

## Consequences

- **Decision 12 amended.** Tauri v2 remains the shell. The Rust side handles
  only what a shell must: window, tray, sidecar lifecycle, and OS keyring
  access. It does not implement pipeline logic.
- **Decision 16 amended.** Decryption happens in the Node sidecar, not in Rust.
  The private key still never enters the webview: it is held by the sidecar,
  which the webview can only reach through a loopback API.
- **Issue #3 closed as unnecessary.** There is one crypto implementation, so
  there are no cross-language vectors to write.
- **Binary size grows** from roughly 10 MB to roughly 60 MB. Accepted.
- **The sidecar must be bound to loopback and authenticated**, because any local
  process could otherwise call it. It uses a random token generated per launch
  and passed to the webview, so a different local process cannot drive it.

## What would reverse this

If the bundled Node runtime turns out to be a genuine distribution problem for
self-hosters, or if startup latency becomes unacceptable, option A is still
available. The TypeScript pipeline would then serve as the reference
implementation for a Rust port, and issue #3 would be reopened.
