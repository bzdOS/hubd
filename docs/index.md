# hubd documentation

Find what you want to do; the link is the place to read about it.

## See it, set it up

| I want to | Read |
|---|---|
| see what a hub looks like after a team's week in it | `hub demo` — [README → Try it in a minute](../README.md#try-it-in-a-minute) |
| install hubd, start a hub and connect a first agent | [1. Memory](start/1-memory.md) · [all the tutorials](start/README.md) |
| follow a whole setup, from an empty hub to what goes wrong in it | [Scenarios](scenarios/README.md) |
| connect a client that has no MCP | [prompts/](../prompts/README.md) |
| start from a ready company layout: rules, roles, cards | [hubd-company/](../hubd-company/) |
| run one shared hub over HTTP for a team | [7. A server](start/7-server.md) · [9. A company server](scenarios/09-company-server.md) · [Self-hosting](self-hosting.md) |
| upgrade, and know what an upgrade will and will not touch | [Quick start → Upgrading](quickstart.md#9-upgrading) · [What hubd promises → Your data](guarantees.md#your-data) |

## Work with it

| I want to | Read |
|---|---|
| know what a card, a queue, a track, a law is | [Concepts](concepts.md) |
| several agent sessions on one project, not stepping on each other | [1. Three clients, one project](scenarios/01-three-clients.md) |
| an agent that waits for work and does it | [3. Queues](start/3-queues.md) · [2. A night worker](scenarios/02-night-worker.md) |
| an orchestrator with workers under it | [5. Roles](start/5-roles.md) · [3. A track with a head](scenarios/03-track-with-a-head.md) |
| see only what waits for me | [6. The owner's day](scenarios/06-owners-day.md) |
| turn a long chat into tasks and decisions | [11. Harvest](scenarios/11-harvest.md) · [HARVEST.md](../HARVEST.md) |
| keep machines, services and their links as cards | [10. Infrastructure as cards](scenarios/10-infrastructure-as-cards.md) |
| one hub across two or more machines | [4. A second machine](start/4-second-machine.md) · [4. A fleet on three machines](scenarios/04-fleet-on-three-machines.md) |
| find why a node stopped syncing, and fix it | [7. A node stopped syncing](scenarios/07-node-stopped-syncing.md) |
| fold in a folder that was a hub of its own by mistake | [12. Absorb](scenarios/12-absorb.md) |
| a weekly review of what happened | [6. The owner's day → Once a week](scenarios/06-owners-day.md#once-a-week) |
| give each kind of role its rules from one template | [5. Roles → Rules, rendered per role](start/5-roles.md#rules-rendered-per-role) · [prompts/meta](../prompts/meta/README.md) |
| turn the lessons the team keeps learning into rules | [6. Laws](start/6-laws.md) · [5. The team learns](scenarios/05-team-learns.md) · [Concepts → From a reflection to a law](concepts.md#from-a-reflection-to-a-law) |
| watch the team: summary, tracks, kanban, history | [5. Roles → The board](start/5-roles.md#the-board) · [Concepts → How each part works](concepts.md#how-each-part-works) |

## Build on it

| I want to | Read |
|---|---|
| read or edit the hub with other tools: an editor, grep, Obsidian | [Reading your hub with any tool](interop.md) |
| send each new journal entry somewhere (chat, mail, a script) | [7. A server → A feed](start/7-server.md#a-feed-of-what-happens) · [8. Notifications](scenarios/08-notifications.md) · [interop → hub watch](interop.md#following-the-journal-hub-watch) · [contrib/watch-to-matrix.sh](../contrib/watch-to-matrix.sh) |
| know how a queue crosses machines, and which transport is on | [interop → Transport](interop.md#transport-how-a-queue-crosses-machines) |
| a weekly chronicle and check-ins with the operator | [The narrative layer](narrative-layer.md) |

## Look it up

Generated from the code, and checked against it by a test.

| I want | Read |
|---|---|
| every `hub` command, its forms and its flags | [Reference → CLI](reference/cli.md) |
| every MCP tool, its parameters, and the prompts | [Reference → MCP tools](reference/mcp.md) |
| every environment variable and its default | [Reference → Environment](reference/env.md) |
| every file in a hub folder, what writes it, whether it syncs | [Reference → Files](reference/files.md) |
| the report prefixes, the reflection fields, how a rule becomes a law | [Reference → Reports](reference/report.md) |
| the role templates, their variables and fragments | [Reference → Prompts](reference/prompts.md) |

## Trust it

| I want to | Read |
|---|---|
| know what hubd promises, and what each promise cost to learn | [What hubd promises](guarantees.md) |
| know exactly how a queue delivers, and how that was broken and fixed | [The queue invariant](queue-invariant.md) |
| read how a real team ran on it for twelve weeks | [Field notes](field-notes.md) |
| read one evening of that team, hour by hour | [Case study](case-study.md) |
| see what changed in each version | [CHANGELOG](../CHANGELOG.md) |
