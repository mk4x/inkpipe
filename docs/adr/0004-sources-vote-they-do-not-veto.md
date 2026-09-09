# ADR 0004: sources vote, they do not veto

**Date:** 2026-09-09
**Status:** Accepted. Measured on two pages, see the amendment below
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
| consistent | unverified | unchanged, as if research were off (see amendment) | yes |
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

## Amendment, same day: the provider is SearXNG, and the numbers exist

Two things changed after this was written, both from running it.

### Google's JSON API was abandoned

Four API keys across two Cloud projects were refused with
`This project does not have the access to Custom Search JSON API`, while the
console showed the API enabled and the project's own metrics showed our
requests arriving and erroring. That is not a configuration this project can
fix, and a search backend that depends on an account staying in good standing
is a backend that breaks again later.

The replacement is **SearXNG, self-hosted**. It queries Google underneath, so
the index is the same, and it needs no API key, no account, no quota and no
billing. It also deletes a whole class of problem: there is no credential to
leak, rotate, or accidentally commit, which matters because a key was leaked to
a public commit during this work.

It runs in Docker on the owner's existing VPS, bound to loopback, behind an
nginx location that requires a token header. Without that token it would be an
open search proxy for anyone who found the hostname.

Google remains supported. It is no longer the default.

### `unverified` was a veto in disguise

The first real comparison downgraded four of six terms on page F from `high` to
`low`, and every one of those four explanations was correct. The cause was this
document's own matrix: "page consistent, sources unverified" produced `low`.

That is wrong, and it contradicts the rule this ADR is named after. Google
having no page that defines the bare word "Language" is not evidence against an
explanation of it. Downgrading on silence is a veto with extra steps.

**An unverified term now behaves exactly as if research were switched off.**
Absence of evidence is not evidence. Sources may still label a term
`unsupported` when they actively argue against it, which is a real signal, and
that path is unchanged.

Two smaller fixes came from the same run. The course was not being passed into
the query, so "Epsilon" was searched as a bare word and returned the Greek
letter and several brand names. And extraction was picking instructions off the
page ("Remove redundancy") and copying the page's misspellings into queries
("Kleeny star"), both now handled in `expand.ts`.

### The numbers

Twelve terms, two pages, three samples each, hand graded.

| | page E | page F |
|---|---|---|
| terms | 6 | 6 |
| verdict changed | 1 | 1 |
| **regressions** | **0** | **0** |
| improvements | 1 (low to high) | 1 (refused to explained) |
| corroborated by sources | 5 of 6 | 3 of 6 |

Zero regressions is the number this ADR said would decide the question. Two
pages and twelve terms is a small sample and the corpus should grow before this
is treated as settled, but nothing here argues for keeping it off.

## Why the status originally said unmeasured

This is the first decision in the project taken **without** a spike behind it,
and that is a real difference from ADR 0001 and ADR 0003.

**The corpus cannot currently show an improvement.** Pages E and F scored nine
of nine correct by hand, with both invented controls refused. There is no
headroom to demonstrate a gain.

The number that decides whether this ships enabled is **regressions**: terms
that were correct without search and wrong with it. That run has now happened
and is recorded in the amendment above: zero regressions across twelve terms.

## What would change this

If a measured run shows regressions on well known terms, the fix is not to tune
prompts. It is to restrict search to the refusal path only, where retrieval has
the best evidence behind it and nothing to corrupt.

If the snippet classifier proves unreliable on real snippets, the fallback is to
treat `mixed` and `refuted` identically, since both already mean the same thing
to the reader: check this yourself.
