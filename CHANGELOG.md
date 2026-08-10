# Changelog

All notable changes to `@bzdos/hubd`. Dates are release-commit dates.
The file format (markdown + JSONL, append-only logs) is the stable contract;
a version here never migrates or deletes data.

## 0.7.0 — 2026-08-10

Section-level card writes, plus the seven tooling gaps a real session filed
after spending an afternoon on "where does this actually run".

- **`hub_section_add`** — append ONE line to ONE section of a card, everything
  around it untouched (`hub section add <proj> <section> "<text>"`). Until now a
  tool could write the digest (`hub_card_set`) and the four sections the report
  router owns; `Gates`, `Metrics`, `Market` and every hand-written section were
  reachable only by editing raw markdown — the operation that once ate curated
  content. Takes a section KEY or a literal heading (so a localised hub works
  either way), an optional `provenance` recorded next to the date, and
  `mode: set` for the sections that are a single current value. A missing
  heading is created and the reply says `created: true`, because a typo growing
  a second nearly identical section is the failure mode here.
- **`hub_task_get(id)`** — one task plus what blocks it and what it blocks. The
  counterpart `hub_resource_get` always had; without it, knowing a number but
  not its project meant guessing project × status (three wasted calls in the
  session that filed this). `hub task get <id>` on the CLI.
- **A miss now points somewhere** — `hub_get(<name>)` used to dead-end at
  "run hub_sync" while that exact name sat in the RESOURCE namespace.
  It now says which namespace holds the name and which tool reads it, and
  suggests near-miss slugs. `hub_search`'s description says to start there when
  you know a keyword but not the project.
- **A queue message can name its task** — `--task <id>` / `task` stamps the id
  into the delivered block (after the sender, so every existing reader still
  matches) and hands it back to the consumer as `tasks`. A HOLD reply once sat
  consumed in a queue for four days while the task itself read plain open, with
  no trace of the blocker anywhere. An id matching nothing is flagged, not
  refused.
- **`hub queue status [role]`** — delivered vs pending, aggregated across every
  per-host file. A single per-host file is not an answer: a message already
  popped elsewhere reads as never-delivered in it. Byte offsets are split on a
  Buffer, so a non-ASCII message cannot skew the count.
- **Closing a task warns about its resources** — a task closed with resources
  still marked `planned` left the resource card (and `hub_graph`) claiming
  "planned" a day later. The close reports which ones look stale and the one
  call that fixes them; it deliberately does NOT cascade, because only the
  person closing knows whether the thing is really live.
- **Project aliases** — a mid-flight rename left the old and the new slug
  both holding tasks, so asking by either name answered about half the project.
  `HUB/project-aliases.json` (`{"old": "canonical"}`) resolves reads both ways
  (task list, journal, `hub_get`, locks) while new work lands on the canonical
  slug; nothing is renamed on disk. `hub doctor` flags slug pairs that look like
  one project, with the exact file to write.

## 0.6.0 — 2026-08-01

The honest-numbers release: four places where the hub quietly told its readers
something that was not true, and one where it told them more than they could
hold.

- **Output budgets** — `hub_brief(hours=168)` once returned 196K characters and
  did not fit the asking agent's context, which loses the whole answer rather
  than its tail. Every list-shaped MCP answer now has a default ceiling and
  reports what it left out in `truncated` (`{key: {shown, hidden}}`) plus a
  `hint`; a silent cut is indistinguishable from "that's all there is". The
  journal is trimmed first everywhere it appears, open tasks and buttons last;
  lists go to a readable floor before any of them goes empty. `full: true`
  opts out, `hub_task_list` takes `limit`/`offset` and always reports `total`.
  The CLI is never capped — a terminal has `grep`.
- **The digest ended at the wrong place** — it was cut at a literal `## Facts`,
  so on a hub that localises its sections (or any card whose next heading is
  something else) `hub_status` and `hub_context` reported the whole card body
  as the one-line digest, and `hub_sync` compared each new digest against that
  blob — "the digest changed" was true on every sync, archiving the full card
  into history each time. Now cut at the next `## `, in one shared helper.
- **A card that trails its own journal** — `hub status` marks it `⚠Nd behind`
  and `hub_brief` lists it under `staleDigests`. Distinct from a stale card: a
  dormant project's card may be old and still true, while a busy project's goes
  wrong within days (one card here sat 33 days behind its own journal).
