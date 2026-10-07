# 3. Queues — an agent that waits for work and does it

**What you get.** Agents you can address by role. A message is a block appended to
a file; a session waiting on the role gets it inside the same tool call, does the
work, reports, and waits again. Nobody pastes tasks into terminals, nothing polls,
and a crash loses nothing, because the queue is the state.

Ten minutes. This continues [2. Work and decisions](2-work.md), in the same practice
hub, on a node called `oak`.

```bash
export HUBD_DIR=/tmp/hub-tour HUBD_TEAM_DIR=/tmp/hub-tour HUBD_NODE=oak
cd /tmp/hub-tour-work/shop
```

## Send, and see it wait

```bash
hub queue send worker "load-test checkout with 200 items on staging; report p95 and errors" --from dev-shop --task oak-4
```

```text
→ worker.oak.queue.md delivered  (about task #oak-4)
```

The role needs no setup: its file appears with the first send, named after the
role and the node that wrote it (`queues/worker.oak.queue.md`). Each node appends
only to its own file for a role, so two machines never write the same one.
`--task` ties the message to a task, so the answer lands on the work and not only
in the message.

```bash
hub queue status worker
```

```text
worker: 1 message(s) — 0 delivered, 1 pending
    oak: 1 total, 0 delivered, 1 pending   nobody has read this file — no cursor here, no read mark from any node
```

## The worker

A standing worker is a session told one thing:

> You are `worker`. Loop: hub_queue_wait("worker", 45) → if a message arrives, do
> it, hub_report the substance, hub_queue_ack it, hub_heartbeat, wait again. On
> timeout just wait again. The queue is your only work source; never stop for input.

From a shell, the same read:

```bash
hub queue wait worker --timeout 5
```

```text
## 2026-10-07 12:58 · from dev-shop · id oak-1 · task #oak-4
load-test checkout with 200 items on staging; report p95 and errors

# about task(s): #oak-4 — report against them (DONE:/NOTE:) so the task carries the outcome
```

```bash
hub queue status worker
```

```text
worker: 1 message(s) — 1 delivered, 0 pending
    oak: 1 total, 1 delivered, 0 pending   read to 133/133B here
```

The wait blocks until content arrives (or the timeout passes) and returns it: a
real long-poll, not a snapshot to re-check. If your client aborts long tool calls,
wait in bites of 30–45 seconds; it is the same loop.

## Delivered is not done

dev-shop sends a second message about the same task:

```bash
hub queue send worker "rerun the load test with the batched query; compare p95" --from dev-shop --task oak-4
```

```text
→ worker.oak.queue.md delivered  (about task #oak-4)
```

Over MCP, the worker's `hub_queue_wait` returns the block with its id and the tasks
it names:

```json
{
 "changed": true,
 "text": "## 2026-10-07 12:58 · from dev-shop · id oak-2 · task #oak-4\nrerun the load test with the batched query; compare p95",
 "tasks": [
  "oak-4"
 ]
}
```

When the work is done, not when it is read, it acks the block:

```json
--> hub_queue_ack {"role": "worker", "id": "oak-2"}
{
 "ok": true,
 "id": "oak-2",
 "status": "acked"
}
```

A session that reads a block and dies looks, from the queue, exactly like one that
did the work. The ack is the difference: the sender's next `hub_queue_send` answers
with `unacked`, the count of blocks read and never confirmed.

## Tasks as a queue

A role can take its tasks, not only its messages, from the same place:

```bash
hub task add "rotate the staging API key" -p shop --assignee worker --by dev-shop
hub queue work worker
```

```text
Task #oak-5 added: rotate the staging API key

## task #oak-5 [shop] · OFFERED — start with: hub claim --task oak-5 --agent worker -t <min>
rotate the staging API key

# close a task only by its outcome (hub report DONE: <id>); cancelling it is closing it
```

`hub queue wait worker --tasks` returns both: new messages, and the open ready tasks
assigned to the role. A task claimed with `hub claim --task` (tutorial 2) is not
offered again until the claim lapses, so two workers on one role split the tasks
instead of doing each twice.

## Who is alive

A worker says it is there, and what it is doing:

```bash
hub heartbeat worker-1 --role worker --status waiting --cwd /tmp/hub-tour-work/shop
hub presence
```

