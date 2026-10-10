# 2. A night worker

**The situation.** Three chores on the team wiki that nobody wants during the day: the
dependency bumps, a test that fails one run in ten, the dead links in the docs. An
agent could do them overnight. But a session started at seven stops at its first
question and waits for you until morning, and in the morning you read its transcript
to find out what it did.

**What you end with.** A worker on a role that takes its tasks from the hub, works
through them, reports each one with its evidence, and turns anything that needs you
into a question with a recommendation instead of a guess. In the morning one command
says what was done, what it cost and what waits for you; your answer goes back to the
worker, and it finishes the job.

Level 3: [3. Queues](../start/3-queues.md) covers queues, acks and tasks as a queue.
Every output below is real, captured in one run on a node called `oak`, so its clock
reads minutes where the story says hours.

```bash
export HUBD_DIR=/tmp/hub-s2 HUBD_TEAM_DIR=/tmp/hub-s2 HUBD_NODE=oak
hub init "$HUBD_DIR" > /dev/null
echo '["alice"]' > "$HUBD_DIR/owner-roles.json"
hub card wiki -m "Team wiki: markdown pages, search, an editor. 1.8 released last week." --by alice > /dev/null
```

`owner-roles.json` names the people. alice's queue is a list of decisions waiting for
her, and the brief shows it as buttons.

## Evening: the work, and the brief for the night

```bash
hub task add "bump the dependencies and run the full suite" -p wiki --assignee night --by alice
hub task add "find why tests/search.spec.ts fails one run in ten" -p wiki --assignee night --by alice
hub task add "fix the dead links in docs/" -p wiki --assignee night --by alice
hub queue send night "Tonight: your three wiki tasks, any order. Stop at 06:00. Anything that needs a decision goes to alice's queue as a question, never into a guess." --from alice
```

```text
Task #oak-1 added: bump the dependencies and run the full suite
Task #oak-2 added: find why tests/search.spec.ts fails one run in ten
Task #oak-3 added: fix the dead links in docs/
→ night.oak.queue.md delivered
```

The tasks are the work. The message is the brief: when to stop, and what to do with a
question.

## The worker

A session in the wiki's folder, with `HUBD_AGENT=night` in its client's config, told
one thing:

> You are `night`. Loop: hub_queue_wait with role "night", tasks: true, timeout 45.
> For an offered task: hub_claim it for 480 minutes, do it, hub_report a FACT: with
> the evidence and DONE: <id> on a line of its own, then hub_usage_add your seconds,
> tokens and cost. For a message: do what it says, then hub_queue_ack it. A decision
> only alice can make goes to her queue as one question with what you found and what
> you recommend; keep the task claimed and go on with the next. hub_heartbeat every
> cycle. On a timeout, wait again. Never end your turn.

Its first wait returns the brief and the work, most urgent first (abridged):

```json
{
 "changed": true,
 "text": "## 2026-10-07 16:05 · from alice · id oak-1\nTonight: your three wiki tasks, any order. Stop at 06:00. Anything that needs a decision goes to alice's queue as a question, never into a guess.",
 "work": [ { "id": "oak-1", "project": "wiki", "title": "bump the dependencies and run the full suite", "claim": null, … },
           { "id": "oak-2", "project": "wiki", "title": "find why tests/search.spec.ts fails one run in ten", "claim": null, … },
           { "id": "oak-3", "project": "wiki", "title": "fix the dead links in docs/", "claim": null, … } ],
 "offered": [ "oak-1", "oak-2", "oak-3" ]
}
```

From a shell, `hub queue work night` lists the same offered tasks.

## The night

Below, the worker's tool calls are shown as the `hub` commands they correspond to.
The first two tasks need nobody:

