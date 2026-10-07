# 11. Harvest

**The situation.** One evening you spend two hours in a chat with an assistant, on
your phone, about leaving the shop's payment provider. By the end the chat holds two
decisions with their reasons, half a dozen "we should", a clause you think is in the
contract, and an email you sent. None of it is anywhere else. Next week the chat is a
scroll you will not read again, and the agents that will do the work never see it.

**What you end with.** The chat turned into hub state: a card for the new project, a
task for each "we should", each decision with its why, what went out and to whom.
What you only thought is written as a guess, and nothing is closed that you did not
confirm. A week later, the same chat harvested again adds what is new and nothing
twice.

Level 2: [2. Work](../start/2-work.md) has cards, tasks and reports. Every output
below is real, captured in one run on a node called `oak`, so its clock reads minutes
where the story says hours.

```bash
export HUBD_DIR=/tmp/hub-s11 HUBD_TEAM_DIR=/tmp/hub-s11 HUBD_NODE=oak
hub init "$HUBD_DIR" > /dev/null
hub card shop -m "Web shop: catalogue, cart, checkout." --by alice > /dev/null
hub task add "Checkout: show the delivery date before payment" -p shop --by alice > /dev/null
```

## Ask for the harvest

hubd ships the request, the Harvest Protocol. `hub harvest` prints it; in an MCP
client it is a prompt (in Claude Code, `/mcp__hubd__harvest`), and the agent writes
into the hub with its own tools. A chat with no hubd tools, like this one on the
phone, gets the text pasted as its last message. The part that matters most:

```bash
hub harvest | sed -n '/^TRUTH/,/^$/p'
```

```text
TRUTH DISCIPLINE (this is the point):
- Never mark anything "done" unless I explicitly confirmed it happened.
  Optimistic logging is the #1 failure — when unsure, write "[?] unconfirmed" and
  ask, don't assume.
- Record what I actually said over what would be tidy.
- If you revise an earlier entry, LOG the correction — don't silently overwrite.
```

## What the chat answered

A chat without the tools answers with one block of commands, for you to read and then
run. This one, from the evening's conversation:

```bash
export HUBD_AGENT=alice
hub card "payments-move" -m "Moving the shop's card payments off the current provider, whose fee went from 1.4% to 2.1% in September.
Decided tonight: a provider with a flat fee of at most 1.5%; the old one stays open 120 days for refunds."
hub task add "Ask two providers for a quote at our volume (about 3,000 payments a month)" -p payments-move -i high
hub task add "Find out whether the new provider moves stored cards, or customers enter them again" -p payments-move
hub task add "Give the current provider notice once the new contract is signed" -p payments-move
hub task add "Checkout: swap the payment form for the new provider's" -p shop -i med
hub task add "Decide who tells subscription customers, and when" -p payments-move
hub report -p payments-move <<EOF
DECIDE: move card payments to a provider with a flat fee of at most 1.5% | the 2.1% fee costs about 1,900 a month at current volume
DECIDE: keep the current provider open 120 days after the move | refunds and chargebacks on old payments go back through it
HYPO: [?] unconfirmed: the contract allows leaving with 30 days' notice
HYPO: the conversion drop in September came from the new 3-D Secure screen, not the price
COMM: emailed the accountant the September fee numbers; waiting on a reply
NEXT: ask two providers for a quote
EOF
```

```text
Card set: payments-move → /tmp/hub-s11/projects/payments-move.md
Task #oak-2 added: Ask two providers for a quote at our volume (about 3,000 payments a month)
Task #oak-3 added: Find out whether the new provider moves stored cards, or customers enter them again
Task #oak-4 added: Give the current provider notice once the new contract is signed
Task #oak-5 added: Checkout: swap the payment form for the new provider's
Task #oak-6 added: Decide who tells subscription customers, and when
Reported to payments-move: 2 decisions, 2 hypothesis, 1 comm, next set
```

The commands name no author, so hubd takes it from `HUBD_AGENT`: whoever runs the
block answers for it. You said you thought the contract had a 30-day notice; the chat
wrote that down as a guess, marked `[?]`. The link between the 3-D Secure screen and
the drop in sales was the chat's own idea, so it is a guess too.

## Read what landed

```bash
hub task list
sed -n '/^## Facts/,$p' "$HUBD_DIR/projects/payments-move.md"
```