```text
Heartbeat: worker-1 -> /tmp/hub-tour/presence/worker-1.json
  seen from: oak (here, 2)
  ● worker-1          worker     waiting    2026-10-07 12:58
  ● alice             alice      acted      2026-10-07 12:56
(2 agents, generated 2026-10-07 12:58)
```

## A button for a human

The queue of an owner role (`owner-roles.json`, tutorial 2) is a list of decisions
waiting for a person. An agent packs a decision so it takes thirty seconds:

```bash
hub queue send alice "APPROVE? Go live with PayCo on Friday. Staging: 200-item cart in 2 s, 0 errors in 1000 checkouts. Recommend: yes." --from dev-shop --task oak-2
hub brief
```

```text
→ alice.oak.queue.md delivered  (about task #oak-2)
── HUB BRIEF · 2026-10-07 12:58 ──────────────────
…
QUEUES:
  1 queued for alice 🔘 (oldest 2026-10-07 12:58) — agent last-seen 2026-10-07 12:56
  0 queued for worker — agent last-seen 2026-10-07 12:58
BUTTONS: 1 waiting (oldest 0d) — alice
    0d alice ← dev-shop #oak-2: APPROVE? Go live with PayCo on Friday. Staging: 200-item cart in 2 s, 0 errors in 1000 checkouts. Re…
```

Every pending decision in one place, with its age, instead of "waiting on you"
buried in the transcripts of several agents.

## One reader, or everyone

A message goes to exactly one live reader of a role. Two sessions on `worker`
split the work; that is a pool. For an announcement every session should see, list
the role in `subscriber-roles.json` in the hub: each waiting session then reads the
role on its own cursor, keyed by `HUBD_SUBSCRIBER`, else `HUBD_SESSION`, else
`HUBD_AGENT`. An orchestrator that watches every role at once without taking their
messages calls `hub_queue_wait_all`. [Recipe 3](../recipes.md#3-orchestrator-and-a-fleet)
is the whole shape.

## What hubd refuses here, and why

A message is prose. The artifact belongs in a file on the sender's node; the message
carries its path, size and sha256.

**Cargo, at any size.** A git diff, a git bundle, a PEM block, or a base64 or hex
run over 2 KB. A change in progress, pasted into a message:

```bash
echo "batch the cart query" >> README.md
hub queue send worker "$(git diff)" --from dev-shop
git checkout -q README.md
```

```text
Error: message refused: it carries a git diff (line 1). A message is prose, not cargo: put the artifact in a file on your node and send its path, size and sha256sum.
```

**Size.** Over 16 KB (`HUBD_MSG_MAX`):

```text
Error: message refused: 20000 bytes, over the 16384-byte limit (HUBD_MSG_MAX). A message is prose, not cargo: put the artifact in a file on your node and send its path, size and sha256sum.
```

**A reader that has stopped.** A role holding 50 unread messages or 256 KB takes no
more until its reader catches up; more messages would only bury the first ones.
With the limit set to one, to see it:

```bash
HUBD_QUEUE_MAX_MSGS=1 hub queue send reviewer "review the batched pricing query" --from dev-shop
HUBD_QUEUE_MAX_MSGS=1 hub queue send reviewer "and the cart index too" --from dev-shop
```

```text
→ reviewer.oak.queue.md delivered
Error [queue-full]: queue full: reviewer already holds 1 unread message(s), 82 bytes; the limit is 1 messages / 262144 bytes (HUBD_QUEUE_MAX_MSGS / HUBD_QUEUE_MAX_BYTES, or queue in <hub>/limits.json). Its reader is behind or stopped, and more messages only bury the first ones: check it (hub queue status reviewer) before sending again. An escalation goes to a role of rank fleet, which is never refused.
```

It exits 4 and leaves one `queue-full` line in the journal, so the refusal is
visible to more than the sender. An owner's queue and a `fleet` role's queue are
never refused: a decision for a person and an escalation always go through.

Never `rm` a queue file to clean up. `hub queue gc` archives the ones nobody ever
read, and in a hub synced between machines a deleted log is refused by the sync
(tutorial 4).

## What you have now

Addressable agents, a durable record of what was asked and what was done, and the
decisions that need you in one list. How a queue crosses machines is
[interop → Transport](../interop.md#transport-how-a-queue-crosses-machines); why a
message is delivered once and never twice is [the queue invariant](../queue-invariant.md).

Next: [4. A second machine](4-second-machine.md) — the same hub on two nodes.
