# Recipes — complete usage scenarios

Each recipe is a real shape of work: the situation, the one-time setup, the
flow, and what you end up with. They compose — most teams run several at once.
Commands are shown as the CLI; every one has an MCP twin (`hub_task_add`,
`hub_queue_wait`, ...) that agents call directly.

New to hubd? Do the [quick start](quickstart.md) first.

---

## 1. Solo developer, several agent sessions

**Situation.** One human, two or three agent sessions (different tools, even
different vendors) across a couple of projects. Each session is brilliant and
has no idea the others exist; you are the coordination layer.

**Setup.** Connect every client to the same hubd with its own floor:

```bash
claude mcp add --scope user hubd --env HUBD_AGENT=dev-api -- npx -y @bzdos/hubd
# in Cursor / another client: same command shape, HUBD_AGENT=dev-frontend
```

**Flow.**

- Session start: the agent calls `hub_context({cwd})` — one call resolves which
  project this checkout is and returns the digest and open tasks. No re-telling.
- Before touching a shared area: `hub claim api src/auth/ --agent dev-api` — a
  soft lock with a TTL, visible to every other session.
- Session end: one structured `hub report` (DECIDE/FACT/NEXT/DONE lines).
- Your morning: `hub brief` — open tasks by deadline, journal, who holds what.

**You get:** on Monday you read what Friday's sessions actually decided and
shipped — from the hub, not from four scrollback buffers.

---

## 2. A standing worker you feed tasks

**Situation.** You want an agent that sits on a role and works whatever
arrives, without you prodding it per task.

**Setup.** None beyond the quick start — a queue exists once something is sent
to it.

**Flow.** Start a session with one instruction:

> You are `worker`. Loop: hub_queue_wait("worker", 45) → if a task arrives, do
> it, hub_report the substance, hub_heartbeat, wait again. On timeout just wait
> again. The queue is your only work source; never stop for input.

Feed it from anywhere — your shell, another agent, another machine:

```bash
hub queue send worker "bump deps and run the full suite on project-api" --from owner-alex
```

Check on delivery without touching anything:

```bash
hub presence            # who is alive on which role, freshness from heartbeats
hub brief               # "N queued for worker — agent last-seen T"
```

**You get:** an addressable agent. The wait returns the task inside the same
tool call, so the session never ends its turn — dozens of wait cycles and a
handful of real tasks over an hour is a normal, observed run. If your client
aborts long tool calls (~60s is common), poll with `timeout: 30-45` — smaller
bites, same loop.

**Gotcha:** exactly one live waiter per role — a second waiter on the same
cursor splits deliveries with the first (each message goes to one of them).
That is right for a worker pool and wrong for announcements; for the latter,
see the next recipe.

---

## 3. Orchestrator and a fleet

**Situation.** One coordinating session dispatches to several specialist
workers and reacts to whoever reports first.

**Setup.** Declare the broadcast roles once (competing work queues need
nothing):

```bash
echo '["announce"]' > <team-root>/subscriber-roles.json
```

**Flow.**

- Dispatch: `hub queue send builder "SPEC_release.md — build and test" --from orchestrator`.
  The task text goes in the queue — a durable file that syncs across machines —
  never pasted into a session's terminal (that is the fragile side-channel this
  replaces).
- Collect: the orchestrator blocks on `hub_queue_wait_all` — a tap across every
  role with its own cursor namespace, so watching never steals a message from a
  role's own consumer. Several supervisors may tap at once.
- Announce: `hub queue send announce "freeze: release at 17:00" --from orchestrator` —
  a declared broadcast role, so EVERY waiting session sees it, each on its own
  cursor.
- Dependencies: give tasks `--needs`, then `hub plan` prints ready-now, the
  critical path, and the unlock order (`hub_trajectory` for agents).

**You get:** fan-out and fan-in over files. If the orchestrator dies, nothing
is lost — the queues are the state, and `hub brief` shows what is pending.

---

## 4. Owner buttons — decisions only a human can make

**Situation.** Agents prepare outward-facing actions (send, post, pay, reply),
but the final call is yours, and you don't want to be polled about it.

**Setup.**

```bash
echo '["alice"]' > ~/.hubd/owner-roles.json    # your own queue role
```

