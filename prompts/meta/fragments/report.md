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
- `HANDOFF: <what is done, what is half-done and where, the next step>`: replaces your own handoff section of the card;
  the session after you (or you after a compaction) starts from it. Write it when your state changes, not only at the end.
- `DONE: <task id>[, <task id>]`: closes the tasks, ids only, as hub_task_list shows them (`pine-471`); `#471` or
  `471` is read as the one task ending in -471. `#471 DONE` or `DONE #471` is not this form and refuses the report.

Rules:
- First line: what was checked and with what (the command and its result), then the rest.
- Do not list files and commits: those are read from git.
- Do not write "done" without an artifact. Name a skipped or failed step plainly.
- An event (published, merged, deployed, sent) is a FACT only once you observed it or its owner confirmed it;
  until then it is HYPO or "prepared". The card and the digest take the same rule: they outlive the turn.
<!-- wish: an event is a FACT only once observed or confirmed; no check -->
- `blocked`: what you tried, the exact error text, what exactly is stuck. Then take other work.
- Length: up to 15 lines, then the reflection block at the end of the same report (see below).
