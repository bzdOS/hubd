# 5. The team learns

**The situation.** The same mistakes come back. A worker loses a turn to a load tool's
defaults, notes it, is compacted, and loses another turn to it next week. A second
worker, on another task, hits the same wall. You find out if you read the transcripts,
and the fix is a line you add by hand to one role's prompt.

**What you end with.** Every turn ends with five checked lines. Once a week the head
reads them as one digest instead of reading the reports, and rules on the lessons that
keep coming back. An accepted one reaches every role of the project with its context.
One that the environment should fix once, instead of every session remembering it, is
rejected with the reason and becomes a task. The head reflects on its own part too.

Level 6: [6. Laws](../start/6-laws.md) writes the reflections and accepts a law step
by step. This scenario uses a demo hub, a week of an invented team's work, and follows
its heads through one weekly review. Every output below is real, captured in one run
on a node called `oak`, so its clock reads minutes where the story says hours.

```bash
hub demo /tmp/hub-s5 > /dev/null
export HUBD_DIR=/tmp/hub-s5 HUBD_TEAM_DIR=/tmp/hub-s5 HUBD_NODE=oak
```

## A week, in one digest

Every turn of every worker ended with a `REFLECT` block: the goal, the result, the
obstacle by class with a fact, what to do instead, and one rule. The head of `atlas`
reads the week:

```bash
hub reflect --project atlas
```

```text
atlas: 5 reflection(s) since 2026-09-30 16:20, from 2 role(s)
  atlas-dev  3: done 1, partial 2 · obstacles: unclear-dispatch 1, environment 1, none 1
  atlas-qa  2: done 1, partial 1 · obstacles: environment 1, none 1

obstacles
  unclear-dispatch 1
    2026-10-01 15:20 atlas-dev: the dispatch named two tabs, the mock shows three
  environment 2
    2026-10-05 16:20 atlas-qa: the CI runner reuses one browser profile between jobs
    2026-10-03 12:20 atlas-dev: the staging database was down for 20 minutes during the deploy

rules proposed more than once
  ×2 run the smoke test before every deploy  (atlas-dev, atlas-qa; last 2026-10-05 16:20)
  ×2 attach a screenshot to each UI task you hand in  (atlas-dev, atlas-qa; last 2026-10-01 20:20)
    ~ ×1 attach a screenshot to every UI task
```

Five turns in fifteen lines. Three of them did not finish, and each says why, with a
fact. One of the three is the head's own doing: an `unclear-dispatch` is a dispatch
that was wrong, not a worker that was slow.

## A law

A rule said three times by one role, or by two roles, within seven days, is a candidate:

```bash
hub reflect --promote --project atlas
```

```text
atlas: 1 candidate(s) for the project's laws since 2026-09-30 16:20 (a rule said 3 times by one role, or by 2 roles), 1 law(s) already

  73c7bc  ×2  atlas-dev 1, atlas-qa 1; last 2026-10-05 16:20
    run the smoke test before every deploy

accept: hub reflect --accept <id> --project atlas --by <head>
reject: hub reflect --reject <id> --project atlas --by <head> --reason "<why>"
```

The screenshot rule is not on the list: it has been a law for two days. The smoke test is
a step any role can take, and nothing else would make it happen, so the head accepts
it:

```bash
hub reflect --accept 73c7bc --project atlas --by atlas-head
hub reflect --laws --project atlas
```

```text
law of atlas, in its card's Laws section: run the smoke test before every deploy
- attach a screenshot to every UI task you hand in
- run the smoke test before every deploy
```

## A lesson that is not a law

The `relay` track's week has another kind of lesson:

```bash
hub reflect --promote --project relay
```

```text
relay: 1 candidate(s) for the project's laws since 2026-09-30 16:20 (a rule said 3 times by one role, or by 2 roles), 0 law(s) already

  9370a7  ×3  relay-dev 3; last 2026-10-06 20:20
    raise the file limit before load tests
    ~ ×1 raise the open file limit before every load test
    ~ ×1 raise the open-file limit before a load test

accept: hub reflect --accept <id> --project relay --by <head>
reject: hub reflect --reject <id> --project relay --by <head> --reason "<why>"
```

