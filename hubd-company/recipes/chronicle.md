# Recipe: chronicle — the weekly chapter

Turn a week of journal and task events into one page a human wants to read —
and will still want to read in five years. Run Monday morning for last week,
or on demand ("write the chapter"). Works with hubd MCP/CLI; degrades to
reading the files directly.

## Input
- `journal.*.jsonl` — entries for the week (Mon 00:00 … Sun 24:00).
- `tasks.*.events.jsonl` — add/done/set events for the week.
- Project cards + `projects/history/` — digest diffs.
- `node scripts/behavior_metrics.mjs --since <Mon>` — the numbers.
- A plan file, if one covers the week — for plan-vs-fact.
- `journal.life.jsonl` — ONLY if the owner keeps one; never quote it verbatim.

## Output
`chronicle/<YYYY>-W<nn>.md`, append-only (corrections are a new "erratum" line,
never a rewrite).

## Chapter template
```
# <YYYY>-Wnn · <dates>
*Written by <agent> on <date>. Coverage: <full week | partial, why>.*

## Chronicle
<5–12 lines of prose: what moved, what stalled, what SHIPPED (left the building).
Group by meaning, not by project. Link [[slugs]] and #task-ids.>

## Numbers
<from behavior_metrics: events per project + the DIVERGENCE INDEX (attention
share of the declared priority projects vs everything else) · task conversion
by cat · episodes: how many, median length · check-ins: N of M active days>

## The Critic (past-you)
<1–3 items: quote a gate/decision WITH ITS DATE → what the week actually did →
one-line verdict. Cards and journal only; no moralizing. The mechanic is
Ulysses-and-the-mast: whoever set the gate judges whoever wants to ignore it.>

## Questions
<0–3 probes from recipes/probe.md, already sent as buttons; copy the wording here>
```

## Rules
- Operator/life braids appear summarized ("energy dipped by Thursday"), never verbatim.
- Chapter ≤ 60 lines. Chronicles are read years later — write for that reader.
- An empty week is still a chapter (3 lines). Silence is data.
- After writing: journal entry `chronicle: chapter Wnn written`.
