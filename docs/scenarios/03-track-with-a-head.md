# 3. A track with a head

**The situation.** A project with two or three agents on it, and you in the middle:
you decide who does what next, you read every "done" to see whether it is, and every
question comes to you, at any hour, in whichever session asked it.

**What you end with.** A head: one role that runs the track for you. It hands out the
work, takes nothing as done without an artifact it can check, and sends you only what
it cannot decide, as one question in one place. You answer on a card, and the Summary
shows the question answered, with its answer, to everyone.

Level 5: [5. Roles](../start/5-roles.md) declares a team and its board from scratch.
This scenario uses a demo hub, a week of an invented team's work, and watches its head
through one hand-in and one escalation. Every output below is real, captured in one
run on a node called `oak`, so its clock reads minutes where the story says hours.

```bash
hub demo /tmp/hub-s3 > /dev/null
export HUBD_DIR=/tmp/hub-s3 HUBD_TEAM_DIR=/tmp/hub-s3 HUBD_NODE=oak
```

The team's machines are `fir`, `pine` and `maple`; your commands run on `oak`, so
what they add gets oak's ids.

## The track

```bash
hub board atlas
```

```text
── atlas · head atlas-head · done 7d 2 · next 3 · blocked 1
    ● atlas-head        head   waiting 6m                    10-07 11:09 #fir-3 Fix the flaky login test
    ● atlas-dev         worker turn 13m #31    #fir-1        10-07 13:09 fir-1: index rebuilt with the new weights; p95 query 84 ms on staging…
    ● atlas-qa          worker waiting 301m                  10-07 10:59 fir-3: the test waited on a fixed 2 s timer; it now waits for the ses…
  DONE (2)
    10-07 11:09  #fir-3  Fix the flaky login test  ← atlas-head: ACCEPT #fir-3: 50 runs, 0 failures, the diff touches only t…
    10-02 16:09  #fir-6  Split the settings page into tabs  ← atlas-head: ACCEPT #fir-6: three tabs, e2e 41/41, the screenshots match…
  NEXT (3)
    #fir-1  Ship search ranking v2 @atlas-dev
    #fir-5  Audit third-party scripts on the landing page
    #fir-4  Rewrite the onboarding copy @atlas-dev
  BLOCKED (1)
    #fir-2  Turn ranking v2 on for 10% of traffic  ← waits on #fir-1
…
```

`atlas-head` heads the track, and `atlas-dev` and `atlas-qa` work under it. Every
task in DONE carries the line that accepted it. `atlas-qa` has been waiting for five
hours, and `#fir-5` has nobody on it.

## The head wakes on events, not on a timer

A head that wakes every few minutes to read the hub spends a model call on each wake,
and most wakes find nothing. Its loop asks the sensor instead, which measures what can
be measured without a model:

```bash
hub sense atlas-head | head -3
```

```text
SUPERVISION EVENTS (2026-10-07 16:09 UTC) — the sensor has already taken the measurements, do not re-measure. Handle EACH one and end the turn.

1. WORKER IDLE: atlas-qa — queue empty for 6 polls (~30 min); open on it: nothing. Cut and give it the next task toward the project goal.
```

Exit 0 means: wake the head with this text. Exit 1 means nothing happened, and no
model is called. (The rest of the output lists the sensor's checks for work handed in
on git branches; this track hands in files.)

## Dispatch

The head gives `#fir-5` to the idle worker. Done is defined up front, as an artifact:

```json
--> hub_task_update {"id": "fir-5", "assignee": "atlas-qa", "by": "atlas-head"}
{
 "ok": true,
 "task": { "id": "fir-5", "project": "atlas", "text": "Audit third-party scripts on the landing page", "assignee": "atlas-qa", "status": "open", … }
}
```

```bash
hub queue send atlas-qa "fir-5: list every third-party script the landing page loads, with its host, its size, and what breaks without it. Hand in a file: its path, size and sha256." --from atlas-head --task fir-5
```

