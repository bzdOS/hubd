# hubd-company — your AI company in a folder

A template for running a mixed team of **AI agents and humans**: a constitution,
role onboardings, message queues, and ready-to-run procedures. Built on
[hubd](https://github.com/bzdOS/hubd) — everything is plain markdown files.

**Hiring an agent here is literally: a fresh session reads a role file.**
That's not a metaphor — it's how this template's authors hired their own CTO.

## What you get

```
AGENTS.md        the constitution: roles, delivery chain, rituals, rules
INBOX.md         append-only team journal (newest entries on top)
projects/        one card per project — the unit everything hangs off
roles/           onboarding docs — paste one into a fresh session to hire
  _vacancy.md      how to write a new role
  product.md       owns WHAT and WHY
  cto.md           owns HOW; the only role that commits
  dev.md           writes code strictly to spec
  pm.md            owns funnel, metrics, copy
  reviewer.md      reads code whole before acceptance
  qa.md            independent acceptance by the spec's tests
  sre.md           build, deploy, run, fix broken builds
  runner.md        cheap, fast, rote work by instruction
queues/          per-role task queues (agents block on them, then work)
recipes/         procedures any agent can run: triage, categorize, inventory
prompts/         wire-up blocks for every surface (MCP and no-MCP alike)
HARVEST.md       extract projects/tasks/decisions from any dialog, two words
examples/        what a real working day looks like in the journal
```

## Start in three steps

1. **Use this template** (button above) — or clone and copy the tree into an
   existing private repo. The structure doesn't need to be the repo root.
2. Edit `AGENTS.md`: put your name in as Owner, keep the roles you need,
   delete the ones you don't.
3. Open a fresh agent session, paste `roles/cto.md` (or any role) as the first
   message, point it at this folder. Your first employee is on the clock.

Add the [hubd](https://github.com/bzdOS/hubd) MCP server for queues, briefs and
the kanban — or don't: every file here works with any model that can read and
write files. No hubd required to start; it just makes things comfortable.

## How this works (the short version)

The team coordinates through files, in descending order of authority:
**git** (truth about code) → **spec files** (assignments with reports and
acceptance appended) → **INBOX.md** (the journal) → **queues** (addressed
delivery). Agents start every session with the same ritual: constitution →
git log → top of the journal → own queue. They end every piece of work the
same way: report → journal entry → back to waiting.

The human's job is decisions: priorities, hiring, vetoes. Everything else
moves without prodding.

## Watch: the kanban

With [hubd](https://github.com/bzdOS/hubd) connected, the dashboard renders this
folder as a **read-only kanban**: columns are task statuses, lanes are projects,
cards move because agents move them. There is exactly one button — **⚙ Rules** —
and it opens AGENTS.md. You don't manage the agents; you manage the rules.

## Feed it

Three ways content enters the company without anyone typing cards by hand:

- **Harvest a dialog** (`HARVEST.md`) — end any working chat with one prompt;
  projects, tasks and decisions land in the base.
- **Inventory a machine** (`recipes/inventory.md`) — point an agent at a
  server; get host → service cards with risks as tasks. Re-run = drift report.
- **Triage a pile** (`recipes/triage.md`) — meeting notes, brain dumps,
  email threads → deduplicated tasks with owners.

## Privacy

This template ships clean. Your filled repos are yours — keep them private.
The journal, queues and role files will contain your work; that's the point.
Template updates never touch your content: copy what you want, when you want.

## License

MIT.
