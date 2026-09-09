# ADR 0004: sources vote, they do not veto

**Date:** 2026-09-09
**Status:** Accepted, unmeasured
**Relates to:** ADR 0003, decision 31, CLAUDE.md rule 4

## Context

ADR 0003 gates every expansion on one question: does the explanation contradict
the page it came from? That was the right call and it scored 8/8 on hand
labelled claims. It also has a hole that ADR 0003 named in its own closing
section and did not fix.

**The page is usually silent.** The owner writes keywords. "IR: LLVM language"
contradicts almost nothing, so the gate passes almost anything. Where the page
says nothing, the model's own belief is unchallenged, and the only other check
in the chain is the same model judging its own output.

The owner raised this three times, most plainly as *"it would be nice that it
fact checks stuff instead of just randomly reasoning about it"*. ADR 0003
rejected web search on injection and privacy grounds. The owner overruled both:
*"it doesnt leak anything and we dont need that much security since they pick
their own vps"*. That is his call to make on his own tool, and the injection
handling costs nothing to keep, so it was kept rather than argued about.

## The risk this creates

Retrieval is not free accuracy. It helps on obscure and recent material and
**hurts on well known material**, where the model's parametric knowledge is
strong and the median search result is a content farm.

Undergraduate computer science is the best represented material in any
pretraining set. The one real error the project has caught is a case in point:
the model called a leftist heap rank "the number of nodes in the subtree".
Searching that term returns pages using rank, s-value, dist and null path
length, some conflating rank with size. That evidence could entrench the error
as easily as correct it.

So the danger is not that search fails to help. It is that search actively
regresses terms that were already right.

## Decision

**Sources get a vote, not a veto.**

```
1  explain        text model, one term, may refuse            unchanged
2  contradiction  does it conflict with the page?             unchanged
3  search         one query per term, SNIPPETS ONLY           new
4  read           per snippet: supports / refutes / irrelevant    new
5  judge          combine snippet verdicts                    new
6  label          the matrix below
```

| page | sources | outcome | text kept |
|---|---|---|---|
| consistent | supported | high | yes |
| consistent | unverified | low, "unverified" | yes |
| consistent | refuted | **unsupported**, flagged | yes |
| consistent | mixed | **unsupported**, "sources disagree" | yes |
| contradicts | supported | **disputed**, both shown | yes |
| contradicts | anything else | contradicted | no |
| refused | supported | **sourced**, written from snippets | yes |
| refused | nothing relevant | refused, "may not exist" | no |

Three properties fall out of that table and are the whole decision.

**Only the page can delete an explanation.** Sources can label, never remove.
This is the direct answer to the regression risk: a content farm cannot outrank
a correct answer, it can only get the reader told to check.

**Sources may write in exactly one case.** When the model refused, there is no
parametric answer to corrupt, and that is precisely the long tail where
retrieval is known to help. Everywhere else the model's explanation stands and
sources judge it.

**Disputed resolves nothing.** When the page and the sources disagree, both are
put in the note and the human decides. A page that is itself wrong is the case
the page-as-ground-truth gate handles worst, and quietly picking a winner would
be the same mistake in the other direction.

### Snippets only

Result pages are never fetched. The engine's snippet is the relevant passage
already extracted, and skipping the fetch removes HTML parsing, redirects,
timeouts, paywalls and bot walls. It is also forced by arithmetic: expansion
runs at 4096 tokens, and five fetched pages as text do not fit while five
snippets read one at a time do.

### Invention detection improves

An invented term returns snippets about something else, so every one classifies
as irrelevant. No relevant source is positive evidence that a term does not
exist, which is stronger than the previous signal of the model declining to
guess.

## Consequences

- **CLAUDE.md rule 4 had to be amended.** It said model output is "never used to
  construct a network request", and terms come from a transcript. The amendment
  keeps the part that matters, that a model can never choose a destination, and
  permits a length capped single line term to a configured provider.
- Google Programmable Search, 100 queries a day free. The term cache is what
  keeps that sufficient, since a semester of notes repeats terms heavily.
- The API key lives beside the keystore, not in `config.json`, which is the file
  people paste into an issue when asking for help.
- A contradicted term still costs a query. The plan said it would not. That
  changed because the disputed outcome is the point: skipping the search on a
  contradicted term would skip the case where the page is wrong.
- Roughly five extra small model calls per term. Expansion runs while the
  machine is idle, and the owner has said repeatedly that time is not the
  constraint.

## Status is Accepted, unmeasured

This is the first decision in the project taken **without** a spike behind it,
and that is a real difference from ADR 0001 and ADR 0003.

**The corpus cannot currently show an improvement.** Pages E and F scored nine
of nine correct by hand, with both invented controls refused. There is no
headroom to demonstrate a gain.

The number that decides whether this ships enabled is **regressions**: terms
that were correct without search and wrong with it. Until a side by side run
exists, `research.enabled` defaults to false.

## What would change this

If a measured run shows regressions on well known terms, the fix is not to tune
prompts. It is to restrict search to the refusal path only, where retrieval has
the best evidence behind it and nothing to corrupt.

If the snippet classifier proves unreliable on real snippets, the fallback is to
treat `mixed` and `refuted` identically, since both already mean the same thing
to the reader: check this yourself.
