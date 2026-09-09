# inkpipe

Photograph handwritten notes on your phone. They arrive as formatted Markdown in
your Obsidian vault, transcribed by a local vision model on your own PC.

**Status: planning.** No code yet. Start with [docs/PREPARATION.md](docs/PREPARATION.md).

```
phone (Expo)          VPS (Fastify)         PC (Tauri + Ollama)      vault (git)
-----------           --------------        -------------------      -----------
capture pages    -->  hold opaque      -->  poll, decrypt,      -->  write .md
encrypt to PC         ciphertext            transcribe, preview      commit, push
keep local copy       delete on ack         approve or edit
```

## Why the middle box is dumb

Your PC is not always on, so something has to hold the photos in between. That
something is a VPS you own, and it holds **ciphertext it cannot read**. The phone
seals every image to your PC's public key during QR pairing. The server never
decodes an image, never runs a model, and never sees your vault.

An attacker who fully owns the server gets device public keys, blob sizes, and
unreadable bytes.

## What it does

- Multi-page capture with automatic deskew and shadow removal
- Local transcription via Ollama, with optional per-note escalation to a cloud
  model that never runs without asking
- LaTeX for maths, cropped originals for diagrams, plus an unverified Mermaid
  attempt you can promote if it happens to be right
- A full preview editor before anything is written, because your corrections are
  both the quality signal and the regression tests
- Three verbosity levels, and anything the model added that was not on the page
  is visibly marked

## Self-hosting

Everything personal (vault path, courses, server URL, model, quotas) is
configuration collected by a setup wizard. Nothing is hardcoded.

See [docs/VPS_SETUP.md](docs/VPS_SETUP.md).

## Documentation

| | |
|---|---|
| [docs/PREPARATION.md](docs/PREPARATION.md) | Goals, non-goals, every decision and its rationale, risks, build order |
| [docs/VPS_SETUP.md](docs/VPS_SETUP.md) | Server setup from a fresh Ubuntu box |
| [CLAUDE.md](CLAUDE.md) | Rules for agents and humans working in this repo |

## License

MIT
