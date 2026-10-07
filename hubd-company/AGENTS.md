# AGENTS.md — the company's rules

*Every agent working here reads this file first, then its rules in
`roles/rules/<role>.md`. Template note: replace the ALL-CAPS placeholders, and
delete the roles you do not use, here and in `roles/team.json`.*

This file is the company's: who does what, in what order, and who decides. How the
hub works (reports, claims, queues, cards) is in `HUBD.md`, which hubd regenerates
to match the installed version. Read it there; do not copy it here, where it would
go stale.

## Org structure

| Role | Owns | Answers to | Rules |
| --- | --- | --- | --- |
| OWNER_NAME | money, strategy, hiring, naming, dates, push and publish; veto on any release | | |
| `owner` | the owner's desk: what only OWNER_NAME decides waits in its queue | | |
| `product` | WHAT and WHY: priorities, PRDs, acceptance against the product goal | `owner` | head |
| `cto` | HOW: specs, acceptance by the spec's tests, the only one who merges to main | `owner` | head |
| `pm` | the funnel and the numbers: metrics, PRD drafts, copy | `product` | worker |
| `dev` | code, strictly to spec | `cto` | worker |
| `reviewer` | reads the code whole before acceptance | `cto` | worker |
| `qa` | runs the spec's numbered tests as cases, with evidence | `cto` | worker |
| `sre` | build, deploy, run; fixes the broken build | `cto` | worker |
| `runner` | rote work by instruction | `cto` | worker |

reviewer, qa, sre and runner are for larger teams: delete the ones you do not need.

A role is a card and two files:

- **The card**, from `roles/team.json` (`node scripts/team.mjs declare --by <you>`):
  its rank, project and head. The board, the escalations and the laws read it.
- **Its rules**, `roles/rules/<role>.md`, rendered from hubd's templates
  (`node scripts/team.mjs render`) with the track's goal, its facts and the owner's
  decisions. Never edited by hand: a rule changes in the template, a fact on the card.
- **Its zone**, `roles/<role>.md`: what is its, what is not, whom it hands in to.

Hiring is a fresh session that reads the last two. Replacing a model is the same.
A new role: `roles/_vacancy.md`.

## Delivery chain

signal → **PRD** (pm drafts, product accepts: the problem, who it is for, the success
metric, scope and non-scope) → **spec** (cto: `specs/SPEC_<name>.md` with numbered
acceptance tests and what not to do; one task per spec) → **code** (dev, on a branch
`task/<slug>`) → **review** (reviewer) and **test cases** (qa) → **acceptance** (cto,
by the spec's tests: `ACCEPT #<id>`, then the merge to main) → **product acceptance**
(product: does it serve the PRD) → **deploy** (sre) → **push and release**
(OWNER_NAME).

A hotfix of 10 lines or fewer: dev → cto, no PRD. Without the specialists the chain
is PRD → spec → code → acceptance → product acceptance.

## Channels, by authority

1. **git**: the truth about code. Done means merged to main by cto.
2. **Spec files**: the assignment. The executor appends `## Report` (what was done,
   deviations, test output); cto appends `## Acceptance`.
3. **The hub**: tasks (what needs doing), reports (what is now true: they land in the
   journal and on the card), cards (the project, the roles, the machines). HUBD.md
   says which to use when.
4. **Queues**: dispatches and hand-ins, addressed to a role. A dispatch names its task
   and its acceptance command; an artifact travels as its path, size and sha256.
5. **INBOX.md**: a person's handoff line, newest on top. Agents report to the hub.

## A session

1. Read this file, then `roles/rules/<role>.md` and `roles/<role>.md`. They are in
   the company folder, `$HUBD_DIR`; you work in the product's repository.
2. `hub_context({cwd})` (CLI `hub whereami`): the project, its laws, who holds what.
   Back after a compaction: `hub_whatsnew({since: "session"})` as well.
3. `git log --oneline -10` and `git status --short`.
4. Work: `hub queue wait <role> --tasks` returns your open tasks and the dispatches
   about them. Start a task by claiming it (`hub claim --task <id> --agent <role>
   -t <minutes>`); a claim that lapses offers the task again.
5. `hub_heartbeat` each turn, so the board shows you.
6. End the turn as your rules say: one report, the reflection last. A worker hands in
   (`-k done`, the artifact named) and does not close its task; the head closes it
   with its verdict.

Every write names its author, and the author is your role: `--by cto`,
`--agent cto`, `--from cto`.

A head need not wait on its queue: `hub sense <role>` prints what needs it (an idle
worker, a hand-in, a branch to accept) and exits 1 when nothing does, so a loop that
wakes the head only on exit 0 spends no model call while nothing happens.

## Conflicts and blocks

- **A claimed file** (`hub claim check <path>`) is its holder's until the claim
  lapses: take other work. An edit conflict always costs more than waiting.
- **Blocked**: a `-k blocked` report with what you tried and the exact error, a line
  in your head's queue, then other work. Never invent the answer.
- **A deviation from the spec** only toward strictness or reliability, and recorded
  in the report.
- **Never touch**: the owner's personal files (list them here: ___), another role's
  uncommitted changes, `.gitignore` without a task.
- **Words the product must not use** (compliance, brand), if any: ___. Acceptance
  includes a grep for them.

## Escalations and the owner's decisions

What a head cannot decide (money, hardware, a security boundary, a release) goes to
the `owner` queue as one message: the problem with a measurement, the options with
the risk of each, the head's choice. It waits on the board, under WAITING FOR YOU,
until OWNER_NAME answers on the company card, quoting the message's header:

    hub section add company owner-decisions "<date> · from <role> · id <id> — <the answer>" --by OWNER_NAME

The next render carries the answer into every role's rules, and nobody asks it
again. Work only OWNER_NAME can do (push, publish, sign, pay) is a task assigned to
OWNER_NAME, and the board lists it among the owner's tasks. Agents never push and
never publish.

## Laws

Every turn's report ends with a reflection. A rule said three times by one role, or
by two roles, within a week is a candidate (`hub reflect --promote --project
PRODUCT_SLUG`), and a head of the track accepts or rejects it in the same turn. An
accepted rule is a law: `hub_context` returns it to every role of the track.

## Publicity rule

If the product, or any part of it, may ever become public: code, commit messages and
docs are in English and a neutral tone from day one, with no personal data and no
internal kitchen. Each role's rules name the check it runs before a hand-in. This
company folder is not that: it holds the journal, the queues and the owner's
decisions, so keep it private.

## Upgrades and migrations

Upgrading hubd **never deletes task or card fields.** The event logs
(`tasks.*.events.jsonl`) are append-only truth: a migration **appends** `set` and
backfill events (a rename, a gap filled); it never rewrites a file or strips a field.
The data is intentionally richer than the engine's schema (a harvest records fields
the tools do not show yet: `channel`, `owner_kind`, `note`, …), and an unrecognized
field is meaning, not cruft. A migration that drops fields is a bug: refuse it.
`hub doctor` flags a rewrite that was not an append.
