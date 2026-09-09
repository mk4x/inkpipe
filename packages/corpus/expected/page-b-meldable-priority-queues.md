---
image: page-b-meldable-priority-queues.jpg
difficulty: tractable
notes: >
  Linear prose plus inline maths. Upright, evenly lit, loose-leaf grid paper.
  Transcribed by hand from the source image. This is the reference the scorer
  measures against, so it must not be edited to match a model's output.
requiredTerms:
  - Meldable
  - priority
  - binary heap
  - Leftist
  - rank
  - nil
  - O(log n)
  - Skew
  - deleteMin
  - singleton
  - subtree
---

# Meldable Priority Queues

Q.insert(e,p), p is priority. Q.init(). Purpose: find and delete minimum.
Q.findmin(), Q.deleteMin()

Higher prio is the smaller p val: 1 > 2

Maybe decreaseKey() or meld()

Normal struct is binary heap

Meld(Q,p): return new PQ with elems from p and Q
- Not possible with binary heaps
- Destructive: p and Q may not exist afterwards

## Leftist Heap

- Annotated binary tree (e,p,r), r is rank
- rank is distance to nil (closest empty node)
- Leftist: u.left().rank >= u.right().rank()
- parent = min(children) + 1 if 2 children, 1 if 1 child, or 0

Meld() O(log n) where n1 + n2 = n
- Look at rightmost path according to prio via right child
- Adjust ranks bottom up
- Switch left and right children to make leftist

Each subtree has at least 2^r - 1 nodes
Max rank of root is log(n+1)

insert: meld singleton heap with elem
deleteMin: remove root, meld children

## Skew Heaps

Leftist without rank
- Always switch subtrees (not just violations)
- "heavy": more nodes in subtree than the other ("light")
