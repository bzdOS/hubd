# Changelog

All notable changes to `@bzdos/hubd`. Dates are release-commit dates.
The file format (markdown + JSONL, append-only logs) is the stable contract;
a version here never migrates or deletes data.

## 0.9.53 — 2026-10-06

- **`mesh-sync` fetches again when another node's push lands first.** Every node pushes to one
  mirror about once a minute, and a push that lands between this node's fetch and its push wins:
  git refuses ours ("fetch first"), or the mirror cannot lock the branch it is moving. One node
  lost one run in six that way, about 90 a day, each a minute of delay and a failed unit in
  systemd's log. That failure, and only that one, now goes back to the fetch in the same run, up
  to `HUBD_SYNC_PUSH_TRIES` times in all (default 3). Any other failed push is left to the next
  run, as before.
- **A node's presence snapshot says when hubd last ran there.** `presence.<node>.json` was
  written on heartbeat only, so a node whose sessions never heartbeat (people at a terminal, not
  agents in a loop) kept the one it wrote weeks before: from every other node it looked silent
  for 24 days while it wrote to the mesh every minute. Any MCP tool call now refreshes it too, at
  most every 5 minutes. A hub that has never published one gets none.
- **`hub doctor` waits for the hub's git.** Its checks read git with an 8 s bound and took a read
  that ran out as an empty answer: with every core busy, `git ls-files` once took longer, and a
  case-colliding pair came back as no pair. Reads of the hub's own repository now get a minute;
  reads of project repositories keep 8 s.

## 0.9.52 — 2026-10-06

- **`hub doctor` says when a merge driver will not run.** The drivers live in the node's own
  `.git`, and a missing one or one whose path went stale fails without a word: the merge just
  falls back. On a node that syncs, doctor now names each driver that is not installed, lacks an
  attribute line, or names a file that is gone, says what a merge does instead, and counts it as
  a warning. A command set by hand is not checked.
- **The driver command names `node` as PATH has it.** It named the binary with every link
  resolved, which on one node was `/usr/bin/node-22`: gone with the next major version, while
  `/usr/bin/node` stays. Now the first `node` on PATH that is the same binary is named. Run
  `hub card merge-driver` again on each node to repoint it.

## 0.9.51 — 2026-10-05

- **A file one node rewrites whole no longer stops the mesh.** `snapshot.<node>.json`,
  `presence.<node>.json`, `sense.<node>.json` and the read marks in `queues/read/` have one
  writer each, so two versions meet only after history was repaired or rebased, or when one node
  name is in two clones. git's text merge then stopped on every line with a time in it: one
  node's snapshot stopped another node's sync until its history was realigned by hand.
  `hub card merge-driver` now also installs a driver for these files that takes the version with
  the later time (`ts`, `written`, or the latest read-mark `at`), whole. Ours and theirs swap
  between a merge and a rebase; the time does not, so both keep the same version. A version whose
  time does not read loses; equal times pick the same version on every node. If the driver's path
  goes stale, the file keeps git's ours. Run the command again on each node to get it.

## 0.9.50 — 2026-10-05

- **`mesh-sync` packs the hub itself, once a run, in the foreground.** git packs after a commit,
  a fetch or a merge, in a process it forks into the background. On macOS that process crashed
  after the fork and left `.git/gc.log.lock`, and every background gc after it stopped on that
  lock without a word: one hub went seven weeks unpacked, 86000 loose objects and 3.75 GiB, and
  every run redid the part of gc that comes before the fork, once for each command that started
  one. git's own gc is now off for the script's commands (`maintenance.auto=false`, read by git
  2.31+), and one `git gc --auto` runs after the push, its errors in the sync's log. A failed
  push still packs. A foreground gc never takes the lock, so a hub that has one needs nothing
  done to it; its first run packs the backlog, which `git -C <hub> gc` by hand does ahead of time.

## 0.9.49 — 2026-10-05

- **A queue read on another node no longer counts full there.** The send limit took a block as
  read only by its own ack, so blocks written before ids, which no ack can name, and header lines
  quoted inside a body stayed unread for ever. A reader hands its file out in order, so a file
  now counts as read up to the last block its ack log names, every block above it included.
- **A reader publishes its position even when nothing new came.** A reader that read its queue
  to the end on a hubd from before read marks left none, and its cursor never leaves its node:
  every other node counted that queue unread until the next message, which a queue counted full
  refused. Each wait now writes the cursor's watermark as the read mark where the two differ.
- **The hub sets the send limit in `limits.json`.** `{"queue": {"msgs": N, "bytes": N,
  "exempt": [role, ...]}}` travels with the mesh; `HUBD_QUEUE_MAX_MSGS` and
  `HUBD_QUEUE_MAX_BYTES` set on a node still win there. A role in `exempt` is never refused nor
  listed as near full: one whose reader reads the file itself, leaving no cursor, mark or ack.
  `hub doctor` names the exempt roles.

## 0.9.48 — 2026-10-05

- **Artifact deliveries are mail, a row of their own.** A mail relay (a fleet tool) records each
  delivery that succeeded as a journal entry of kind `delivery`, through `hub report -k
  delivery`: `<sender> → <recipient>: <name> <bytes> B sha256 <hex>` (the byte unit may be the
  Cyrillic one, the arrow `->`). Live shows the newest 20 in a Mail row above Activity, which no
  longer lists them; `/api/kanban` and `hub_kanban` gain `mail`, each delivery read into
  `from, to, name, bytes, sha256` beside its whole text. On the Summary each track has the newest
  20 whose recipient is one of its roles (`/api/summary` gains `mail` per track, and
  `mailLimit`). An entry of the kind whose text does not read so is kept whole with the parts
  null: Live shows it, and no track claims it. `hub report` takes any kind, so the relay needs
  no change.

## 0.9.47 — 2026-10-05

- **The Summary shows each node as its own snapshot states it.** A node's fleet tool writes
  `snapshot.<node>.json` (v1: sessions, disks, relays) into the hub directory, and the mesh
  carries it like `presence.<node>.json`; hubd only reads it. `/api/summary` gains `nodes`, one
  row per file, and `snapshotStaleMin` and `diskFullPct`. The page lists each node's snapshot
  age, disks and relays, and a table of sessions: session, node, role, state, minutes since the
  hub, minutes since motion. In red: a snapshot over 5 minutes old (or with no time), a disk at
  90% or more, a relay failed or not active. Fields it does not know are ignored; a file that
  does not parse, is not an object or is not v1 is a row "snapshot unreadable" with its node and
  the reason.

## 0.9.46 — 2026-10-05

- **An escalation to the fleet waits until it is answered, and the board says which.** An
  escalation is a block with an id in the queue of a `fleet` role, and its key is its header,
  `<date> · from <role> · id N`. It is answered when an entry of the fleet card's Owner decisions
  section quotes that key; the entry's stamp is the answer's time. Matching is by the key alone:
  "id 3" is not "id 32", and no author or wording is read for an answer. Entries the section cap
  moved to the project's history still answer, and of two answers to one key the later stands.
- **"Waiting for you" lists every unanswered escalation, however old, and those answered in the
  last 24 hours** with the answer, in `hub board`, the Tracks view and the Summary
  (`/api/summary` gains `escalations: {fleet, waiting, answered}` and `answeredHours`). Each
  carries its key, who sent it to which role, its text, how long it waited and, once answered,
  when and what. Queue files are read whole for this, not their last 256 KB. This replaces the
  window of escalations and of the fleet role's own replies, which said nothing about whether
  the owner had answered.
- **A section key `owner-decisions`** (`## Owner decisions`), not in new cards, localised by
  `sections.json` like any other: `hub section add <fleet project> owner-decisions "<key> —
  <answer>" --by <you>`.

## 0.9.45 — 2026-10-05

- **`hub serve` opens on a Summary: where each track stands, assembled by a script.** Asked
  "where is each track", a coordinator retold the board, and two retellings of one state differed.
  `/api/summary` answers from the files: per track, the goal, the tasks in work, blocked and
  closed in the last 24 hours, each with its age, its assignee and the head's newest verdict
  entry in full, and each role's newest `blocked` entry until the role hands that task in or the
  task closes. Lists are ordered by their own fields, so a fixed hub at a fixed moment gives the
  same bytes. It is the first screen of a hub with heads; a mode chosen before still wins.
- **A verdict is a head's entry that names the task and holds a verdict word** in capitals:
  ACCEPT, ACCEPTED, REJECT, REJECTED, plus the words a hub lists in `<hub>/verdicts.json`,
  `{"accept": [...], "reject": [...]}`. At one position the longer word wins, so a negated form
  listed under reject is read whole. A task is named by `#<id>`, or bare when its id has a letter:
  a bare number in prose is a count. In an entry that opens with a verdict, a task takes the
  word before its name ("ACCEPT #12, REJECT #13"); in one that names a task first, the word after.
- **A card's `goal` section** (`## Goal`), which the Summary quotes; without one, the digest's
  first line. New cards do not get it: a head writes it with `hub section add <slug> goal
  "<line>" --by <you> --set`, and `sections.json` localises its heading like any other.
- The board and the Summary share one definition of a track (`trackLayout`).

## 0.9.44 — 2026-10-05

- **`hub_reflect`: the reflection digest over MCP**, what `hub reflect --json` prints: `project`
  (its aliases count as it), `since` (default 7d), `level`. A head reads it instead of its
  workers' reports in full. Every key is present with zeros; a capped reply drops `decisions`
  first, then `rules`, and says so.
- **A rule that holds the fragment's own example is not a rule.** On one hub, two roles put the
  example's rule into 86 of 2768 reflections: 45 times alone, 41 times after the fragment's own
  lines restated. The `reflect` field refuses it, with the reason. A `REFLECT` block that holds it
  is read, and the reply names it a problem. `hub reflect` counts it as `exampleRule`, never among
  the rules, and `hub recall` finds no rule in it.
- **The fragments say it, and the head reads the digest.** `reflect`: the `rule` is what this turn
  taught, in the role's own words; the `reflect` field is named as the other way to give the
  block; the example says its rule is not the reader's. `head-cycle`: step 1 reads `hub_reflect`,
  step 5 reads its obstacle counts and its rules. Every role's rendered rules differ from the
  render until rendered again: `hub prompts render … --check` exits 1 on each.
- **`hub watch --exec <command>`: each entry to a command, marked when it exits 0.** The entry goes
  to `sh -c <command>` as one JSON line on stdin, so a delivery that fails is retried: it is
  delivered at least once. A non-zero exit, or a command killed after 20 s, stops the pass at its
  entry; it and the entries after it are handed over again on the next pass. One pass then exits
  1. `--follow` says so once, retries each interval, and says when the command exits 0 again. The
  cursor is saved after every entry. On SIGINT, SIGTERM or SIGHUP the command in flight finishes
  and the watch exits 0. `HUBD_WATCH_KEY` is the entry's key, the same on every attempt, for a
  receiver that drops repeats. `--exec` with `--json` is an error.
- **`contrib/watch-to-matrix.sh` runs over `--exec`.** The Matrix transaction id is
  `hubd-$HUBD_WATCH_KEY`, so a retried post shows once. Before, the id changed on every attempt:
  a post that timed out after the server took it was shown twice. An entry the script is killed
  holding was lost; now it is posted on the next start.
- **Docs.** HUBD.md names `hub_reflect` and the `reflect` field. It pointed at `hub get <slug>`,
  which the CLI does not have; it now names `hub_get` and the card file. The quickstart lists
  mesh-sync's exit 5 (a merge git refused before merging) and shows `hub reflect` and
  `hub watch`. The interop doc describes `--exec`.

## 0.9.43 — 2026-10-05

- **`hub watch --as <name>`: the journal's new entries, each once.** For a notifier that follows
  the journal. Reading the files by byte offset shows an entry twice after a union merge doubles
  it, and misses one a merge puts before lines already read. It replays a file that a reset
  shortened and a pull grew back, and it loses the lines cut into a month archive by rotation.
  The cursor (`.watch/<name>.json`, node-local, never synced) holds no offset. It holds a short
  hash of each entry it passed, keyed by node log and line, as the hub's readers drop repeats.
  One pass and exit, or `--follow` (a pass when a journal file changed, `--interval`, default
  5 s). `--json` prints one entry per line. A new cursor starts at its first run, or earlier with
  `--since`. Hashes are kept for 7 days. `-p` narrows what is shown, and the private braid is
  shown only with `--private`. An entry is marked once it is written, so a reader that goes away
  misses nothing on the next run. Measured on a week of one hub's journal, 11593 entries: the
  first pass took 1.7 s, a pass after that 0.7 s, and the cursor holds 154 KB.
- **`contrib/watch-to-matrix.sh`**, a bridge to a Matrix room over `hub watch --follow --json`.
  It retries a post that fails, and it is now in the package.
- `.watch/` joins the node-local lines a writing command puts in `.git/info/exclude`.

## 0.9.42 — 2026-10-05

