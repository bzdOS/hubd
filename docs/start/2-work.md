# 2. Work and decisions — what to do now, and what only you can decide

**What you get.** Tasks with dependencies and deadlines, one answer to "what next",
a day split into what agents can do and what waits for a human, and soft locks so
two sessions do not edit the same file at once.

Ten minutes. This continues [1. Memory](1-memory.md): same practice hub, same `shop`
project, outputs from a node called `oak`.

```bash
export HUBD_DIR=/tmp/hub-tour HUBD_TEAM_DIR=/tmp/hub-tour HUBD_NODE=oak
cd /tmp/hub-tour-work/shop
```

## Tasks, and what they wait on

Say which roles are human. Their tasks are the decisions only a person can make:

```bash
echo '["alice"]' > "$HUBD_DIR/owner-roles.json"
```

```bash
hub task add "choose the payment provider" -p shop --assignee alice --by dev-shop
hub task add "wire the hosted payment page into checkout" -p shop -i high --needs oak-1 --by dev-shop
hub task add "fix the 30 s checkout timeout on big carts" -p shop -d 2026-10-10 --by dev-shop
hub task add "load-test checkout with 200 items" -p shop --needs oak-3 --by dev-shop
```

```text
Task #oak-1 added: choose the payment provider
Task #oak-2 added: wire the hosted payment page into checkout
Task #oak-3 added: fix the 30 s checkout timeout on big carts
Task #oak-4 added: load-test checkout with 200 items
```

A task id carries the node that made it (`oak-1`), so two machines never hand out
the same number. `--needs` says what a task waits on; `-d` is a deadline; `-i high`
is importance.

```bash
hub task list -p shop
```

```text
  #oak-1 [shop] @alice choose the payment provider
! #oak-2 [shop] wire the hosted payment page into checkout
  #oak-3 [shop] ⏰2026-10-10 fix the 30 s checkout timeout on big carts
  #oak-4 [shop] load-test checkout with 200 items
(4 tasks)
```

## What next

One answer, with its reason:

```bash
hub now shop
```

```text
#oak-3 [shop] ⏰2026-10-10
fix the 30 s checkout timeout on big carts

why: due 2026-10-10
(2 ready, 2 blocked; next after it: #oak-1)
```

The whole graph, when one answer is not enough:

```bash
hub plan shop
```

```text
── TRAJECTORY · shop · 2026-10-07 12:55 ──  open 4 · ready 2 · blocked 2 · depth 2

READY NOW (2):
  #oak-1 [shop] choose the payment provider
  #oak-3 [shop] fix the 30 s checkout timeout on big carts

CRITICAL PATH (2): #oak-1 → #oak-2

UNLOCK ORDER (topo layers):
  L0: #oak-1 #oak-3
  L1: #oak-2 #oak-4

BLOCKED (2):
  #oak-2 ← waiting on #oak-1 — wire the hosted payment page into checkout
  #oak-4 ← waiting on #oak-3 — load-test checkout with 200 items
```

And the day, split by who can act:

```bash
hub agenda shop
```

```text
── AGENDA · shop · 2026-10-07 12:55 ──  ready 2 · blocked 2

DUE SOON (1):
  #oak-3 [shop] ⏰2026-10-10 fix the 30 s checkout timeout on big carts

OWNER BUTTONS (only a human can press) (1):
  #oak-1 [shop] @alice choose the payment provider

AGENT WORK, READY NOW (1):
  #oak-3 [shop] ⏰2026-10-10 fix the 30 s checkout timeout on big carts

BLOCKED (2):
  #oak-2 [shop] wire the hosted payment page into checkout  ← waits on #oak-1
  #oak-4 [shop] load-test checkout with 200 items  ← waits on #oak-3
```

The payment page cannot start until alice chooses a provider, and the agenda says
so rather than letting an agent guess. `hub inbox` is the short form for you: only
what needs a decision (unassigned, blocked, overdue, stale locks).

Agents ask the same questions over MCP: `hub_next`, `hub_trajectory`, `hub_agenda`.

