# 12. Absorb

**The situation.** The build box was reinstalled, and the service file that starts its
agents came back without `HUBD_DIR`. With no hub named, hubd uses `~/.hubd`, so for
three days the agents there wrote to a hub of their own. They took tasks, reported,
sent each other orders, and every write succeeded. On the team hub none of it
happened. Worse, the new hub counted its task ids from 1, so `pine-1` there and
`pine-1` on the team hub are two different pieces of work.

**What you end with.** The three days in the team hub, as a node of their own: every
task and report, the ids renamed so they collide with nothing, the queue history kept
and not delivered twice, the messages nobody read listed for you to send again on
purpose, and a card that differs kept aside for you to fold. And how to keep it from
happening again.

Level 4: [4. A second machine](../start/4-second-machine.md) has nodes and per-node
files, which is how the lost days come back. Every output below is real, captured in
one run on a node called `oak`, so its clock reads minutes where the story says hours.

```bash
export HUBD_DIR=/tmp/hub-s12 HUBD_TEAM_DIR=/tmp/hub-s12 HUBD_NODE=oak
hub init "$HUBD_DIR" > /dev/null
pine() ( export HUBD_NODE=pine; "$@" )
lost() ( unset HUBD_DIR HUBD_TEAM_DIR; export HOME=/tmp/hub-s12-home HUBD_NODE=pine; "$@" )
hub card shop -m "Web shop: catalogue, cart, checkout. 1.5.0 is the next release." --by alice > /dev/null
pine hub task add "Load test checkout at 200 orders a minute" -p shop --by head-shop
pine hub task add "Rotate the payment webhook secret" -p shop --by head-shop
```

```text
Task #pine-1 added: Load test checkout at 200 orders a minute
Task #pine-2 added: Rotate the payment webhook secret
```

`pine …` runs a command the way the build box ran it before the reinstall, on the
team hub. `lost …` runs it the way the box runs it after: no `HUBD_DIR`, so the hub is
`~/.hubd` in the agents' home, here `/tmp/hub-s12-home`.

## Three days on the wrong hub

```bash
lost hub card shop -m "Shop: load tests run on pine, against a copy of production." --by head-shop
lost hub task add "Fix the slow cart query the load test found" -p shop -i high --by head-shop
lost hub queue send worker "Run the checkout load test again once pine-1 is in; report the p95." --from head-shop
lost hub queue wait worker --timeout 1
lost hub report -p shop --agent worker <<'EOF'
FACT: with pine-1 in, checkout p95 is 310 ms at 200 orders a minute (840 ms before)
DONE: pine-1
EOF
lost hub task add "Cache the shipping rates: 40% of the cart time now" -p shop --by head-shop
lost hub queue send worker "Take pine-2 next." --from head-shop
```

```text
Card set: shop → /tmp/hub-s12-home/.hubd/projects/shop.md
Task #pine-1 added: Fix the slow cart query the load test found
→ worker.pine.queue.md delivered
## 2026-10-07 17:11 · from head-shop · id pine-1
Run the checkout load test again once pine-1 is in; report the p95.
Reported to shop: 1 fact, closed #pine-1
Task #pine-2 added: Cache the shipping rates: 40% of the cart time now
→ worker.pine.queue.md delivered
```

The head and the worker talked, the slow query was fixed and its task closed, and the
next order is waiting. In that hub, `pine-1` is the cart query.

## What the team sees

```bash
hub task list -p shop
```

```text
  #pine-1 [shop] Load test checkout at 200 orders a minute
  #pine-2 [shop] Rotate the payment webhook secret
(2 tasks)
```

