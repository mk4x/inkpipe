# ADR 0001: Local-first transcription is viable, with mandatory prep and priming

**Date:** 2026-09-09
**Status:** Accepted
**Supersedes:** the untested assumption in PREPARATION.md section 4 conclusion 3

## Context

PREPARATION.md recorded that a local vision model on 16 GB of VRAM was "unlikely
to handle Page A acceptably" and marked that as **untested**. Issue #1 existed to
test it before any product code depended on the answer.

Harness: `packages/corpus/spike.mjs`, scored by `packages/corpus/score.mjs`
against hand-written references. Temperature 0, single run per cell.

## Results

qwen2.5vl:7b, CER (lower is better) and required-term coverage (higher is better):

| Variant | Page A CER | Page A cov | Page B CER | Page B cov |
|---|---|---|---|---|
| raw image, default 4096 context | HTTP 400 | - | HTTP 400 | - |
| raw image, 8192 context | 1.227 | 0.286 | **0.099** | 0.909 |
| prepped, plain prompt | 2.267 | 0.381 | 0.116 | 0.909 |
| prepped, course-primed prompt | **0.567** | 0.952 | 0.146 | 0.909 |

minicpm-v:8b, prepped and plain: Page A 3.319 / 0.095, Page B 3.373 / 0.091.
Both outputs were degenerate loops.

## Findings

**1. Local-first survives.** Page B at CER 0.099 to 0.146 with 91 percent term
coverage is a usable draft. Combined with the preview editor (decision 21), that
is a working product for linear note pages.

**2. The dominant failure mode is degenerate repetition, not misreading.**
qwen2.5vl:7b emitted "VM / Guest OS / Hypervisor / VM1 / VM2 / VM3" for 593
lines on Page A. minicpm-v:8b repeated "with (p, q)" 337 times on Page B. This
output is confidently wrong, arrives with HTTP 200, and would otherwise be
written into a note. It is also trivially detectable.

**3. Image preparation is mandatory, for two independent reasons.** A full
resolution page is roughly 4200 image tokens and hard-fails the default 4096
context. And on the rotated, shadowed Page A, prep moved CER from 1.227 to 0.567
and coverage from 0.286 to 0.952. Rotation is very likely the dominant term.

**4. Course priming is what prevents the loop.** On Page A, plain prompting
looped (CER 2.267, 57 seconds). The same image with a course glossary did not
loop (CER 0.567, 3 seconds). This confirms PREPARATION.md section 4 conclusion 2,
which was previously an argument rather than a measurement.

**5. Priming is not free.** On the easy Page B it slightly hurt: CER 0.116 plain
versus 0.146 primed. Priming helps dense or ambiguous pages and mildly harms
clean ones.

**6. Page A remains poor even at its best.** CER 0.567 is not a usable
transcript. It confirms decision 6 (opt-in cloud escalation) and decision 8
(always embed the cropped original) as necessary rather than optional.

**7. CER understates semantic risk.** At CER 0.116 the model still turned
"Adjust ranks bottom up" into "Adjust values bottom up", and inverted
"Always switch subtrees (not just violations)" into "that just violate". A good
score does not mean a safe note, which is exactly why decision 21 makes the
preview a full editor rather than approve-or-reject.

## Decisions

1. **Local-first is confirmed.** `qwen2.5vl:7b` is the default model.
2. **`minicpm-v:8b` is rejected.**
3. **Image prep is a required pipeline stage**, not a setting: orientation
   correction, greyscale, contrast normalisation, downscale to 1600px long edge.
4. **Course priming is a required prompt stage.** The per-course glossary is
   load-bearing infrastructure, not a later enhancement.
5. **Every transcript passes a degeneracy gate before reaching the preview.**
   `packages/corpus/detect-degenerate.mjs` separated all eight recordings
   correctly, rejecting exactly the four high-CER runs with no false positives.
   A rejected transcript is retried once, then surfaced as a failed page with
   the cropped original, never silently written.

## Caveats

Two pages, one run each, one prompt pair, two models. This is enough to choose a
direction and not enough to tune one. The coverage figure on primed runs is
partly inflated because the course glossary shares vocabulary with the required
term list, so **CER is the honest metric for the priming comparison** and it
moves in the same direction regardless.

`llama3.2-vision:11b` had not finished downloading when this was written and
remains untested.

## Consequences

- PREPARATION.md section 4 conclusion 3 is now resolved and its section 5 model
  choice is no longer open.
- Three new required pipeline stages (prep, priming, degeneracy gate) must appear
  in SPEC.md when it is written.
- The corpus needs more than two pages before any prompt tuning is trustworthy.
