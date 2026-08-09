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
so a write that lands unattributed stays unattributable forever.

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
see `hub sections`. `hub card <slug> -m "<digest>"` sets the digest; `hub get <slug>`
reads a project; `hub status` / `hub brief` orient you. Sitting in a project folder
and don't know its slug? `hub_context({cwd:"<your absolute cwd>"})` resolves it for
you (`.hubd` marker file → a card's recorded sync path → a folder-name guess, flagged
`guessed:true` when it's not certain) and returns the digest in one call — use it
instead of a manual `hub_get` when you already have a cwd.

A card can be fresh and still lie. `hub status` / `hub brief` flag one whose digest has
fallen behind its OWN journal (`digestStale`, `⚠Nd behind`): the project kept moving and
the card didn't. That flag is a request to re-sync the digest, not a bug — and it never
fires on a project that has simply gone quiet.

## Tasks — one closed vocabulary, one open one

`cat` is the closed one: **technical | communicative | decision | chore**. Every by-type
number in the hub is counted on it, so it stays four values wide. Pass anything else and
it is kept as a **tag**, not silently accepted as a category — tags are the open
vocabulary, use them freely (`--tag ci --tag release`). `hub task retag` shows which
existing tasks carry an off-enum category and moves them into tags on `--apply`.

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
without an agent (or you) having to check each owner's queue by hand.

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
2. Before touching a shared area, `hub claim` it.
3. At the end: ONE structured `hub report` (substance only — see Channels) + one INBOX
   handoff line for the humans.
