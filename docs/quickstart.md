# Quick start — zero to a working hub

Ten minutes: install two binaries, scaffold a team folder, connect one agent,
and watch work flow through the journal, tasks and queues. Everything below is
plain files — at any step you can `cat` what just happened.

Want full worked scenarios instead of a walkthrough? See [recipes](recipes.md).

## 0. What you are setting up

Three things, two of them one npm package:

- **`hubd`** — the daemon: an MCP server your agents talk to (stdio, zero deps).
- **`hub`** — the CLI: the same data for you, no LLM required.
- **data** — a folder you own (`HUBD_DIR`, default `~/.hubd`): markdown + JSONL.
  Code and data never mix; upgrading the code never touches the data. A fleet that
  hands every role one shared folder sets `HUBD_TEAM_DIR` alone — queues, presence,
  journal and tasks all live there; `hub doctor` prints which variable won.

## 1. Install

```bash
npm i -g @bzdos/hubd
hub doctor
```

The first run creates `~/.hubd` and materialises `HUBD.md` — the agent-facing
protocol, regenerated from the installed version (never edit it by hand).
`hub doctor` also prints an `environment:` section when something outside the
code needs attention — it will tell you about `HUBD_AGENT` below.

One-off, without installing: `npx -p @bzdos/hubd hub doctor`.

## 2. Scaffold the team folder

```bash
hub init
```

This creates, in the current directory (or `hub init <path>`):

- `AGENTS.md` — your team constitution: roles, policy, decision rights. Yours
  to write; hubd never touches it.
- `INBOX.md` — the human-readable handoff journal (newest on top).
- `queues/` — per-role message queues (files appear on first send).
- `specs/SPEC_template.md` — an assignment template for delegated work.

Rule of thumb: `AGENTS.md` is law you write, `HUBD.md` is the manual the tool
maintains.

## 3. Connect an agent

```bash
claude mcp add --scope user hubd --env HUBD_AGENT=dev-myproject -- npx -y @bzdos/hubd
```

Set `HUBD_AGENT` on day one. Every write names its author — journal entries,
tasks, queue messages — and the field is required. The floor catches calls
that forget it: they get attributed to `dev-myproject` plus a short per-session
suffix instead of failing. Name the **function**, not the model (`dev-hubd`,
`reviewer-api`) — model and client names (`claude`, `cursor`) are refused,
because many sessions share them and the journal is forever.

Other clients: any MCP client that can run `npx -y @bzdos/hubd` over stdio
works the same. No MCP at all? Paste the matching block from
[`prompts/`](../prompts/) — every model that can read and write files can join.

**Verify:** restart the client, then ask the agent to call `hub_onboarding` —
it returns the protocol. That call is the whole onboarding.

## 4. First contact

In a project folder, tell the agent something like:

> Sync this project into the hub: call hub_context with your cwd, then
> hub_sync with a digest of where the project stands.

The agent calls `hub_sync {path, digest, agent}`; hubd collects the git facts
itself (branch, commits since last sync, dirty count) — agents never retype
what git already knows. You check the result with your own eyes:

```bash
hub status          # every project, one line each
hub get myproject   # one project in depth: card + journal + locks
```

To write one line into one section of a card — `Gates`, `Metrics`, or a section
you added yourself — without touching the rest:

```bash
hub section add myproject gates "kill if no paying user by 2026-09-01" --by dev-alex --src "owner call"
hub task get 42     # one task by id, plus what blocks it and what it blocks
```

A card is a snapshot, and hubd enforces that rather than asking politely: an over-long
digest is refused, a dated `appendLine` is refused (that is an event — `hub report` takes
it, and files it in the journal too), and a section that outgrows its limit has its oldest
entries moved into `projects/history/<slug>.md`, never dropped. Your numbers live in
`limits.json` in the hub. A hub that grew before the limits existed catches up with
`hub cards compact` (dry run; `--apply --by <you>` to write).

A `⚠Nd behind` next to a project means its card has fallen behind its own
journal: the work moved, the digest didn't. Re-sync that one with a fresh
digest. (A project that has simply gone quiet is never flagged.)

Over MCP, long answers are capped to fit an agent's context and say what they
left out in `truncated` — narrow the question, page with `limit`/`offset`, or
pass `full: true`. The CLI is never capped; a terminal has `grep`.
`hub_get`, `hub_whatsnew` and `hub_task_list` are compact by default: the card's
head and the newest 5 journal entries, the newest 20 entries, 50 tasks, with
long texts cut. `full: true` gives each of them whole.

## 5. The daily loop