- **A reflection is data.** `hub_report` takes a `reflect` field: `goal`, `result`
  (done | partial | no), `obstacle` (permissions | path | unclear-dispatch | environment | model
  | none) with `obstacle_fact`, `instead`, `rule`, and a `level`: `turn`, or `head` and `fleet`,
  which may carry `decisions` on proposed rules (accepted | rejected | needs-owner). A value off
  a list is refused before anything is written, and so is a reflection given both as the field
  and in the text. The journal entry keeps the field and the same block as text, so a reader of
  the journal sees what it saw before. The CLI takes it as `hub report --reflect <json|file>`.
- **The `REFLECT` block in a report's text is read, not refused.** Reports written to the
  fragment keep working. The reply says the reflection was read and names what is off the lists:
  measured on one hub's journal, 24% of 2691 reflections had something, most often a fact after
  `none`.
- **`hub reflect --project <p> [--since 7d] [--level turn|head|fleet] [--json]`.** Per role, the
  reflections and their results; per obstacle class, the count and the latest three facts; the
  rules proposed more than once, compared without case and punctuation; the decisions a head or
  the fleet took. A result or class off the lists is counted as `other` or `unclassified`. The
  `--json` keys are always there, at zero when empty.
- **`hub recall` finds a reflection's rule and obstacle as hits of their own.** They end the
  entry, so inside the journal hit they sat past the 300 characters a hit shows.

## 0.9.41 — 2026-10-05

- **A role's rules over MCP.** `prompts/list` now names the worker, head and orchestrator
  templates next to `harvest`, each with its declared variables as required arguments, described
  from the tables in `prompts/meta/README.md`. `prompts/get` with all of them returns byte for
  byte what `hub prompts render` prints, rendered by the same code from the installed package, so
  a client with no rules file gets the current rules, not a copy. A missing or blank argument is
  an invalid-params error (-32602) that names it; a broken template is an internal error, and
  `prompts/list` then lists `harvest` alone and says why on stderr.
- A template variable without a row in `prompts/meta/README.md` now fails a test: the MCP argument
  would go out without a description.

## 0.9.40 — 2026-10-05

- **A conflict is named as one in any locale.** `mesh-sync` tells a refused merge (exit 5) from a
  content conflict (exit 2) by git's own words, and git translates them. On a node with a Russian
  locale a card conflict was reported as a failed pull, and that node's mesh stood for 2.5 and 4.5
  hours. The script now runs git under `LC_ALL=C`.
- **Cards merge by section: `hub card merge-driver`.** Run once on a node, it installs a git merge
  driver for `projects/*.md` in that node's `.git/config` and `.git/info/attributes`. A section is
  a `##` heading and what follows it. Sections changed on different sides merge without a
  conflict. A section changed on both sides gets a line merge of its own; when that clashes, both
  versions are kept, the node's own first, under a line asking a person to look. Two writes of
  one card keep the later `- set:` stamp. Measured on a mesh, 72 card merges in nine days: git
  stopped on 42. With the driver, 4 of those merge clean and 38 are kept and marked, and no line
  is lost in any. Nothing travels with the mesh, so a node without the driver merges as before. If
  the driver's path goes stale, the merge falls back to git's union merge; run the command again.
  `--remove` takes it out.
- **A shared hub stays group-writable after a sync that stops.** Group write was restored only
  after a merge that changed HEAD, but a failed fetch or merge has already written into `.git` as
  the sync's user. Those paths restore it too.
- A node that runs a copy of `mesh-sync.sh` gets the locale and permission fixes only when the
  copy is replaced. The driver runs from the installed package.

## 0.9.39 — 2026-10-04

- **A failed mesh merge no longer hands a queue out again.** `mesh-sync` merged in the live hub
  dir. A merge that stopped on a conflict in other files stood open until the abort, and every
  file it touched held the other side's version meanwhile. A reader took a block from a queue
  file; the abort put the shorter local version back, the cursor fell to 0, and the worker got
  its whole queue again, on every failed run for over an hour. Two fixes, either enough for that
  case:
  - `mesh-sync` fetches and tries the merge outside the working tree first (`git merge-tree
    --write-tree`, git 2.38+). A conflicted merge still exits 2, and the hub is not touched.
    Only a clean merge is made in place. An older git merges in place and aborts, as before.
  - A queue cursor tells a rollback from a purge. When its watermark is gone but the file holds
    blocks not newer than it (an id not above its id, a time not after its time), it resumes
    after the last of them, not at 0. When the newer version comes back, the watermark is ahead
    of the cursor and everything through its block is skipped. Both rules need a header with an
    id; without one, nothing changes.
- A node that runs a copy of `mesh-sync.sh` rather than the one in the package gets the first
  fix only when the copy is replaced.

## 0.9.38 — 2026-10-04

- **Nine rules from a finished project, in the role rules where they are read.** Each comes from
  a case that happened. Heads: the cheap mechanical check of an artifact is the first dispatch
  and is rerun after every step; a full pass waits until names are fixed; verification gets no
  less time than production. Every role: exit code 0 is not a result; a claim about quality is
  a sample; check against the original, not a retelling; an event is a `FACT` only once observed
  or confirmed; an owner decision outranks an older practice found in the history. The
  orchestrator does not warn again about a risk the owner has weighed. The protocol's
  compaction section: a label in the narrative ("a project convention") is checked against
  state. The rules extend existing lines; a render grows by 0.9-1.2 KB.
- **A note for authors is not rendered in a fragment either.** It was stripped only in the top
  template. None of the nine rules has a check, so each is marked `<!-- wish: …; no check -->`
  next to it; the role never reads the mark, and `grep -rn '^<!-- wish' prompts/meta` lists them.

## 0.9.37 — 2026-10-04

- **A role hands a branch over; it does not push.** The role rules said "before a push", "rewrite
  before the push" and "you push to a local branch". Roles push nowhere: a branch goes for review,
  as a bundle or a patch. Workers read push as a step, and heads waited on one. `privacy.md` now
  runs the private check before a branch is handed over, and says a role never pushes to an
  external remote or asks anyone to.
- **New required variable `private_check`** for `hub prompts render`: the command a role runs
  before handing a branch over; empty output means clean. A worker had the patterns to look for
  but not the command. A render without it exits 2 and names it, and the rules file is not
  rewritten: add `private_check` to a role's variables before upgrading.

## 0.9.36 — 2026-10-04

- **A queue read that came up short no longer hands out stray bytes.** The reader takes the
  file's size, then reads up to it. A sync that replaced the file with a shorter version in
  between left the read short. The reader handed out the bytes it got plus the unread end of
  an uninitialised buffer, which can hold fragments of other messages. Its cursor then moved
  past bytes it never read. Now a short read hands out nothing and leaves the cursor; the next
  poll reads the file as it is. Readers that only count or peek get the bytes actually read.

## 0.9.35 — 2026-10-04

- **Three reads are compact by default.** Over MCP, on a live hub, `hub_get` came to 6-8k tokens
  a call, `hub_whatsnew` to 8k and `hub_task_list` to 9-11k (tokens estimated as chars / 3.5). Now
  `hub_get` gives the card's first 4000 chars (frontmatter, digest, facts, next step) and the newest
  5 journal entries with text cut to 240 chars; `hub_whatsnew` the newest 20 entries, text cut to
  240; `hub_task_list` at most 50 tasks, text cut to 160, without `_origin` and empty fields. On the
  same hub: 1.8k, 2.0k and 2.1k tokens for one project's open tasks (5.6k for 50 open tasks across
  every project). `truncated` and `hint` say what was cut, and `full: true` returns all of it
  whole. A list trimmed to fit kept its oldest end even when that end was a journal's past; the
  newest end is kept now. The CLI is unchanged.
- **`hub_card_set` replies `{ok, project, section, bytes}`.** The caller wrote the digest a moment
  ago; the reply no longer carries it, the card path or the patches back (`verbose: true` does).
- **The server's instructions no longer say "call hub_heartbeat after each hub_report".** That text
  reaches every client, and a role run by a shell loop has `hub_heartbeat` denied. The advice stays
  in the tool's own description.
- **The reflection is the last block of the turn's one report**, not a report of its own: a call
  late in a turn re-reads the whole turn (`prompts/meta/fragments/reflect.md`, `report.md`,
  `turn.md`). `hub sense` reads it at the end of a report, as the journal joins it (`· REFLECT ·
  goal: …`), and still at the start: the WORKER REPORT a head is woken with keeps the reflection
  whole (up to 500 chars) and cuts the body before it, where it used to cut at 700 chars and lose
  a trailing reflection.

## 0.9.34 — 2026-10-03

- **A message is prose, not cargo.** A queue message is read whole by a model, and a role loop
  cuts one past 16 KB: a 2.3 MB base64 bundle sent to a head overflowed it twice, and the work it
  carried stood. A queue message (`hub queue send`, `hub_queue_send`), a report and a task's text
  over 16 KB (`HUBD_MSG_MAX`) are now refused, and so are four shapes at any size: a base64 or hex
  run over 2 KB (lines wrapped at 60+ columns count as one run), a git diff, a git bundle, a PEM
  block. The error names the rule: put the artifact in a file and send its path, size and sha256.
