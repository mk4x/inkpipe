---
image: page-e-compiler-construction.jpg
difficulty: keyword-dense
rotate: 0
partial: true
notes: >
  Upright, grid paper, blue ink, evenly lit. A new course (Compiler
  Construction), so it is the first corpus page whose subject does not appear
  anywhere in the existing notes.

  The interesting property is that it is almost entirely terse keywords and
  arrow diagrams rather than sentences: "IR: LLVM language", "input code -> IR
  -> optimized code". This is precisely the case that motivated expansion, so it
  is the page to judge the expansion feature against.

  Marked partial: the arrow topology in the front-end pipeline is transcribed as
  a linear sequence, which is what it means, but the original is drawn as a
  diagram with side annotations.
requiredTerms:
  - Compiler Construction
  - Python
  - Interpreter
  - JIT
  - GCC
  - Front end
  - Back end
  - IR
  - LLVM
  - optimizer
  - Lexical Analysis
  - Token Stream
  - AST
  - Semantical Analysis
  - type checking
---

# Compiler Construction

x86, GNU as, ld, as

Most code in Python 3.10, OOP

Git

Compiler black box def: code program 1 -> code in another program.
Slow but highly optimized code gen.

Interpreter: execute and read the effect

JIT (just in time comp): int may produce machine/byte code

GCC: supps input lang. (C, C++ ...) and the output languages (machine code)

Front end Compiler -> IR -> Back end Compiler

Source lang on the left, target language on the right.

## IR

IR: LLVM language, more flexible

input code -> IR (LLVM) -> optimized code

IR -> optimizer -> IR

## Front end

Lexical Analysis -> Token Stream -> Syntaxical Analysis -> AST

Lexical Analysis: find words (keywords)

Syntaxical Analysis: see sentences created by "words"

-> Semantical Analysis, type checking, code gen
