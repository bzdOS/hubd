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
  trust your own claim any more than you'd trust another agent's.

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