- **A queue nobody reads takes no more.** A send is refused once the role already holds 50 unread
  messages or 256 KB (`HUBD_QUEUE_MAX_MSGS`, `HUBD_QUEUE_MAX_BYTES`; 0 turns either off). Unread
  is counted past the furthest read position (this node's cursor and every node's read mark; a
  broadcast role's furthest reader), less every block the ack log says was handed out, so a
  reader on an older hubd is credited through its acks. An owner role is exempt. `hub doctor`
  warns at 80% of either limit and marks a full queue.

## 0.9.33 — 2026-10-03

- **Every node counts a queue the same way.** A cursor never leaves its node, so the node that
  wrote a role's messages counted as pending what the node that read them had taken: on a live
  mesh, 44 pending on one node and 0 on the other for one queue of 71. A role's reader now
  publishes how far it got, `queues/read/<role>.<node>.json`: one writer per file, mesh-synced,
  the header of the last block handed out plus its offset. `hub queue status`, the depth a send
  reports, `hub brief`, `hub doctor`, and ghost and stranded queues all take the furthest of this
  node's cursor and every node's mark, and `queue status` names the node and the time. The header
  is trusted, not the offset: a file trimmed above the mark still reads as read to its end, and a
  file recreated under the same name does not inherit it. Delivery is unchanged. A tap
  (`hub_queue_wait_all`) writes no mark. Design: `docs/queue-invariant.md`, "Read marks".
- **One "delivered" per block in the ack log.** Every reader, taps included, appended one for every
  block it was handed, so a queue handed out from its start seventeen times left 361 lines for 61
  ids. Now only a role's reader writes, and only for an id the log does not have yet.
- **Block ids continue past the ack log.** A file emptied by hand restarted at id 1, and the old
  log answered for the new id 1. `hub queue gc` and `hub gc` move a queue's ack log into the
  archive with it, so the next file starts clean.

## 0.9.32 — 2026-10-02

- **Role rules from one template, not copies.** `prompts/meta/` ships three templates (`worker`,
  `head`, `orchestrator`) and eight shared fragments: the turn, boundaries, preemption, privacy,
  the report, the reflection every turn ends with, a head's dispatch cycle, and the orchestrator's
  reflection over the heads. Everything specific to one role, its name, directory, track goal and
  facts, the owner's decisions, comes in as a variable. Until now each role's rules lived as a
  copy, and a rule fixed in one copy stayed wrong in the others.
- **`hub prompts render <template> --vars <json|file> [--out F | --check F]`.** `{{> name}}`
  includes `fragments/name.md`, at most 3 deep, and a cycle is an error naming the chain;
  `{{name}}` is a variable from the template's `<!-- vars: ... -->` line. A missing or blank
  variable is an error with its name, never an empty string: a blank in a role's rules drops a
  fact the role cannot know it lost. A variable used but not declared, or declared and never used,
  is an error with file and line. `--check` exits 1 with a line diff when the file differs from
  the render, and every render error exits 2, so a loop can tell stale rules from a broken
  template. The command only reads, like `harvest`. Format: `prompts/meta/README.md`.

## 0.9.31 — 2026-10-01

Fixes from the acceptance review of 0.9.30.

- **A command that only reads writes nothing.** Every `hub` run refreshed the protocol first, and
  that wrote `HUBD.md`, created the hub's folders, appended lines to the tracked `.gitignore` and
  removed every `.tmp` file older than a minute, so a dry `hub gc --json` deleted the very stale
  file it was meant to list. Reading commands (`status`, `brief`, `board`, `doctor`, `task list`,
  a dry `gc`, ...) now leave the hub byte for byte as they found it, task cache included; the
  hub's folders are created by the first write. A test snapshots a hub around each of them.
- **No command appends to the tracked `.gitignore` any more.** In a mesh that file is a commit, and
  two nodes on different versions appending different lines to its end stopped each other's sync
  on a conflict. The node-local lines (now also `*.lock`, `*.tmp.*`, `tasks.json`, `claims.json`)
  go into `.git/info/exclude`, which never travels, on every writing command; `hub init` completes
  the shared `.gitignore`, once, on one node. `hub doctor` warns about a node-local file nothing
  ignores, and notes lines only the exclude file has.
- **A node is live by its own files.** Which nodes still write to the mesh decides whose queue
  files gc may move, and it was read from presence snapshots and commit names, while mesh-sync
  commits under the hostname: a node whose `HUBD_NODE` differed and whose snapshot was stale read
  as gone. The newest stamp in its journal, its task log or a queue file of its name counts now,
  and `mesh-sync.sh` commits under `HUBD_NODE` when set, normalised as the file names are.
- **The board's journal window skips old month archives.** It read and parsed every journal file
  since the hub began and filtered to its window afterwards; a month archive that ended before the
  window is no longer opened.
- **`hub sense`:** an escalation that cannot be written is reported on stderr and in the turn text
  instead of being dropped, and a missing `HUBD_SENSE_ESCALATIONS` directory is created; a private
  pattern that is not a valid regex no longer counts as declared for `hub lint`.
- **Harvest:** every project card ends with a Communication section, what has gone out and what
  is still queued.

## 0.9.30 — 2026-09-30

Fixes from the acceptance review of 0.9.28–0.9.29.

- **The board escapes quotes.** Its `esc()` escaped `<`, `>` and `&` only, and a heartbeat status
  (free text any loop writes) went into a `title="..."` attribute: a status with a quote in it
  opened an event handler in the owner's browser. Both quotes are escaped now, and every value the
  page renders goes through it. A role alive without state fields says how long ago it was seen;
  "+ other projects" shows every project with open work next to the tracks (`/api/board?all=1`);
  the board reads a journal window (30 days, or `--days` if longer) instead of the whole journal on
  every refresh.
- **`hub gc` is a dry run without `--apply`, all of it.** The old half of the command removed stale
  locks, cache backups, `.tmp` files, idle readers and session records on every run and printed
  them ahead of the listing, so `hub gc --json` was not JSON. That litter is now one more class,
  listed and removed only by `hub gc --apply --by <you>`.
- **A node archives only queue files it may move.** Its own shards, and shards with no writer left
  (a node with no presence snapshot and no mesh commit for 30 days; a file with no node in its
  name) — never another live node's shard, whose writer was left with a modify/delete conflict and
  a stopped sync, and never an empty file. `hub gc` and `hub queue gc` list what they left and why.
  Whether a role is alive now counts every node's published presence, not only this node's.
- **The hub's `.gitignore` is completed, not only created.** `hub init` wrote the node-local lines
  only into a new file, so an older hub never got `.mesh-freeze`: a commit by hand carried a freeze
  to a peer. Every hub run now appends the lines an existing `.gitignore` lacks, `hub freeze`
  warns when its marker is tracked anyway, and `hub doctor` reports node-local files git tracks.
- **`hub sense`:** a wake held back by the hourly budget restores the minute's fingerprints along
  with the journal marks (the held-back report used to count as seen and never reached the head);
  with no private pattern declared a branch fails the checklist instead of passing it; a head may
  carry its own patterns as its `private` attribute; escalations go to `HUBD_SENSE_ESCALATIONS`
  when set (a parallel run keeps its own file by default); a task `in_progress`, `doing` or
  `active` counts as open work; the published `sense.<node>.json` is written under a lock, so two
  heads finishing together no longer lose one update.
- **`hub` that cannot load exits 3 for `hub sense`.** A module that fails to load is thrown before
  any of the CLI runs, and Node exits 1 — which a loop reads as "no events". The installed `hub` is
  now a small wrapper that catches it, prints it, and exits 3 for `hub sense` (other commands keep 1).
- **`hub lint` / `hub audit`:** a head that accepts branches with no private patterns declared; one
  role alive on two nodes at once (each node has its own cursors, so both carry out every order) —
  in the audit too, with a stable key.

## 0.9.29 — 2026-09-30

- **`hub sense` does not re-raise a branch the journal already judged.** Its own state was the only
  memory of past verdicts, so a fresh state — a new node, the first pass of a run in parallel with
  another sensor — raised every open task branch as critical, including ones rejected hours ago. A
  `decision` entry `ACCEPT|REJECT <full sha>` for that branch and sha now counts as decided.
- The sensor's state directory and escalation log keep the group bits on a shared hub, so a head's
  loop and an operator running as different users can both write them.

## 0.9.28 — 2026-09-30

A fleet asked for four things that all needed the same missing piece — the hub knew every role only
by what it wrote, never what it IS — so that piece comes first.

- **Roles are cards.** A role is a resource card of type `role`: `rank` (`head`, `worker`, `fleet`),
  `project`, a `head` link from a worker, `status: off`, and any attribute its tooling needs (`repo`,
  `base`, `review`, `plan`, `idle_min`). `hub resource set` takes open attributes with
  `--attr key=value` (`attrs` over MCP); an empty value removes one. `hub lint` reports open work
  assigned to a name that is neither a role nor an owner role, and says it checked nothing while no
  roles are declared.
- **A loop reports its state as fields.** `hub heartbeat` / `hub_heartbeat` take `state`
  (`turn` | `waiting` | `exit`), `turn`, `turn_started` (`now`), `empty_count`, `silent_count`,
  `exit_reason`. A supervisor used to parse the loop's status wording and went blind whenever a word
  changed. The hub keeps `state_since` across heartbeats that repeat a state — the loop's own
  counters restart with the loop — and a turn's start while its number stays the same. A heartbeat
  without them keeps the old record shape.
- **`hub board`, and a Tracks view in `hub serve`.** Every track (a project with a head) on one
  screen: each role's state, current task, last journal step and handoff; what got done in the
  window with the journal line that accepted it; what is next, most urgent first; what is blocked
  and on what; the branch verdicts; what the head's sensor last raised. Above them, what waits for
  the owner: the owner queue, the owner's tasks, `owner-go` tasks, escalations to a `fleet` role and
  its answers. Titles are a task's first line, at most 80 characters, on the kanban too; the rest is
  one click away. Tracks are the default view when heads are declared. A tenant's board reads only
  the tenant's queues.
- **The History view** of `hub serve` is a bar per month of the journal and one entry at a time,
  with step and playback controls; it reads the journal through the same reader as every other view.
- **Work mode: a role's queue as its tasks.** `hub queue wait <role> --tasks` (`hub_queue_wait`
  with `tasks: true`) also returns the role's open, ready tasks, most urgent first, each with its
  claim and the latest messages that name it, and wakes while one is offered. Reading consumes
  nothing; starting is a claim on the task (`hub claim --task <id>`, `hub_claim({task})`) with a TTL,
  and a lapsed claim offers it again — so a turn that did nothing with an order loses nothing. An
  order about a task that was closed meanwhile is held back: cancelling is closing. `hub queue work
  <role>` shows the view without waiting. Without the flag nothing changes.
- **`hub sense <head>`: a head's sensor without a model.** Workers judged from heartbeat fields
  (idle on the sensor's clock, stuck, a long turn; a worker that is not running goes to the fleet,
  not the head), new reports from the journal — to the minute with a fingerprint, so two reports of
  one minute are two, and never one the worker already sent to the head's queue, matched by text —
  and task branches in the head's repo through a checklist in its review clone (on the base, commits,
  build products, private patterns). Exit 0 with text wakes the head, 1 is nothing new, 3 is a
  failure. Non-critical wakes are budgeted per hour, an event standing an hour is escalated.
  `hub sense <head> verdict <branch> accept|reject` writes `ACCEPT|REJECT <full sha>` to the journal
  and sends the order to whoever handed the branch in. Thresholds and patterns live in
  `<hub>/sense.json`, state in `.sense/` (node-local), and each node publishes `sense.<node>.json`.
- **`hub gc` lists what piles up, by class, and archives it the one way the mesh accepts.** Queues
  of a name that is no live role, dead waiter markers, stale presence of non-roles, notices whose
  cause is gone, and — listed only — open tasks on such names. `--apply --by <you>` moves queues into
  `queues/archive/` with their cursors, in one commit. **mesh-sync now accepts a deleted log exactly
  when the same bytes are in an archive**; before, it refused the very `hub queue gc --apply` its own
  refusal message recommended. An `rm` or an edited copy is still refused.
- `hub lint` reports two live readers on one work queue while it is true.
- **Fixed: the owner's list of queue items was empty for every block written since block ids
  exist.** Its header pattern did not allow the id between sender and task, so `hub brief` counted
  buttons it could not list.
- **Queue messages carry a block id and can be acknowledged.** Headers read `· from <sender> · id
  <N>`, and `hub_queue_ack` marks a block processed, not just read, so a sender can tell a zombie
  reader from a working one.
- `hub_report` takes `TO: <role>`: the entry stays public, and readers can filter by addressee.
- `hub lint` reports two cards that describe one project (same path or repo); `hub cards merge
  <from> <to>` aliases one to the other and archives it.
- Unknown CLI flags are an error instead of being ignored. Interrupted atomic writes clean up after
  themselves, and stale temp files are removed at start-up and by `hub gc`.
- `HUBD_TASK_ID_PREFIX` replaces the hostname in new task ids; the sequence continues from the
  highest id under either name.
- A cursor-conflict notice clears once a work queue is back to one waiter.

## 0.9.27 — 2026-09-27

- **`hub presence --json` and `hub log --json`.** The table render truncates names and statuses to
  a fixed width and the journal line drops fields, so scripts were parsing the text or reading
  `presence/*.json` behind the hub — re-implementing the cross-node merge as they went. `--json`
  prints the same object `hub_presence` returns and the journal entries as stored.
- Orchestrator prompt: an empty queue is a dispatch cycle, and a fleet blocker is re-measured
  before a lane waits on it.

## 0.9.26 — 2026-09-23

- **A broadcast reader keeps its place across a respawn** (task maple-99). The cursor of a
  subscriber was keyed by the client process, so every restart of a role got a fresh namespace:
  it either re-read the whole queue or, with `--from-now`, skipped what arrived while it was down —
  and each dead namespace stayed in `hub queue status` as a reader "behind" forever (eight for one
  role on one node). Cursors now key on a name that survives the process: `HUBD_SUBSCRIBER`, else
  `HUBD_SESSION`, else `HUBD_AGENT`, else the process as before. The author floor and the whatsnew
  checkpoint keep the per-process id — `HUBD_AGENT` is shared by every session on a machine, and an
  author shared that way is what the floor exists to prevent. Two live sessions that do share a
  reader name on one broadcast role are now detected and reported (they would split it), with the
  fix. The first wait under the new name starts a new cursor once, like any new subscriber.
- **Dead reader namespaces are archived, not kept forever or deleted.** `hub queue gc` lists
  namespaces idle for 7 days (a live reader rewrites its marker every poll) and `--apply` moves them
  to `.qstate/_archive/`; `hub gc`, which used to `rm -rf` them, now moves them too. `hub doctor`
  names them. Archived namespaces are not counted as readers anywhere.
- **A card no longer grows a second copy of a section** (task maple-112). Writers matched one
  exact heading, so a card written before the hub was localised — or a heading typed in another case
  — got a new section beside the old one, and every later copy of a heading was dead: nothing could
  append to it, readers still saw it. Writes now find the section a card already has for that key
  under its configured heading, the English default, or a declared alias (`"aliases": [...]` in
  `sections.json`), case-insensitively. `hub doctor` names cards holding a section twice, and
  `hub cards merge-sections` (dry run by default) folds them: lists concatenate in file order into
  the live section, and a second next step goes to `projects/history/`, because two current steps is
  the defect. A heading that merely resembles a key (`## Facts` beside the localised facts section,
  a hand-written section on the hubs it appears on) is left alone unless declared an alias —
  merging it would let rotation move curated facts to history.
- **The author rule now covers claims, heartbeats, freeze, absorb and `cards compact`.** A claim or
  presence record under `claude` is as unattributable as a journal line under it.
- **A stale lock is stolen by rename, not unlink.** Two waiters that both saw a stale lock could
  have the second remove the first's fresh one, leaving two holders; the steal now moves exactly one
  file and puts it back if it turns out to be fresh.
- **The secret store check resolves symlinks.** A store reached through a symlink into the team
  root passed as "outside" while every byte landed in the replicated tree.

## 0.9.25 — 2026-09-23

An audit pass over the whole codebase: every finding below was reproduced on the code before it was
fixed, and each has a test that fails on 0.9.24.

- **Security: a queue role could name a path.** `hub_queue_send` used the role verbatim in
  `queues/<role>.<node>.queue.md`, so `role: "../../x"` wrote `x.<node>.queue.md` two directories
  above the hub — over the HTTP transport, anywhere the server user can write, from any tenant.
  Role and subscriber names are now checked before any disk access (letters, digits, `-`, `_`;
  subscribers may also carry `.`), and refused rather than rewritten.
- **Security: over HTTP, a caller's `cwd` was resolved against the server's disk.** `hub_context`
  looked for a `.hubd` marker and a git root under whatever path it was given and, through
  `claimsTouched`, listed recently modified files there; `hub_claim_check` and `hub_presence` did
  the same, and the audit riding on `hub_brief` ran `git log` in a card's `- path:`, which a tenant
  writes. The HTTP transport now sets `local: false` on every call (a caller cannot override it),
  and those tools answer from hub data only, saying what they did not check.
