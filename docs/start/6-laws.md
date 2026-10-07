# 6. Laws — a team that learns from its own turns

**What you get.** Every turn ends with five checked lines: what it was for, what came
of it, what got in the way, what to do differently, and one rule it taught. hubd
counts them. A rule that several turns keep arriving at becomes a candidate; the head
accepts it, and from then on every role on the project gets it with its context. The
team's lessons stop living in one session's memory.

Ten minutes. This continues [5. Roles](5-roles.md): the `shop` track, its head
`head-shop`, on `oak`.

```bash
export HUBD_DIR=/tmp/hub-tour HUBD_TEAM_DIR=/tmp/hub-tour HUBD_NODE=oak
cd /tmp/hub-tour-work/shop
```

## A turn ends with a reflection

The last block of a turn's one report is the word `REFLECT` and five lines. The
worker that ran the load test:

```bash
hub report -p shop --agent worker <<'EOF'
FACT: load test, 200-item carts, 1000 checkouts: p95 1.4 s, 0 errors (bench/load-200.log)
REFLECT
goal: measure checkout under 200-item carts
result: done
obstacle: environment — the load tool defaults to 10-item carts; the first run measured nothing useful
instead: set the cart size before the first run
rule: load-test with the cart size the bug was reported at, not the tool's default
EOF
```

```text
Reported to shop: 1 fact, note, reflection (turn, read from the text)
```

And the developer who wired the payment page, a turn later:

```bash
hub report -p shop --agent dev-shop <<'EOF'
FACT: the payment page redirect works for carts up to 200 items on staging
REFLECT
goal: wire the hosted payment page into checkout
result: partial
obstacle: environment — staging had 10-item carts only; a 200-item cart failed the redirect at 8 KB of query string
instead: test with the cart size the bug was reported at from the start
rule: load-test with the cart size the bug was reported at, not the tool's default
EOF
```

```text
Reported to shop: 1 fact, note, reflection (turn, read from the text)
```

`result` is `done`, `partial` or `no`. `obstacle` is a class from a fixed list
(`permissions`, `path`, `unclear-dispatch`, `environment`, `model`, `none`) and then
the fact, with a number in it. The fixed list is what lets a head count obstacles
instead of reading them. The worker's rules (tutorial 5) ask for this block on every
turn, so nobody has to remember it.

## What the turns say, together

```bash
hub reflect --project shop
```

```text
shop: 2 reflection(s) since 2026-09-30 13:04, from 2 role(s)
  worker  1: done 1 · obstacles: environment 1
  dev-shop  1: partial 1 · obstacles: environment 1

obstacles
  environment 2
    2026-10-07 13:04 dev-shop: staging had 10-item carts only; a 200-item cart failed the redirect at 8 KB of query string
    2026-10-07 13:04 worker: the load tool defaults to 10-item carts; the first run measured nothing useful

rules proposed more than once
  ×2 load-test with the cart size the bug was reported at, not the tool's default  (worker, dev-shop; last 2026-10-07 13:04)
```

Two roles, working on different tasks, hit the same wall and drew the same rule from
it. That is the signal a head is looking for, and it took no meeting to find.

## From a rule to a law

```bash
hub reflect --promote --project shop
```

```text
shop: 1 candidate(s) for the project's laws since 2026-09-30 13:04 (a rule said 3 times by one role, or by 2 roles), 0 law(s) already

  4c20cb  ×2  worker 1, dev-shop 1; last 2026-10-07 13:04
    load-test with the cart size the bug was reported at, not the tool's default

accept: hub reflect --accept <id> --project shop --by <head>
reject: hub reflect --reject <id> --project shop --by <head> --reason "<why>"
```

A rule said three times by one role, or by two roles, within seven days is a
candidate. The head rules on it:

```bash
hub reflect --accept 4c20cb --project shop --by head-shop
hub reflect --laws --project shop
```

```text
law of shop, in its card's Laws section: load-test with the cart size the bug was reported at, not the tool's default
- load-test with the cart size the bug was reported at, not the tool's default
```

The law is a line in the card's Laws section, and the acceptance is a decision in the
journal. Every role that opens the project now gets it: `hub_context` returns it as
`laws`, and `hub whereami` shows it:

```text
…
laws:     1, accepted by the project's head
  - load-test with the cart size the bug was reported at, not the tool's default
…
```

A rejected candidate (`--reject <id> --reason "<why>"`) leaves the list, and comes back
only if the turns keep saying it. Laws are never rotated into history with a section's
older lines: a law moved out of the card would be a law nobody reads.

## Heads and the orchestrator reflect too

A head ends its review of its workers with `HEAD-REFLECT`, the orchestrator its review
of the heads with `FLEET-REFLECT`; `hub reflect --level head|fleet` reads each level
on its own. The demo hub has a candidate waiting:

```bash
HUBD_DIR=/tmp/hub-tour-demo HUBD_TEAM_DIR=/tmp/hub-tour-demo hub reflect --promote --project relay
```

```text
relay: 1 candidate(s) for the project's laws since 2026-09-30 13:13 (a rule said 3 times by one role, or by 2 roles), 0 law(s) already

  9370a7  ×3  relay-dev 3; last 2026-10-06 17:13
    raise the file limit before load tests
    ~ ×1 raise the open file limit before every load test
    ~ ×1 raise the open-file limit before a load test

accept: hub reflect --accept <id> --project relay --by <head>
reject: hub reflect --reject <id> --project relay --by <head> --reason "<why>"
```

One role said it three times, in three wordings. Wordings that share most of their
words count as one rule, and the `~` lines are the other wordings counted with it: a
rule said three ways is still said three times.

## What hubd refuses here, and why

**A reflection that hides the obstacle.** A turn that delivered nothing names what held
it up; "no result, no obstacle" is the one answer a head can do nothing with.

```bash
hub report -p shop --agent worker -m "FACT: nothing shipped" --reflect '{"goal":"rotate the staging key","result":"no","obstacle":"none","instead":"none","rule":"none"}'
```

```text
Error: reflect: result "no" with obstacle "none": a turn that delivered nothing names what held it up, one of permissions | path | unclear-dispatch | environment | model
```

The `--reflect` field (and `hub_report`'s `reflect` over MCP) is checked as it is
written: a value off a list refuses the whole report, with the reason. The text block
is read without refusing, because rejecting a report would lose the report; what is
wrong in it is counted as a problem the head sees. A `rule` holding several rules
joined by `;` is refused too: one turn, one lesson.

**A worker making law.** A project's laws are its head's to rule on, or a fleet
role's:

```bash
hub reflect --accept 4c20cb --project shop --by dev-shop
```

```text
Error: a law of shop is its head's to rule on (head-shop) or a fleet role's; dev-shop is of rank worker
```

## What you have now

A team whose repeated lessons become rules every role works by, with a person
deciding which ones. The picture is in [Concepts → From a reflection to a law](../concepts.md#from-a-reflection-to-a-law).

Next: [7. A server](7-server.md) — one hub for a team over HTTP, and a feed of what
happens in it.
