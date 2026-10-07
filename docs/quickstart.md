# Quick start — zero to a working hub

The quick start is now [seven short tutorials](start/README.md), each a level of what
hubd does, each with the real output of every command, in a practice hub that leaves
your own alone. Start with [1. Memory](start/1-memory.md); it takes ten minutes.

This page keeps its old sections, so links to them still land somewhere useful: each
says where its content went.

## 0. What you are setting up

One npm package with two commands: `hubd`, the MCP server your agents talk to, and
`hub`, the CLI for you. They work on a folder you own (`HUBD_DIR`, default `~/.hubd`)
of markdown and JSONL; upgrading the code never touches it. The words, and what
lives where: [Concepts](concepts.md).

## 1. Install

```bash
npm i -g @bzdos/hubd
hub doctor
```

One-off, without installing: `npx -p @bzdos/hubd hub doctor`. The first run creates
the hub and writes `HUBD.md`, the manual for agents, from the installed version.

## 2. Scaffold the team folder

`hub init`, and what each file it creates is for: [1. Memory → A practice hub](start/1-memory.md#a-practice-hub).

## 3. Connect an agent

```bash
claude mcp add --scope user hubd --env HUBD_AGENT=dev-myproject -- npx -y @bzdos/hubd
```

Name the function in `HUBD_AGENT` (`dev-shop`, `reviewer-api`), not the model: a
model's name is refused as an author ([why](start/1-memory.md#what-hubd-refuses-here-and-why)).
Other clients: [1. Memory → Connect the agent](start/1-memory.md#connect-the-agent).

## 4. First contact

A project's card, a report, asking the hub, and picking up after a compaction:
[1. Memory](start/1-memory.md).

## 5. The daily loop

The one table worth memorising:

| you want to say | channel | lives |
| --- | --- | --- |
| "I'm working on X — don't clobber" | `hub claim` | expires (TTL) |
| "this needs doing" | `hub task add` | until closed |
| "this is now true / decided / shipped" | `hub report` | forever |
| "agent, do this" | `hub queue send` | until consumed |
| "starting / still going" | nothing | — |

Tasks, what to do next, claims, closing work and the owner's buttons:
[2. Work and decisions](start/2-work.md).

## 6. Watch it

`hub brief`, `hub board` and `hub serve`: [5. Roles → The board](start/5-roles.md#the-board).
The turns' reflections and the laws they become: [6. Laws](start/6-laws.md). Each new
journal entry, once, to a person or a script: [7. A server → A feed of what
happens](start/7-server.md#a-feed-of-what-happens).

## 7. Queues — make an agent addressable

[3. Queues](start/3-queues.md): send, wait, ack, tasks as a queue, a button for a
human, and the limits a queue keeps.

## 8. A second machine

[4. A second machine](start/4-second-machine.md): the hub in git, mesh-sync, cards
that merge by section, `hub doctor` for the mesh, `hub freeze`, and what the sync
refuses. Joining a folder that was a hub of its own: `hub absorb` in
[Guarantees](guarantees.md).

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

- [Recipes](recipes.md) — complete setups: a standing worker, an orchestrator
  fleet, owner buttons, two machines, infra topology.
- [`hubd-company/`](../hubd-company/) (repo only) — a ready org template:
  constitution, role onboardings, recipes, a weekly chronicle.
- [Self-hosting](self-hosting.md) — one shared hub for a team over HTTP.
- [Interop](interop.md) — reading the hub with grep, Obsidian, anything.
