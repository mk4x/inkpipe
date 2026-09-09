# ADR 0005: a window, without adding a runtime

**Date:** 2026-09-09
**Status:** Accepted
**Relates to:** ADR 0002, decision 25

## Context

ADR 0002 replaced the planned Tauri and Rust core with a Node service and a
React interface served on loopback. That decision was right and is not reversed
here. It had a consequence nobody wrote down: the application opened in a
browser tab, started from a terminal, with no window, no icon and no installer.

The owner, on being told the pipeline worked end to end: *"but i asked for a
desktop app. so what went wrong? where is the desktop app? never saw it."*

He was right. Every property of a desktop application was true except the ones
he could see. It runs on his machine, holds his private key, talks to his local
model, and writes to his vault. It just did not look like anything.

Decision 25 also asked that setup do everything, including installing Ollama.
None of that existed.

## Options

**Electron.** Ships a whole Chromium to display a page, adding roughly 150 MB
to carry a browser that Windows already has. Rejected on size for no gain.

**Tauri.** A small binary and a good fit, but it needs a Rust toolchain, and
ADR 0002 removed Rust from this project deliberately. Reintroducing it for a
window would undo that for cosmetics.

**A single executable.** Node 24 supports single executable applications. It
does not work here: SEA cannot embed a native addon, and `sharp` is one.

**A chromeless browser window.** Chromium based browsers accept `--app=URL`,
which opens a window with no address bar, no tabs, and its own taskbar entry.
Edge ships with Windows, so on the target platform it is guaranteed present and
costs nothing at all.

## Decision

**`--app=` on a browser that is already installed.** Edge first because it is
guaranteed, then Chrome, then Brave. If none is found the launcher prints a URL
and everything still works, so a missing browser degrades the appearance rather
than losing the application.

The window gets **its own browser profile**, for two reasons that are not
cosmetic. Without it the window joins the user's ordinary session, so closing
their last unrelated tab can take inkpipe with it. And this page renders
decrypted notes, so it must not inherit whatever extensions they have installed.
Extensions are disabled explicitly as well.

**The window is the application.** Closing it exits the service. Leaving a
process running that nothing points at, holding a private key, is worse than
useless.

**The port is chosen by the operating system**, not fixed. A fixed port fails on
second launch, and could collide with something already listening on a service
that holds the content key.

### The installer

Inno Setup, producing a 32 MB `inkpipe-setup-x.y.z.exe`.

- **Per user, no administrator.** This holds a private key and writes to a
  personal vault. It has no business in Program Files.
- **A bundled `node.exe`.** The machine needs nothing installed beforehand, and
  whatever Node the user has is irrelevant, because the shortcut runs the
  bundled runtime by absolute path. Only `node.exe` ships: npm, headers and
  documentation are another 26 MB that nothing here runs.
- **Started through a VBScript.** Running `node.exe` from a shortcut flashes up
  a console and leaves it on the taskbar all session, which was a large part of
  why this did not feel like an application.
- **Ollama is detected, not installed.** The installer says if it is missing and
  the in-app setup screen offers to install it. That download is gigabytes and
  belongs behind a progress bar the user can cancel, not inside a silent
  installer step.
- **Uninstalling removes the window profile and nothing else.** `keys.json` is
  derived from the recovery phrase, and losing it makes every pending page
  permanently unreadable, so an uninstall must never destroy it quietly.

## Consequences

- No new runtime, no Rust, no 150 MB of Chromium.
- The dependency is now "a Chromium based browser exists", which on Windows is
  the same as "Windows is installed".
- Source ships as TypeScript and is run by Node 24 type stripping, so the
  installer contains no build output except the interface bundle.
- The build needs Inno Setup, which is not a runtime dependency. `npm run
  installer` finds the compiler and says how to install it if it is missing.

## What this does not do

There is no tray icon, no automatic update, and no code signing. Unsigned means
SmartScreen will warn on first run, which is the honest state of a personal
project and not worth a certificate yet.

macOS and Linux get the launcher, since the browser detection covers them, but
no installer. Nobody has asked for one.