- **Security: the multi-tenant board showed the operator's `AGENTS.md`** to every tenant that had
  not written its own, through the team-root fallback. A tenant now sees its own rules or none.
- **`hub whereami` ran the marker's inventory script through a shell**, quoted with JSON double
  quotes, inside which a shell still expands `$(...)`. It is executed directly now.
- **`hub_section_add` was the one card write with no size cap.** 0.9.23 rotated over-long sections
  on report, sync and card-set; a section fed only through here grew without bound. It rotates too.
- **History files in a shared hub were created owner-only.** `projects/history/<slug>.md` is
  appended by whoever writes the card; the first writer left it `rw-r--r--`, and the next user's
  card write then failed on the history step before saving the card — the maple-98 class, in
  one more place. All history appends (and absorbed files) now go through the same group-bit rule.
- **`DECIDE: a | b | c` lost `c`** from both the card and the journal: the split kept two parts.
- **A claim written without `ttlMin` crashed the next conflicting claim** after saving it
  (`Invalid Date`), and printed `NaNm left` in `hub brief`.
- **`hub_get`'s truncation note read `card: undefined shown, undefined hidden`** when the card
  string was cut; it now says how many characters were shown and hidden.
- `hub doctor`'s torn-write line described a 200-line window the check no longer uses.
- Refactors, behaviour unchanged except that a task with no `created` stamp now sorts the same way
  in `hub_brief` and the kanban as it already did in `hub_next`: one urgency sort instead of three copies, one reader for the
  shipped protocol, one digest-size refusal, one tail reader and role-file matcher in the queue
  module, and the node-name rules shared between the mesh check and the log readers.

## 0.9.24 — 2026-09-23

- **The queue depth a send reports now knows what it can mean on this node.** 0.9.21 added the depth
  so a sender could see a backlog instead of trusting "sent"; it read that depth against a cursor
  that is node-local by design, and then said "nothing is consuming" about it. For a role consumed
  on another machine — most sends in a fleet — that accusation is simply wrong, and caught it on its
  first real use: a send to an orchestrator read as 172 unconsumed messages while its consumer was
  working normally one node away. A role this node really does consume still gets the warning; a
  role it has never consumed gets the fact instead — this is the only view this machine can have,
  check on the node that runs it. The reply carries `consumedHere` so the distinction is machine
  readable, not only in prose.

## 0.9.23 — 2026-09-23

- **A card is a snapshot, and hubd now holds it to that.** "3-6 lines of current state" was in
  `hub_card_set`'s own description and held for nobody: one hub reached 41 cards with three past
  72 KB and one past 250 KB, and `hub_get` on the largest returned 72444 characters that the
  caller's context refused — the tool could not deliver its own data (task maple-111). The
  growth was not where it looked: every digest was fine at 1.7-3.6 KB, and the bulk was
  `## Facts & hypotheses` at 47, 63 and 231 KB, written one `- fact:` line at a time by
  `hub_report` with nothing to rotate it, so a cap on the digest alone would have changed nothing.
  Now: an accumulating section that outgrows `card.sectionBytes` has its OLDEST entries moved to
  `projects/history/<slug>.md`, and the card keeps the recent ones plus a line saying where the
  rest went. Moved, never trimmed — `DECIDE:` is journaled but `FACT:`, `HYPO:` and `COMM:` are
  not, so the card is their only copy and dropping the tail would destroy it. Enforced on WRITE,
  because a card allowed to grow on one node arrives over-sized on every peer; a card holding
  conflict markers is left alone, since resolving it is a human's call. A digest over
  `card.digestBytes` is refused, and so is an `appendLine` that starts with a date — that is an
  event, and the refusal names `hub_report`, which writes the card section and the journal both.
  Limits are the hub's, in `limits.json`, not constants in the code.
- **`hub_get` can no longer become unreadable.** The output budget only ever shrank arrays, and a
  card is one string field — so the largest payload in the answer was the one thing it could not
  cut. It now trims long strings too, from the head (where the digest and the next step are), and
  reports `shownChars` / `hiddenChars` with how to read the rest. The 257 KB card that started
  this returns an 18 KB reply.
- **`hub cards compact`** brings a hub that grew before the limits existed back under them. Dry by
  default: which section of which card loses how much, and where it goes. On the hub it was
  written for, six cards went from 257/86/72 KB to 22/22/32 KB with every line accounted for.

## 0.9.22 — 2026-09-14

- **`hub doctor` names the peers that have stopped appearing in the mesh.** Found by running the
  0.9.21 checks across the fleet: one node had been 77 commits behind for hours because a single
  card conflict aborted every pull. Its own doctor said so precisely — and nobody runs another
  machine's doctor. From any other node the evidence was already in the shared history and unread:
  mesh-sync commits as the node it runs on, so a peer that stops pushing stops appearing. Only real
  participants are judged (a node that never committed here is an absorbed log or a legacy name, not
  a machine gone quiet), and only while the mesh itself is moving, so a week nobody worked does not
  light up every row. Hostname case is matched across the two spellings mesh-sync and the file names
  use.

## 0.9.21 — 2026-09-14

- **A broadcast role no longer reports a "pending" that is true for nobody.** Every reader of a
  fan-out role keeps its own cursor, so the shared one is never advanced and the arithmetic against
  it only climbs. `hub queue status` printed that number as the headline, and it was quoted as
  evidence of a delivery failure — about a project head that had been working all day, while the
  real stall was on another node entirely (task maple-98). `hub_brief` had refused to print it
  since 0.9.5; the ledger now agrees: readers with how far each is behind, the shared-cursor
  arithmetic kept as `sharedCursorPending` for forensics only.

## 0.9.20 — 2026-09-14

One theme: a hub that cannot do its job must say so, instead of looking idle.

- **A queue cursor that cannot be written no longer reads as an empty queue.** Measured across four
  live fleet roles: 12, 27 and 43 KB of orders undelivered for a day, while every wait answered
  NO_CHANGES, every send answered "delivered", and every role logged "queue empty" (task
  maple-98). Delivery advances a per-file byte cursor; on a shared hub a command run by
  another user leaves that cursor owned by them, and `drainFile` caught the resulting EACCES the
  same way it caught a busy lock — the one error where "skip this poll, retry next" is right. Now
  only a contended lock is transient: anything else raises `QueueStalled`, naming the file, what it
  costs and the command that fixes it. `queueWait` checks writability BEFORE it blocks, so the stall
  is reported while the queue is still empty rather than discovered by the message that gets lost;
  one broken cursor no longer hides the roles that are fine (they deliver, with `stalled` alongside);
  `hub doctor` lists such cursors first among the queue checks; and `hub_queue_send` returns the
  depth now waiting, so a sender sees a backlog that is climbing instead of trusting "sent".
  The request in the task — drain the backlog before entering the long-poll — was already the
  behaviour since the first release; it was never the cause.
- **In a shared hub, a file hubd creates is writable by the group that shares the directory.** This
  is the same failure at its source. The node that proved it ran the role as `freebsd` while the
  cursor had been created by `agent` with the default umask — and neither user could repair it,
  because `chmod` requires ownership. Now every file hubd writes into a group-writable directory
  (queue files, cursors, waiter markers, the journal, task events, usage, anything through
  `atomicWrite`) gets group read/write. A directory without group write is a private hub and is left
  exactly as the umask made it, which is every single-user install.
- **A waiter marker whose process is gone is cleared.** The `finally` that removes it only runs on a
  clean exit, so every killed session left one behind; six were found on two nodes, each making the
  next waiter report a conflict that did not exist.
- **`hub freeze "<why>" --by <you>` / `hub unfreeze`.** Every dangerous operation on a hub directory
  starts with "stop the sync first", which meant remembering which of launchd, cron or a systemd
  timer this node uses, under time pressure — twice it was not remembered. The marker is node-local
  and gitignored (a mesh-wide freeze would have to travel by the sync it just stopped). `hub doctor`
  states the freeze, and calls it a warning after six hours, because a freeze somebody forgot is a
  node that silently stopped syncing.
- **mesh-sync keeps a shared hub writable, and refuses a deleted log.** On a fleet node the sync runs
  as root and the roles run as someone else, so every directory a pull creates locks them out — the
  source of the stall above. After any pull that changed something, group write is restored over a
  hub that is itself group-writable; a private hub is untouched. And the append-only guard now covers
  deletion: it read diffs, and a file that is gone has no diff, so removing `journal.<node>.jsonl` or
  a queue file passed straight through to every peer (exit 4, naming `hub queue gc --apply` as the
  way to retire a queue properly).
- **A heartbeat records which hub it was written into**, resolved through symlinks. Two roles on one
  machine writing into two hubs was invisible for a day, twice (tasks maple-88, -96), and was
  found by a human comparing directories. `hub presence` now flags an agent on this node whose
  records go elsewhere; records from other nodes are not flagged, since every node legitimately has
  its own path. `hub doctor` and `hub_whatsnew` also report a hub directory this process cannot write
  — the condition under which everything reads healthy and nothing you write is kept.

## 0.9.19 — 2026-09-12

- **`hub absorb` is all-or-nothing.** Its first field run stopped half-way with `EACCES`: the
  `absorbed/` directory had arrived on that node through a root `git pull`, without group write,
  so the logs were already on disk when the queue copies failed — and the label then counted as
  used while the manifest and the queue history were missing. Every directory to be written is now
  probed for write access first, the logs are written last, and a failure removes everything the
  run created before surfacing, so the same label works again once the permission is fixed. The
  error says what to fix.

## 0.9.18 — 2026-09-12

- **`hub absorb <dir> --as <label>` — a hub base written in isolation joins this one as a new
  node.** The sequel to 0.9.17: for a day the fleet's roles wrote to a private `~/.hubd` (23
  tasks, ~190 journal entries, 8 queue files) while the shared base carried on, and the two now
  had to become one (task maple-96). Copying by hand fails twice over: the private
  `pine-1..23` collide with the shared `pine-1..23` (the fold would remap the newcomers to
  bare numbers, and every "see pine-4" in their reports would point at a stranger's task), and
  a copied queue file is re-delivered wholesale to the live waiter on that role. So the isolated
  base is absorbed as a NEW node — the model the fold already has: its logs become
  `tasks.<label>.events.jsonl`, `journal.<label>.jsonl`, `usage.<label>.jsonl`, and every id it
  minted is renamed `<label>-<n>` (own number kept) in every field and every text of the copies —
  events, journal, queue blocks, cards. Queue history is kept under `absorbed/<label>/queues/`
  with the delivered offset recorded, never placed where a waiter would read it; blocks nobody
  read are listed so the operator re-sends them on purpose. Cards and resources whose slug already
  exists are kept aside verbatim (two digests a day apart are not a list to union); new slugs
  join. Presence, cursors, claims, the task cache and `HUBD.md` are named as not absorbed. Dry run
  by default; `--apply --by <you>` writes only new files (the mesh-sync guard watches removed
  lines, never new files), rebuilds the fold, reports how many absorbed tasks are visible, and
  journals the absorb under the author; a manifest with the full id map sits next to the copies.
  Refuses while a waiter pid recorded in the source is alive, when the source is itself a git
  repository (a mesh node syncs, it is not absorbed), when the label is already a node here, and
  when it would overwrite anything. CLI only: it reads another directory on the server's disk,
  the class of tool that stays off the network transport.

## 0.9.17 — 2026-09-11

- **`HUBD_TEAM_DIR` names the whole hub, not just the queues.** The variable moved only the team
  root (queues, `AGENTS.md`), and the MCP server ignored it even for those, writing queues under
  the hub base. A fleet that set `HUBD_TEAM_DIR=/srv/team/hub` for every role therefore had the
  roles' heartbeats, reports and eleven unread escalations in each role's own `~/.hubd` for a day,
  while the orchestrator read `/srv/team/hub` and concluded no role was alive (task
  maple-88). Now: `HUBD_DIR` wins when set; otherwise `HUBD_TEAM_DIR` (or the legacy
  `HUBD_QUEUE_DIR`) is the hub base as well, so one variable means one directory. The stdio server
  resolves its team root exactly as the CLI does (env first, then the base; no cwd walk-up, the
  client owns the cwd); over HTTP the tenant directory stays the whole world. `hub doctor` prints
  `hub base: <path> (via env HUBD_DIR | env HUBD_TEAM_DIR | default)` so a misrouted role is one
  line to diagnose, and the team-root note explains the split instead of only naming it. Smoke
  cases: CLI doctor and task under `HUBD_TEAM_DIR` alone, both set (`HUBD_DIR` wins), and an MCP
  server declared with `HUBD_TEAM_DIR` alone landing heartbeat, queue message and report there.

## 0.9.16 — 2026-09-11

- **`hub whereami` — state, not narrative, for the shell.** A compaction hands an agent a summary
  of what happened; work resumes from what exists, and one session re-discovered its own committed
  finding and re-wrote a script that already sat untracked (task maple-74). `hub whereami
  [cwd] [--json]` prints everything `hub_context` returns (project, digest with age and
  staleness, open tasks, claims, who else is heartbeating under this root, `claimsTouched`, the
  journal tail) plus the git inventory: recent commit subjects, diff stat, untracked files with
  their first line, files changed in the last half hour. The `.hubd` marker's optional second
  line names a project-local inventory script, run last with its output capped — project registers
  stay in the project. Read-only, no network, under three seconds. `prompts/client-hooks.md`
  (renamed from `claim-check-hooks.md`) carries the Claude Code `SessionStart`/`PostCompact`
  recipe and the honest table for the other clients; the protocol's "Recovering after
  compaction" names it as the first step.
- **A claim can now warn before the edit.** `area` was free text and nothing told an agent that the
  file it had just opened was somebody's declared zone; two sessions edited one checkout and the
  conflict was avoided by luck (task maple-79). An area is read as a path glob relative to
  the project root — `src/**/*.ts`, `docs/{a,b}.md`, a bare directory, several joined with ` + ` —
  and the claim reply says `matchable`; prose stays legal and is flagged. `hub claim check <path>
  [-p proj] [--agent you]` exits 0 when free or your own, 1 with one line per holder otherwise;
  `hub_claim_check({path, agent})` is the tool form, returning holders, `mine`, and the prose
  claims it could not test (`unmatchable`), never silently ignoring them. `hub_context` gained
  `claimsTouched`: live claims of other agents whose glob covers a file changed in this checkout
  in the last 30 minutes (`agent`, `recentMinutes`), bounded so a monorepo does not turn "where am
  I" into a census. `prompts/client-hooks.md` carries the Claude Code `PreToolUse` recipe and
  an honest table for the other clients (unknown, prose fallback) — the hook informs, it never
  blocks, because the lock is soft by constitution.
- **`hub audit` sees the end-of-session dump.** Two days of audit work, dozens of findings, not one
  journal line until the third morning — not laziness but ritual: the protocol said "one report at
  session end" and fleet sessions compact rather than end (task maple-80). Two checks, both
  thermometers that block nothing: `report-at-end-only` — an agent's structured entries for a day all
  within two minutes at the END of a trace at least thirty minutes long, the trace being every
  timestamp the hub holds for that agent that day (journal lines of any kind, tasks created, claims
  taken, its presence record); and `work-without-journal` — a card's local `- path:` checkout gained
  five or more commits in the window while the project's journal gained nothing (only where the
  checkout exists on this node; `git:false` skips it). Both quote their law from `rules.json → laws`
  or the engine default, file one keyed incident under `--apply`, and ride into the `review` block
  of `hub_brief`/`hub_whatsnew` like every other kind. Heartbeats keep no history, so a session is
  approximated by the calendar day — the audit notes and `hub lint` say so instead of implying a
  precision the check does not have.
