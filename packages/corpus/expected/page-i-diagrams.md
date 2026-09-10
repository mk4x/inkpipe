---
image: page-i-diagrams.png
course: General
rotate: 0
note: |
  The first corpus page with drawn diagrams on it, and the page that made
  diagram cropping real rather than theoretical. Written for the purpose: the
  owner said the three drawings "do not make sense, but just there for the
  thrill", which is exactly right for a test. What matters is that they are
  drawings, not what they mean.

  Three of them, deliberately different in shape:

  1. A mind map. Circled words joined by lines, spread wide across the page,
     with nodes near both margins.
  2. A flow chart. A vertical chain that branches left and right, mixing arrows
     with plain text.
  3. A small directed graph, circled single letters with arrows between them,
     sitting beside other writing rather than alone.

  WHAT IT MEASURED

  Detection works. qwen2.5vl:7b found all three on the first run, and two or
  three on later runs, so the count is not stable. Before this page every corpus
  page was written notes or dense mathematics and the model correctly returned
  nothing on all of them, which meant the detection path had never once been
  exercised.

  Three real defects came out of it, all in the validation rather than the
  model:

  - A box that OVERRUNS the page edge was being refused. The model gave the
    third drawing y 0.8 with h 0.3, a correct position with a sloppy height, and
    refusing it lost a diagram that was really there. Overrun is now clamped;
    only a box that STARTS off the page is refused.
  - Crops clipped the drawings. The right hand edge is where a 7B is
    consistently wrong: at 0.03 padding the mind map lost "Word" and
    "Something", at 0.06 the flow chart still lost "Succeed" and "get rich".
  - So the crop now takes its vertical band from the model and its WIDTH from
    the page. Vertical placement is the part the model is reliably good at, and
    on lined notes a drawing occupies the writing area anyway.

  The crops include the spiral binding and a strip of desk. That is the right
  trade: a complete diagram with clutter around it beats a tidy one with a node
  cut off.
---

This page tests the diagram feature

Here
Word
Brainstorm
Idea
Idea 2
Something

Diagram 2 - genius plan

Breach
Open
Fail <- Get data -> Succeed
go to jail
get rich

Drawing 3

IP -> L
B
A
Done
