# The narrative layer — a board that sees the operator

PM tools track the work. A hubd folder can also track the *human running it* —
and tell both stories as one narrative: task-tracks and the operator's life at
work, braided. This document is the design; the ready-to-use pieces live in the
[`hubd-company/`](../hubd-company/) template (`owner/`, `chronicle/`,
`recipes/chronicle.md`, `recipes/probe.md`, `scripts/behavior_metrics.mjs`).

## Why hubd can do this and generic trackers can't

Your hub is already a longitudinal behavioral corpus: **typed** tasks
(technical / communicative / decision), append-only journals with timestamps,
card history with dated decisions and gates. That's enough to compute things
no questionnaire or standup can give you:

- conversion by task type ("your communicative tasks age 10× faster than
  technical ones");
- the **divergence index** — attention share of your *declared* priorities vs
  where events actually happened;
- episodes — clusters of activity with <2h gaps: where your time actually went,
  with zero extra input;
- plan-vs-fact, gate discipline, abandonment curves.

## The three braids

A narrative needs more than work events. Model it as three streams with
**file-level** privacy, not policy-level:

| Braid | What | Where | Sync |
|---|---|---|---|
| **Work** | tasks, decisions, ships, card diffs | `journal.*.jsonl`, `tasks.*.events.jsonl`, card history | synced, as today |
| **Operator** | one-line mood/energy, day check-in/out, session marks | `journal.*.jsonl` via kind-convention | synced |
| **Life** | opt-in events outside work | `journal.life.jsonl` | **local only, gitignored, never leaves the machine** |

The owner defines what each braid may contain in an **operator card**
(`owner/<handle>.md`) — rhythm, interface preferences, and a Boundaries section
that agents may read but never edit. No boundaries confirmed → no operator/life
collection. The life braid simply doesn't exist until the owner creates it:
that's a feature, not a gap.

## The kind-convention (works today, no code changes)

Until the journal schema grows dedicated kinds, state entries are `note`s with
a prefix — trivially parseable, breaks nothing:

```
mood: <one line, the owner's own words — never an agent's paraphrase>
energy: <1–5> [+ why]
checkin: <one line in the morning>   checkout: <how the day ended>
session: <start/end of a work session, for the duration axis>
```

Anti-coercion rule: a missed check-in is not a debt. The system never reminds twice.

## The chronicle: chapters, arcs, years

- **Chapter = week** → `chronicle/<YYYY>-W<nn>.md`, append-only, four voices:
  **Chronicle** (prose: moved/stalled/shipped) · **Numbers** (behavior metrics) ·
  **The Critic** (past decisions with dates vs this week's facts — whoever set
  the gate judges whoever ignores it) · **Questions** (probes sent to the owner).
- **Arc ≈ 6 weeks** or one strategy shift — synthesized from chapters only.
- **Year** — from arcs.

Journals get grepped; chronicles get read — by the owner years later, and by
every fresh agent that needs the story so far in two pages.

A public cut of a chapter (build-in-public) contains the work braid only, after
the owner's manual review. Operator and life braids never leave the hub.

## Probes: build the profile with questions, not sensors

The cheapest profiling instrument is one good question at the right moment;
a paragraph of answer routinely closes a blind spot log-mining never would.
Anomaly sources: silent projects with open tasks · plan-vs-fact gaps ·
recurring entities without cards · overdue gates · stale owner-queue buttons ·
card-says-background-but-attention-spikes contradictions.
Rules: ≤1 probe/day, batched on the owner's strong day, curiosity framing,
never invent urgency, and the owner's answer outranks any inference from data.

## Gates on the layer itself

The layer plays by its own methodology. Trial: 4 weeks.
- **SCALE** if chapters get written AND read AND check-ins land on ≥50% of
  active days → promote recipes to server tools (`hub_chronicle`, `hub_probe`),
  extend journal kinds, surface owner presence.
- **KILL** if chapters go unread or check-ins stay empty → drop the ritual
  without guilt; keep only the passive metrics script (needs no input).