- **Closing a closed task is a no-op** — two sessions finishing the same handoff
  both reported `DONE:` (34 minutes apart, on task #189), which appended a
  second done event and moved the close time, so every count downstream saw two
  closes and the lifespan silently grew by the gap. The attempt is still
  journalled, and a report gets it back as `doneAlready`, separate from `done`.
- **`cat` is a closed vocabulary again** — technical | communicative | decision
  | chore. Anything else is kept as a **tag** instead of becoming a category of
  one: 18 one-off values across 37 tasks had turned the axis every by-type
  number rests on into noise. `hub task retag` previews and (with `--apply`)
  migrates existing ones — append-only set events, no log rewritten.
- **CLI output stopped being cut at 64KB** — found while shipping the rest of
  this release. Node writes to a pipe asynchronously and a pipe buffers 64KB, so
  `process.exit()` right after a large `console.log` dropped the remainder:
  `hub task list --json` (~300KB here) redirected to a file was whole, but piped
  into `jq` arrived cut mid-token at exactly 65536 bytes, with nothing to tell
  the reader. stdout/stderr are written synchronously now. Whether it showed at
  all depended on a race with the reader, which is why nothing caught it — the
  regression test uses a deliberately slow reader.

- **Ghost queues** — a queue file is born on the first send and never dies; this
  hub had 43 files against ONE live cursor, and every never-consumed role was
  counted as pending work. `hub_brief` now flags them `neverRead`, `hub doctor`
  warns, and `hub queue gc` lists them (dry by default) and archives them into
  `queues/archive/` on `--apply` — moved, never deleted, and never an owner's
  own queue, which a human legitimately reads as a file. The dry run also says
  how many never-consumed files the age threshold is holding back, so the
  default never reads as "the rest are fine".

## 0.5.0 — 2026-07-26

The attribution-and-environment release. **Breaking:** an author is now
required on every write — `agent`/`by` on report, sync, card set, task
add/update, resource set, whatsnew, and `from` on queue send. Bare model,
client and placeholder names (`claude`, `cursor`, `unknown`, `mcp`, ...) are
refused: many sessions share them, so they identify nobody.

- **`HUBD_AGENT` floor** — set it in the server's env and a call that omits
  the author gets that name plus a short per-session suffix instead of an
  error. Per-session, so two sessions on one host stay distinguishable and
  `hub_claim` still detects a second holder. A floor naming a model is
  ignored, not laundered. No floor over HTTP: one server serves many callers.
- **Environment checks** — an upgrade can require something outside the code
  (a config variable, a role declaration, a protocol section worth
  re-reading). `hub_whatsnew` now returns those as `environment: [...]`, each
  item saying what is wrong, the remedy, and who can fix it (`agent` /
  `agent+restart` / `owner`); `hub doctor` shows the same list. Nothing
  blocks, nothing needs acknowledging — an item disappears when its condition
  does. Protocol changes are announced per SECTION (hashed individually), so
  agents re-read what moved, not the whole manual.
- **Subscriber cursors and fan-out roles** — a queue cursor belongs to a
  reader, not a machine. Roles listed in `<team>/subscriber-roles.json`
  broadcast: every waiting session has its own cursor and sees every message.
  Undeclared roles stay competing-worker queues (at-most-once). Session
  identity is process-derived (ppid + start time — a recycled pid can't
  inherit a dead session's cursor), never model-supplied.
- **Queue delivery hardened** — the cursor advances under a lock, so two
  competing waiters can no longer double-deliver a block seen in the same
  poll window; `hub doctor` reads the offsets/waiters that actually exist
  (per-host filenames) instead of paths nothing writes; `hub_brief` reports
  broadcast roles as `fanout` instead of a phantom shared-cursor backlog.
- **Sync tells you what moved** — `hub_sync` computes commits/insertions/
  deletions since the last sync from git (plus auto-detected project version
  and test count) and writes them to the card; agents stop retyping git.
- **Report honesty** — `DONE:` with an id that matches nothing comes back as
  `doneMissed` instead of vanishing; cards created by `hub_card_set` show
  their `set` time in `hub status` and age into the brief's stale list.
- **MCP ergonomics** — `hub_queue_wait` default timeout dropped to 45s
  (clients abort long calls around ~60s and the server cannot see that
  limit); `importance` editable via task update; error messages name the
  missing field instead of listing three.
- **Docs** — a [quick start](docs/quickstart.md) and eight
  [recipes](docs/recipes.md), both shipped in the package; self-hosting notes
  what HTTP mode actually disables (`hub_sync` and both queue waits).

## 0.4.8 — 2026-07-17 (not published to npm; shipped in 0.5.0)

- **Task ids stopped colliding across nodes** — new ids are node-scoped
  (`planck-3`), minted from the node's own append-only log, so two offline
  machines can never mint the same id; legacy numeric collisions are resolved
  by keying updates to the task's origin (node, id), fixing the cross-node
  mis-close.
- **`hub_context`** — cwd → project auto-bootstrap: a `.hubd` marker file, a
  card's recorded sync path, or a folder-name guess (flagged `guessed`).
- **Presence** — `hub_heartbeat`/`hub_presence`: a fleet roster with TTL
  freshness, so MCP/headless agents are as visible as screen-scraped ones.
- **Buttons** — pending items in a human-owner queue (`HUB/owner-roles.json`)
  roll up in `hub_brief` as "N buttons waiting (oldest X days)".
- **`hub_trajectory` / `hub plan`** — deterministic dependency planner over
  `depends_on`: ready now, topo layers, critical path, cycles.
- `hub task list --json` and `--status`; consumer-loop duration findings
  documented in the protocol (poll with 30-45s timeouts on impatient clients).

## 0.4.7 — 2026-07-09

- Protocol: the handoff convention (the queue IS the channel — task bodies
  never go into a terminal) and the consumer loop (an agent makes itself
  addressable by looping on the blocking wait as a tool call).

## 0.4.6 — 2026-07-09

- `hub_queue_wait_all` / `hub queue wait '*'` — subscribe to every role at
  once on a separate offset namespace: a supervisor taps the fleet without
  stealing any role's messages.

## 0.4.5 — 2026-07-08

- `hub_onboarding` (one-time orientation, serves the shipped protocol) and
  `hub_whatsnew` (personalized "what did I miss" since your own last call),
  with a one-line nudge for agents that skip them.

## 0.4.4 — 2026-07-08

- `hub_queue_send` + `hub_queue_wait` over MCP — a real blocking long-poll on
  a role's queue, replacing sleep-and-recheck loops.

## 0.4.3 — 2026-07-08

- Per-host queue files (`<role>.<node>.queue.md`) — a shared queue file meant
  two offline nodes editing one file, a git merge conflict, an aborted mesh
  sync, and a message the waiting node never saw. Single writer per file;
  legacy shared files still read.

## 0.4.0 – 0.4.2 — 2026-07-04

- Harvest as an MCP prompt (`prompts/get harvest`) + `hub harvest`: the
  Harvest Protocol ships with the package, no repo fetch (0.4.0).
- Prompt-block cleanup: surface blocks wire up and point at `HUBD.md` instead
  of re-teaching mechanics that rot (0.4.1).
- Docs synced with reality: roadmap items marked shipped, dead references
  dropped (0.4.2).

## 0.3.0 — 2026-06-30

- **`HUBD.md`** — the agent protocol as a per-node generated artifact,
  materialised from the installed package on every `hub` run and stamped with
  the version: update the code and even file-only agents never follow stale
  instructions. `hub upgrade`, doctor version check; `AGENTS.md` slims down
  to team rules.

## 0.2.0 — 2026-06-30

- **`sections.json`** — one i18n source drives both the card scaffold and the
  report router, so localised headings can never drift apart (the duplicate-
  sections bug class). `hub sections`; the old split files become deprecated
  aliases.

## 0.1.9 — 2026-06-29

- **Structured reports** — `DECIDE:/FACT:/HYPO:/COMM:/NEXT:/DONE:/TASK:`
  lines fan into card sections and task events deterministically (pure prefix
  match, no AI); `hub decide` / `hub next` shortcuts.

## 0.1.8 — 2026-06-29

- **Resources + the typed graph** — infra as cards (host/vm/service/endpoint/
  provider) with structured frontmatter and `[[wikilink]]` edges (`runs_on`,
  `depends_on`, ...); `hub graph` renders one topology across projects and
  resources; tasks link to resources.

## 0.1.1 – 0.1.7 — 2026-06-12 .. 2026-06-26

- Card scaffold on new cards; sync/card-set preserve every hand-written
  section verbatim (the silent-data-loss fix); MCP Registry metadata; crash
  fixes with regression tests; the append-only guard in `hub doctor` (a
  migration that strips fields is flagged, never silent); abuse guards on the
  HTTP server; `hub gc`. (0.1.3 was never published to npm — folded into
  0.1.4.)

## 0.1.0 — 2026-06-12

- First publish: MCP server (stdio) + CLI over one folder of markdown and
  JSONL — cards, journal, tasks, claims, read-only kanban.
