---
image: page-c-max-flow-min-cut.jpg
difficulty: hard-maths
rotate: 0
partial: true
notes: >
  Upright, well lit, grid paper, blue ink. The hard thing here is not the page
  quality, it is the content: dense mathematical notation (summations with
  subscripted index sets, inequalities, set-valued function arguments) written
  fast and loosely.

  This is the case that tests whether LaTeX output is achievable, which Page B
  only touched lightly with a single O(log n).

  Marked partial: several tokens are genuinely ambiguous even to a careful human
  reader, notably the word before "reverse push" and the abbreviated graph
  argument on the "Find the max flow" line. Where a reading is uncertain the
  most plausible technical term is used, since that is also what a primed model
  should produce.
requiredTerms:
  - Capacity constraint
  - flow
  - arcs
  - Maximum flow
  - cut
  - conservation
  - Residual
  - bounded
  - forward
  - backward
  - cap
---

# Capacity constraint

$0 \le f(u,v) \le c(u,v)$ for all arcs

for all $v$, flow in = flow out

Maximum flow problem: given $G$

Find the max flow. $G, c, s, t$

Flow across any cut: $|f| = f(S,T)$

flow conservation only applies to cut position, rest cancel out

## Residual

reverse push, cancel flow, residual cap = push more

Min cap along path, all will have that cap

Why is flow bounded? Because

$|f| = f(S,T) = \text{flow}(S,T)$. All forward terms

under cap constraint: $f(S,T) \le c(u,v)$

Drop backward term: $\sum_{u \in S, v \in T} c(u,v) \le C(S,T)$

So $\max_f = |f| \le \min_{(S,T)} C(S,T)$

forwards $f(S,T)$

bounded by $\sum_{u \in S, v \in T} c(u,v) = C(S,T)$