- **Three places the hub spent an agent's context on nothing** (task maple-83). A `resource
  set` that changes nothing no longer writes a journal line or rewrites the card (the same resource
  was "set" twice in ten hours with identical content, and both lines sat in the next agent's
  `hub_whatsnew` next to two real entries). Identical journal entries — same kind, project, author
  and text — fold into one with `times` and `firstTs` in `hub_whatsnew` and `hub_brief`.
  `hub_task_add` replies `{ok, id, project, importance, cat, textPreview}` instead of echoing the
  2-3 KB the caller just wrote (`verbose:true` for the whole task; the engine's return is
  unchanged). `hub_onboarding` defaults to `mode:"short"` — the channel table, the author rule, the
  session ritual, the start of the recovery section and the list of every other section, under 600
  words, cut from the same file so it cannot drift; `mode:"full"` is the ~4000-word manual as
  before. The "`~ task → text` edited" lines the task also named were already gone: attribute
  maintenance stopped being journaled in 0.9.11.
- **`hub_whatsnew` was empty for the one return that matters in a fleet — after a context
  compaction — and the server told returning agents to call it.** Its checkpoint is "since my own
  last call"; after a compaction that is the same session, so everything it wrote itself lies before
  the checkpoint and the delta is zero on its own topic (task maple-84). Now `since` takes
  `"checkpoint"` (default), `"session"` — since this session began, own writes included; the start
  is the earlier of this key's first check-in and the author's first journal line today, because
  heartbeats keep no history — or an ISO time. A fresh checkpoint with an empty delta carries a
  `hint` naming `since:"session"` and `hub_context`. The server instructions and a new protocol
  section, "Recovering after compaction", say to read state first (`hub_context`, the card, the
  journal tail) and to write `FACT:` at the moment of the finding, not at a session end that a
  compacting session never reaches.
- **A digest could be patched only by rewriting it, so a stale line stayed stale; and nothing said
  so at the moment the facts were in hand.** A digest braids the owner's strategic frame with a few
  lines of fact; the facts went stale in a week and the agent who knew better left the whole text
  alone rather than rewrite the frame — `hub_context` kept handing the next session a four-month-old
  state (task maple-81). `hub_card_set` now patches: `replace: [{from, to}]` swaps exact
  substrings (each must occur exactly once — absent or ambiguous is an error, never a silent no-op)
  and `appendLine` adds one line; `hub card <slug> --replace "<old>" --with "<new>"
  [--append-line …]` on the CLI. And `hub_report` — the one call every session makes with fresh
  facts — returns `digestAgeDays`, plus `digestStale` and a `hint` naming the last set date and
  the patch route once the digest trails the project's journal (`staleDays`, default 7),
  measured after the report's own write. The `- set: <ts> by <who>` line the engine already
  stamps is the digest's "as of"; no second date field was added.
- **`hub_context` is now a "where am I", not just a slug lookup.** The protocol names it the first
  call of a session, and it was the one read that never warned: it returned a digest four months
  behind the project's own journal with no date and no flag, said nothing about the other
  session editing the same checkout, and told a guessed project nothing about how to make it
  certain (task maple-78). It now returns `digestSetAt`, `digestSetBy`, `digestAgeDays` and
  the same `digestStale` verdict `hub_status` gives (`staleDays`, default 7); `presenceHere` —
  live heartbeats whose cwd is this root or under it; `journalTail` — the project's last few
  entries (`journalTail`, default 5); and, when the project was guessed from the folder name, a
  `hint` with the one-line `.hubd` fix. `hub_presence` gained `cwd` and `project` filters that use
  the same predicates, so the two tools cannot name different people.
- **`hub_recall` scored stop-words and matched inside words; neither it nor `hub_whatsnew` could be
  narrowed to a project.** "IMM not established attention overlap" returned eight hits and none
  from the project the question was about: the first scored on "not" and "overlap", two more on
  "not" and an `imm` found inside "committing", five on "not" alone; `hub_whatsnew` in the same
  session returned six entries from three other projects (task maple-77). Now a small
  RU+EN stop-list is dropped from the terms and listed back as `dropped` (a query made only of
  stop-words is refused, naming them); a term matches at the start of a word — `imm` → IMM,
  IMM's, immediately — never inside one; and both tools take `project` (a slug or a
  comma-separated few). The implicit ×1.5 boost for the caller's last `hub_context` project is
  not done: `hub_context` does not know who is calling, and guessing would be a fourth silent
  attribution path. Pass `project`.
- **`hub_search` trimmed its hits without saying so, and `full:true` could not undo it.** The
  engine sliced to 40 before the server's output cap ran, so the cap saw a list already at its
  limit, wrote no `truncated`, and had nothing to restore: 106 matches came back as 42 with no
  sign of the other 64 (task maple-82). The engine now returns every hit; the per-tool
  plan in the server is the one place that trims, and it reports `truncated {hits: {shown,
  hidden}}` with the `full:true` hint like every other list tool.
- **`hub_report` signed an explicit author's work with the `HUBD_AGENT` floor.** Tools read the
  author under three synonyms — `agent`, `by`, `from` — and the MCP server filled every empty one
  from `HUBD_AGENT`. `hub_report` reads `by ?? agent`, so `hub_report({agent: "doc-auditor@…"})`
  left `by` empty, the floor filled it, and the floor won: three decisions and a `done` landed in
  the append-only journal under `owner-desk-<session>`, one minute after `hub_task_add` with the
  same name under `by` was attributed correctly (task maple-75). Now an author named under
  ANY of the three fills the other two; the floor only fills a call that named nobody. Covered by
  the attribution block in `tests/smoke_mcp.sh`, which fails on the old server.
- **`NEXT:` wiped the owner's next step and said nothing.** A side session's one-line `NEXT:`
  replaced a step the owner had written in a card; the reply was `{next: true}`, and the old text
  survived only in the journal (task maple-76). Replacement is by design — one concrete
  step — but silent replacement is a lost decision. Now the step is stamped `— set <ts> by <who>`;
  the replaced step stays as one dated `prev (<ts>, by <who>): …` line (one, not a history); the
  reply carries `nextReplaced {text, by, at}`, and the CLI prints it; and a step set by an owner
  role (`owner-roles.json`) is not replaced by a non-owner — the report is refused with the step's
  text unless `force:true` (`--force`). Owners replace anything without force. Steps written
  before the stamp existed are still reported as replaced, just without an owner check.
- **`hub queue send` delivered the name of a flag instead of the message.** The body was read
  as `args[3]`, blindly. `hub queue send hv --from bzdos "text"` delivered a block whose body was
  the word `--from`; `--text "..."` delivered `--text`; `--agent hv "..."` delivered `--agent` —
  and each reported success, so the sender saw a delivery and the receiver got a placeholder.
  Measured on three roles and two nodes (task maple-63); two orchestrators had already
  declared the queue channel unreliable and started duplicating everything into the journal.
  Now positional arguments are collected with every flag and its value skipped wherever they
  sit; `--text "<text>"` is accepted for bodies that begin with `-`; `-` as the text reads the
  body from stdin (`hub queue send hv - --from x < file`); `--agent` is accepted as the sender.
  A flag the command does not know is an error, not a guess — guessing whether an unknown flag
  takes a value is how a body gets swallowed as one. Every refusal exits non-zero and writes
  nothing. `hub task add` takes its text through the same parser, so flag-first order works
  there too. Covered by `tests/smoke_cli.sh` case 12 (multiline, flag-first, `--text`, `--agent`,
  refusals, an 8 KB body with quotes and dollars arriving byte-for-byte).
- **`hub task add` filed a flag as a task.** `hub task add -p x --by y` created a task whose text
  was `-p`, and that task now sits in an append-only event log forever. The text is positional;
  a value starting with `-` in that slot is a misplaced argument and the command dies with usage
  before writing anything, the way `hub decide` and `hub task get` already did. Covered by
  `tests/smoke_cli.sh` case 11.

## 0.9.15 — 2026-09-10

- **A per-node file was travelling the mesh, and the code comment had said otherwise for
  releases.** `.checkins.json` holds each agent's `hub_whatsnew` checkpoint. `runWhatsNew`'s own
  comment described it as "gitignored, per-node like `.qstate/` — never mesh-synced, so it never
  merge-conflicts"; on the hub it was written against, the file was **tracked**. Every node's
  checkpoints travelled to every other node and overwrote them — plain JSON, no union rule, no
  merge driver. `ensureProtocol` now gitignores it (and `hub init` writes the entry), so the
  comment and the deployment agree. Losing a checkpoint costs one over-long `hub_whatsnew` window
  per agent, which is the cheapest failure available here.

  Found by adding a fourth node to a mesh: three writers had made the collision merely wrong, and
  a fourth made it worth fixing.

## 0.9.14 — 2026-09-10

- **0.9.13 reported two different gaps as one, and running it against the real mesh is what showed
  it.** A node that has published *no* registry is invisible from here — that is the state the 92
  hours consisted of. A node whose registry **is** here and was published a while ago is not
  invisible at all: its rows carry their own `last_seen` and are judged by their own `ttlMin`, so
  nothing they say is less true; what is missing is only heartbeats made *since*. And since a
  snapshot refreshes on heartbeat, an old one is exactly what a **quiet** node looks like — so
  0.9.13 flagged two idle machines as unseen ones, which is the same warning meaning two things
  that this release exists to stop.

  `blindTo` now means no registry at all and is the only one that warns. `laggingBehind` reports
  the age with what it actually costs the reader, as a statement rather than a flag.

## 0.9.13 — 2026-09-10

- **`hub_presence` answered a fleet question with one machine's answer, and never said so.** The
  same role read as **383 minutes** since heartbeat on one node and **8469 minutes — 5.9 days** on
  another. Nothing was stale and nothing had diverged. `presence/` is node-local by design (a file
  per agent, rewritten every few seconds; syncing it would turn every heartbeat in the fleet into
  pushed git history), the roles ran on one machine and the orchestrators on another, so the
  orchestrator was reading a neighbour's registry as if it were the fleet's. It escalated "worker
  is dead, cannot dispatch" **four times across 92 hours** while the worker was working.

  Two changes, and the second is why the first is not merely cosmetic:

  1. **Every row now says which node observed it** (`observedOn`), and `alsoOn` when one agent name
     turns up on several — a name used by more than one process is worth seeing, the same call the
     version-skew report makes.

  2. **`coverage`**, which is the part that was missing entirely. Every current mesh member is
     listed with the age of its published registry, or `snapshot: null` when it has none, plus
     `blindTo` and a `note` in as many words: *a role running there is invisible here, which is
     NOT the same as dead*. A role nobody reports was previously indistinguishable from a role that
     had died, and that indistinguishability is the entire 92 hours.

- **Each node publishes one snapshot of its own registry: `presence.<node>.json`.** A single small
  file, not the directory, so cross-node liveness costs one write per node per five minutes
  whatever the heartbeat rate. Two properties make this safe in a mesh where syncing `presence/`
  was not:

  - A node only ever writes the file bearing **its own name**, exactly like `journal.<node>.jsonl`
    and `tasks.<node>.events.jsonl`. Two nodes never touch one file, so there is nothing for a
    merge to resolve — no union rule needed and no conflict possible. `JOURNAL_NODE` is lowercased
    and sanitised at its source, so two nodes cannot mint names differing only in case either;
    that collision is what took one node out of this mesh for 246 commits.
  - The throttle is deliberately **shorter than the shortest `ttlMin`** in use (15 minutes by
    default). Longer, and a live agent could read as expired from another node — the same lie in a
    new place. Five minutes leaves 3× headroom. `HUBD_PRESENCE_SNAPSHOT_MS` overrides it.

  The `presence/` gitignore entry carries a trailing slash, which matches the **directory** only,
  so the snapshot beside it travels. `hub doctor` grew a `fleet:` line next to `writers:`: the same
  shape of question one layer up — that block says which hubd wrote here, this one says whose
  agents are observable from here.

- **Membership is no longer "ever wrote a journal".** That set never shrinks, and this hub's
  journals still carry three retired node names — one of them the same machine under an old
  hostname. Reporting six blind spots where there are two is how a warning teaches its reader to
  skip it. A member is a node that has written within `memberDays` (30); a retired one drops off on
  its own. `writerVersions()` gained `lastWrite`, the newest entry of any kind, because `lastAt`
  can only see version-stamped ones — a node still running a pre-0.9.4 hubd reported `lastAt: null`
  and read as one that had never written at all.

- **The other two thirds of that report had already fixed themselves, and saying so is the finding.**
  It also measured tasks not replicating (a task created on one node absent from the other two an
  hour later) and one queue shard living at two different sizes under one name. Re-measured across
  all three nodes: `tasks.<node>.events.jsonl` identical to the byte, and both named shards
  identical on all three — 11554 B / 8 blocks and 808603 B / 1650 blocks. The measurements were
  dated one day before the mesh work in 0.9.5–0.9.11 landed: a node 246 commits behind that could
  not merge at all (queue files differing only in case, on a case-insensitive filesystem), and an
  origin that was a working copy rather than a bare mirror. What looked like three defects in
  replication was two symptoms of one stalled mesh, plus one reporting bug that had nothing to do
  with replication.

## 0.9.12 — 2026-09-09

- **The version-skew warning named a cause it could not observe, and the cause was wrong on this
  hub.** `hub doctor` reported "0.9.10 and 0.9.11 both writing recently — two installs on one node"
  and told the reader to check before upgrading. There was one install. The resident MCP server had
  imported `core.mjs` while `VERSION` still read 0.9.10 and went on writing 0.9.10 while a freshly
  spawned CLI wrote 0.9.11 out of the same file — upgrading a package on disk does not reach a
  process that already imported it, and no amount of `npm ls -g` would have shown that.

  The interleaving detection was right and is unchanged. What it prints now is the **agent names
  per version**, which turns an unanswerable question ("where is the second install?") into an
  addressable one ("these agents hold the older module — restart their clients"). An agent
  appearing under both versions is reported as such rather than smoothed away: it means that name
  is used by more than one process, which is itself the thing worth seeing.

- **The audit now rides on traffic it does not generate.** `roles/auditor.md` has existed for
  months and has never been run once; `hub_lint` and `hub_audit` both work and nothing calls them,
  because calling them is a separate decision somebody has to remember to make — and the whole
  class of thing they catch is the class nobody remembers. `hub_brief` and `hub_whatsnew` now carry
  a `review` block: the top findings from both, **one per kind**, each quoting the rule it enforces
  with the date that rule was written. A plain top-3 filled itself with three copies of one rule
  and pushed two other kinds of problem off the list, so each kind appears once with its remaining
  count beside it.

  What this deliberately does **not** do is file anything. The spec asked for a finding older than
  seven days to be applied automatically under the author `auditor-ambient`. That is an agent
  writing a record claiming a verdict nobody reached — the same move as "acknowledged in version X"
  that this project bans in so many words. A finding that has sat for a week is not thereby
  decided. `hub audit --apply` still files, from an explicit call, with the caller's name on it.

- **Two new lint checks, from measuring the cards rather than judging them.** Three of thirty-nine
  cards on the live hub had no `- synced:`/`- set:` line, and every freshness check in the engine —
  `hub_status`'s `digestStale`, `hub_brief`'s `staleDigests`, the audit's `card-behind-journal` —
  silently **skips** a card that has none. Two of those three were substantial: 55 and 60 lines,
  nine sections, real content no check had ever looked at. A card that reads perfectly to a person
  and is invisible to the instrument is the worst of the two states, because nothing says so.
  `card-without-digest` says so. `card-empty` is kept separate for the degenerate case (one card
  was a title and nothing else): "write the card" and "stamp the card you already wrote" are not
  the same job.

- **The buttons that were rotting were not in the queue.** The spec was aimed at the owner queue —
  items sent to a human, waiting weeks. Measured, that queue was empty: read to the byte, cursor
  offsets equal to file size. What had actually rotted was the other surface entirely — **31 of 143
  open tasks belonged to the owner, the oldest 80 days, four of them past deadlines that fell 15
  days earlier**. The queue was read; the decisions were never made.

  `ownerWaiting()` reports them with age and how far past deadline, `hub brief` prints them, and
  the audit files **one** rollup finding rather than thirty-one — a backlog about a backlog is
  addressed to the same person it would be shouting at. A task with no `created` stamp is counted
  but its age reported as unknown; guessing zero would make the oldest backlog look like the
  freshest.

- **`ownerQueueItems()`: what is waiting, not how many bytes.** The old rollup answered "6 waiting,
  oldest 61 days" — right and useless, because finding out *what* meant opening the file and
  scrolling past two months of blocks, which is the friction that let them rot. One row per pending
  block now, with age, sender and the block's first line (the subject every sender in this hub
  already writes). No format is enforced and nothing is asked of senders; the existing convention
  is simply read. Pure read: no cursor moves, because looking at a queue must not consume it.

  Also refused here: the spec wanted `hub_queue_send` to **reject** owner items lacking `proposal`
  and `default_on_silence`, and a sweep inside `hub_brief` to **execute** that default —
  hibernate, kill, defer — once an expiry passed. Executing a default on silence is hubd deciding
  the owner's work for them because they did not answer fast enough. Silence is not consent. The
  hard refusal would also have broken every existing sender in the fleet at once, to enforce a
  field shape never written down anywhere those senders can read.

- **`hub doctor`'s stranded-queue number covered two unrelated situations and read as the alarming
  one.** "2811 messages in 45 queues nothing here has taken" sounds like 2811 dropped pieces of
  work. 2718 of them were in queues written to **within the day**, which a dead role does not do —
  and cursors and presence are node-local, so a queue fed here and drained on Pine looks
  identical from this machine to one addressed to nobody. The caveat saying so was one line under a
  truncated list, after the total.

  Split now on the only locally available evidence — is anything still arriving. Queues that have
  gone quiet with work still in them are the decidable list, **printed whole** (it was that tail
  which used to be truncated, exactly backwards): 93 messages in 24 queues. Still-fed queues are
  reported as unverifiable from here, not as backlog.

- **`hub audit` no longer reads a year of journal to answer nothing.** The gate-expired check needs
  the last decision per project, and consults it only for projects declared as money bets in
  `rules.json → money`, which is empty until somebody declares one. On an undeclared hub that scan
  was 460ms of a 472ms run and answered no question at all. That became load-bearing the moment
  the audit started riding on `hub_brief`: the price of a check that checks nothing is paid by
  every call that carries it.

## 0.9.11 — 2026-09-09

- **The journal is the owner's memory prosthesis, and it was half machine echo.** Measured on a
  live hub: 2642 entries, **1211 of them task echo**, and 725 came from one line in
  `runTaskUpdate` — `~ task #pine-66 -> @opencode-bsdos`, `~ task #pine-65 -> done`. Every
  field of that line already exists in `tasks.<node>.events.jsonl` at full fidelity, which is where
  a machine looks anyway.

  Attribute maintenance no longer reaches the journal: text fixes, tags, deps, resources,
  importance, dates, and the bare `edited` that said nothing at all. Who holds a task and what
  state it is in still does — an assignment is the single most useful event in a coordination log,
  and it was 33 of those 725 lines, not the bulk.