```text
→ atlas-qa.oak.queue.md delivered  (about task #fir-5)
```

## The hand-in

`atlas-qa` reads the dispatch, takes the task, does the audit and hands it in: the
finding as a `FACT:`, and the artifact as a `done` entry in the journal (`-k done`)
with its path, size and checksum.

```bash
hub queue wait atlas-qa --timeout 1
hub claim --task fir-5 -t 120 --agent atlas-qa
mkdir -p /tmp/hub-s3-work && cat > /tmp/hub-s3-work/fir-5-audit.md <<'EOF'
# fir-5: third-party scripts on the landing page

| host                  | bytes   | without it                                        |
|-----------------------|---------|---------------------------------------------------|
| cdn.analytics.example | 48 210  | no page-view counts                               |
| fonts.example         | 31 004  | system fonts; the layout holds                    |
| widget.chat.example   | 212 880 | no chat bubble; it sets 3 cookies before consent  |
EOF
F=/tmp/hub-s3-work/fir-5-audit.md
hub report -p atlas --agent atlas-qa -k done <<EOF
FACT: the landing page loads 3 third-party scripts, 292 KB; the chat widget sets 3 cookies before consent
fir-5 handed in: $F, $(wc -c < $F | tr -d ' ') B, sha256 $(shasum -a 256 $F | cut -c1-64)
EOF
```

```text
## 2026-10-07 16:09 · from atlas-head · id oak-1 · task #fir-5
fir-5: list every third-party script the landing page loads, with its host, its size, and what breaks without it. Hand in a file: its path, size and sha256.

# about task(s): #fir-5 — report against them (DONE:/NOTE:) so the task carries the outcome
Started #fir-5: 9e45e4db-5702-49db-9307-4948f05e2098 (until 2026-10-07 18:09)
Reported to atlas: 1 fact, note
```

The worker does not close the task. Handing in is its part; closing is the head's.

## Accept by artifact

The head's next sensor run has the hand-in as an event:

```bash
hub sense atlas-head | head -3
```

```text
SUPERVISION EVENTS (2026-10-07 16:10 UTC) — the sensor has already taken the measurements, do not re-measure. Handle EACH one and end the turn.

1. WORKER REPORT atlas-qa 2026-10-07 16:10 UTC: fir-5 handed in: /tmp/hub-s3-work/fir-5-audit.md, 490 B, sha256 f4d378436f9f3f624ee8aa67ac3ffc8411c36e8abf3ffa372fbbdcc50f87b2ea
```

It checks the artifact, not the report: the file is the one handed in, and it says
what the dispatch asked for.

```bash
shasum -a 256 /tmp/hub-s3-work/fir-5-audit.md
hub report -p atlas --agent atlas-head <<'EOF'
ACCEPT #fir-5: 3 scripts, each with its host, size and what breaks without it; the sha256 matches the hand-in
DONE: fir-5
EOF
```

```text
f4d378436f9f3f624ee8aa67ac3ffc8411c36e8abf3ffa372fbbdcc50f87b2ea  /tmp/hub-s3-work/fir-5-audit.md
Reported to atlas: closed #fir-5, released 1 task claim, note
```

`ACCEPT #<id>` in capitals is a verdict: the board and the Summary show it beside the
task. A `REJECT #<id>` says what to fix, and the task stays open.

## Escalate

The audit found something the head cannot decide: the chat widget breaks the consent
rule, and marketing relies on the chat. That is the owner's call. A head escalates to
the team's coordinator, the role of rank `fleet` (`coord` here), and an escalation
waits there, with its age, until the owner answers it:

```bash
hub queue send coord "The landing page's chat widget sets 3 cookies before consent (the fir-5 audit). Marketing relies on the chat. Drop it, or load it only after consent, at the cost of a slower first chat?" --from atlas-head
hub board atlas | sed -n '/WAITING FOR YOU/,$p'
```

