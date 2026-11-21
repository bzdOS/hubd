# Team organization, as runnable examples

Eight ways a team of agents is organized in hubd, each a short shell script you can read top to
bottom and run. Each one shows one rule, and starts with the scar that rule came from: the thing
that went wrong before the rule existed. Every script runs on a fresh [`hub demo`](../../docs/start/README.md)
in a temporary folder of its own (an invented team: projects atlas, relay and infra; roles
relay-head, relay-dev, atlas-head...). Your own hub is never read or written.

```bash
sh examples/team/run.sh          # all eight, one PASS/FAIL line each
sh examples/team/run.sh -v 04    # one, with everything it printed
```

`HUB` picks the command (default `hub`; from a checkout: `HUB="node hub/hub.mjs"`). The examples
need `sh`, `git` and `node`, nothing from the network.

| Example | Rule | Scar |
|---|---|---|
| [01 Laws](01-laws.sh) | A project's rule is a line in its card's Laws section, put there by the project's head (`hub reflect --law`), and `hub_context` hands it to every role at session start. | A rule said in one session's chat was gone in the next; the worker who started after the chat broke it the same day. |
| [02 The role registry](02-roster.sh) | Role names come from resource cards of type `role`; `hub lint` flags work assigned to any other name, or to a role switched off. | A task on a misspelt role stayed open for good: no loop waits under that name. |
| [03 Head handover](03-head-handover.sh) | One live head per project: declare the new head, move the workers, switch the old head off, move its open work (`hub task update --assignee`), and let lint confirm. | The old head's release task stayed under its name, read by no loop, and the old head could still rule on the project's laws. |
| [04 The sensor without a model](04-sense-without-a-model.sh) | `hub sense <head>` takes the measurements; the head only decides. An accept is refused while the checklist fails, and private text bound for a public repo goes to the fleet at once. | "Nothing private" was printed by a check with no patterns to check with, and a branch bound for a public repo went through. |
| [05 The queue is the channel](05-queue-channel.sh) | Work for a role goes to its queue; the role blocks on `queue wait`; `queue status` counts what was read by the reader's own cursor ("read to N/N"). | An order given in chat never reached the worker that started after it. |
| [06 Readiness by heartbeat](06-readiness.sh) | A resource is ready while its check heartbeats within `--ttl`; `hub presence --alive` lists only those. A card's `status: up` is a claim written once. | A card said a service was up after it had stopped. |
| [07 The audit](07-audit.sh) | `rules.json` holds the team's own dated laws and the checks it enforces (`strict`); `hub audit --apply` files each finding once, quoting that law. | Gates expired silently for weeks while the rule sat written down. |
| [08 A reaction to the journal](08-watch-exec.sh) | `hub watch --as <name> --exec <cmd>` hands each new entry to a command and marks it only when the command exits 0. Here: an ACCEPT deletes the merged branch ([the handler](delete-merged-branch.sh)). | Accepted branches stayed in the remote after their merge, and each copy was raised for acceptance again. |

What the scripts assert is what the engine guarantees: `tests/logic/examples.mjs` runs them in
`npm test`, so a change that breaks a recipe fails there first.
