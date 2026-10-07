# Scenarios

Twelve setups from real use, each a story with a problem in it. The
[tutorials](../start/README.md) teach one level at a time; a scenario uses whatever
levels its situation needs, and says which at the top.

Each one opens with the situation and what you end with, builds it from an empty
practice hub under `/tmp`, and ends with what can go wrong. The `bash` blocks run in
order in one shell, and the output under each is what they printed. An `sh` block is
for a real machine and is not part of the run. Every output is real, captured on a
node called `oak`, or on two or three simulated nodes on one computer. A run takes
minutes where the story takes hours or days, so the clock in the output reads minutes.
In a clone of the repository, `node tests/docs.mjs` runs them all and compares what they
print with these pages.

| | You end with | Level |
| --- | --- | --- |
| [1. Three clients, one project](01-three-clients.md) | Sessions in three clients that start from the hub instead of from you, and the day in one place. | 1, 2 |
| [2. A night worker](02-night-worker.md) | A worker that takes tasks overnight, reports each with evidence, and leaves you questions instead of guesses. | 3 |
| [3. A track with a head](03-track-with-a-head.md) | A head that runs a track, takes nothing as done without an artifact, and sends you only what it cannot decide. | 5 |
| [4. A fleet on three machines](04-fleet-on-three-machines.md) | One hub on three machines: roles and disks reported, files handed over with a checksum, one screen for all. | 4 |
| [5. The team learns](05-team-learns.md) | Reflections every turn, a weekly digest, and the lessons that keep coming back ruled on: a law or a task. | 6 |
| [6. The owner's day](06-owners-day.md) | One morning list of what waits for you, answers given where they were asked, and a weekly review. | 2, 3, 5 |
| [7. A node stopped syncing](07-node-stopped-syncing.md) | Which node stopped and why, and the fix for each of three causes. | 4 |
| [8. Notifications](08-notifications.md) | Feeds to Matrix, Slack and ntfy, each with its own filter, retried until delivered. | 7 |
| [9. A company server](09-company-server.md) | The team's hub over HTTPS on a node of the mesh, and a server with a workspace per client. | 7 |
| [10. Infrastructure as cards](10-infrastructure-as-cards.md) | Machines and services as linked cards, tasks that name them, and the gaps the hub finds by itself. | 2, 5 |
| [11. Harvest](11-harvest.md) | An evening's chat turned into cards, tasks, decisions and guesses, with nothing closed that was only talked about. | 2 |
| [12. Absorb](12-absorb.md) | Three days written to the wrong hub, folded into the right one under ids that collide with nothing. | 4 |

You need Node 18 or later and git. Scenarios 3, 4, 8 and 9 also use `curl` and `jq`;
8 uses `python3`, and 9 uses `openssl`.

When you are done, `rm -rf /tmp/hub-s[0-9]*` removes every trace.
