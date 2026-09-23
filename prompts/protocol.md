# How to work with this hub

Mechanics of hubd for agents. This is regenerated from the installed hubd version
into `HUBD.md` in the hub — do NOT hand-edit `HUBD.md`. Team rules (roles, project
policy) live in `AGENTS.md`, which is yours to write; this file is the tool's manual.

## Channels — pick the right one (this is the #1 mistake)

| you want to say | use | lives |
| --- | --- | --- |
| "I'm working on X — don't clobber" | `hub claim <proj> <area> <agent>` | transient, expires (TTL) |
| "this needs doing" | `hub task add "<text>" -p <proj>` | until closed |
| "this is now true / decided / learned / shipped" | `hub report` (below) | durable — journal + card |
| "agent, do this" | `hub queue send <role> "<text>" --from <you>` | until consumed |
| a trivial step ("starting", "looking", "still going") | NOTHING | — |

Report SUBSTANCE, never play-by-play. "I'm on it / in progress" is a **claim**, not a
report. A trivial step is **nothing**. Spamming the journal with progress is the failure
mode this table exists to prevent.

A claim's `area` is a path glob relative to the project root — `src/**/*.ts`,
`docs/{a,b}.md`, a bare directory, several joined with ` + ` — so that `hub claim check
<path>` / `hub_claim_check` can tell the next agent, before its edit, whose zone the file is
in, and `hub_context` can report `claimsTouched` when a freshly changed file sits in one.
Prose areas are accepted and flagged `matchable:false`. Editor hooks that run the check
automatically: `prompts/client-hooks.md` in the hubd repository. The lock stays soft:
the check informs, it never forbids.

### When the hub tells you your environment needs work

An upgrade can require something that is **not** in the code: a variable in your
client's config, a role declared in the hub, a section of this file worth re-reading.
`hub_whatsnew` returns those as `environment: [...]`, and any tool result may carry a
one-line `⚠ environment:` notice pointing at it. `hub doctor` shows the same list to a
human.

Each item says **who can fix it** — act on that, do not guess:

| `actor` | means | what you do |
| --- | --- | --- |
| `agent` | a file in the hub | just do it, then the item disappears by itself |
| `agent+restart` | a client config | make the edit and say it needs a restart to take effect; work explicitly in the meantime |
| `owner` | a human, often on another host | say so. File a button ONLY if it blocks you — hubd never writes to the owner's queue on its own |

No item ever blocks a call. Nothing is "acknowledged" either: an item is gone when the
condition is gone, so if you keep seeing one, it is still true.

When a protocol section changes you get its title, not a verdict on whether it matters.
hubd does not know what you are working on — you do. Re-read the ones that touch it.

### Say who you are — every write needs an author

`agent` / `by` is **required** on everything that writes: report, sync, card set, task
add, task update, resource set, claim, heartbeat, whatsnew — and `from` on queue send,
because a delivered block says "from <sender>" forever. The journal is append-only,
so a write that lands unattributed stays unattributable forever. The three are synonyms:
name yourself under any one of them and every tool reads that name; `HUBD_AGENT` fills in
only when a call named nobody at all.

Name **the function you are performing** — `dev-hubd`, `reviewer-bsdos`,
`orchestrator`. Not which model you are: that is recorded in your client's own
transcript, and many sessions share one model, so it identifies nobody. Not a queue
role either — a role is a mailbox (`hub queue wait`), the author is who is at it. Bare
model or client names (`claude`, `opus`, `gpt`, `cursor`, `opencode`) and placeholders
(`unknown`, `cli`, `root`, `agent`) are refused, and the error will say so.

If a call of yours is rejected for this, do not retry with a placeholder — pick the
name that says what you are doing. Whoever configured your server may have set
`HUBD_AGENT` as a floor, in which case an omitted author becomes that name plus a
per-session suffix rather than an error; being explicit still beats the floor.

## Reporting — structured, at session end