```text
  #oak-1 [shop] Checkout: show the delivery date before payment
! #oak-2 [payments-move] Ask two providers for a quote at our volume (about 3,000 payments a month)
  #oak-3 [payments-move] Find out whether the new provider moves stored cards, or customers enter them again
  #oak-4 [payments-move] Give the current provider notice once the new contract is signed
~ #oak-5 [shop] Checkout: swap the payment form for the new provider's
  #oak-6 [payments-move] Decide who tells subscription customers, and when
(6 tasks)
## Facts & hypotheses

- hypothesis: [?] unconfirmed: the contract allows leaving with 30 days' notice
- hypothesis: the conversion drop in September came from the new 3-D Secure screen, not the price

## Decisions

- 2026-10-07 17:08: move card payments to a provider with a flat fee of at most 1.5% — the 2.1% fee costs about 1,900 a month at current volume
- 2026-10-07 17:08: keep the current provider open 120 days after the move — refunds and chargebacks on old payments go back through it

## Communication

- 2026-10-07 17:08: emailed the accountant the September fee numbers; waiting on a reply
```

Each kind of line went to its place: the decisions with their reasons under
Decisions and in the journal, the guesses under Facts & hypotheses, the email under
Communication, dated. The checkout task went to the shop, where whoever works on the
checkout will find it. `hub brief` shows the new tasks tomorrow morning, and an agent
that opens either project reads them in `hub_context`.

## A week later

The chat went on: both quotes came in, you read the contract, and the new provider
said it moves stored cards itself. Harvest again. The chat does not know what the hub
already holds, so paste the open tasks with the request:

```bash
hub task list -p payments-move
```

```text
! #oak-2 [payments-move] Ask two providers for a quote at our volume (about 3,000 payments a month)
  #oak-3 [payments-move] Find out whether the new provider moves stored cards, or customers enter them again
  #oak-4 [payments-move] Give the current provider notice once the new contract is signed
  #oak-6 [payments-move] Decide who tells subscription customers, and when
(4 tasks)
```

The answer adds only what is new, and closes what you said is done:

```bash
hub task add "Plan the cut-over weekend with the new provider" -p payments-move
hub report -p payments-move <<EOF
DECIDE: go with the provider that quoted 1.3% flat | the lowest fee, and it moves stored cards itself
FACT: the contract allows leaving with 30 days' written notice (clause 14.2)
FACT: the new provider moves stored cards; subscription customers need not enter them again
DONE: oak-2
DONE: oak-3
EOF
hub recall "contract notice"
```

```text
Task #oak-7 added: Plan the cut-over weekend with the new provider
Reported to payments-move: 1 decision, 2 facts, closed #oak-2 #oak-3
recall "contract notice" — 4 hit(s), top 4

[section] payments-move card / Facts & hypotheses  as of 2026-10-07 17:08
  - hypothesis: [?] unconfirmed: the contract allows leaving with 30 days' notice

[section] payments-move card / Facts & hypotheses  as of 2026-10-07 17:08
  - fact: the contract allows leaving with 30 days' written notice (clause 14.2)

[task] task #oak-4 (open)  as of 2026-10-07 17:08
  Give the current provider notice once the new contract is signed

[journal] journal 2026-10-07 17:08 [payments-move/alice]  as of 2026-10-07 17:08
  + task #oak-4: Give the current provider notice once the new contract is signed
```

The guess and the fact that settled it are both on the card, in that order: the
correction is logged, not written over. A month later, `hub recall` answers from the
hub, not from the chat.

## What can go wrong

**Done that was only talked about.** "We'll send the notice tomorrow" is not a sent
notice. The protocol forbids closing what you did not confirm, and you are the last
check: read the block before you run it, and every `DONE:` in it most of all. An agent
with tools writes without showing you a block, so the same reading goes to what it
reports back.

**The same harvest twice.** `hub task add` does not look for an equal task: a block
run twice files every task twice. Without tools, give the chat the open tasks, as
above; with tools, the protocol's first step is `hub_task_list`.

**A key in the chat.** A token you pasted while debugging is in the chat, and a
harvest can copy it into a card, which goes to every node and stays in the hub's git
history. Look for one in the block; a secret belongs in `hub secret set`.

**A guess written as a fact.** "The 3-D Secure screen cost us sales" reads like a
finding once it is on a card. The protocol writes an inferred connection as `HYPO:`,
and it lands as `- hypothesis:`; leave it so until something proves it.

**A project nobody touches again.** A harvested card is dated like any other:
`hub status` shows when it was last set, and `hub brief` lists it under `STALE CARDS`
after a week with no new set, so an evening's plan cannot rot unseen.
