---
image: page-f-formal-languages.png
difficulty: notation-dense
rotate: 0
partial: false
notes: >
  Compiler Construction, second page: formal language theory. A PNG rather than
  a JPEG, which is worth having in the corpus since the pipeline must handle
  both.

  The hard part is notation rather than handwriting: capital sigma as an
  alphabet, epsilon as the empty string, superscripts (sigma-zero, sigma-k,
  Kleene star), and set operators. Every one of those is a place the model can
  silently produce something that reads plausibly and means something else.

  Note "Kleeny star" is written that way on the page. The correct spelling is
  Kleene. That is deliberate corpus content: the expansion feature should be
  able to explain the concept, and must NOT quietly rewrite what the page says,
  because a transcript that disagrees with the paper is a transcript you cannot
  trust.
requiredTerms:
  - Remove redundancy
  - Avoid division
  - Bit shift
  - Optimize later
  - Micro syntax
  - keywords
  - alphabet
  - ASCII
  - epsilon
  - empty string
  - Kleen
  - language
---

# Compiler Construction

- Remove redundancy
- Avoid division (Bit shift)
- Optimize later (MVP -> optimize)
- Micro syntax: if, for, pass ... keywords, nums ...

$\Sigma$ = set of all pos. chars = the alphabet / ASCII

$\epsilon$ = "epsilon" = empty string = $\Sigma^0$

$\Sigma^k$ = set of all words over $\Sigma$ with exactly k chars

Kleeny star $\Sigma^*$ is set of all words $\in \Sigma$

Def: $L \subseteq \Sigma^*$ is a language
