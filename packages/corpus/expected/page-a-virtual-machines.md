---
image: page-a-virtual-machines.jpg
difficulty: hard
rotate: 270
partial: true
notes: >
  The hard case. Photographed 270 degrees off upright, with a hard shadow band
  and glare, two ink colours, and spiral-binding curvature.

  This reference was transcribed from the PREPPED image (rotate 270, greyscale,
  contrast normalised, 1600px). That matters: on the raw image a careful human
  reader recovers roughly 60 percent, and after prep roughly 90 percent. The
  shadow band, not the handwriting, was doing most of the damage. The right hand
  side turned out to be a three column comparison table rather than the
  free-form diagram it appeared to be.

  Still marked partial: the arrow topology in the left half (which box feeds
  which) is not encoded here, because a human transcriber cannot recover it
  reliably either. Diagram fidelity is handled by decision 8 in PREPARATION.md
  (crop and embed the original) rather than by transcription accuracy, so a
  model is scored on text only.
requiredTerms:
  - Virtual Machines
  - VMM
  - vCPU
  - page table
  - Guest OS
  - privileged
  - TLB
  - Hypervisor
  - Host hardware
  - Binary
  - Dirty bit
  - trap
  - emulate
  - snapshot
  - migrate
  - Type 1
  - Type 2
  - Emulator
  - Java VM
  - Container
  - docker
---

# Virtual Machines

VMM manages vCPU and page table (shared)

Guest: proc1, proc2, proc3

When Guest OS does privileged instruct, what does VMM do?
More TLB misses, from overhead switching

To firmware -> guests
if 1 -> special OS -> guest Host
in -> all VMM app -> guests
-> Host OS

Hypervisor: VM1, VM2, VM3, each with kernel. VMM below them. Host hardware below that.

VM: send, returned back

## Binary tran, priv. ins.

When x86 is too dumb to trigger trap, VMM trapped, emulated if legal

VM repairs untouched but runs slower due to trap-and-emulate

Dirty bit: tracking changing pages as we migrate. Via snapshots, however.

## VM migrate

VM host to another?
Host 1, copy, send R/O, Host 2 create VM, Terminate, dirty, running

## Type comparison

| | Type 0 | Type 1 | Type 2 |
|---|---|---|---|
| Used for | Built for hypervisor | Cloud comp | Personal, easy |
| Trade off | cost, special hardware, software feature | | less efficiency |
| How | special Hardware | special OS | User process runs VM |

Emulator: software for other Architecture, slow execution

Java VM: virtualizes single app, not entire OS, abstraction for compose

Container: docker, lightweight, less flexible