**Flow.** A task that needs OWNER splits in two:

1. **Prep** (agent): boil the decision down to a package decidable in ≤30
   seconds — context, the recommendation, the exact text to send.
2. **Button** (you): the agent queues the package to your role:

```bash
hub queue send alice "APPROVE? Reply to ACME: <final text>. Context: they asked for net-60; we hold net-30. Recommend: decline politely, offer net-45." --from dev-sales
```

Your side of the loop:

```bash
hub brief               # "BUTTONS: 2 waiting (oldest 1d) — alice"
hub queue wait alice --timeout 10
```

**You get:** every pending decision in one place with an age counter, instead
of scattered "waiting on you" messages inside N agent transcripts. hubd never
files a button by itself — an agent does, and only when it is actually blocked.

---

## 5. Harvest — turn a working chat into hub state

**Situation.** A long dialog (planning, debugging, a decision thread) contains
projects, tasks and decisions that exist nowhere else.

**Flow.** In an MCP client, invoke the shipped prompt — no file fetching:

```
/harvest        (the MCP prompt; or paste `hub harvest` output into the chat)
```

The agent then writes what the dialog established: `hub_card_set` for projects
that have no local checkout, `hub_task_add` for every "we should...",
`hub report` with DECIDE lines for every decision, `--needs` for ordering.

**You get:** the dialog becomes queryable state — `hub status` shows the new
cards, `hub plan` sequences the extracted tasks — instead of prose you will
never re-read. Cards created this way (`- set:` stamp) age into `hub brief`'s
stale list like any synced card, so a harvested project cannot silently rot.

---

## 6. Infrastructure as cards — the topology graph

**Situation.** Hosts, VMs, services and their relationships live in your head
(or a wiki that drifted). Agents keep asking "where does this deploy?".

**Flow.** Facts go in fields, relationships in typed edges:

```bash
hub resource set myvm --type vm --addr 10.0.0.7 --os debian --status live \
  --link runs_on:baremetal-1 --by devops
hub resource set hubd-api --type service --link deploys_to:myvm --by devops
hub task add "rotate the TLS cert" -p infra --resource hubd-api --by devops
```

Read it back:

```bash
hub graph               # who runs on / depends on / deploys to what
hub resource get myvm   # one card + its in/out edges
hub doctor              # flags dangling links (an edge to a card that doesn't exist)
```

**You get:** `hub graph` renders one topology across projects AND resources —
the same `[[wikilink]]` edge mechanism reads both — and every task can point at
the infrastructure it touches.

---

## 7. Two machines, one hub

**Situation.** A desktop and a laptop (or your machine and a VPS), one team of
agents across both.

**Setup.** The data folder is a git repo; any private remote works:

```bash
cd ~/.hubd && git init && git add -A && git commit -m "hub"
git remote add origin ssh://you@yourhost/~/hub.git && git push -u origin main
```

Cron a sync loop on each machine (append-only files make this safe):

```
*/10 * * * * cd ~/.hubd && git pull --rebase -q && git add -A && git commit -qm sync; git push -q
```

**Flow.** Nothing changes for anyone. Journals, task events and queues are all
per-host files (`journal.<node>.jsonl`, `tasks.<node>.events.jsonl`,
`queues/<role>.<node>.queue.md`) — single writer each, so pulls never conflict.
A `hub queue send` on the desktop is delivered to a waiter on the laptop on the
next sync; task ids are node-scoped (`planck-3`), so offline adds can never
collide. Runtime state (`tasks.json`, `HUBD.md`, `.qstate/`, `presence/`,
`.env-state.json`) is gitignored automatically — each node keeps its own.