```bash
hub claim --task oak-1 -t 480 --agent night
hub report -p wiki --agent night <<'EOF'
FACT: 14 dependencies bumped, 2 majors held back (the editor and the markdown parser: breaking changes listed in deps-2026-10-07.md); full suite 412/412
DONE: oak-1
EOF
hub usage add --agent night -p wiki --task oak-1 --seconds 1260 --tokens-in 380000 --tokens-out 21000 --cost 1.42 --model sonnet

hub claim --task oak-2 -t 480 --agent night
hub report -p wiki --agent night <<'EOF'
FACT: search.spec.ts flaked because the index rebuilds on a timer; the test now waits for the index-ready event. 200 runs, 0 failures (was 19 of 200)
DONE: oak-2
EOF
hub usage add --agent night -p wiki --task oak-2 --seconds 2950 --tokens-in 910000 --tokens-out 44000 --cost 3.30 --model sonnet
```

```text
Started #oak-1: 2bcb3d8a-5745-44c7-a8ef-81319437bd02 (until 2026-10-08 00:05)
Reported to wiki: 1 fact, closed #oak-1, released 1 task claim
recorded for night [wiki] #oak-1: 1260s, 401000 tokens, $1.42
Started #oak-2: 2a9395d8-7f54-4d76-8576-4ac7989d77db (until 2026-10-08 00:05)
Reported to wiki: 1 fact, closed #oak-2, released 1 task claim
recorded for night [wiki] #oak-2: 2950s, 954000 tokens, $3.3
```

The evidence is on the card, so `hub recall "search.spec"` finds it next month. The
claim says the task is taken: a second worker on the role would not be offered it,
and if this session dies, the claim lapses and the task is offered again.
`usage add` records what only the session can see, its time, tokens and money.

The third task needs alice. One dead link points at a page that no longer exists, and
which page should replace it is not the worker's call:

```bash
hub claim --task oak-3 -t 480 --agent night
hub queue send alice "DECIDE? 11 of 12 dead links in docs/ are fixed. The 12th points at /guides/sso, deleted in 1.8. Redirect it to /admin/auth (closest page), or drop the link? Recommend: redirect." --from night --task oak-3
hub report -p wiki --agent night -m "FACT: 11 of 12 dead links in docs/ fixed; the 12th (/guides/sso) waits on alice: redirect or drop"
hub usage add --agent night -p wiki --task oak-3 --seconds 840 --tokens-in 150000 --tokens-out 9000 --cost 0.61 --model sonnet
hub heartbeat night --role night --status "waiting; oak-3 waits on alice" --ttl 60
```

```text
Started #oak-3: 3c8c9011-feea-4bdb-b05f-9a5e5ba922ea (until 2026-10-08 00:05)
→ alice.oak.queue.md delivered  (about task #oak-3)
Reported to wiki: 1 fact
recorded for night [wiki] #oak-3: 840s, 159000 tokens, $0.61
Heartbeat: night -> /tmp/hub-s2/presence/night.json
```

It did not guess and it did not stop. With the work done it acks the brief, and its
next wait blocks until something arrives:

```json
--> hub_queue_ack {"role": "night", "id": "oak-1"}
{
 "ok": true,
 "id": "oak-1",
 "status": "acked"
}
```

## Morning

```bash
hub brief
hub usage --days 1
```

```text
── HUB BRIEF · 2026-10-07 16:05 ──────────────────
TASKS (1 open):
   #oak-3 [wiki] fix the dead links in docs/  @night
JOURNAL (48h):
 10-07 16:05 [wiki/night] card: card reported: FACT — 11 of 12 dead links in docs/ fixed; th
 10-07 16:05 [wiki/night] card: card reported: FACT — search.spec.ts flaked because the inde
 10-07 16:05 [wiki/night] done: #oak-2 find why tests/search.spec.ts fails one run in ten
 …
LOCKS:
 [wiki] task:oak-3 — night, 7h 59m left
QUEUES:
  1 queued for alice 🔘 (oldest 2026-10-07 16:05) — agent last-seen 2026-10-07 16:05
  0 queued for night — agent last-seen 2026-10-07 16:05
BUTTONS: 1 waiting (oldest 0d) — alice
    0d alice ← night #oak-3: DECIDE? 11 of 12 dead links in docs/ are fixed. The 12th points at /guides/sso, deleted in 1.8. Redi…
── USAGE · 1d ──
SUPPLIED by callers (3 report(s)): 84 min · 1514000 tokens · $5.33
  wiki: 84 min · 1514000 tokens · $5.33
MEASURED by the hub: 2 task(s) closed, median 0d open-to-close
note: seconds/tokens/cost here are SUPPLIED by callers (hub_usage_add); what a session spent is READ by hub stats, apart. tasksClosed and journal events are MEASURED from its own logs.
```

