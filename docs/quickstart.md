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
  Code and data never mix; upgrading the code never touches the data.

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

A `⚠Nd behind` next to a project means its card has fallen behind its own
journal: the work moved, the digest didn't. Re-sync that one with a fresh
digest. (A project that has simply gone quiet is never flagged.)

Over MCP, long answers are capped to fit an agent's context and say what they
left out in `truncated` — narrow the question, page with `limit`/`offset`, or
pass `full: true`. The CLI is never capped; a terminal has `grep`.

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

## 6. Watch it

```bash
hub brief           # morning brief: tasks by deadline, journal, locks, queues
hub inbox           # only what needs a DECISION: blocked/overdue/unassigned
hub serve           # read-only kanban on localhost:7777
```

The board's only button is ⚙ Rules, and it opens AGENTS.md. Cards move because
agents move them; you manage the rules, not the agents.

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
its own cursor and sees every message. Decisions only a human can make go to an
owner queue (list those role names in `HUB/owner-roles.json`) and `hub brief`
rolls them up as "N buttons waiting".

Experiments leave roles behind — a queue file is created by the first send and
never removed, so old test roles keep showing pending work for a consumer that
never existed. `hub brief` marks those `neverRead`, and `hub queue gc` cleans up:

```bash
hub queue gc              # dry run — what has never been consumed and is >30d old
hub queue gc --apply      # move them to queues/archive/ (moved, never deleted)
```

An owner's own queue is never collected: a human reads it as a file, so having
no cursor is normal there.

## 8. A second machine

Your data is a folder, so sync it like one:

```bash
cd ~/.hubd && git init && git add -A && git commit -m "hub"
git remote add origin ssh://you@yourhost/~/hub.git && git push -u origin main
```

On the other machine: install the package from npm, clone the data, done. Every
log is per-host and append-only (`journal.<node>.jsonl`, `tasks.<node>.events.jsonl`,
`queues/<role>.<node>.queue.md`), so two machines never conflict on one file —
a plain pull/push loop (cron it) is a working mesh. No GitHub required.

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