File ONE `hub report` of prefix-tagged lines; each routes into the project card. Many
decisions/facts = many lines (one per line):

    hub report -p <proj> <<EOF
    DECIDE: <what> | <why>      # -> Decisions
    FACT:   <reusable fact>     # -> Facts & hypotheses
    HYPO:   <belief, unproven>  # -> Facts & hypotheses
    COMM:   <shipped / queued>  # -> Communication
    NEXT:   <the one next action>
    DONE:   <task-ids, comma-separated>   # closes tasks
    TASK:   <new task text>               # opens a task
    NOTE:   <one-line, anything else>
    EOF

- Do NOT list files/commits — "what changed" is read from git, not retyped.
- Lines with no prefix become a NOTE. A report that is ONLY a NOTE is usually
  coordination — use `hub claim` instead.
- Shortcuts: `hub decide "<what>" --why "<why>" -p <proj>`, `hub next "<...>" -p <proj>`.
- **DONE: closes tasks by id, no per-task confirmation** — check EACH id in the
  list is actually finished before writing the line, not just the ones you're
  most confident about. `DONE: 12, 13, 14` closes all three the instant the
  report lands; one line of habit (copying a batch of ids across from a
  similar report) can close something that isn't done yet. Verify, don't
  trust your own claim any more than you'd trust another agent's. An id that
  matches no task comes back in the summary as `doneMissed` — it closed
  NOTHING; recheck the id, that task is still open. An id someone had ALREADY
  closed comes back as `doneAlready`: the second close is a no-op, not a
  second closing, so nothing double-counts — but it does mean two sessions
  believed they owned that task, which is worth a look.

## Cards & sections

