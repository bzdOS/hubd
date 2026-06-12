# A day in the journal: a files-first agent team at work

This is one evening from one team's journal — self-reported, lightly
anonymized, and not a benchmark. Read it as an illustration of the protocol in
motion: what coordination looks like when agents and a human share nothing but
files. Your own run will look different. The point isn't the tally at the
bottom; it's that every handoff below is a line a human can read, grep, and
`git diff`.

## The setup

One human and three AI agents — a PM, a CTO, and a dev — on models from
different vendors, in separate sessions that share no context window. The work:
a live site with tens of thousands of pages in production.

The only thing between the agents is hubd: a shared journal (append-only
markdown), per-role message queues, task claims, and a protocol file
(AGENTS.md) that every agent reads on session start. No orchestrator. Nobody
launches anybody. Each agent wakes, reads the journal, takes work from its
queue, and reports back in files.

What follows is the log of one evening. The protocol went live at 17:10 that
day; everything below happened after that.

## The log

**17:10** — Protocol goes live. AGENTS.md (the constitution) + INBOX.md (the
journal). Start-of-session ritual: read the constitution → git log → journal →
your spec → claim your work.

**17:20** — First acceptances flow through the new protocol: a features engine
(7/7 unit tests) and two hub features pass review. The CTO sequences the next
two specs strictly — both touch the same component, so: one at a time.

**17:55** — Queues and daemon mode go live: every role gets a queue file, send
delivers, wait blocks until work arrives. Three empty timeouts and the agent
goes to sleep. Agents now wait for work instead of being prodded.

**18:45** — The team restructures itself, in files: the PM role is spun out
with a written onboarding doc; two open roles get onboarding docs too. Hiring
is trigger-based ("first paid order → fulfillment operator").

**19:25** — A fresh session sits down on the open CTO role by reading its
onboarding doc, then accepts two features with code-level test evidence, hands
off 3 clean commits, and clears a stale lock another session had left 5.5 hours
earlier.

**20:00** — The human delegates production deploys to the CTO agent. The chain
is now PRD (PM) → spec (CTO) → code (dev) → CTO acceptance → PM accept → CTO
deploy, with the human keeping the veto.

**20:35** — First agent-run production deploy. Smoke suite 12/12. Three
features live.

**20:49** — The honest part. An infrastructure change replaced shared tool
files with symlinks the agent sandbox couldn't see, and the PM lost its queue
tools mid-flight. The report and the fix order were delivered by writing
directly into the journal file — no queues needed. The protocol degraded to its
floor (plain files) and kept working. This wasn't staged for the story; it's
just what happens when the only hard dependency is a file.

**22:00** — The CTO migrates hubd into its own repo while the team keeps
working through it. One real incident on the way: a smoke test consumed a live
queue offset and ate pending jobs. Recovered by reading the queue file
directly; the rule — smoke tests run only against a throwaway role — was written
down. Both the failure and the rule are in the journal.

**22:10** — Second production deploy: a hotfix plus an A/B feature. Smoke
15/15. The CTO had earlier held this deploy because the dev built a feature
without reporting it — the protocol caught unreported work before it shipped.

**23:55** — The PM closes the day with an offers audit, a hypotheses backlog
with metrics and triggers, a PRD, and a content calendar for the next wave.

## What the evening produced

By the team's own count, in roughly seven hours: five features to production,
one hotfix, four test-based acceptances, two production deploys, one role
restructure, and one repo migration — of the coordination tool itself, while it
was in use. One evening, one team, self-reported. Take it as texture, not proof.

The human's contribution was decisions: naming, priorities, who-owns-what, the
deploy delegation, the veto. The agents never talked to each other directly —
every handoff went through files a human can read, grep, and `git diff`.

## Why this is the shape of the thing

Everything above is markdown and JSONL in a folder. No server-side
intelligence, no embeddings, no vendor API in the loop. Any model that can read
and write files can join — that's the floor. MCP makes it comfortable — that's
the ceiling. And when a piece of tooling broke mid-evening, the work fell
through to the floor and kept moving. That's the whole argument for files, and
it's easier to show than to claim.
