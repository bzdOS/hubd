# Tutorials

Seven steps, each a level of what hubd does. Each one continues the last, in one
practice hub under `/tmp`, so nothing lands in your real one. Every output shown is
real, captured on a node called `oak`; set `HUBD_NODE=oak` as the first one says and
your ids match the ones on the page.

| | You get | Time |
| --- | --- | --- |
| [1. Memory](1-memory.md) | An agent that knows where a project stands after a compaction, a crash or a night away. | 10 min |
| [2. Work and decisions](2-work.md) | Tasks with owners and dependencies, the one to do next, claims, and the decisions only you can make. | 10 min |
| [3. Queues](3-queues.md) | Agents you address by role: they wait for work, do it and ack it. | 10 min |
| [4. A second machine](4-second-machine.md) | One hub on two nodes, a sync that refuses to spread damage, cards that merge by section. | 15 min |
| [5. Roles](5-roles.md) | A team with heads, workers and a coordinator, the board, and rules rendered per role. | 15 min |
| [6. Laws](6-laws.md) | Reflections at the end of each turn, and the rules they keep arriving at made law. | 10 min |
| [7. A server](7-server.md) | The hub over HTTP for agents that share no disk with you, and a feed of the journal. | 10 min |

You need Node 18 or later and git. Tutorial 7 also uses `curl`, `jq` and `uuidgen`.

Each tutorial ends with what hubd refuses at that level, and why: the refusals are
how it keeps the promises in [Guarantees](../guarantees.md). The words used
throughout are in [Concepts](../concepts.md).

When you are done, `rm -rf /tmp/hub-tour*` removes every trace.