The channel table is the one thing worth memorising (it is the #1 mistake):

| you want to say | channel | lives |
| --- | --- | --- |
| "I'm working on X — don't clobber" | `hub claim` | expires (TTL) |
| "this needs doing" | `hub task add` | until closed |
| "this is now true / decided / shipped" | `hub report` | forever |
| "agent, do this" | `hub queue send` | until consumed |
| "starting / still going" | nothing | — |

A session ends with ONE structured report — prefix-tagged lines that fan into
the project card's sections:

```bash
hub report -p myproject --agent dev-myproject <<EOF
DECIDE: ship 0.2 without SSO | demand unproven, two asks total
FACT: the registry JWT expires in minutes, not hours
NEXT: redeploy staging under 0.2.0
DONE: 42, 43
EOF
```

`DONE:` closes tasks by id, no confirmation — an id that matches nothing comes
back as `doneMissed`, check it. "What changed" is read from git, never listed
by hand.

Two habits that pay for themselves the first week:

- **Write `FACT:` at the moment of the finding, not at the end.** Agent sessions get their
  context compacted, and a compacted session never reaches "the end" — the finding leaves
  with the context. `hub audit` notices a day whose whole report landed in its last two minutes.
- **Resume from state.** After a compaction (or a night away) run `hub whereami` — project,
  digest age, open tasks, who else is in this checkout, the journal tail, and the git
  inventory — instead of trusting the summary. Claim areas as globs (`hub claim myproject
  'src/**/*.ts' --agent dev-myproject`) and run `hub claim check <path>` before editing a
  shared file; editor hooks that do both automatically are in
  [prompts/client-hooks.md](../prompts/client-hooks.md).

## 6. Watch it

```bash
hub brief           # morning brief: tasks by deadline, journal, locks, queues
hub inbox           # only what needs a DECISION: blocked/overdue/unassigned
hub board           # every track: roles, done this week, next, what waits for you
hub serve           # read-only board on localhost:7777 (Summary, Tracks, Live, History)
hub reflect --project <slug>   # the turns' reflections: obstacles by class, rules proposed again
hub watch --as me --follow     # new journal entries as they arrive, each once
```

The board's only button is ⚙ Rules, and it opens AGENTS.md. Cards move because
agents move them; you manage the rules, not the agents. Tracks and the Summary
appear once roles are declared as cards — `hub resource set <role> --type role --attr rank=head
--attr project=<slug> --by <you>`, and `--link head:<head>` for a worker.
A block with an id in the queue of a `fleet` role is an escalation; it waits for you on the board
until the fleet card's Owner decisions quote its key: `hub section add <slug> owner-decisions
"<date> · from <role> · id N — <answer>" --by <you>`. A node whose fleet tool writes
`snapshot.<node>.json` into the hub shows on the Summary with its sessions, disks and relays.
A mail relay that reports each delivery — `hub report "<sender> → <recipient>: <name> <bytes> B
sha256 <hex>" -k delivery -p <slug> --agent <relay>` — fills the Mail row of Live, and the
recipient track's Mail on the Summary.

## 7. Queues — make an agent addressable

```bash
hub queue send worker "run the release checklist for 0.2" --from owner-alex
```

A waiting session picks it up and goes back to waiting — no polling you:

```
hub_queue_wait(worker) -> task? do it -> hub_report -> hub_heartbeat -> wait again
```

One live waiter per role by default: a message goes to exactly one reader, so
two sessions on one role split work instead of duplicating it. A role listed in
`<team>/subscriber-roles.json` broadcasts instead — every waiting session gets
its own cursor and sees every message. That cursor is keyed by `HUBD_SUBSCRIBER`,
else `HUBD_SESSION`, else `HUBD_AGENT`, so a role restarted with the same env
resumes where it stopped; give two sessions on one machine distinct
`HUBD_SUBSCRIBER`s if both read the same broadcast. Decisions only a human can make go to an
owner queue (list those role names in `HUB/owner-roles.json`) and `hub brief`
rolls them up as "N buttons waiting".

A reply usually concerns a specific task. Say so, and the answer lands back on
the work instead of dying with the message:

```bash
hub queue send worker "HOLD: blocked on the owner's call" --from dev-alex --task 42
hub queue status worker    # delivered vs pending, across every host's file at once
```

The count is the same on every node: a role's reader publishes how far it got
(`queues/read/`, mesh-synced), and `queue status` names the node that read each
file.

A message is prose: over 16 KB, or carrying a long base64/hex run, a diff, a git
bundle or a PEM block, it is refused — put the artifact in a file and send its
path, size and sha256 (`HUBD_MSG_MAX`). A role already holding 50 unread messages
or 256 KB takes no more until its reader catches up. The hub sets these in
`limits.json`, `{"queue": {"msgs": 50, "bytes": 262144}}`; `HUBD_QUEUE_MAX_MSGS`
and `HUBD_QUEUE_MAX_BYTES` set on a node win there, and 0 turns a limit off.
`hub doctor` warns at 80%. A role whose reader reads its queue file itself, not
through `hub queue wait`, leaves hubd nothing to count its reads by: list it in
`queue.exempt` of the same file.

Experiments leave roles behind — a queue file is created by the first send and
never removed, so old test roles keep showing pending work for a consumer that
never existed. `hub brief` marks those `neverRead`, and `hub queue gc` cleans up:

```bash
hub queue gc              # dry run — what has never been consumed and is >30d old
hub queue gc --apply      # move them to queues/archive/ (moved, never deleted)
```

An owner's own queue is never collected: a human reads it as a file, so having
no cursor is normal there. Once roles are declared, `hub gc` lists the rest of what
piles up — queues of names that are no live role, dead waiter markers, stale
presence, this node's own litter — and touches nothing; `hub gc --apply --by <you>`
archives it in one commit. Each node archives its own queue files (and ones no node
writes any more), never another live node's. Never `rm` a queue in a mesh hub:
mesh-sync refuses a deleted log (it would delete that history on every peer) and
accepts only a move into `queues/archive/` with the bytes intact.

A role can take its tasks, not only its messages, from the queue:

```bash
hub queue wait worker --tasks        # messages, plus the open ready tasks assigned to worker
hub claim --task 42 --agent worker -t 60   # started: not offered again until the claim lapses
```

## 8. A second machine

Your data is a folder, so sync it like one:

```bash
cd ~/.hubd && git init && git add -A && git commit -m "hub"
git remote add origin ssh://you@yourhost/~/hub.git && git push -u origin main
```

On the other machine: install the package from npm, clone the data, done. Every
log is per-host and append-only (`journal.<node>.jsonl`, `tasks.<node>.events.jsonl`,
`queues/<role>.<node>.queue.md`), so two machines never conflict on one file —
a plain pull/push loop is a working mesh. No GitHub required.

Don't write that loop yourself — the package ships it:

```bash
sh "$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"   # commit, fetch, merge, push; exits in ms when idle
```

Schedule it every minute (`launchd`, a systemd user timer, cron). It refuses to
sync if a task event log lost or changed a line — that means a migration rewrote
history instead of appending to it, and syncing would spread the damage to every
peer. It tries the merge outside the hub first, so a conflicted one never reaches it: no
conflict markers, and no reader sees files change and change back (an older git than 2.38
merges in place and aborts). A failed push is just a retry next run, because the commit is already
local. Exit codes: `2` merge conflict, `3` push, `4` append-only refusal (a log that lost lines,
or one that was deleted outright), `5` a merge git refused before merging (local changes to a
tracked file, or two paths that differ only by case): nothing conflicted, run `hub doctor`.

Project cards are the one file several nodes rewrite. Run `hub card merge-driver` once on each
node, and git merges them by `##` section instead of stopping on them
([recipes](recipes.md#7-two-machines-one-hub)).

Before you touch the hub folder itself — a purge, a restore, an `absorb`, anything that rewrites —
stop the sync on that machine, so a tick mid-operation cannot hand a half-finished state to every
peer. You do not need to remember whether this node runs launchd, cron or a systemd timer:

```bash
hub freeze "restoring yesterday's backup" --by owner-alex
hub unfreeze
```

`hub doctor` states the freeze while it lasts and warns once it has outlived any plausible
operation — a forgotten freeze is a node that quietly stopped syncing, which is the failure it
exists to prevent.

If several users share one hub folder (a fleet: agents under one account, the sync under root),
keep the directory group-writable. Whatever a pull creates belongs to whoever ran it, and a user
who cannot write a cursor gets a queue that answers "nothing new" forever. mesh-sync restores group
write after every pull on a hub that is already group-writable, and after every one that stops, and
`hub doctor` names any cursor this user cannot advance.

If a machine (or a set of agents) turns out to have been writing to a folder that
was never the shared hub, do not copy files across by hand — task ids from the same
hostname collide, and a copied queue file gets re-delivered to whoever is waiting on
that role. Stop the writers, then:

```bash
hub absorb /home/agent/.hubd --as pine-agent              # dry run: the plan, nothing written
hub absorb /home/agent/.hubd --as pine-agent --apply --by owner-alex
```

The isolated folder joins as a new node: its logs become `*.pine-agent.*` files here,
its ids become `pine-agent-<n>` everywhere they are mentioned, queue history is kept
under `absorbed/pine-agent/` with what was never read listed for you to re-send on
purpose, and cards whose slug already exists are kept aside verbatim. The next
mesh-sync carries the new files to every peer. Then move the old folder away.

One cron-specific trap: an ssh key with a passphrase cannot work unattended there
(no agent). `launchd` and systemd user services inherit one; cron does not.

## 9. Upgrading

```bash
npm i -g @bzdos/hubd@latest
```

The next `hub` run refreshes `HUBD.md` to match. When an upgrade needs
something outside the code — a config variable, a role declaration, a protocol
section worth re-reading — hubd tells the agents itself: `hub_whatsnew` returns
an `environment` list with what is wrong, the remedy, and who can fix it.
`hub doctor` shows you the same list. Nothing blocks, nothing needs
acknowledging: an item disappears when its condition does.

## Where to go next

- [Recipes](recipes.md) — complete scenarios: a standing worker, an
  orchestrator fleet, owner buttons, harvesting a chat, infra topology.
- [`hubd-company/`](../hubd-company/) (repo only) — a ready org template:
  constitution, role onboardings, recipes, a weekly chronicle.
- [Self-hosting](self-hosting.md) — one shared hub for a team over HTTP.
- [Interop](interop.md) — reading the hub with grep, Obsidian, anything.