## Starting work, without stepping on anyone

An agent that starts a task says so, and the task is not offered to anyone else
until the claim lapses:

```bash
hub claim --task oak-3 --agent dev-shop -t 60
```

```text
Started #oak-3: 8f17a466-9a4a-44d0-8f64-e4dff4c1bff7 (until 2026-10-07 13:55)
```

It can also claim the files it is about to change, as a glob:

```bash
hub claim shop 'src/checkout/**' --agent dev-shop -t 60 --note "timeout fix"
```

```text
Lock: c667af9e-f11a-4532-bd5f-31b9c2a3ec19
```

A second session, before it edits a file there:

```bash
hub claim check src/checkout/cart.js --agent dev-api
```

```text
src/checkout/** — dev-shop since 2026-10-07 12:55 (timeout fix)
  src/checkout/cart.js is inside 1 live claim(s) on shop — coordinate before editing (soft lock, not enforced)
```

It exits 1, so an editor hook can stop on it; [prompts/client-hooks.md](../../prompts/client-hooks.md)
has hooks that claim and check for you. A claim is a soft lock: it informs, it never
blocks a write, and it expires by itself (`-t` minutes, 240 by default), so a crashed
session holds nothing for long.

## Closing work

The session that fixed the timeout files one report:

```bash
hub report -p shop --agent dev-shop <<'EOF'
FACT: the timeout was one query per cart line; batched, a 200-item cart checks out in 2 s
DONE: oak-3, oak-9
EOF
```

```text
Reported to shop: 1 fact, closed #oak-3, released 1 task claim
  warning: NOT closed: #oak-9 (no such task) — check the id with `hub task list`. Write "DONE: <id>[, <id>]" on a line of its own, each id as hub_task_list shows it ("DONE: pine-471"), "#" optional, or the bare number when one task ends in it ("DONE: 471").
```

`oak-9` was a typo. hubd closes what it can find and names what it could not; it
never guesses which task you meant. Closing `oak-3` also released the claim that
started it, whoever held it: finished work holds nothing. The claim on
`src/checkout/**` stays until it expires or `hub release` drops it, because files
outlive a task.

## The owner presses the button

Alice decides, and says why, so the reason outlives the conversation it was made in:

```bash
hub decide "PayCo's hosted page" --why "cheapest fees at our volume, and no card data touches us" -p shop --by alice
hub task done oak-1 --by alice
```

```text
Decided on shop: +1 → ## Decisions
Task #oak-1 closed
```

```bash
hub agenda shop
```

```text
── AGENDA · shop · 2026-10-07 12:56 ──  ready 2 · blocked 0

AGENT WORK, READY NOW (2):
  #oak-2 [shop] wire the hosted payment page into checkout
  #oak-4 [shop] load-test checkout with 200 items
```

Both blocked tasks are ready now: one waited on a fix, the other on a person.

## What hubd refuses here, and why

**Starting finished work.** A claim on a closed task would hide it from nobody and
mislead everyone.

```bash
hub claim --task oak-3 --agent dev-api
```

```text
Error: task #oak-3 is done — there is nothing to start
```

**A task with no project.** A task belongs somewhere, or nobody's `hub now` shows it.

```bash
hub task add "x" --by dev-shop
```

```text
Error: Project required: -p <proj>
```

**A closing id that matches nothing**, shown above: closed tasks are named, missed
ids are named, nothing is guessed. Over MCP the same list comes back as `doneMissed`.

What hubd does *not* do is just as deliberate: it never files an owner button by
itself, and it never blocks a write because of a claim. Both are decisions for the
agents and the people, made visible, not made for them.

## What you have now

A project whose work is a graph, an answer to "what next" for agents and for you,
and locks that expire. The longer scenarios: [Recipe 1](../recipes.md#1-solo-developer-several-agent-sessions)
(several sessions, one project) and [Recipe 4](../recipes.md#4-owner-buttons--decisions-only-a-human-can-make)
(owner buttons as queue messages).

Next: [3. Queues](3-queues.md) — an agent that waits for work and does it.
