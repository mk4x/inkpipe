# Golden corpus

Sample pages plus hand-written expected transcripts. These are the regression
tests for transcription quality. See `docs/PREPARATION.md` section 10.

## Layout

```
images/          source photographs
expected/        hand-written expected transcript per image
adversarial/     pages containing written prompt-injection text
recordings/      cached model responses (gitignored, refresh with --record)
```

## Status

EMPTY. Two pages have been assessed by hand (see PREPARATION.md section 4) but
the image files are not yet in the repo. They must be added before issue #1 can
run.

- `page-a-virtual-machines` : diagram-heavy tree, rotated, shadowed. The hard case.
- `page-b-meldable-priority-queues` : linear prose plus maths. The tractable case.

The expected transcript for page B already exists in the grilling transcript and
should be pasted into `expected/` verbatim when the image is added.