One card per project at `projects/<slug>.md`: `## Digest` plus the sections reports
route into — Next step / Gates / Metrics / Market / Facts & hypotheses / Decisions /
Communication. Section headings localise (any language) in ONE file, `sections.json`;
see `hub sections`. `hub card <slug> -m "<digest>"` sets the digest — and when only one line
of it went stale, patch instead of rewriting the owner's framing: `hub card <slug> --replace
"<old>" --with "<new>"` / `hub_card_set({replace:[{from,to}], appendLine})`; a `from` that is
not in the digest is an error, never a silent no-op.

**The card is a snapshot, and hubd holds it to that.** A digest over the hub's limit is refused,
and so is an `appendLine` that starts with a date — a dated line is an event, and events go to
`hub_report`, which writes the right card section *and* the journal. When an accumulating section
(Facts & hypotheses, Decisions, Communication) outgrows its limit, its OLDEST entries move to
`projects/history/<slug>.md` and the card keeps the recent ones with a line saying where the rest
went. Nothing is deleted: `FACT:`/`HYPO:`/`COMM:` live only in the card, so the overflow is moved,
never trimmed. Limits are the hub's, in `limits.json` (`card.digestBytes`, `card.sectionBytes`).
This matters because a card that cannot be read does not answer the one question it exists for:
one hub reached 41 cards with three past 72 KB, and `hub_get` on the largest was refused by the
caller's own context budget. `hub_report` tells you the digest's age
in every reply and nudges once it trails the journal you just moved. `hub get <slug>`
reads a project; `hub status` / `hub brief` orient you. Sitting in a project folder
and don't know its slug? `hub_context({cwd:"<your absolute cwd>"})` resolves it for
you (`.hubd` marker file → a card's recorded sync path → a folder-name guess, flagged
`guessed:true` when it's not certain, with the one-line `.hubd` fix in `hint`) and returns
the digest in one call — use it instead of a manual `hub_get` when you already have a cwd.
It is also the call to make after a context compaction, because it answers from STATE, not
from a summary: `digestSetAt/By/AgeDays` and `digestStale` (the same verdict `hub_status`
gives — a digest can trail its own journal by months and still read as current),
`presenceHere` (live heartbeats whose cwd is under this root — who else is editing this
checkout right now; `hub_presence({cwd})` / `({project})` ask the same question fleet-wide),
and `journalTail` (the project's last few entries). Read those before re-discovering your own
findings in git.

To write ONE line into ONE section — `Gates`, `Metrics`, `Market`, or any section a human
added — use `hub_section_add({project, section, text, by, provenance?})` (`hub section add
<proj> <section> "<text>"`). It appends through the same machinery reports use, so everything
around it survives, and it creates a missing heading — check `created` in the reply, because a
typo is how a card grows two nearly identical sections. For Decisions / Facts / Communication /
Next step, a normal report with `DECIDE:`/`FACT:`/`COMM:`/`NEXT:` is still the right call.
`provenance` records where a line came from, next to the date it was written.

`NEXT:` replaces the step — one concrete next action, not a list — but never silently. The step
is stamped with who set it and when; the step it replaced stays as one dated `prev` line in the
section, and the reply carries `nextReplaced {text, by, at}`, so a side session sees what it
overwrote and can put it back. A step set by an owner role (`HUB/owner-roles.json`) is not
replaced by a non-owner: the report is refused with the step's text, unless `force:true`
(`--force`) — and then a `DECIDE:` line saying why belongs in the same report.

A card can be fresh and still lie. `hub status` / `hub brief` flag one whose digest has
fallen behind its OWN journal (`digestStale`, `⚠Nd behind`): the project kept moving and
the card didn't. That flag is a request to re-sync the digest, not a bug — and it never
fires on a project that has simply gone quiet.

Know a task id? `hub_task_get(id)` returns it plus what blocks it and what it blocks — never go
guessing project × status against `hub_task_list`. Know only a keyword? `hub_search` first: it
searches every card and the whole journal and tells you which project owns the thing.

One project can answer to two names: a rename leaves the old slug holding its own tasks, so
`HUB/project-aliases.json` (`{"old": "canonical"}`) makes reads resolve BOTH ways while new work
lands on the canonical slug. Nothing is renamed on disk. `hub doctor` points out slug pairs that
look like one project.

## Tasks — one closed vocabulary, one open one

`cat` is the closed one: **technical | communicative | decision | chore**. Every by-type
number in the hub is counted on it, so it stays four values wide. Pass anything else and
it is kept as a **tag**, not silently accepted as a category — tags are the open
vocabulary, use them freely (`--tag ci --tag release`). `hub task retag` shows which
existing tasks carry an off-enum category and moves them into tags on `--apply`.

## What do I do now, and what do we know about X

- **`hub now`** / `hub_next` — ONE task, and why it won. A task whose dependencies are still open
  is never eligible, however loud it is. If the winner is the owner's to press, it says so:
  prepare it, don't decide it.
- **`hub agenda`** / `hub_agenda` — the day split by WHO CAN ACT: agent work ready now, owner
  buttons, blocked (and on what), overdue. A mixed list hides that half of it isn't yours to start.
- **`hub recall "<question>"`** / `hub_recall` — ranked across cards, sections, decisions, journal
  and tasks, where `hub_search` is flat and exact. Every hit carries the date it was true **as of**
  and a stale flag. Treat a stale hit as a lead, not a fact: re-check it, then re-state it as a
  fresh `FACT:` if it still holds. Stop-words (the, not, of, and their Russian counterparts) carry no topic and are dropped
  — the answer lists them as `dropped`, and a query made only of them is refused. A term matches
  at the start of a word (`imm` → IMM, IMM's, immediately), never inside one (not `committing`).
  `project` narrows recall — and `hub_whatsnew` — to one project or a comma-separated few.

## Scope: project, person, machine

Not everything belongs to a project.

- **`hub_operator`** — the operator card: the human's rhythm, the framing that works, and
  **Boundaries** — what is never collected. Agents READ Boundaries and never edit it. It is a card
  (so section writes and recall reach it) but not a project.
- **`private: true`** on a report routes prose to the **local-only** life braid
  (`journal.life.jsonl` — gitignored, never mesh-synced) and stamps the entry. Read it to write a
  weekly chapter; never quote it verbatim into a synced file. Prose only — a structured prefix
  writes into a card, and cards are synced, so that combination is refused rather than published.
- **`hub_rules`** — read AGENTS.md, or append an amendment. It is appended under one dated,
  attributed heading, never rewriting a line already there: an audit has to be able to quote what
  the rule used to say.

## What the work costs

The hub knows WHO did WHAT. It cannot see time, tokens or money — so `hub_usage_add` is how those
arrive (`seconds`, `tokensIn`, `tokensOut`, `costUsd`, `model`), and `hub usage` reports them as
**SUPPLIED**, separately from what it **MEASURED** itself (closed-task spans, journal events).
Keep the halves apart when you quote them: a cost that mixes an observed span with a guessed rate
gets repeated later as if somebody had counted.

## Rules that are checks, and rules that are wishes

A rule written as prose gets broken; a rule that is a check does not. `HUB/rules.json` is where
an instance says which is which:

    { "money":  ["<slug>"],                       // which projects are money bets
      "strict": { "rejectNoteOnlyReport": true },  // opt-in, empty by default
      "laws":   { "gate-expired": { "text": "<your rule, verbatim>", "since": "2026-07-04" } } }

- **`hub lint`** — every rule that can be checked, checked: a money bet whose gate has no date,
  a human-owned communicative task with no prep it depends on. Each finding says whether this
  instance actually *enforces* it, so "we have a rule about that" and "the rule bites" stay
  different things.
- **`hub audit [--days N] [--apply --by <you>]`** — declarations against behaviour: a gate date
  that passed with no decision since, a project whose share of the journal contradicts the `MODE:`
  its own card declares, owner buttons nobody pressed, a card that stopped following its journal,
  tasks with no project, an agent whose day's structured entries all fell in the last two minutes
  of a half-hour-plus trace (`report-at-end-only` — the findings written at "the end" a compacting
  session never reaches), a local checkout with commits and a project journal with nothing
  (`work-without-journal`). `--apply` turns each finding into an incident task; findings are keyed,
  so a weekly run never files the same one twice. Close-rate numbers are printed and never filed —
  a rate is a thermometer, not a violation.
- Incidents quote **`laws`** — your own rule with the date you wrote it — because an engine's
  opinion carries no weight and your own past decision does. No local law? The finding still
  fires and says it is using the engine's wording.
- You do not have to remember to call either one. `hub_brief` and `hub_whatsnew` carry a
  **`review`** block: the top findings of both, one per KIND (a repeated rule cannot crowd out the
  others), each quoting its law and date. It **reports only** — nothing is filed unless somebody
  calls `hub audit --apply` with their own name on it. `reviewLimit: 0` turns the block off.
- `strict.rejectNoteOnlyReport` refuses a report made of nothing but unprefixed prose (an explicit
  `NOTE:` still lands). Off unless asked: nothing here starts refusing writes because it was
  upgraded.

## Recovering after compaction

A context compaction hands you a NARRATIVE of what happened; work resumes from STATE — what
exists now. Fleet sessions compact often and on purpose, so this is the normal way a session
returns, not an edge case. One session re-discovered its own finding (already committed under a
subject that named it) and re-wrote a script that already sat untracked in `scripts/`.

1. `hub whereami` in a shell, `hub_context({cwd})` over MCP — the same function. It answers
   from state: the digest with its age and `digestStale`, `presenceHere` (who else is in this
   checkout right now), `journalTail`, open tasks, claims, `claimsTouched`; the shell form adds
   the git inventory — commit subjects (findings live there), diff stat, untracked files with
   their first line (does it already exist?), files changed in the last half hour — and runs
   the project's own inventory script if the `.hubd` marker names one on its second line.
   Editors can run it for you at session start and after a compaction:
   `prompts/client-hooks.md` in the hubd repository.
2. `hub_whatsnew({since:"session"})`, not the default. The default checkpoint is "since my last
   call" — the same session, so everything it wrote itself lies before it and the delta is empty;
   the reply says so in `hint` when that is what it sees.
3. Write `FACT:` at the moment of the finding, not at the end of the session. A session that
   compacts never reaches "the end", and the finding leaves with the context.
4. Before "finding" a defect — `hub_recall`, then `git log -S<the number>`; before writing a
   script — the untracked files. Before editing a shared file — `hub claim`; if `presenceHere`
   shows someone else, ask.
5. Name yourself function@session (`paper-auditor@psyco-29`) so two sessions of one function do
   not collapse into one presence record.

## Reading a big hub without drowning

Every list-shaped tool answer is capped by default so it fits your context, and it TELLS
you what it left out: look for `truncated` (`{key: {shown, hidden}}`) and the `hint`.
There is nothing hidden from you — narrow the question (`project`, `hours`, `status`),
page through it (`hub_task_list` takes `limit`/`offset` and always reports the full
`total`), or pass `full: true` to get everything. The journal is trimmed before anything
else, because recent chatter compresses best; open tasks and pending buttons are the last
to go. The CLI is never capped — a terminal has `grep`.

## Resources & the relationship graph

Infra is a card too, at `resources/<slug>.md` — host, vm, service, endpoint, provider —
with structured frontmatter (type/address/os/status) and typed `[[wikilink]]` edges
(`runs_on` / `depends_on` / `deploys_to` / `exposes` / `part_of`). `hub resource set`,
`hub resource list`, `hub resource get`, `hub graph`. Link a task to what it touches:
`hub task add "<text>" -p <proj> --resource <slug>`.

## Queues — addressed work

`hub queue send <role> "<text>" --from <you>` delivers work to a role; `hub queue wait
<role>` blocks until something arrives (exit 0 with the lines, or exit 2 on timeout).
One live waiter per role at a time: a message goes to exactly one of them, so two
sessions waiting on one role split the work rather than both doing it. A role named in
`<team>/subscriber-roles.json` is the other kind — a broadcast, where every waiting
session has its own cursor and sees every message. `hub queue wait '*'` taps EVERY role
at once (own offset — does not consume any role's messages), for a supervisor watching
the fleet; several supervisors may tap at the same time without competing.

Flags may come before or after the text. A body that begins with `-` (a list, a diff) goes
through `--text "<text>"`; a long or shell-hostile body goes through stdin — `hub queue send
<role> - --from <you> < file`. A flag the command does not know is refused, and every refusal
exits non-zero with nothing written: a delivery that "succeeded" with the wrong body is the
failure this guards against.

Say what a message is ABOUT: `hub queue send <role> "<text>" --from <you> --task <id>` stamps the
task into the delivered block, and the consumer gets the ids back with the text (`tasks`). Report
the outcome onto those tasks — a HOLD that lives only in a consumed message leaves the task
reading plain open, with no trace of the blocker. To see what has actually been delivered versus
what is still waiting, across every host's file at once: `hub queue status [role]`. One per-host
file read on its own is not the answer — a message already popped elsewhere looks undelivered in it.

**Sending appends; it does not deliver.** A send reports the depth now waiting for that role, and a
depth that keeps climbing means nothing is consuming — check that the role is waiting, and run `hub
doctor` on its node. One failure used to be invisible on both sides: a cursor the consumer cannot
write (a shared hub where another user's command created it) stopped delivery completely while every
wait answered "nothing new". That is now an error naming the file and the fix, `hub doctor` lists such
cursors, and a wait never reports an empty queue it could not actually read.

A queue file is created by the first send and never disappears on its own, so an
experiment leaves a role behind that nobody ever listens on. Those show up in `hub_brief`
marked `neverRead` — messages waiting for a consumer that has never existed are not
backlog, don't work them off. `hub queue gc` lists them (dry by default) and `--apply`
moves them into `queues/archive/` — moved, never deleted, and never a human owner's queue.

### Buttons — an owner-decision queue is not an agent queue
A task that needs OWNER to act outward (send, post, pay, call) splits in two: prep (an
agent boils it down to a package the owner can decide on in <=30s) and the button itself
(the owner's call). Prep goes wherever it's needed; the button goes to that owner's own
queue role via plain `hub queue send <owner-role> "<package>"` — no separate mechanism.
List human-owner role names (e.g. `["alice"]`) in `HUB/owner-roles.json` and `hub_brief`
rolls up pending items in those roles as "N buttons waiting (oldest X days)" — visibility
without an agent (or you) having to check each owner's queue by hand. From 0.9.12 it also
lists them one per line (`buttonItems`: age, sender, subject), because the count told the
owner they were behind without telling them what of.

Two things wait on an owner and they are NOT the same. A **queue item** is a package somebody
addressed and is waiting on. An **open task assigned to an owner role** is a decision sitting on
the board that nobody else may move — `ownerWaiting` in `hub_brief`, with age and how far past
deadline. Measured on the hub this shipped from, the owner's queue was empty and 31 open tasks
were his, the oldest 80 days: the queue had been read, the decisions never made. Nothing acts on
either list. hubd does not hibernate, defer or close your work because you did not answer — silence
is not consent, and a default executed in your name is not a default, it is a decision.

### Handoff convention — the queue IS the channel, not the terminal
When you hand a task to another agent, the task text goes in the QUEUE (`hub queue send`),
a durable file that mesh/Zenoh-replicates across nodes. Do NOT paste task bodies into an
agent's terminal — that is a fragile side-channel. If you must poke a running agent, send
only a short pointer ("new work in your queue"); the substance lives in the queue.

### Consumer loop — how an agent BECOMES addressable
An MCP-client agent makes ITSELF addressable by looping on the blocking wait as a tool
call — no external driver, no terminal puppeteering, no fallback daemon:

    hub_queue_wait(role, timeout)  ->  task?  do it -> hub_report -> hub_heartbeat -> wait again
                                       timeout (changed:false)  -> wait again
                                       never stop for input; the queue is the only work source

The wait returns the task as a tool RESULT inside the SAME turn, so the agent always has a
next action and never ends its turn — that is the whole reason hub_queue_wait blocks. The
agent self-loops; hubd stays a dumb server. (This is the ONLY consumer model — an external
process pasting tasks into a terminal is the anti-pattern this replaces.)

The `hub_heartbeat` after each `hub_report` is what makes an MCP/headless agent as visible
as a screen-scraped one: it overwrites your one presence record (agent, role, status,
task_id, cwd, freshness from `ttlMin`, default 15min). `hub_presence` reads the fleet
roster back; `hub_brief`'s QUEUES line pairs "N queued for role X" with that role's
last-seen agent, so a human can tell "is anyone even listening" without screen-peeking.

**`presence/` is node-local, so read `coverage` before you believe an absence.** The directory
never syncs (a file per agent, rewritten every few seconds — syncing it would push every heartbeat
in the fleet into git history), so from any one node it describes THAT machine. From 0.9.13 each
node also publishes one small snapshot, `presence.<node>.json`, refreshed on heartbeat at most
every 5 minutes, and `hub_presence` merges them: each row carries `observedOn` (which node saw that
heartbeat) and `coverage` lists every member with the age of its registry — or `snapshot: null`
when it has published none, plus `blindTo`. **A role nobody reports is invisible, which is not the
same as dead.** That confusion cost 92 hours once: one role read as 383 minutes since heartbeat on
one node and 5.9 days on another, and an orchestrator escalated "worker is dead" four times while
the worker worked. If `blindTo` names a node, ask on that node before concluding anything about
its agents.

**Duration, not just one task (task #196):** confirmed over one real session — dozens of
`hub_queue_wait` polls held over an hour, five substantial tasks handled back to back with
no manual nudge between them. The gotcha isn't the server (`lib/queue.mjs`'s poll loop is a
real long-poll up to `timeout`, unaffected) — it's the CLIENT: at least one MCP client hangs
up a call around ~60s with "Request timed out" (JSON-RPC -32001), while timeouts up to ~45s
came back reliably every time. If your client errors on a long wait, don't fight it — poll
with a shorter timeout (~30-45s) in a tighter loop instead of leaning on `hub_queue_wait`'s
own 170s default / 540s max; the loop still never stops for input, it just takes smaller bites.

## Session ritual

1. Read `AGENTS.md` (team constitution) + this `HUBD.md` (mechanics) + the top of `INBOX.md`.
2. Before touching a shared area, `hub claim` it, with the area as a path glob; before editing a
   shared file, `hub claim check <path>` (see Channels for how areas match).
3. At the end: ONE structured `hub report` (substance only — see Channels) + one INBOX
   handoff line for the humans.