`relay-dev` said it three times in three wordings, and it is true. But a law is
something every session must remember, every time, and this one can be made true
once: the load box can boot with the higher limit. The head rejects it with that
reason, and turns it into the task that makes it unnecessary:

```bash
hub reflect --reject 9370a7 --project relay --by relay-head --reason "a fixed limit in the load box image, not a rule to remember: see the task"
hub task add "set nofile to 1048576 in the load box image" -p relay --assignee relay-dev --by relay-head
```

```text
rejected for relay: raise the file limit before load tests
Task #oak-1 added: set nofile to 1048576 in the load box image
```

Both verdicts are decisions in the journal, with their reasons. A rejected rule leaves
the list, and comes back only if the turns keep saying it after the rejection.

## The head's own turn

The head ends its review with a reflection of its own, `HEAD-REFLECT`, in the same
five lines. The question is where it held things up itself:

```bash
hub report -p atlas --agent atlas-head <<'EOF'
FACT: atlas week: 5 turns, 2 done, 3 partial; obstacles environment 2, unclear-dispatch 1
HEAD-REFLECT
goal: review the atlas workers' week
result: done
obstacle: unclear-dispatch — my dispatch for fir-6 named two tabs, the mock had three; one turn of atlas-dev redone
instead: I would have linked the mock in the dispatch instead of retelling it
rule: link the mock in every UI dispatch, do not retell it
EOF
hub reflect --project atlas --level head
```

```text
Reported to atlas: 1 fact, note, reflection (head, read from the text)
atlas: 1 reflection(s) since 2026-09-30 16:20, level head, from 1 role(s)
  atlas-head  1: done 1 · obstacles: unclear-dispatch 1

obstacles
  unclear-dispatch 1
    2026-10-07 16:20 atlas-head: my dispatch for fir-6 named two tabs, the mock had three; one turn of atlas-dev redone
```

Heads' reflections are counted apart from the workers', and the orchestrator reads
them as the head reads its workers' (`--level fleet` is the orchestrator's own).

## Every role gets it

The next session of any role on `atlas` starts with `hub_context`. A folder whose name
is not the project's says which project it is with a `.hubd` file:

```bash
mkdir -p /tmp/hub-s5-work/atlas && echo atlas > /tmp/hub-s5-work/atlas/.hubd
```

What `atlas-qa`'s session gets from that folder (abridged):

```json
--> hub_context {"cwd": "/tmp/hub-s5-work/atlas"}
{
 "project": "atlas",
 "via": "marker",
 "laws": [
  "attach a screenshot to every UI task you hand in",
  "run the smoke test before every deploy"
 ],
 "openTasks": [ … ],
 "journalTail": [ …,
  { "agent": "atlas-head", "kind": "decision", "text": "law accepted: run the smoke test before every deploy", … },
  … ]
}
```

Nobody edited a prompt. `atlas-dev` and `atlas-qa` drew the rule, the head accepted it,
and every session on the project now starts with it, whichever client it runs in.
From a shell, `hub whereami` in that folder shows the same `laws:`.

## What can go wrong

**A rule nobody can check.** "Be careful with deploys" can be said by two roles and
become a candidate. A law that cannot be checked is not followed; the head rejects it,
and the reason says what a rule must name: what to do, and when.

**One rule in two languages.** The head matches rules by their words, so a rule in
two languages counts as two rules, each half as often. The worker's rules keep the
values in the language of the dispatch, and the keys in English.

**The example's rule.** A model asked for a rule fills the field with the nearest
text that fits, which is often the rule in the prompt's own example. hubd counts that
one apart and never as a candidate, and the field form refuses it.

**A worker making law.** A project's laws are its head's to rule on, or a fleet
role's; a worker's `--accept` is refused
([6. Laws](../start/6-laws.md#what-hubd-refuses-here-and-why)).

**A session that skips `hub_context`.** It never sees the laws. The worker's rules
make `hub_context` its first call, and the first call after a compaction.
