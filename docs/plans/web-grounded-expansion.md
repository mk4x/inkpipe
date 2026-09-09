# Plan: web grounded expansion

**Status:** agreed with the owner, not built.
**Date:** 2026-09-09
**Becomes:** ADR 0004 when implemented, plus decision 31 in PREPARATION.md.

Written so a fresh session can pick this up without re-deriving it.

## The hole this closes

Expansion today (ADR 0003) is gated by one question: does the explanation
contradict the page? That works when the page says something. The owner writes
keywords, so usually the page says nothing on the point, and the gate passes
whatever the model believed. There is no external authority anywhere in the
loop.

Owner, three times, and correct: *"it would be nice that it fact checks stuff
instead of just randomly reasoning about it"*.

## The risk this must not create

Retrieval helps for obscure and recent material. It hurts for well known
material, because undergraduate computer science is saturated in pretraining
while the average search result is a content farm. The one real error we have
caught is a case in point: the model called a leftist heap rank the number of
nodes in the subtree. Searching that term returns pages using rank, s-value,
dist and null path length, some conflating rank with size. That evidence could
entrench the error as easily as fix it.

**So sources get a vote, not a veto.** They may challenge an explanation. They
may not supply one, except in the single case where the model has no explanation
to challenge.

## Decisions locked

| Question | Decision | Who |
|---|---|---|
| Search at all | Yes | owner |
| Snippets or fetch pages | Snippets only. No page fetching, no HTML parsing | owner |
| Provider | Google Programmable Search JSON API | owner |
| Quota | 100 queries a day free tier is enough | owner |
| Batch terms per query | **No.** Ranking depends on a focused query | mine, owner's idea corrected |
| Quota strategy | Cache by term, and search only on demand | mine |
| Sources may rewrite an explanation | Only when the model refused | mine, unopposed |
| Injection handling | Keep it, costs nothing, output is already inerted | mine, owner waived the security case |

The owner explicitly waived the privacy and threat-model objections: *"it
doesnt leak anything and we dont need that much security since they pick their
own vps"*. Term only queries stay anyway, because a term is what makes a good
query, so privacy comes free rather than as a constraint.

## Design

Three stages, matching the shape the owner proposed (reader subagents, then a
checker and writer).

```
1  explain        as today, may refuse                        unchanged
2  contradiction  does it conflict with the page?             unchanged, THE GATE
3  search         one query per term, snippets only           new
4  read           per snippet: supports / contradicts / irrelevant   new, the subagents
5  judge          weigh the snippet verdicts                  new, the checker
6  label          high / low / refused / contradicted / unsupported
```

Stage 4 is one small model call per snippet, each a bounded three way
classification rather than open generation. Small models are far better at that
than at synthesis, which is the same reasoning that split ADR 0003 into steps.
It also sidesteps the context limit: expansion runs at 4096 tokens and five
snippets summarised individually fit where five fetched pages never could.

### When search runs

Not on every term. Two triggers:

- **The model refused.** This is the long tail where retrieval is known to help
  and where there is no parametric knowledge to corrupt. Here, and only here,
  sources may supply the explanation, written strictly from snippets.
- **The explanation passed the contradiction gate.** Search is a second,
  independent authority. It can downgrade to `unsupported`, never overwrite.

A term that was already contradicted by the page is dead and costs no query.

### Invented terms get a better detector

"The Vandermeer register pass" returns nothing coherent. No relevant snippets is
positive evidence that a term does not exist, which is stronger than the current
signal, that being the model declining to guess.

### Quota

100 queries a day, roughly 12 terms on a dense page.

- **Cache by normalised term, persisted.** A semester of notes repeats terms
  heavily. This is the large win and should be built first.
- **Only the two triggers above**, not every term.
- Refuse to run and say so when the daily budget is spent, rather than silently
  degrading to unsourced expansion.

## Files

New:

- `apps/agent/src/search.ts` provider, query construction, term guards. The one
  place anything leaves the machine. A draft of this exists only in the previous
  session transcript, not on disk.
- `apps/agent/src/evidence.ts` snippet classification, the judge, caching.

Changed:

- `apps/agent/src/expand.ts` add `unsupported` to `Confidence`, carry `sources`
  on `Expansion`, render citations in `renderExpansions`.
- `apps/desktop/service/src/config.ts` new `research` block.
- `apps/agent/test/egress.test.ts` **currently uncommitted.** Its allow list
  forbids `google.com` outright and its negative control asserts that a Google
  search URL is rejected. Both must become "only the configured provider
  endpoint", and it must gain a test that note content cannot reach a query.

## Config

```
research: {
  enabled: false,               // off by default until measured
  provider: 'google',
  apiKey: '',                   // secret, not in config.json, see below
  cx: '',                       // programmable search engine id
  maxQueriesPerDay: 100,
  snippetsPerTerm: 5,
}
```

The API key is a credential and must not sit in a plain config file next to
vault paths. Put it where the join token already lives, and have the setup
wizard collect it.

## Documentation obligations

Not optional, the drift check enforces the first two.

- **CLAUDE.md rule 4 currently forbids this outright**: model output is "never
  used to construct a network request". Terms come from a transcript, which is
  model output, so this feature contradicts a recorded rule. Amend it to allow a
  length capped, single line term sent to a configured provider, and keep the
  part that matters, which is that a model can never choose the destination.
- `docs/SETUP.md` for the config schema change.
- `docs/PREPARATION.md` decision 31, and `docs/adr/0004-*.md`.
- CLAUDE.md's "Project state" and "Layout" sections are both stale. State says
  there is no code. Layout still says Tauri and Rust, which ADR 0002 replaced.
  Fix while in there.

## Tests

Scripted, no network, no model, same approach as `expand.test.ts`:

- a query is never built from multiline or over length input
- a whole transcript passed as a term throws rather than searching
- provider construction fails loudly on missing credentials
- snippets classified irrelevant do not count as support
- an unsupported explanation is marked, kept, and visibly labelled
- a refused term explained from sources is labelled as source written
- sources cannot overturn the page contradiction gate
- no relevant snippets on an invented term keeps it refused
- cache returns without a second query
- the day budget stops queries and reports rather than degrading silently
- egress: the only allowed non local host is the configured provider

## How we decide whether it ships on by default

**The current corpus cannot show an improvement.** Pages E and F scored nine of
nine correct by hand with both invented controls refused. There is no headroom.

The number that decides this is **regressions**, meaning terms that were correct
without search and became wrong with it. Search must be off by default until a
side by side run exists.

The owner is supplying more corpus images, on lined paper rather than the grid
paper used so far. Issue #8 (feedback loop and corpus growth) is the blocker
and should come first.

Harness: extend `packages/corpus/expand-live.mjs` to run each term twice, with
and without research, and print the two verdicts side by side for hand grading.

## Open items

- Where the API key is stored, and the wizard step that collects it.
- Whether `unsupported` is rendered as a warning callout or an inline marker.
- Cache location and whether it expires at all.