- **A closure is narrative, so it was promoted rather than dropped.** The spec this came from asked
  for `kind: task` to disappear from the journal entirely, on the assumption that closures are
  already recorded as `kind: done` by `hub_report`. That assumption is false for the CLI path: of
  467 `-> done` echoes on the live hub, **83 were the only journal trace that the task had ever
  been closed**. Deleting them to remove noise would have erased 83 closures from the readable
  record.

  Closing now writes a `done` entry carrying the task's text — what a person scanning the month
  actually needs — and the echo line is not written alongside it, so a close is recorded once.

- **Two thirds of that spec turned out to be unnecessary, and saying so is part of the change.**
  It also asked for deduplication of identical adjacent events within 60s, and for `hub_recall` to
  ignore echo. On the live data there were **zero** identical adjacent entries — 0.9.3's read-side
  dedup already drops byte-identical lines — while 264 pairs were identical *modulo the task id*,
  which no exact-match dedup would ever catch. Removing the echo at the write side deletes that
  whole category instead. And recall already ranks every journal line below every card and
  decision; excluding what survives the cut would remove signal, not noise.

  Its proposed allowlist (`done/note/decision/blocked/sync`) would also have silently stopped
  journaling five real narrative kinds that exist in the data: `resource`, `insight`, `reflection`,
  `ship`, `broken`. A denylist of echo is the right shape — a new narrative kind is then recorded by
  default.

## 0.9.10 — 2026-09-09

- **`hub doctor` looks for conflict markers in queue files too, and names the right
  remedy per kind.** Queues were missing from that check for three releases, and
  they are the worse case: a card is only *read*, a queue is *delivered*. On one
  mesh 83 marker lines turned out to be committed as content across eight queue
  files — 57 in a single file — and every one had been handed to a worker as the
  text of a message. They got there the ordinary way: an earlier merge was resolved
  by hand, incompletely, and committed, after which each new merge nested markers
  inside the leftovers (`<<<<<<<` with no `=======`, two `=======` in a row).

  The remedy differs, so it is named per kind rather than once: `hub card resolve`
  unions list hunks and refuses prose, `hub queue resolve` unions blocks and
  appends. Sending a reader to the wrong one is the same class of mistake as the
  "upgrade that node" line 0.9.7 removed. `hub card resolve` also stops picking up
  queue files, which it could never have resolved.

  The queue root is passed in rather than resolved inside `core`: the team root can
  differ from the hub base, and the resolver for it lives in `queue.mjs`, which
  imports `core`.

- **A commit-message gate, because the publish gate cannot catch the commit that
  breaks it.** `tests/check_clean.sh` scans the git log, and a message enters the
  log only after the commit exists — so a run that passes is honest and the very
  next commit can still poison it. Three commits did exactly that here, each
  ending with "Checked: check_clean PASS", each true, and together they blocked a
  release until the messages had to be rewritten with `commit-tree`.

  `sh tests/check_clean.sh --msg FILE` applies the same denylist to one message,
  and `.githooks/commit-msg` calls it. Enable once per clone with
  `git config core.hooksPath .githooks`. Rewriting an unpushed message is free;
  rewriting a pushed one is not, and a published one cannot be rewritten at all.

## 0.9.9 — 2026-09-07

- **A purged queue re-delivered everything that survived the purge.** Cursors are
  byte offsets, and a shrunken file reset its cursor to `0` — right for a file that
  was *recreated*, wrong for one that was *trimmed*. And trimming turns out to be
  routine, not aberrant: two commits on one mesh removed **15531** and **13422**
  lines of consumed messages, because those files had grown past fifteen thousand
  lines and hubd offers no operation for compacting them. So it happens with a shell
  redirect, and every surviving block was then delivered a second time, silently, to
  workers whose stated contract is at-most-once. On the hub this was found on, one
  cursor sat at byte 131043 of a 17651-byte file — one drain away from re-delivering
  the whole thing to nine subscribers.

  The cursor file now carries a **watermark**: the header of the last block
  delivered, on a second line. On a shrink it decides without needing to know what
  was removed — found in what remains, resume just past it; absent, it was purged
  along with everything before it, so every surviving block postdates it and `0` is
  genuinely correct. A file that was truly recreated lands in the same branch and
  wants the same answer.

  Format-compatible on purpose: every reader does `parseInt(trim(contents))`, and
  `parseInt` stops at the first non-digit, so an older hubd on the same node still
  reads the offset and ignores the rest. `.qstate` is node-local and gitignored, so
  none of this touches the mesh or the message format.

  A repeated header resolves to its **last** occurrence — timestamps are
  minute-resolution, so one sender can write two identical ones — erring toward
  delivering less rather than twice.