Two tasks closed, one parked on a question, $5.33, and one button. No transcript to
read. The cost is marked as supplied because the hub cannot count it: a session that
reports nothing costs $0 here.

alice reads her queue the way any role does, and answers on the task:

```bash
hub queue wait alice --timeout 1
hub queue send night "Redirect /guides/sso to /admin/auth." --from alice --task oak-3
```

```text
## 2026-10-07 16:05 · from night · id oak-2 · task #oak-3
DECIDE? 11 of 12 dead links in docs/ are fixed. The 12th points at /guides/sso, deleted in 1.8. Redirect it to /admin/auth (closest page), or drop the link? Recommend: redirect.

# about task(s): #oak-3 — report against them (DONE:/NOTE:) so the task carries the outcome
→ night.oak.queue.md delivered  (about task #oak-3)
```

The worker, still in its loop, gets the answer with the task it belongs to (abridged):

```json
{
 "changed": true,
 "text": "## 2026-10-07 16:05 · from alice · id oak-3 · task #oak-3\nRedirect /guides/sso to /admin/auth.",
 "tasks": [ "oak-3" ],
 "work": [ { "id": "oak-3", "title": "fix the dead links in docs/",
             "claim": { "agent": "night", "until": "2026-10-08 00:05", … },
             "messages": [ { "from": "alice", "text": "Redirect /guides/sso to /admin/auth.", … } ], … } ],
 "offered": []
}
```

```bash
hub report -p wiki --agent night <<'EOF'
FACT: /guides/sso redirects to /admin/auth; 0 dead links in docs/
DONE: oak-3
EOF
hub task list -p wiki
```

```text
Reported to wiki: 1 fact, closed #oak-3, released 1 task claim
(0 tasks)
```

It acks alice's message, `oak-3`, and waits again. Her part of the night took one
read and one sentence.

## What can go wrong

**The client cuts the wait.** Many MCP clients abort a tool call after about a
minute, and hubd cannot see that limit. Wait in bites of 30 to 45 seconds; the loop is
the same.

**The session ends its turn.** A model that finds nothing to do tends to say so and
stop, and a stopped session waits for you, not for the queue. The instruction says
"never end your turn" because that is the failure: on a timeout, the answer is
another wait.

**Read, then died.** A block that was read and never acked looks like work done to
anyone who only counts deliveries. The ack comes after the work, and the sender's next
`hub_queue_send` reports `unacked` for the blocks that never got one.

**A claim that lapses too soon, or too late.** A released or lapsed claim offers the
task again, so a worker that let go of `oak-3` while waiting on alice would pick it up
and ask her a second time. The claim's TTL is also how long a dead worker holds a
task; 480 minutes is a night.

**Two sessions on one role.** They split the messages and the tasks between them: a
pool, which is right for workers and wrong for the brief. An announcement every session
should read goes to a subscriber role ([3. Queues](../start/3-queues.md#one-reader-or-everyone)).

**The machine sleeps.** A laptop with its lid shut runs no agent. `hub presence` and
the brief show when the worker was last seen; a night's work belongs on a machine that
stays up, or on a node of a mesh ([4. Fleet](04-fleet-on-three-machines.md)).
