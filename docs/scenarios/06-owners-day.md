# 6. The owner's day

**The situation.** Three tracks and a coordinator run without you. What still needs
you are the decisions only a person can make: money, going live, anything said to the
outside. Each one arrives as a "waiting on you" line somewhere in a session's
transcript. The one you miss waits for days, and then decides by default.

**What you end with.** In the morning, one list of everything that waits for you, each
item with its age. You answer each where it was asked, in a sentence, and the agents
pick the answers up without being told. Once a week, a review that does not depend on
what you remember: what the cards declare, against what happened.

Levels 2, 3 and 5: [2. Work](../start/2-work.md) has decisions as tasks,
[3. Queues](../start/3-queues.md#a-button-for-a-human) as messages, and
[5. Roles](../start/5-roles.md) the board that collects them. This scenario uses a
demo hub, a week of an invented team's work, whose owner role is `owner`. Every output
below is real, captured in one run on a node called `oak`, so its clock reads minutes
where the story says hours.

```bash
hub demo /tmp/hub-s6 > /dev/null
export HUBD_DIR=/tmp/hub-s6 HUBD_TEAM_DIR=/tmp/hub-s6 HUBD_NODE=oak
```

## Morning: what waits for you

```bash
hub board | sed -n '/WAITING FOR YOU/,$p'
```

```text
── WAITING FOR YOU
  owner queue (1)
    owner  0d  from atlas-head  Ranking v2 can go to 10% of traffic once fir-1 is in. Turn it on Tuesday, or wa…
  your tasks (1)
    #maple-4 [infra]  Approve a 2 TB disk for the build cache on fir
  escalations to coord, unanswered (1)
    2026-10-07 15:36 · from relay-head · id pine-17  waiting 50m  #pine-2  The staging key server rejects the new webhook signing key: 401 on ev…
  answered in the last 24h (1)
    2026-10-06 20:26 · from atlas-head · id fir-41  answered 10-06 21:26 after 60m  renewed the cert; renew a week ahead from now on
```

Three kinds of question, from three places: a message to your queue, a task with
your name on it, and an escalation a head sent up. The Summary in `hub serve` shows
the same list. `hub brief` counts them too, as `BUTTONS` and `OWNER'S OWN`.

## A message: answer it where it was asked

```bash
hub queue wait owner --timeout 1
hub queue send atlas-head "Wait for the Thursday release: ship ranking v2 in it, then 10% on Friday morning, with the rollback switch tested first." --from owner --task fir-2
```

```text
## 2026-10-07 15:56 · from atlas-head · id fir-44
Ranking v2 can go to 10% of traffic once fir-1 is in. Turn it on Tuesday, or wait for the Thursday release?
→ atlas-head.oak.queue.md delivered  (about task #fir-2)
```

The answer is about the task it decides, so the head gets it with the task.

## A task: decide it, with the reason

The coordinator filed the disk as your task, and its note has the numbers:

```bash
hub log infra | tail -3
```

```text
2026-10-07 15:41 [infra/coord] task: + task #maple-3: Free space on fir: / is at 93%
2026-10-07 15:46 [infra/coord] note: fir: / at 93%, the build cache holds 61 GB; filed maple-3
2026-10-07 15:47 [infra/coord] task: + task #maple-4: Approve a 2 TB disk for the build cache on fir
```

```bash
hub report -p infra --agent owner <<'EOF'
DECIDE: buy the 2 TB disk for the build cache on fir | the cache is 61 GB and grows about 4 GB a week; cleaning it buys a month, the disk two years
DONE: maple-4
EOF
```

```text
Reported to infra: 1 decision, closed #maple-4
```

The decision and its reason go on the infra card, where the next person who asks why
fir has a second disk will find them.

## An escalation: answer it on the card

An escalation is answered by an entry in Owner decisions on the coordinator's card
that quotes its key ([3. A track with a head](03-track-with-a-head.md#answer) has the
whole path):

```bash
KEY="$(hub board | grep -o '20[0-9-]* [0-9:]* · from relay-head · id pine-17')"
hub section add infra owner-decisions "answered $KEY — roll staging back to the old signing key today; rotate again after the key server upgrade" --by owner
hub board | sed -n '/WAITING FOR YOU/,$p'
```

```text
infra → ## Owner decisions
── WAITING FOR YOU
  answered in the last 24h (2)
    2026-10-07 15:36 · from relay-head · id pine-17  answered 10-07 16:26 after 50m  roll staging back to the old signing key today; rotate again after th…
    2026-10-06 20:26 · from atlas-head · id fir-41  answered 10-06 21:26 after 60m  renewed the cert; renew a week ahead from now on
  nothing
```

Nothing waits. Three answers, each a sentence, each where the one who asked will look.

## The agents pick it up

Nobody has to tell the head. Its next wait returns the answer, with the task it is
about:

```bash
hub queue wait atlas-head --timeout 1
```

```text
## 2026-10-07 16:26 · from owner · id oak-1 · task #fir-2
Wait for the Thursday release: ship ranking v2 in it, then 10% on Friday morning, with the rollback switch tested first.

# about task(s): #fir-2 — report against them (DONE:/NOTE:) so the task carries the outcome
```

`relay-head` finds its answer on the infra card, and the Summary shows `pine-17` as
answered, with the answer, to everyone.

## Once a week

A review that does not depend on your noticing anything. First, once, tell hubd what to
hold the cards to: which projects are money bets, and your own rule, with the date
you wrote it. The relay card's gate was written when the paid tier started, a month
ago:

```bash
cat > "$HUBD_DIR/rules.json" <<'EOF'
{ "money": ["relay"],
  "laws": { "gate-expired": { "text": "A money bet gets a verdict on its gate date: go on, change course, or stop.",
                              "since": "2026-09-01", "source": "AGENTS.md" } } }
EOF
cat >> "$HUBD_DIR/projects/relay.md" <<'EOF'

## Gates

- 2026-09-07 10:00: the paid tier has 20 paying teams by 2026-10-05, or it goes back to free
EOF
```

Then, every Monday:

```bash
hub inbox
hub audit --days 7 --apply --by owner
```

```text

## BLOCKED (1)
  2026-10-07 15:16 [relay/relay-dev] pine-2: the staging key server rejects the new signing key (401 on every request since the rotation); the delivery test cannot run

## UNASSIGNED (2)
  #fir-5 [atlas] normal — Audit third-party scripts on the landing page
  #pine-4 [relay] normal — Rate-limit headers on the public API
── AUDIT · 2026-10-07 16:26 · window 7d ──
  note: report-at-end-only: traces are journal lines + task creations + claims + presence records; heartbeats keep no history, so a session is approximated by the calendar day.
  note: work-without-journal checked nothing: no card records a local `- path:` with a git checkout on this node.

NUMBERS (a thermometer, not a verdict):
  journal entries: 49 · open tasks: 9
  attention share: atlas 43% · relay 27% · infra 22% · mail 8%
  closed by category: none 5
  closed by assignee: owner 2 · atlas-dev 1 · relay-dev 1 · atlas-qa 1

FINDINGS (1):
 ! [gate-expired] relay: gate date 2026-10-05 passed with no decision recorded since
     rule: A money bet gets a verdict on its gate date: go on, change course, or stop. (recorded 2026-09-01)
     fix:  either DECIDE a new date or let it drop to background — hub decide "<verdict>" --why "<why>" -p relay

filed 1 incident(s): #oak-1
one report written to project "general"
```

`hub inbox` is what the team cannot move without someone: the blocked, the overdue,
the unassigned. `hub audit` reads what the cards declare against what happened: a gate
whose date passed with no decision since, a project that says `MODE: background` and
takes most of the week, a button nobody pressed for a week, a card that stopped
following its own journal. The finding quotes your rule and the date you wrote it, and
`--apply` files it as a task, once: a finding already open is not filed again next
Monday.

The paid tier missed its gate. The verdict is the owner's:

```bash
hub report -p relay --agent owner <<'EOF'
DECIDE: keep the paid tier to 2026-11-02 | 14 paying teams and 6 in trial; the webhook outage cost two weeks of trials
DONE: oak-1
EOF
hub section add relay gates "the paid tier has 20 paying teams by 2026-11-02, or it goes back to free" --by owner
hub audit --days 7 | tail -1
```

```text
Reported to relay: 1 decision, closed #oak-1
relay → ## Gates
no findings — declarations and behaviour agree
```

The rest of the weekly review, when something looks off: `hub brief --hours 168` for
the week's journal, `hub plan` for what unlocks what, `hub doctor` for the hub itself,
`hub lint` for which of your rules are checks and which are only written down.

## What can go wrong

**A question in a transcript.** An agent that asks in its own session, not in your
queue, asks no one: the question is on no list. The worker's rules send a decision to
the owner's queue, as one package: what was found, the options, a recommendation.

**A button you leave.** The brief and the board show its age. At seven days the audit
files it: an unanswered button decides by default, usually as "no".

**An answer in a chat.** An escalation is answered only by an Owner decisions entry
that quotes its key. Said anywhere else, the question stays waiting on every board.

**A question that takes more than a minute.** hubd never files a button by itself; an
agent does, and the package should be decidable in thirty seconds: the context, the
recommendation, the exact text to send. One that is not goes back as a question.

**A rule the audit cannot check.** A gate is checked only on a project listed in
`money`. With none listed, the audit says so in a note rather than reporting "no
findings" as if it had looked. A gate with no date can never pass; `hub lint` finds
one on a money bet.

**Numbers that lie.** A card that stopped following its project shows `⚠Nd behind`
in `hub status`, and old experiment roles still count as queues waiting in `hub
doctor`; `hub queue gc` lists those, and `--apply` moves them to `queues/archive/`.
Left alone, both inflate every number in the review.
