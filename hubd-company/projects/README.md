# projects/ — one card per project

A project card is the unit everything else hangs off: tasks point to it, the
kanban draws a lane for it, briefs summarize it. One markdown file per project.

## Card format

The sections are the engine's own scaffold (`hub card` creates the same set;
headings localise in ONE file, `HUB/sections.json`, which also drives report
routing — so cards and reports never drift apart):

```markdown
---
status: active        # active | paused | done
owner: product        # role or human responsible
parent:               # optional — sub-project or host this belongs to
related: []           # [[links]] to other cards
---
# project-slug

## Digest

3–6 lines: what this is, current state, what changed last.

## Next step

the one next action — who, by when

## Gates

kill / scale criteria — the honest metric to judge by, not vanity

## Metrics

current honest readings

## Market

who it is for; is paying demand proven?

## Facts & hypotheses

what is known (fact) vs what is being tested (hypothesis)

## Decisions

append-only log: decision · why · date

## Communication

what has gone out externally vs what is still queued
```

Keep the digest short and current — a card that lies is worse than no card.
Agents update it on handoff (`hub card <slug> -m "<digest>"` or by editing the
file); a structured `hub report` routes its DECIDE:/FACT:/COMM:/NEXT: lines
into the matching sections, creating a section if the card lacks it. Sections
you add by hand are preserved verbatim.

## Where cards come from

- **By hand:** copy `_example.md`, rename, fill.
- **From a dialog:** run `recipes/categorize.md` or the Harvest Protocol
  (`HARVEST.md`) — agents extract projects from conversations.
- **From a machine:** run `recipes/inventory.md` against a server — it writes
  hosts, services and endpoints as resource cards with typed edges (risks land
  as tasks), and `hub graph` draws the topology. Re-run it monthly; the diff
  is your drift report.
