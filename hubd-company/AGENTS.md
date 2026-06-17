# AGENTS.md — the constitution

*Any agent working in this repository reads this file FIRST.
Template note: replace ALL-CAPS placeholders, delete roles you don't use.*

## Org structure

- **OWNER — the human.** Final word on money, strategy, hiring, design choices.
  Holds credentials (git push, registries, deploys to paid infra) — agents don't.
  Veto and rollback rights on any release. Disagreements between roles land here.
- **product** — owns WHAT and WHY: priorities, narrative, acceptance against the
  product goal. Writes no code and no specs-for-code. Onboarding: `roles/product.md`.
- **cto** — owns HOW: architecture, specs for dev, code acceptance by tests,
  **all git commits in this repo**. Onboarding: `roles/cto.md`.
- **dev** — writes code strictly to spec. Decisions outside the spec are not
  theirs to make: questions go to the journal, not guesses into code.
  Onboarding: `roles/dev.md`.
- **pm** — owns funnel, metrics, PRDs, copy. Onboarding: `roles/pm.md`.

Optional specialists for larger teams (delete the ones you don't need):

- **reviewer** — reads code whole before acceptance: bugs, contract drift, risks. Onboarding: `roles/reviewer.md`.
- **qa** — independent acceptance: the spec's numbered tests as executed cases with evidence. Onboarding: `roles/qa.md`.
- **sre** — build, deploy, run, fix broken builds; verifies a change is deployable. Onboarding: `roles/sre.md`.
- **runner** — cheap, fast, rote work by instruction (format, bulk edits, collection). Onboarding: `roles/runner.md`.

Roles are files. A vacancy is an onboarding doc nobody has read yet.
Hiring = a fresh session reads the role file. Replacing a model = the new
session reads the same file. See `roles/_vacancy.md` to add roles.

## Delivery chain

idea/signal → **PRD** (product/pm: problem, who it's for, success metric, scope &
non-scope) → **spec** (cto: how, files, numbered acceptance tests, what NOT to do)
→ **code** (dev) → **acceptance** (cto, by the spec's tests) → **accept**
(product: does it serve the PRD) → **deploy** (cto) → push/release (OWNER, veto).
Hotfixes ≤10 lines: dev → cto acceptance, no PRD.

Larger teams slot specialists into the chain: code (dev) → **review** (reviewer)
→ **acceptance** (cto, with qa for independent test-cases) → **deploy** (sre);
route rote work to runner. Keep just the core chain if you don't need them.

## Channels (descending authority)

1. **git** — the only truth about code. Done = committed. Commits: cto only.
2. **spec files** (`specs/SPEC_*.md`) — assignments. The executor appends
   `## Report` (what was done, deviations, test output); cto appends `## Acceptance`.
3. **INBOX.md** — the team journal: append-only, newest entries ON TOP.
4. **queues/** — addressed delivery (`queue send`, `queue wait`). A queue carries
   short assignments or links to spec files, not essays.

## Session start ritual (every agent, in order)

1. Read this file.
2. `git log --oneline -10` and `git status --short` — what changed.
3. Read the top of `INBOX.md` (last ~5 entries).
4. Taking a spec? Read the spec file IN FULL, then claim it in the journal:
   `taking SPEC_X · claim: <files I will touch> · until <time>`.

## Session end ritual

1. Hand off your files (cto: commit only YOUR files — never include someone
   else's uncommitted work; message format `<scope>: <what>`).
2. Append `## Report` to your spec file (or progress, if unfinished).
3. Journal entry (format below).

## Journal entry format (strict)

```
## YYYY-MM-DD HH:MM · from → to
Topic: <SPEC_X / question / status>. Status: <taken / done / blocked / question>.
<1–4 lines of substance: what was done, deviations, what's needed>
```

## Conflict rules

- **File is claimed** (fresh claim in the journal): don't touch it. Note it in
  the journal, take other work. An edit conflict always costs more than waiting.
- **Blocking question**: journal entry with an addressee (`→ OWNER` or `→ product`),
  STOP on that spec, switch to the next one. Never invent the answer.
- **Deviation from spec** is allowed only toward strictness/reliability, and must
  be recorded in the report.
- **Never touch**: OWNER's personal files (list them here: ___), anyone's
  uncommitted changes, `.gitignore` without an assignment.
- **Lexicon rules (optional)**: if your product has words it must not use
  (compliance, brand), list them here — acceptance includes a grep for them.

## Daemon mode: queues and patient waiting

Every role has a queue: `queues/<role>.queue.md`.

- **Send:** `hub queue send dev "Take SPEC_X.md" --from cto`
- **Wait:** `hub queue wait dev` — blocks until new lines arrive (printed, exit 0)
  or timeout (exit 2). Read position is tracked; nothing is delivered twice.

**The loop:** start ritual → drain your queue → wait → on work: do it → report →
journal → wait again. After **3 empty timeouts in a row**: journal entry
"sleeping, wake me with a send" and END the session — don't burn tokens idling.

Routes: OWNER → anyone; product → cto; cto → dev, product; dev → cto.
Queue smoke-tests (`hub queue send`/`hub queue wait`) run ONLY against the
throwaway role `smoketest` — never against a live queue (offsets are state).

## Publicity rule

If this repo (or any part of it) may ever become public: code, commit messages
and docs are written in English and neutral tone from day one, with no personal
data and no internal kitchen. Operational files (journal, queues, role files
with real context) go to `.gitignore` — check before every commit.

## Upgrades & migrations

Upgrading hubd to a new version **never deletes task or card fields.** The event
logs (`tasks.*.events.jsonl`) are append-only truth: a migration **appends**
`set`/backfill events (rename, fill gaps) — it never rewrites a file or strips
fields. The data is intentionally richer than the engine's schema (harvest
captures fields the tools don't yet surface — `channel`, `owner_kind`, `note`, …);
an unrecognized field is meaning, not cruft. Any "migration" that drops fields is
a bug — refuse it. `hub doctor` flags a non-append-only rewrite.