**One warning about `.gitattributes`.** Single writer per file means pulls
*normally* never conflict — but when one does (a restored backup, a rotated
month archive, the same node's folder alive on two machines), `merge=union`
looks like the obvious cure, and it is what this tool's own author reached for.
It keeps both sides of the hunk instead of stopping to ask, so the sync never
fails again. It also never deduplicates: a line present on both sides survives
twice, the next merge sees the doubled file as one side of the next union, and
it compounds without a word. One hub reached 27,464 journal lines holding 1,919
entries. Since 0.9.3 readers drop byte-identical repeats and `hub doctor`
reports the bloat and its cause, so your counts are right either way — but the
files still grow, so prefer letting a genuine conflict stop the sync and fixing
it once.

**One warning about mixed filesystems.** If any node runs macOS or Windows,
never let two tracked paths differ only by case. On Linux they are two files; on
a case-insensitive filesystem they are **one file for two index entries**, git
can only ever satisfy one of them, and `git add -A` stages nothing while the
other stays dirty forever. Every merge that must write the unsatisfiable path
then refuses — permanently, with an error about local changes that no commit or
stash can clear. This is not hypothetical: a hostname spelled `Planck` in old
queue file names and `planck` in new ones took one node out of its own mesh for
228 commits, while its sync loop retried every 60 seconds and reported a content
conflict that did not exist. Since 0.9.5 `hub doctor` counts the divergence from
`origin` and names any colliding pair — including pairs that exist only in the
remote's tree, which is the case that blocks you. The fix is always the same:
remove one of the two paths from the mesh. Since 0.9.6 hubd will not create such
a pair itself; a pair older than that still has to be retired by hand.

**The one file that can conflict.** Journals, task events and queues are per-host
and append-only, so a pull cannot conflict on them. Project cards are the
exception: one mutable file that any node rewrites, so two nodes appending to the
same section is a same-hunk change. The sync script aborts rather than leaving
markers in your data, so the workflow is `git merge`, then `hub card resolve`,
then commit. It unions the bullet-list hunks and leaves prose ones for you — and
`hub doctor` shouts if a card is still carrying markers, because a reader hands
those to an agent as content, not as an error.

**You get:** a mesh with no server. GitHub optional; an SSH box you own is
enough.

---

## 8. The weekly ritual

**Situation.** You want a standing review that does not depend on your memory.

**Flow.**

```bash
hub inbox               # what needs a DECISION: blocked, overdue, unassigned, stale locks
hub brief --hours 168   # the week's journal, stale cards, queue depths
hub plan                # dependency layers: what unlocks what, where the cycles are
hub log myproject -n 30 # one project's trail when something looks off
hub doctor              # base, locks, and queues nobody has ever consumed
hub lint                # which of your rules are checks, and which are only written down
hub audit --days 7      # declarations vs behaviour; --apply --by <you> files the incidents
```

`hub audit` is the part that does not depend on you noticing anything. It reads
what the cards DECLARE (gates with dates, `MODE:` lines) against what actually
happened (the journal, the task log) and reports the disagreements: a gate whose
date passed with no decision since, a project in `MODE: background` eating most
of the week's attention, buttons nobody pressed, a card that stopped following
its own journal. With `--apply` each one becomes an incident task quoting **your**
rule and the date you wrote it (`HUB/rules.json` → `laws`) — the only authority
that reliably lands is your own past self. Findings are keyed, so running it every
Monday never files the same incident twice.

Two lines in that output are about the hub lying to you rather than about the
work. `⚠Nd behind` in `hub status` means a card stopped following its own
project — re-sync that digest. Ghost queues in `hub doctor` mean old experiment
roles are still counted as pending work; `hub queue gc` lists them and
`--apply` archives them into `queues/archive/` (moved, never deleted). Left
alone, both quietly inflate every number you are about to read.

A weekly review is also the moment to keep the task vocabulary honest:
`hub task retag` shows tasks whose `cat` is not one of technical / communicative
/ decision / chore, and moves them into tags on `--apply` — so the by-type
numbers in the chronicle stay countable.

Then edit `AGENTS.md` — the rules, not the agents — with whatever the week
taught you. For the narrative layer on top (an agent-written weekly chronicle
with mood and divergence metrics), see
[`hubd-company/`](../hubd-company/) and `scripts/behavior_metrics.mjs` there:
your hub is a longitudinal behavioral corpus, and the chronicle reads itself
out of it.

---

## Picking a recipe

| you want | recipe |
| --- | --- |
| stop re-explaining state between sessions | 1 |
| an agent that works a backlog unattended | 2 |
| coordinate several specialists | 3 |
| approve outward actions without being polled | 4 |
| capture a planning chat before it scrolls away | 5 |
| stop answering "where does this deploy?" | 6 |
| same team on two machines | 7 |
| a review that survives your vacation | 8 |