- **`hub doctor` names queue files trimmed outside hubd**, and says which of them
  will re-deliver. A cursor past the end of its file is direct evidence that the file
  lost content after that cursor last read it: no git, no heuristic, no false
  positives. Cursors written before this release have no watermark, so their
  behaviour is unchanged — `0`, because there is genuinely no information to do
  better with — but it is now disclosed instead of silent.

  The alternative check, comparing the node in each filename against the authors of
  its commits, does find real cross-node writes: on this mesh
  `chat.pine.queue.md` carried commits from three different nodes. But it also
  flags renamed files, nodes that are not in the git mesh at all, hostname case, and
  history that was already resolved — so it is a forensic tool, not a monitor, and it
  stays out of doctor.

- **`hub queue resolve` — block-level union for a conflicted queue.** Queue files
  are append-only by contract but have no union merge, so two sides that both
  appended really do conflict: one node came back after two days holding 49 local
  commits with five queue files conflicted at once, and every block on both sides
  was a message somebody had sent.

  Ours stays exactly where it is; blocks only the other side has are appended at
  the **end**. That is a better trade than the timestamp-ordered union this was
  first designed as, and the reason is cursors: they are byte offsets, so inserting
  a block anywhere before one silently moves it, and a ts-ordered merge would have
  to recompute every cursor in the hub — including the ones on other nodes that
  this one cannot see. Appending inserts nothing before anything, so every existing
  cursor stays as valid as it was. Strict time order is the cost, and it costs
  nothing: a reader walks forward from its cursor and every block carries its own
  timestamp.

  Deduplicated on the whole block, not the header — the same minute and sender can
  carry two different messages, and collapsing those would be losing work to save a
  line. A malformed hunk is counted and left untouched, and the command exits
  non-zero while any remain.

- **`merge=union` on queue files: considered and rejected**, with the reasoning
  written down in `docs/queue-invariant.md`. It would silence the conflict that
  exposed all of this, and it would destroy the byte-offset contract: union inserts
  the other side's lines mid-file, so every cursor past the insertion points
  somewhere else, and the result is skipped or duplicated messages with no error and
  no trace. Journals survive union because they are read whole and deduplicated; a
  queue is read incrementally by offset. A stopped sync is better than a wrong
  delivery.

## 0.9.8 — 2026-09-03

- **`hub queue send` reported success when there was nobody to deliver to, and
  nothing in the hub said otherwise.** A task dispatched to a role with no consumer
  running is accepted, written, and counted — and then simply sits. On one hub two
  roles were sent work twice in an afternoon; the only thing that ever noticed was a
  third agent writing `REPEATED ESCALATION` in prose, hours later. A send that
  cannot be delivered should not read like a send that was.

  `hub doctor` now reports queues holding messages that nothing has taken, with no
  agent present for the role. `queue gc`'s existing `ghost` predicate could not
  cover this: it requires 30 days of age, which is the right threshold for "archive
  this" and useless for "did anything happen". The two lists are complementary and
  never double-count — stranded is the fresh case, ghost is the old one.

  Owner queues are excluded. A human's queue waiting on a human is the system
  working; only an agent role with nobody home is a fault.

- **And the new line states its own scope, because the numbers diverge sharply.**
  Cursors live in `.qstate/` and presence in `presence/`, and neither is mesh-synced
  — deliberately, since three machines have three sets of readers. So the check can
  only say *nothing here has taken these, and no agent for the role is running
  here*, never *these were not delivered*. Measured on one mesh the same instant:
  **473 messages across 41 queues** looked untaken from a laptop that consumes
  almost nothing, and **53 across 18** from the node whose consumers actually hold
  the cursors. The laptop's number is not wrong, it is answering a narrower
  question, and the line says so rather than letting a reader assume the stronger
  claim.

## 0.9.7 — 2026-09-03

Three places where hubd said more than it had seen.

- **`hub doctor` no longer tells you to upgrade a node it cannot know is stale.**
  The version-skew line read `installed here is X - upgrade that node`, and it was
  wrong on a live hub the day it shipped: two nodes whose packages were *already*
  current had simply not written since, so doctor sent a human to go and upgrade
  what was done. From here, a node that upgraded and stayed quiet is
  indistinguishable from one that never upgraded. So the line now reports what the
  log says — `last wrote with X; this install is Y` — and states that caveat once,
  out loud, instead of guessing past it.

  The `ahead` direction keeps its verdict, because it is an observation and not an
  inference: a stamp newer than this build cannot be produced by anything but newer
  code, so *this copy is older than the mesh* is a fact.

- **A malformed log line that cannot be repaired no longer warns forever.** 0.9.3's
  own comment says a warning that can never be cleared is one a reader learns to
  skip — and then doctor was set to nag about two malformed journal lines with no
  legitimate repair: editing them rewrites an append-only log and trips the sync
  guard on every peer.

  The distinction that matters is not *malformed* but *still happening*. A torn
  write at the tail of a live log means a writer is failing now and someone should
  look. The same line with good entries appended after it is history. So
  `journalCounts()` reports `malformedRecent` and only that warns; old ones are
  stated with what a reader does about them (drops them) and why nothing else can
  be.

  The measure is how many good entries FOLLOW the line, not how far back it sits.
  A line count cannot tell the difference: the first cut of this used a fixed window
  of trailing lines and called two June-era lines at the head of a 58-line log
  "happening NOW", because the whole file fitted inside the window.

- **`scripts/mesh-sync.sh` bounds its network steps** (`HUBD_SYNC_TIMEOUT`, default
  300s). It runs unattended on a timer, and `BatchMode`/`ConnectTimeout` cover ssh
  but not git: a pull that blocks forever leaves a process nothing will ever clean
  up and no line in the log to say so. Hitting the cap is a failed run, which the
  next run retries — the same contract the script already had for a failed push.
  Hosts without `timeout` keep the old behaviour rather than gaining a new failure
  mode.

## 0.9.6 — 2026-09-02

0.9.5 could *report* the deadlock it found. This stops it happening again, and
gives the one file that can genuinely conflict a way to be resolved.

- **hubd no longer creates a second spelling of a queue file that already
  exists.** Both places a queue file comes into being — `queueSend`, and the
  `queueWait` that touches its own node's file so a fresh waiter has something to
  track — now go through `resolveQueueFile`, which writes to an existing
  case-variant instead of adding a rival one. Whichever spelling arrived first
  wins. That is arbitrary and harmless: readers match
  `<role>.<anything>.queue.md`, cursors are keyed by file name, and one file per
  role and node is the entire invariant.

  Note where this does work. On a case-insensitive filesystem the OS already
  collapses the two names, so nothing there can create the pair; the nodes that
  create it are the case-sensitive ones, which never feel the damage — it lands on
  whichever peer runs macOS or Windows. That asymmetry is why it went unnoticed
  for 228 commits, and why the check has to live on the write path rather than
  where it hurts.

  It also means an integration test cannot tell a working guard from a missing one
  on the machine these tests usually run on: delete the guard and every
  filesystem-level assertion still passes. So the decision is a pure function over
  a list of names (`pickExistingVariant`) and is tested as one.

- **`hub card resolve` — the one shared file in a hub that can conflict.**
  Everything else is per-node and append-only, so it cannot. A project card is a
  single mutable file that any node rewrites, and two nodes appending to the same
  section is a same-hunk change: three conflicts in one hour on one card.

  Bullet-list hunks are unioned, because two nodes appending facts have not
  disagreed about anything — both bullets are true and the conflict is an artefact
  of where they landed. Identical bullets collapse to one, the same reasoning as
  the log dedup. Prose hunks are left exactly as they are and named by section: if
  both sides rewrote a digest, one of them meant to replace the other, and picking
  would be inventing a decision nobody made. The command exits non-zero while
  anything is left, so a script cannot mistake a partial resolution for a finished
  one. A malformed hunk — no separator, no terminator — is never touched.

- **`hub doctor` reports cards that still hold conflict markers.** `<<<<<<<` in a
  card is not a broken file to a reader: it is content. `readCard` returns it,
  `digestOf` slices it, `hub_context` hands it to an agent, and the agent reads two
  contradictory versions of the project's state as though both were true. The mesh
  script aborts rather than leaving markers, deliberately — but an abort is not the
  only way a merge can end.

## 0.9.5 — 2026-09-02

Found by using 0.9.4's writer-version report on a live mesh, an hour after
publishing it.

- **One node had not received anyone else's work for 228 commits, and every
  report called the hub healthy.** Its sync ran on a 60-second timer: commit,
  pull, push. The pull failed, the job logged a line and exited non-zero, and a
  minute later it was restarted to fail identically. Meanwhile `hub status`,
  `hub brief` and `hub doctor` all read the local hub and found nothing wrong —
  correctly, from a copy that had quietly stopped being part of the mesh. A sync
  loop that keeps retrying is indistinguishable from a working one unless
  somebody counts the commits.

  `hub doctor` now counts them: `origin/<branch>: N behind, M ahead`, with a
  warning that this hub is not receiving the other nodes' work. Read from git,
  not from the sync log — the log says whatever the script decided to say, and
  here the script's own diagnosis was wrong. The log's last complaint is quoted
  underneath, as a human's clue rather than as the verdict.

- **The cause: two tracked paths differing only by case.** Queue files used to be
  named from the raw hostname while journals went through `HUBD_NODE`, which
  lowercases. Unifying them was correct, and the safety argument at the time was
  right too — readers match `<role>.<anything>.queue.md`, so nothing written
  under the old name is stranded. What nobody examined was what *two spellings of
  one node* mean to a case-insensitive filesystem three nodes away. Six pairs had
  accumulated, e.g. `queues/hv.Pine.queue.md` and `queues/hv.pine.queue.md`.

  On macOS or Windows the pair is **one file for two index entries**. Git maps the
  file on disk to one of them; the other can never be satisfied. `git add -A`
  stages nothing, `git commit` reports an empty commit, and any merge that has to
  write the unsatisfiable path refuses — so the "resolve by hand" the sync kept
  printing was not merely unclear advice, it was impossible advice. `hub doctor`
  now names each pair and says plainly that no local commit can clear it: one of
  the two has to leave the mesh.

  The check reads the **remote's** tree as well as the local index, because the
  pair that blocks a pull usually arrived from another node and is not tracked
  here yet. Looking only at your own index finds nothing wrong with a hub that
  cannot sync — which is exactly the state this was found in.

- **`scripts/mesh-sync.sh` no longer misnames its own failure** (new exit 5). It
  had one message for every kind of pull failure: `(real content conflict) —
  resolve by hand`. That was wrong twice. Once for a missing git identity, where
  the fix went into the code and the message was left saying the same wrong thing.
  And once here, where git refuses *before* merging and no conflict exists at all.
  Exit 5 is now "refused before merging, nothing conflicted", exit 2 stays for a
  genuine content clash, and git's own output is printed instead of swallowed.

- First tests for `mesh-sync.sh` (13 assertions), covering all four exits and
  including a from-scratch reproduction of the case-collision deadlock. They skip
  themselves on a case-sensitive filesystem, where it cannot happen.

## 0.9.4 — 2026-09-02

- **`hub version` — the tool could not say what version it was.** No `version`
  command, no `--version`, no `-v`; the only way to find out was `npm ls -g`. That
  omission had a price. On the machine that develops hubd, the global `hub` on
  `PATH` sat **nine releases behind** for weeks — 0.4.8 against a 0.9.3 source
  checkout — while the MCP server ran from the checkout and everything appeared to
  work. It is this project's own thesis pointed back at it: not a crash, an answer,
  given confidently by code too old to know what it was answering.

  `hub version` prints the number **and the path of the copy that printed it**,
  because on a real machine those are one question — a stale global install and a
  live checkout are both called `hub`, and they answer differently. It is handled
  before any other work, so asking a possibly-wrong install what it is never writes
  anything.

- **Every journal line now carries the hubd that appended it.** `journalAppend`
  stamps `v`. The log is the only place a version can be observed across the mesh:
  `presence/` is node-local and never synced, so it can only ever describe the
  machine already asking, while every node reads every other node's journal. Same
  rule as `HUBD.md` and `tasks.json` one level down — a written artifact names the
  code that produced it. An entry that already carries a `v` keeps it, so a relayed
  line still describes its origin.

- **`hub doctor` reports writer versions, in both directions.** Which node wrote
  with which hubd; which nodes are **behind** this install; and — the case that
  matters more — whether a node wrote with something **newer**, meaning *this* copy
  is the stale one. A stale reader is exactly the reader that cannot be relied on to
  notice anything else.

  It also names two installs writing into one node's log, which is the shape the
  0.4.8 incident actually had. The test is *interleaving*, not "more than one version
  present": an ordinary upgrade also puts two versions in a log but partitions them
  (every old line, then every new one), whereas two installs running side by side
  keep taking turns. Bounded to a node's last 50 stamped entries, because the claim
  is about the present and a warning that can never be cleared is one a reader learns
  to skip.

  The record necessarily starts empty, and doctor says so — `no version stamps yet`
  — rather than printing a reassuring nothing. Pre-0.9.4 entries count as
  `unstamped`; a version hubd cannot know is reported as unknown, never inferred from
  the line next to it.