Nothing from pine for three days, and on the team hub `pine-1` is still the load test.
On a mesh, `hub doctor` on another node names a peer that went quiet
([7. A node stopped syncing](07-node-stopped-syncing.md#ask-the-node-that-stopped)).
On pine itself, ask the way the agents run, with their user and their environment:

```bash
lost hub doctor | sed -n '/^hub base:/,/^$/p'
```

```text
hub base:
  path:     /tmp/hub-s12-home/.hubd  (via default)
  projects: 1
  resources:0
  tasks:    1 open
  claims:   0 active, 0 expired
  journal:  1 file(s), 4 entries
  writers:  pine 0.9.56
  fleet:    pine (here, 0)
```

`via default`: nothing named a hub, and hubd used the one in the home folder.

## Stop the writers, then look

Fix the environment where the agents get it, the service's environment file, and
restart them, so nothing writes to `~/.hubd` again. `hub absorb` refuses while an
agent recorded in the source still waits on one of its queues: a copy taken while it
writes is stale when it lands. Then, from any node of the team hub, a dry run:

```bash
hub absorb /tmp/hub-s12-home/.hubd --as pine-stray
```

```text
Would absorb /tmp/hub-s12-home/.hubd as node pine-stray  (dry run - add --apply --by <you>)
  tasks:    2 added in 3 event(s) from tasks.pine.events.jsonl
  ids:      pine-1 -> pine-stray-1, pine-2 -> pine-stray-2
  journal:  4 entr(y/ies) from journal.pine.jsonl
  queues:   1 file(s) kept under absorbed/pine-stray/queues/ - never re-delivered
    UNREAD  worker.pine.queue.md: 1 block(s), 70 B  -> re-send on purpose if it still matters
  card      shop -> absorbed/pine-stray/projects/shop.md  (slug exists here; fold the digest by hand)
  not absorbed (node-local or generated): presence/, .qstate/, tasks.json, HUBD.md
Would write 5 new file(s); nothing here is rewritten.
```

The source becomes a node of the team hub, named by `--as`: its logs become the
`pine-stray` node's files, which no node has written before, so nothing here is
rewritten. Each of its ids becomes `pine-stray-<n>`, in every field and every text,
reports included. Its queues are kept under `absorbed/`, with how far each was read,
and never delivered again; the block nobody read is named. Its shop card is kept aside,
because the team hub has one too, and two digests are not a list to merge: a person
picks.

## Fold it in

```bash
hub absorb /tmp/hub-s12-home/.hubd --as pine-stray --apply --by alice
mv /tmp/hub-s12-home/.hubd /tmp/hub-s12-home/.hubd.absorbed
hub task list -p shop
hub log shop | grep pine-stray
```

```text
Absorbed /tmp/hub-s12-home/.hubd as node pine-stray
  tasks:    2 added in 3 event(s) from tasks.pine.events.jsonl  -> 2 visible after fold
  ids:      pine-1 -> pine-stray-1, pine-2 -> pine-stray-2
  journal:  4 entr(y/ies) from journal.pine.jsonl
  queues:   1 file(s) kept under absorbed/pine-stray/queues/ - never re-delivered
    UNREAD  worker.pine.queue.md: 1 block(s), 70 B  -> re-send on purpose if it still matters
  card      shop -> absorbed/pine-stray/projects/shop.md  (slug exists here; fold the digest by hand)
  not absorbed (node-local or generated): presence/, .qstate/, tasks.json, HUBD.md
Wrote 5 new file(s); nothing here is rewritten. Next mesh-sync carries them to every peer. Move the source away so nothing falls back to it.
  #pine-1 [shop] Load test checkout at 200 orders a minute
  #pine-2 [shop] Rotate the payment webhook secret
  #pine-stray-2 [shop] Cache the shipping rates: 40% of the cart time now
(3 tasks)
2026-10-07 17:11 [shop/head-shop] task: + task #pine-stray-1: Fix the slow cart query the load test found
2026-10-07 17:11 [shop/worker] done: #pine-stray-1 Fix the slow cart query the load test found
2026-10-07 17:11 [shop/head-shop] task: + task #pine-stray-2: Cache the shipping rates: 40% of the cart time now
```

The three days are in the team hub's history, under their own ids: `pine-1` is the
load test, as it always was here, and the cart query is `pine-stray-1`, in the task and
in the worker's report. The source is moved away, so nothing reads it by mistake.

## What is left for you

The card kept aside, against the team's:

```bash
diff "$HUBD_DIR/projects/shop.md" "$HUBD_DIR/absorbed/pine-stray/projects/shop.md"
```

```text
4c4
< - set: 2026-10-07 17:11 by alice
---
> - set: 2026-10-07 17:11 by head-shop
8c8
< Web shop: catalogue, cart, checkout. 1.5.0 is the next release.
---
> Shop: load tests run on pine, against a copy of production.
28c28
< <what is known (fact) vs what is being tested (hypothesis)>
---
> - fact: with pine-stray-1 in, checkout p95 is 310 ms at 200 orders a minute (840 ms before)
```

Keep what is still true:

```bash
hub card shop --append-line "Load tests run on pine, against a copy of production." --by alice
hub section add shop facts "with pine-stray-1 in, checkout p95 is 310 ms at 200 orders a minute (840 ms before)" --by alice
```

```text
Card patched: shop → /tmp/hub-s12/projects/shop.md
  Web shop: catalogue, cart, checkout. 1.5.0 is the next release.
  Load tests run on pine, against a copy of production.
shop → ## Facts & hypotheses
```

The unread order is in the kept queue, after the one the worker read:

```bash
tail -2 "$HUBD_DIR/absorbed/pine-stray/queues/worker.pine.queue.md"
hub queue send worker "From the days on the wrong hub: take pine-stray-2 next, the shipping-rate cache." --from head-shop --task pine-stray-2
```

```text
## 2026-10-07 17:11 · from head-shop · id pine-stray-2
Take pine-stray-2 next.
→ worker.oak.queue.md delivered  (about task #pine-stray-2)
```

Sent again on purpose, after reading it: three days later, an order may no longer
hold.

## What can go wrong

**Copying the files by hand.** The stray tasks file put next to the team's names
`pine-1` twice, for two pieces of work, and every "see pine-1" in a report points at
both. A queue file copied in is delivered again, from its first line: a second delivery
of three days of orders is the incident `hub absorb` was written after.

**A node that has its own clone.** A source that is a git repository is refused: that
is a mesh node that stopped syncing, and it catches up by syncing
([7. A node stopped syncing](07-node-stopped-syncing.md)), not by being copied.

**Writers you did not stop.** The refusal sees only an agent that waits on a queue in
the source. One that only writes is not seen, and what it writes after the absorb stays
behind. An absorb happens once: the label is refused the second time, and the same
source under a new label would bring everything in twice. Stop the writers first, and
move the source away right after.

**Sending everything unread again.** The list of unread blocks is a list to read, not
to forward. Some of it was overtaken while the agents were away.

**The next time.** hubd falls back to `~/.hubd` without a word, by design: one person
on one machine needs no setup. On a machine where agents run as services, name the hub
in the environment file the service reads, not in a shell profile it never sources,
and run `hub doctor` once as that user: `via env HUBD_DIR` is what you want to read.