```text
→ coord.oak.queue.md delivered
── WAITING FOR YOU
  owner queue (1)
    owner  0d  from atlas-head  Ranking v2 can go to 10% of traffic once fir-1 is in. Turn it on Tuesday, or wa…
  your tasks (1)
    #maple-4 [infra]  Approve a 2 TB disk for the build cache on fir
  escalations to coord, unanswered (2)
    2026-10-07 16:10 · from atlas-head · id oak-2  waiting 0m  The landing page's chat widget sets 3 cookies before consent (the fir…
    2026-10-07 15:19 · from relay-head · id pine-17  waiting 51m  #pine-2  The staging key server rejects the new webhook signing key: 401 on ev…
  answered in the last 24h (1)
    2026-10-06 20:09 · from atlas-head · id fir-41  answered 10-06 21:09 after 60m  renewed the cert; renew a week ahead from now on
```

Everything that waits for you, from every track, in one list.

## Answer

The answer goes on the coordinator's project card, in Owner decisions, and quotes the
escalation's key: its header line, the time, the sender and the id.

```bash
KEY="$(hub board | grep -o '20[0-9-]* [0-9:]* · from atlas-head · id oak-[0-9]*')"
hub section add infra owner-decisions "answered $KEY — load it after consent; a slower first chat is fine" --by owner
```

```text
infra → ## Owner decisions
```

An answer is a dated entry on a card, so it is still there next month for anyone who
asks why the chat loads late.

## The Summary

`hub serve` is the read-only board in a browser; its Summary is every track and every
escalation on one screen. The same data, from its API:

```bash
hub serve -p 7790 &
curl -s localhost:7790/api/summary | jq '.escalations | {waiting: [.waiting[].key], answered: [.answered[] | {key, answer: .answer.text}]}'
kill %1
```

```text
hubd kanban  http://127.0.0.1:7790
  Summary: where each track stands   Tracks: roles, done, next, waiting for you   Live: kanban   History: sparkline + event playback
Ctrl+C to stop
{
  "waiting": [
    "2026-10-07 15:19 · from relay-head · id pine-17"
  ],
  "answered": [
    {
      "key": "2026-10-06 20:09 · from atlas-head · id fir-41",
      "answer": "- 2026-10-06 21:09: answered 2026-10-06 20:09 · from atlas-head · id fir-41 — renewed the cert; renew a week ahead from now on"
    },
    {
      "key": "2026-10-07 16:10 · from atlas-head · id oak-2",
      "answer": "- 2026-10-07 16:10: answered 2026-10-07 16:10 · from atlas-head · id oak-2 — load it after consent; a slower first chat is fine"
    }
  ]
}
```

The head reads the same answer and turns it into work:

```bash
hub task add "load the chat widget only after consent" -p atlas --assignee atlas-dev --by atlas-head
```

```text
Task #oak-1 added: load the chat widget only after consent
```

## What can go wrong

**"Done" without an artifact.** A hand-in that says done and names nothing is a claim
nobody can check. The head rejects it and says what is missing; the demo's week has
one:

```bash
hub log atlas | grep REJECT
```

```text
2026-10-07 10:09 [atlas/atlas-head] note: REJECT #fir-4: the hero still says "beta", and the Team screen has no screenshot; redo both
```

**A verdict in lowercase.** "accept" in a sentence is not a verdict, so the task shows
no acceptance. A verdict is the word in capitals with the task's `#id`. Heads that
write in another language add their words in `verdicts.json` in the hub.

**An answer that does not quote the key.** The escalation stays waiting, however old.
Nothing reads a chat for an answer, and `id oak-2` is not `id oak-20`. Take the key
from the board, as above.

**A head that works instead of heading.** A head that writes the code too has no one
to check it. The head's rules ([prompts/meta](../../prompts/meta/README.md)) say it
dispatches and accepts; [5. Roles](../start/5-roles.md#rules-rendered-per-role) renders
them.

**A head on a timer.** A head that wakes every five minutes to look spends a model call
on every look. Two heads on a timer once spent a night on about 140 empty turns. Put
`hub sense` in its loop, and wake the model only on exit 0.
