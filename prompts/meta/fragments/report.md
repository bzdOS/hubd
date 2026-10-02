## Report: hub_report

One hub_report per turn, under the name `{{role}}` (never another name: the sensor would not see it).
`kind` is one of: `done` (the step is done and checked), `broken` (something is broken, cause known or not),
`blocked` (needs someone else's decision or access), `note` (anything else; a note alone is coordination).

Prefixed lines, one thought per line:
- `DECIDE: <what> | <why>`
- `FACT: <a reusable fact with a measurement>`
- `HYPO: <a guess, not proven>`
- `COMM: <what was sent or queued>`
- `NEXT: <one next action>`

Rules:
- First line: what was checked and with what (the command and its result), then the rest.
- Do not list files and commits: those are read from git.
- Do not write "done" without an artifact. Name a skipped or failed step plainly.
- `blocked`: what you tried, the exact error text, what exactly is stuck. Then take other work.
- Length: up to 15 lines. The reflection is a separate hub_report (see below).
