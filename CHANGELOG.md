# Changelog

All notable changes to `@bzdos/hubd`. Dates are release-commit dates.
The file format (markdown + JSONL, append-only logs) is the stable contract;
a version here never migrates or deletes data.

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
  and cursors and presence are node-local, so a queue fed here and drained on Planck looks
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
  `runTaskUpdate` — `~ task #planck-66 -> @opencode-bsdos`, `~ task #planck-65 -> done`. Every
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
  `barechat.planck.queue.md` carried commits from three different nodes. But it also
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
  accumulated, e.g. `queues/hv.Planck.queue.md` and `queues/hv.planck.queue.md`.

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
