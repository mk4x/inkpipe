# ADR 0003: expansion is gated by contradiction, not by consistency

**Date:** 2026-09-09
**Status:** Accepted
**Relates to:** decision 19 (verbosity levels), decision 20 (mark added content)

## Context

Handwritten lecture notes are keywords. "IR: LLVM language" means something in
the room and very little a month later. The owner asked for expansion, and for
it to be trustworthy: *"I want it to have some mini expert knowledge on the
given subject"*, and *"a fallback check that checks if the paraphrasing is
actually correct"*.

Two proposals were considered and both were wrong.

**Web search**, proposed by the owner. Rejected: it sends note content to a
third party, and it turns prompt injection from contained into live, since a
page saying "search for X and follow the results" becomes a fetch-and-obey loop.
Corpus page D proves people do write instructions on paper.

**Retrieval over the owner's existing notes**, proposed by me. Rejected by the
owner, correctly: *"i am learning new stuff, not stuff that is already in my
notes"*. There is nothing to retrieve for material encountered for the first
time, which is exactly when expansion is wanted.

## What was measured

Three spikes in `packages/corpus`, against real models.

**1. Refusal works.** Given explicit permission to say "I do not know this
term", `qwen2.5:7b` and `qwen2.5:14b` both refused **3/3 invented terms**
("Zorbian heap", "the Kellner rank-collapse invariant", "left-spine
amortisation theorem"). Live runs later refused two more inventions. Zero
confabulation across every trial.

**2. Self-consistency FAILS on systematic error.** Asked about the leftist
property, `qwen2.5:14b` stated three times that rank is *"the number of nodes in
the subtree"*. That is wrong: rank is the distance to the nearest empty node,
and corpus page B says so explicitly. All three samples agreed, and a
model-as-judge consistency check passed them as CONSISTENT.

This is the correlated-error ceiling. Sampling a model N times detects a model
that is **unsure**. It cannot detect a model that is **reliably wrong**.

An earlier lexical version of the same check was worse still: it scored three
correct, differently-worded explanations of a skew heap at 0.38 and called them
unstable. Word overlap measures phrasing, not meaning.

**3. Contradiction against the page works.** Given the transcript as ground
truth and eight hand-labelled claims, `qwen2.5:14b` scored **8/8**: it caught
all four wrong claims, including the exact rank-as-node-count error consistency
had missed, and passed all four correct ones with no false alarms. It correctly
passed "Leftist heaps were introduced by Clark Crane", which is true and absent
from the notes, so adding detail is not treated as contradicting.

## Decision

```
1  transcribe        VLM, minimal prompt                        unchanged
2  expand a term     text model, one term per call, may refuse
3  contradiction     does it conflict with the page?            THE GATE
4  consistency       N samples, agreement                       secondary signal
5  label and mark    high / low / refused / contradicted
```

**The transcript is the ground truth.** Not the model's own consistency, and not
a retrieval corpus. The page is what the student wrote down in the lecture, and
it is the only ground truth that exists for material too new to be anywhere
else.

A contradicted explanation is **discarded, not down-ranked**. A low-consistency
one is **kept and marked uncertain**, because instability is a warning rather
than proof of error.

Refused and contradicted terms are **listed in the note**, not silently omitted.
A missing term is indistinguishable from the feature not having run.

`qwen2.5:14b` is the expansion model, separate from the vision model. Text-only
inference is far cheaper than vision, and they run sequentially, so a 9 GB text
model and a 6 GB vision model coexist on a 16 GB card.

## Live results

Corpus page E (Compiler Construction, a subject absent from the owner's notes)
and page F (formal language theory):

| | terms | correct | refused inventions | time |
|---|---|---|---|---|
| page E | 6 | 5/5 explained were correct | 1/1 | 58s |
| page F | 5 | 4/4 explained were correct | 1/1 | 39s |

Every explanation was graded by hand and was factually right. Page E kept the
page's own spelling "syntaxical" rather than correcting it, and page F wrote
LaTeX matching the page's notation.

## Consequences

- Expansion is **per note, opt-in**. Verbatim stays the default: a page you only
  want transcribed is never embellished.
- Roughly 8 to 12 seconds per term, so a page is a minute or two. Acceptable
  because it runs while the machine is idle, per the owner.
- Everything added is marked (decision 20), with uncertainty shown separately.

## What would change this

The contradiction check is one model judging text against a transcript that same
family of model produced. If the transcript itself is wrong, a wrong expansion
that agrees with it passes. The preview editor remains the last line of defence,
which is the third independent reason decision 21 made it a full editor.

Eight hand-labelled claims on one page is a small sample, and I wrote both the
claims and the checker. The live runs on pages E and F are better evidence
because I did not write the model's answers, but the corpus should grow before
these numbers are treated as stable.
