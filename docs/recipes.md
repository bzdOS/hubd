# Recipes

The recipes grew into [scenarios](scenarios/README.md): each one a whole story, built
from an empty hub, with its real output and what can go wrong. This page keeps the
old numbers, so a link to a recipe still lands.

## 1. Solo developer, several agent sessions

[1. Three clients, one project](scenarios/01-three-clients.md).

## 2. A standing worker you feed tasks

[2. A night worker](scenarios/02-night-worker.md). The loop itself is in
[3. Queues](start/3-queues.md).

## 3. Orchestrator and a fleet

[3. A track with a head](scenarios/03-track-with-a-head.md). A team of several heads
and a coordinator is in [5. Roles](start/5-roles.md).

## 4. Owner buttons — decisions only a human can make

[6. The owner's day](scenarios/06-owners-day.md).

## 5. Harvest — turn a working chat into hub state

[11. Harvest](scenarios/11-harvest.md).

## 6. Infrastructure as cards — the topology graph

[10. Infrastructure as cards](scenarios/10-infrastructure-as-cards.md).

## 7. Two machines, one hub

[4. A second machine](start/4-second-machine.md) sets it up,
[4. A fleet on three machines](scenarios/04-fleet-on-three-machines.md) runs one, and
[7. A node stopped syncing](scenarios/07-node-stopped-syncing.md) has what goes wrong,
`merge=union` and mixed filesystems included.

## 8. The weekly ritual

[6. The owner's day → Once a week](scenarios/06-owners-day.md#once-a-week).

## 9. Team organization, runnable

[examples/team](../examples/team/README.md): laws, the role registry, handing a project to a new
head, the sensor without a model, the queue as the channel, readiness by heartbeat, the audit,
a reaction to the journal, and the same reaction run by the MCP server. Nine scripts, each run on
a fresh `hub demo` with one command.

## 10. Reactions

A standing reaction (an ACCEPT deletes the branch once merged; a check every ten minutes) runs
inside the MCP server every agent session already starts, so nobody keeps a watcher running.
The rules live in `<hub>/reactions.json`:

```json
{ "commands": { "delete-merged": "REPO=/srv/review/relay sh /srv/hooks/delete-merged-branch.sh",
                "deploy-age": "sh /srv/hooks/deploy-age.sh" },
  "rules": [
    { "id": "janitor", "by": "relay-head", "project": "relay",
      "on": { "kind": "decision", "match": "^ACCEPT " }, "run": "delete-merged" },
    { "id": "stale-deploy", "by": "relay-head", "project": "relay",
      "every": "10m", "run": "deploy-age", "queue": "relay-dev" } ] }
```

- A rule names a command from `commands` by its id; a command line in `run` is refused. Journal
  text never reaches a command line: the entry goes to the command as one JSON line on stdin.
  A command that starts with `hub ` runs this hub's own CLI.
- `by` is an owner role, a fleet role, or the live head of the rule's `project`; any other rule is
  refused, and `hub reactions` says why.
- `on` (a journal entry: `kind`, `project`, `agent`, `match` on the text): the command runs on each
  new matching entry once. Exit 1 means "not yet": the entry comes again on the next tick. Any
  other non-zero exit is a failure, journaled once per cause.
- `every` (`30s`, `10m`, `24h`, `1d`): exit 0 fired (its output to `queue`, a `heartbeat:
  {agent, ttl}` for a readiness check), exit 1 nothing to do, anything else a failure.
  `"journal": "change"` journals only when the outcome changes.
- `reactions.json` travels with the hub to every node. A rule whose effect is outside the node
  (a branch deleted in a shared remote) names `"node": "<node>"`, or its command must be safe to
  run once per node, as the branch handler is.
- One runner per rule per node: a lease in `.reactions/`, taken over when its holder's process is
  gone or has stopped renewing it. Each firing is a journal entry of kind `reaction`, which never
  triggers a rule.
- The server ticks every 30 s (`HUBD_REACTIONS_TICK_S`); `HUBD_REACTIONS=0` turns it off;
  a multi-tenant HTTP server never runs reactions. `hub reactions` shows each rule, who holds it
  and how it last went; `hub reactions run` makes one pass now.