- Version comparison is numeric, not lexical: `0.9.10` is newer than `0.9.2` and
  sorts before it as text. Four releases away, that would have inverted every check
  above.

## 0.9.3 — 2026-09-02

- **A mesh merge could duplicate lines in an append-only log, and every count
  believed them.** `merge=union` is the natural `.gitattributes` for logs like
  these — keep both sides of a conflicting hunk instead of stopping to ask — and
  for two machines appending *different* lines it is exactly right. What it does
  not do is deduplicate: a line present on both sides survives twice, and the
  next merge sees the doubled file as one side of the next union, so it
  compounds. Nothing anywhere errors. Git reports a clean merge, the file is
  still valid JSONL, every line in it is a line somebody really wrote, and
  append-only was never violated — the log only grew, exactly as promised. Only
  the counts are wrong, everywhere at once and all agreeing with each other,
  which reads like corroboration rather than a fault. This is also what fed the
  0.9.2 fold bug: union made the replays, the fold minted a task per replay.

  Every read path now drops byte-identical repeats. Not the writer and not the
  sync script: shrinking a log on disk would trip the append-only guard in
  `scripts/mesh-sync.sh` on every other node, and the events were never wrong —
  only the view built from them was. Byte-identical lines are indistinguishable
  to every reader by construction, so keeping the first is lossless in the only
  sense available, and the cost is stated rather than hidden: two genuinely
  separate events that serialize identically (same node, same minute, same text)
  now count once. Dedup is scoped per node log **family** — a node's live log
  plus the month archives rotated out of it — and never across nodes, because a
  journal entry carries no node field and the file name is the only place that
  distinction lives.

  On the hub this was found in: the journal read **27,464 lines as 1,919
  entries**, one task log held 5,359 events for 519 distinct, single lines
  appeared up to 33 times, and seven node log families were inflated. Scoping
  the dedup per node rather than globally keeps three real events a global
  `sort -u` would have merged.

- **A cache folded by a buggy fold no longer outlives the fix.** `tasks.json` is
  rebuilt when it is older than the newest event file, which can only ever
  notice *new events* — and the case that misses is the one that matters most. A
  fix to the fold itself leaves every event byte-identical and every mtime
  untouched, so the wrong cache survives the upgrade and keeps being served as
  fact. That is not hypothetical: after 0.9.2 shipped, `hub doctor` on the very
  hub the bug was found on still reported **977 open tasks**; the corrected fold
  said 154. The cache now carries the version that folded it and is refolded on
  any mismatch — the same rule `HUBD.md` and `sections.json` already follow, for
  the same reason. `hub doctor` also stopped reading the raw cache file and goes
  through `loadTasks()` like everything else, because doctor is precisely where a
  human checks the hub against their own expectations.

- **`hub doctor` says the entry count, and says what it dropped.** The journal
  line used to count lines on disk, so it reported the inflated figure as fact —
  the exact failure this release is about, in the tool people run to check the
  hub. It now prints entries a reader actually sees, plus a `logs:` block naming
  each inflated node log, its raw and distinct counts, and the cause. Serving a
  corrected number over files that quietly keep the duplicates would be the same
  lie one level down. [recipes #7](docs/recipes.md) carries the same warning for
  anyone setting up a mesh.

## 0.9.2 — 2026-09-02

- **The owner exists in `hub presence`.** Agents heartbeat because the protocol
  tells them to; nobody tells the human anything, so the one person in the fleet
  was the only member of it with no liveness at all — a board could show buttons
  waiting twelve days with no way to tell "away" from "here and not answering",
  which are the two states that decide whether to wait or route around them.
  Nothing new is asked of the human: a write authored by a declared owner role
  (`owner-roles.json`) IS the evidence a person acted, recorded from the choke
  point every write already passes, plus the two paths that skip it — a queue
  reply, which never journals, and a report of pure `FACT:`/`COMM:` lines, which
  writes only the card. Owner TTL is four hours, because a person who answered an
  hour ago is still around in a way a polling loop is not.

- **A replayed task event stopped multiplying into new tasks.** The fold's
  collision guard compared the remap against the RAW id, so once a key had been
  remapped — its id was already taken by another node — every later `add` for
  that same key mismatched again and minted yet another task. One duplicated
  line in an append-only log therefore multiplied without limit. Worse, it
  silently broke the invariant `set`/`del` are keyed on: eleven tasks ended up
  sharing one origin, so closing "the" task reached exactly one of them and the
  other ten stayed open, unreachable by any id anyone had. A key that already
  has a home now keeps it, and a replayed add overwrites its own task — which is
  what re-reading an append-only log should do.

  Found by taking a task out of a work queue and noticing the backlog disagreed
  with itself. On the hub this was found in: **1507 tasks fold to 427**, 977 open
  become 153, and the count of tasks sharing an origin goes from 104 groups to
  zero. Nothing is deleted and no log is rewritten — the events were always
  right; only the view built from them was wrong, which is the whole reason the
  logs are the truth and `tasks.json` is a cache.

- **A `set` event now says how it is keyed.** Fixing the above surfaced that the
  writer and the reader had drifted apart: `runTaskUpdate` records a set under
  the task's ORIGIN `(node, id)`, while the reader (rightly, for older events)
  treats a set's id as a FINAL id and prefers a live task holding that number.
  Those two are byte-identical on disk and mean different tasks — a node updating
  its own remapped task emits exactly what "update the visible #169" used to
  emit — so an update could land on another node's task that merely happens to
  hold that number. New writes carry `keyed: "origin"` and are resolved through
  the remap; unmarked events keep the heuristic they were written under. The
  ambiguity was in the data, so it is removed from the data going forward rather
  than guessed at on every read.

## 0.9.1 — 2026-08-26

- **`mesh-sync.sh` ships with the package** — "your data is a folder, sync it
  like one" was advice with no tool attached; every node was running a copy of
  the same script by hand. `sh "$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"`
  commits, pulls and pushes a hub between peers over ssh, with no GitHub in the
  path. Its four safety properties are each a scar and are documented as such in
  the file: it REFUSES to sync when a task event log lost or changed a line (a
  migration that rewrote history instead of appending would otherwise propagate
  to every peer), injects a git identity on the pull as well as the commit (a
  node with no global git user reported a merge conflict that did not exist),
  aborts a conflicted merge rather than leaving conflict markers inside hub data,
  and treats a failed push as a retry because the commit is already local. Exit
  codes 2 / 3 / 4 say which of those happened.
- **`hub audit` stopped generating findings out of its own bookkeeping** — filing
  an incident writes a journal line for that project, which made the project's
  card look days behind its own journal on the next run: an incident produced by
  the act of filing an incident. A weekly pass would have grown its own backlog
  through a route the keyed dedup does not cover. The freshness signal now
  ignores the kinds the tracker writes about its own records (`task`, and the
  audit's own summary, now filed as `audit`), because a card is behind when WORK
  it does not reflect has happened — not when the tracker took notes. Caught by a
  test asserting a second pass files nothing; a third pass is now asserted too.

## 0.9.0 — 2026-08-10

The memory-and-scope release: what to do now, what we know about X, what it
cost, and which of those belongs to a project at all.

- **`hub_next` / `hub now`** — ONE task and the reason it won, not a list.
  Picking from a list is work, and a session made to pick tends to pick the easy
  one. A task whose dependencies are still open is never eligible, however loud
  it is; a winner that is the owner's to press says so.
- **`hub_agenda` / `hub agenda`** — the day split by WHO CAN ACT: agent work
  ready now, owner buttons, blocked (and on what), overdue. A task counts as the
  owner's if it says `owner_kind: human` OR is assigned to a role already
  declared in `HUB/owner-roles.json` — without that second test, most real
  owner decisions landed in a column whose entire promise is that its reader can
  start everything in it.
- **`hub_recall` / `hub recall`** — ranked memory across cards, sections,
  decisions, journal and tasks, where `hub_search` is flat and exact and
  `hub_get` is one project's everything. Scoring is deterministic and readable —
  term coverage first, then where the line lives (a decision outranks a passing
  note), then recency; no embeddings, no index, no model in the loop. Term
  coverage leads on purpose: with the field weight first, "queue offset"
  surfaced decisions containing only "queue" and buried the lines actually about
  offsets — the ranking was measuring prestige, not relevance. Every hit carries
  the date it was true **as of** plus a stale flag, because recall's real failure
  mode is handing over a two-month-old fact with this morning's confidence.
- **`hub_usage_add` / `hub_usage`** — what the work cost, with a hard line down
  the middle: **SUPPLIED** (seconds, tokens, money — none of which the hub can
  observe, so a client reports them) versus **MEASURED** (closed-task spans,
  journal events — the hub's own arithmetic). The split is the feature: a number
  that mixes an observed span with a guessed rate gets quoted later as if
  somebody had counted. An entry with no numbers is refused — an absent value
  must not become a recorded zero.
- **`hub init` stopped scaffolding into source checkouts** — with no argument it
  took the cwd, so run from a code repo it dropped `AGENTS.md`, `INBOX.md`,
  `queues/` and `specs/` in there, ready to be committed by accident. It now
  refuses when the cwd has a `.git` and no hub data, names both safe
  alternatives, and `--here` overrides — the same shape of guard the queue
  resolver already had for misrouted sends. This project's own `.gitignore`
  carries `/queues/` and `/INBOX.md` entries: the scar of this exact misroute,
  papered over rather than fixed. It happened again while healthchecking 0.9.0,
  which is how it got found.
- **One node identity for the whole hub** — queue filenames read the hostname
  directly while the journal and the task log went through `HUBD_NODE`, so on a
  host whose identity had to be normalised by that variable, `journal.<node>.jsonl`
  and `<role>.<node>.queue.md` disagreed about the same machine. That is the
  ghost-employee bug from the other side: a hostname change already invented a
  node nobody hired, and half the files honouring an override while the other
  half ignore it is how one machine becomes two. Found by running the packaged
  tree against a real hub. Renaming the write target strands nothing — readers
  match `<role>.<anything>.queue.md`, so files written under the old name are
  still read; verified live, with the old and new files aggregating in one ledger.
- **Scope layers** — not everything belongs to a project. `hub_operator` reads
  the operator card (the human's rhythm, the framing that works, and
  **Boundaries** — what is never collected; agents read that section and never
  edit it): a card, so section writes and recall reach it, but excluded from
  every project view because it is not one. `private: true` on a report routes
  prose to the local-only life braid (`journal.life.jsonl`, gitignored, never
  mesh-synced) and stamps the entry; mixing it with a structured prefix is
  refused rather than quietly published, since cards are synced. `hub_rules`
  reads AGENTS.md and appends an amendment under one dated, attributed heading —
  never rewriting a line, because an audit has to be able to quote what a rule
  used to say.

## 0.8.0 — 2026-08-10

Rules stop being prose. A rule written down gets broken; a rule that is a check
does not — and the two had never been distinguishable from inside the hub.

- **`HUB/rules.json`** — one file where an instance declares which projects are
  money bets (`money`), which checks it actually enforces (`strict`, opt-in and
  empty by default), and the rules an incident may quote (`laws`, each with the
  date it was written).
- **`hub lint` / `hub_lint`** — every rule that CAN be checked, checked: a money
  bet whose gate names a criterion but no date (nothing can ever declare it
  missed), and a human-owned communicative task with no prep it depends on (the
  owner would have to both prepare the thing and decide it). Each finding says
  whether this instance enforces it, so "we have a rule about that" and "the
  rule bites" stay different facts. The gate check covers only DECLARED money
  bets and SAYS SO when none are declared — run over every card it produced 11
  findings where the rule covers a handful, and a check that cries about things
  outside its own rule stops being read.
- **`hub audit` / `hub_audit`** — declarations against behaviour, frozen from a
  role that had been run by hand for weeks: a gate date that passed with no
  decision recorded since (the verdict is what was missing, so a later DECIDE
  clears it) · a project whose share of the journal contradicts the `MODE:` its
  own card declares, in both directions · owner buttons nobody pressed · a card
  that stopped following its own journal · tasks with no project. Read-only by
  default; `--apply` files one incident task per finding and writes ONE report.
  Three refusals are deliberate: it is **not a dashboard** (the output is work
  somebody owns), it **quotes you, not itself** (each incident carries your rule
  and the date you wrote it — an engine's opinion carries no weight next to your
  own past decision), and a **weekly run cannot pile up** (findings are keyed and
  a key already open is never filed again). Close rates are printed as numbers
  and never filed: a rate is a thermometer, not a violation.
- **`strict.rejectNoteOnlyReport`** — refuses a report made of nothing but
  unprefixed prose, naming the alternative (`hub claim` for "I'm on it"). An
  explicit `NOTE:` still lands, because the refusal message promises that. Off
  unless asked: an upgrade must never start refusing writes uninvited.

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
  (`pine-3`), minted from the node's own append-only log, so two offline
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
