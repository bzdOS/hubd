# What hubd promises, and the case behind each promise

A tool for agents rarely fails by crashing. It fails by *answering* —
confidently, and wrong. A list that ended early without saying so. A count that
turns out to be mostly duplicates. A task close that lands on somebody else's
id. A person would stop at "wait, fifteen hundred tasks? I didn't create
fifteen hundred tasks." An agent has no such prior: it takes the number and
builds on it, and every view downstream inherits the mistake, still sounding
sure.

hubd is built against that failure mode, and it shows in the boring parts. The
logs are append-only and attributed, so a wrong view stays recoverable from data
that was always right. Every truncation announces itself. Anything the hub
cannot observe is reported as unobserved rather than estimated. Much of this
codebase is not features — it is refusals to sound certain.

Each promise below came out of a real case on a working hub, and the case is told
next to it. The version that made the promise is named, so you can tell which
copy of hubd keeps it ([changelog](../CHANGELOG.md)).

- [Principles](#principles)
- [Your data](#your-data)
- [Answers that do not overstate](#answers-that-do-not-overstate)
- [The mesh](#the-mesh)
- [Queues](#queues)
- [Cards](#cards)
- [Agents that come back](#agents-that-come-back)

## Principles

Violating these means it is not this product.

- **Files first.** Your hub is markdown and JSONL in a folder you own. No hubd → the
  files are still readable as they are, in any editor, `grep`, or a Markdown app like
  Obsidian ([reading your hub with any tool](interop.md)). No MCP → the files.
- **Dumb server, smart agents — no AI inside.** hubd stores and serves; the
  intelligence comes from your agents.
- **Never sound more certain than the data.** A tool that misleads its reader is
  broken even when nothing errored, so a truncated answer says it was truncated and a
  number the hub cannot observe is never estimated.
- **Human-readable everything. Zero dependencies.**
- **Read-only for the human; write access flows through rules.** The board has one
  button, and it opens the rules.

## Your data

- **Code and data are two separate things.** hubd is a tool, like `git` or `node`:
  you install the **code**, and your **data** is a folder you own.
  - *Code* — the npm package. Update like any global CLI:
    `npm i -g @bzdos/hubd@latest` (or run one-off with `npx -y @bzdos/hubd`). A new
    version ships the engine; it never touches your data.
  - *Data* — `HUBD_DIR` (default `~/.hubd`): plain markdown + JSONL, yours to keep.
    `HUBD_TEAM_DIR` set on its own means the same one directory for everything; set
    both only when the queues really live somewhere else. `hub doctor` says which won.
- **An upgrade never migrates or deletes your data.** The event logs are
  append-only and richer than any one version's schema. On several machines each one
  installs the code from npm, and your data travels in your own git: two separate
  tracks.
- **Every write names its author.** `HUBD_AGENT` is the default author for calls
  that omit one, per server config. Set it in every client and on every host: a
  required field with no floor turns a forgotten argument into a failed call, and an
  append-only log with an unattributed write in it stays unattributable forever.
  Model and client names (`claude`, `gpt`, `cursor`) and placeholders (`unknown`,
  `cli`, `root`) are refused: which model you are is already in your client's own
  transcript, while many sessions share it. Name the function.
- **A command that only reads writes nothing** (0.9.31). Every `hub` run used to
  refresh the protocol first, and that wrote `HUBD.md`, created folders, appended
  lines to the tracked `.gitignore` and removed old `.tmp` files — so a dry
  `hub gc --json` deleted the very stale file it was meant to list, and two nodes on
  different versions appending different lines to `.gitignore` stopped each other's
  sync on a conflict. Reading commands now leave the hub byte for byte as they found
  it, and a test snapshots a hub around each of them. `hub demo` is on that list
  too: it writes only into a folder of its own.

## Answers that do not overstate

- **A truncated answer says so** (0.9.35). On a live hub `hub_get`, `hub_whatsnew`
  and `hub_task_list` came to 6-11k tokens a call. They are compact by default over
  MCP now: the card's head and the newest 5 journal lines for `hub_get`, the newest
  20 entries for `hub_whatsnew`, 50 tasks for `hub_task_list`, long texts cut, and
  `truncated` saying what was left out — about 2k tokens each on the same hub (5.6k
  for 50 tasks across every project). `full: true` gives the whole answer.
- **Unobserved is not the same as dead** (0.9.13). `presence/` is node-local, and
  an orchestrator reading one machine's registry escalated "worker is dead, cannot
  dispatch" four times across 92 hours while the worker was working on another
  machine. Each node now publishes one small `presence.<node>.json`, every row of
  `hub_presence` says which node observed it, and a `coverage` list names any member
  that is reporting nothing: a role nobody reports is invisible, not dead.
- **Which version is actually running** (0.9.4, 0.9.12). `hub version` prints the
  number *and the path of the copy that printed it*, because on a real machine those
  are one question: a stale global install and a live source checkout are both called
  `hub`. Each journal line carries the version that appended it, so `hub doctor`
  reports the whole mesh — which node is behind, whether **this** copy is the stale
  one, and whether two hubds are writing into one node at the same time, **naming the
  agents on each version**. That last detail is 0.9.12 paying for a wrong guess of its
  own: the warning used to say "two installs on one node", and there was one install
  — a resident MCP server kept writing the version it had imported while a fresh CLI
  wrote the current one out of the same file. Upgrading a package on disk does not
  reach a process that already imported it. This exists because the machine that
  develops hubd ran a CLI nine releases old for weeks and nothing anywhere could have
  said so.
- **What an upgrade needs from you, said by the hub.** Sometimes a new version wants
  something outside the code: a variable in a client's config, a role declared in the
  hub, a protocol section worth re-reading. `hub_whatsnew` returns an `environment`
  list, every item saying what is wrong, what fixes it, and **who can** — the agent,
  the agent plus a client restart, or you. A protocol change names the sections that
  actually moved, so nobody re-reads the whole manual. `hub doctor` shows the same list
  to a human. Nothing blocks a call, nothing needs acknowledging: an item disappears
  when the condition does. Per-node state in `.env-state.json`, never mesh-synced —
  three machines have three environments.

## The mesh

- **A sync that keeps retrying does not look healthy.** `hub doctor` counts how many
  commits this hub is behind `origin`, because a sync loop that keeps retrying looks
  exactly like one that works: one node went 228 commits without receiving anyone
  else's work while every report called the hub healthy. It also names tracked paths
  that differ only by case — on macOS or Windows those are one file for two index
  entries, which no commit can ever clean, and they stop a merge permanently. Since
  0.9.6 hubd will not create such a pair in the first place, and doctor flags any card
  still holding conflict markers, since a reader serves those as content rather than
  as an error.
- **A peer that went quiet is named** (0.9.22). A node whose pull keeps aborting
  knows it, and nobody runs another machine's `hub doctor` — so it writes locally,
  reaches no one, and looks fine from every side. `hub doctor` names the nodes that
  have stopped appearing in the mesh's own history.
- **Before you rewrite the hub folder** (0.9.20) — `hub freeze "<why>" --by <you>`
  stops this node's mesh-sync whatever schedules it, `hub unfreeze` releases it, and
  `hub doctor` will not let you forget it is on.
- **A card does not conflict** (0.9.40, 0.9.51) — run `hub card merge-driver` once on
  each node. Cards then merge by `##` section: two nodes writing different sections
  never conflict, and one section changed on both keeps both versions under a line
  asking a person to look. A node's snapshot, presence, sense and read-mark files take
  the version with the later time, in a merge and a rebase alike. It lives in the
  node's own `.git`, so a node without it merges as before, and `hub doctor` says so
  — and, since 0.9.52, says when a driver is configured but will not run.
- **When a card does conflict** — the only shared file that can, being the one
  mutable one — `hub card resolve` unions the bullet-list hunks (two nodes appending
  facts have not disagreed) and leaves prose hunks for you, named by section. It exits
  non-zero while anything is left.
- **A hub that was written in isolation is folded in, not lost** (0.9.18) — a
  misrouted env var, a private `~/.hubd`, a laptop that never joined. `hub absorb
  <dir> --as <label>` makes its logs that label's per-node files here, renames its
  task ids `<label>-<n>` in every field and every text so they stop colliding with
  yours, keeps its queue history aside and never re-delivers it, and prints the plan
  (id map, unread blocks, cards kept for a human) before anything is written. Nothing
  already in your hub is rewritten.

## Queues

- **A queue that answers "nothing new" is empty** (0.9.20). Delivery advances a
  per-file cursor, so a cursor this user cannot write stopped delivery dead — and it
  looked exactly like an idle queue, on both sides: the wait said nothing new, the
  send said sent. Four live roles held a day of orders that way. Now the wait fails
  with the file and the fix, `hub doctor` lists such cursors, and a send reports the
  depth now waiting so a climbing backlog is visible to the sender.
- **Every node counts a queue the same way** (0.9.33, 0.9.49). A cursor never leaves
  its node, so the node that wrote a role's messages counted as pending what the node
  that read them had already taken: 44 pending on one, 0 on the other, for one queue.
  A role's reader publishes how far it got (`queues/read/<role>.<node>.json`,
  mesh-synced, one writer each), and every count — `hub queue status`, a send's depth,
  `hub brief`, `hub doctor` — takes the furthest position any node reached. A reader
  publishes its position even when nothing new came, and a file counts as read up to
  the last block its ack log names.
- **A message is prose, not cargo** (0.9.34). A queue message is read whole by a
  model, and a role loop cuts one past 16 KB: a 2.3 MB base64 bundle sent to a head
  overflowed it twice, and the work stood. A queue message, a report and a task text
  over 16 KB (`HUBD_MSG_MAX`) are refused, and so are a base64 or hex run over 2 KB, a
  diff, a git bundle and a PEM block at any size; the error says to put the
  artifact in a file and send its path, size and sha256. A diff is caught wherever it
  starts, after prose, indented or quoted, by its `diff --git` line or by a unified
  hunk's `---`, `+++` and `@@` lines, so `diff -u` output counts too (0.9.56).
- **A queue nobody reads takes no more** (0.9.34, 0.9.54). A send is refused once the
  role holds 50 unread messages or 256 KB (`queue.msgs`, `queue.bytes` in the hub's
  `limits.json`, or `HUBD_QUEUE_MAX_MSGS`, `HUBD_QUEUE_MAX_BYTES` on a node; 0 = off),
  and `hub doctor` warns at 80%. An owner role is exempt, and so is a role listed in
  `queue.exempt`: one whose reader reads the file itself. A role of rank `fleet` is
  never refused, so an escalation always goes, and a refused send exits 4 with
  `Error [queue-full]` and leaves a `queue-full` line in the sender's project journal.
- **An id names one message** (0.9.54). A queue block's id was a number counted per
  file, so one hub held "id 39" in twelve headers across four roles' queues, and an ack
  or an answer that named it named any of them. It is `<node>-<N>` (`pine-12`) now,
  counted by the node across every queue, as a task id is. Bare ids from before are
  still read and acked.
- **A message is handed out once, even when its file is cut short** (0.9.57). A
  reader was handed the same 411 bytes twice in one afternoon, the tail of a message
  without its header: its shard had stood cut inside the last block handed out and
  was whole a minute later, and the cursor had followed the cut. A shorter file that
  holds nothing past the last block handed out now leaves the cursor where it was, a
  file that is not shorter is checked against that block's header before anything is
  read, and a markdown heading inside a message no longer ends it. How: [the queue
  invariant](queue-invariant.md#cut-short--a-file-caught-while-it-is-written).
- **A message still being written is not handed out** (0.9.58). A shard rewritten in
  place could be caught longer than its cursor with its newest block cut, and that
  block went out in two parts, the second without its header. A tail without the
  newline every block ends with is now a block still being written: it waits, and the
  whole blocks before it go out. How: [the queue
  invariant](queue-invariant.md#cut-short--a-file-caught-while-it-is-written).
- **When a queue conflicts** — append-only by contract, but without union merge two
  sides that both appended do collide. `hub queue resolve` keeps ours in place and
  appends theirs at the end, which leaves every byte cursor in the hub valid. Why not
  `merge=union`: [the queue invariant](queue-invariant.md).

## Cards

- **A card is a snapshot, not a log** (0.9.23). The digest is advertised as a few lines
  of current state, and nothing held it there: one hub reached three cards past 72 KB,
  and reading the largest was refused by the caller's context budget. hubd refuses an
  over-long digest and a dated `appendLine` (that is an event — `hub report` takes it),
  and moves the oldest entries of an over-long section into
  `projects/history/<slug>.md`. Moved, never dropped: facts written by `hub_report`
  live only in the card. `hub cards compact` catches up a hub that grew first.
- **Patching a digest leaves the rest byte for byte** — `hub card <slug> --replace
  "<old>" --with "<new>"` (or `hub_card_set({replace:[{from,to}], appendLine})`) fixes
  one stale line without rewriting the owner's framing; a `from` that is not there is
  an error, never a silent no-op. `hub_report` tells you the digest's age in every
  reply and nudges once it trails the journal you just moved.

## Agents that come back

- **Resuming after a context compaction** (0.9.16) — a compaction hands an agent a
  summary of what happened; work resumes from what exists. `hub whereami` (shell) and
  `hub_context` (MCP) answer from state: the project, its digest with age and a
  `digestStale` verdict, open tasks, who else is heartbeating in this checkout, the
  journal tail — plus, in the shell, the git inventory (commit subjects, diff stat,
  untracked files with their first line, files changed in the last half hour).
  `hub_whatsnew({since:"session"})` returns what the session itself wrote, which the
  default "since my last call" checkpoint cannot. Editor hooks that run `hub whereami`
  at session start and after a compaction:
  [prompts/client-hooks.md](../prompts/client-hooks.md).
- **Claims warn before the edit** (0.9.16) — a claim's `area` is a path glob relative
  to the project root (`src/**/*.ts`, `docs/{a,b}.md`, a directory). `hub claim check
  <path>` / `hub_claim_check` says whose zone a file is in before you write it, and
  `hub_context` reports `claimsTouched` when a freshly changed file sits in somebody's.
  The lock stays soft: it informs, it never forbids. Prose areas are still accepted,
  flagged `matchable:false`.

The longer stories: [twelve weeks of field notes](field-notes.md), every mechanism that
broke, and [the queue invariant](queue-invariant.md), what happens when it breaks.
