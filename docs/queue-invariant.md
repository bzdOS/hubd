# The queue invariant, and what happens when it breaks

A design note. It documents a contract hubd depends on, three ways the contract
was found broken in a live mesh, and what is being done about each — including one
tempting fix that is rejected and why.

## The contract

`queues/<role>.<node>.queue.md` — one file per role per node, appended to only by
that node, never rewritten. Cursors are **byte offsets** into that file, stored in
`.qstate/<file>.offset`, node-local and never mesh-synced. How far a role's reader
got is published separately, for every node to count with: see
[Read marks](#read-marks--the-position-every-node-can-see) below.

Both halves are load-bearing, and the module says so in its own header:

> Per-host files are conflict-free by construction (single writer each), and the
> byte offset stays valid because each file only ever grows by clean append from
> one writer.

Single writer buys conflict-free merges. Append-only buys valid byte offsets. Lose
either and the other stops being true.

## Three ways it was found broken

**1. A real content conflict.** `queues/chat.pine.queue.md` diverged: 120
message blocks on one node, 1 on another — and the 1 was newer. The mesh sync
stopped, correctly, and refused to guess. Resolved by hand as a union of blocks;
either side alone would have lost data (`--ours` would have dropped 1 message,
`--theirs` 102).

**2. Cross-node writes.** Comparing the node in each filename against the authors
of its non-merge commits: `chat.fir.queue.md` has only `fir`,
`hv.pine.queue.md` only `Pine` — but `chat.pine.queue.md` carried commits
from `Maple`, `Pine` **and** `fir`. One file, three writers.

**3. Out-of-band truncation — and it is legitimate.** Two commits removed **15531**
and **13422** lines from queue files. The removed blocks were old, consumed
messages; the files had grown past fifteen thousand lines. So somebody purges
consumed history, which is reasonable housekeeping — and hubd has no operation for
it, so it happens with a shell redirect and `mesh-sync` faithfully commits the
result. hubd itself never writes a queue file except by append (`queueSend`) and
creating an empty one (`queueWait`); every other write in the module targets
`.qstate`, not the queue.

That third finding reframes the first two. These are not merely violations to be
stamped out: a needed operation is missing, so people do it out of band, and the
byte-offset contract is what pays.

## The cost nobody was charged for

`drainFile` handled a shrunken file by resetting the cursor to `0`:

```js
if (sz < off) { fs.writeFileSync(offFile, '0', 'utf8'); return null; }
```

For a file that was *recreated* that is right. For a file that was *purged* it
means the entire remaining content is delivered again — silently, with no error, to
workers whose stated contract is at-most-once. A 13000-line purge is followed by a
re-delivery of whatever survived it.

## Rejected: `merge=union` on queue files

The obvious response to finding (1) is to give queues the same
`.gitattributes` treatment the logs have. It is the wrong instrument, for three
reasons, the first decisive.

**It destroys the byte-offset contract.** Union merge inserts the other side's
lines *into the middle* of the file. Every cursor past the insertion point now
points somewhere else. The result is skipped or duplicated messages with no error
and no trace. Journals survive union because they are read whole and deduplicated;
a queue is read incrementally by offset, so the same merge that saves a journal
silently mis-delivers a queue. A stopped sync is better than a wrong delivery.

**It duplicates.** Union never deduplicates — the 0.9.3 scar. Queue readers have no
dedup at all, so a duplicated block is delivered as two genuine messages.

**It converts a signal into silence.** A conflict on a per-node queue file is
information: it means two writers touched one node's file, which is supposed to be
impossible. Finding (2) above was discovered *because* the merge stopped. Merging it
away removes the only detector.

## The design

Three layers, cheapest first. Each is useful alone.

### Layer 1 — make the offset survive a purge, and say when one happened

**A delivery watermark alongside the offset.** After a successful drain, record the
header line of the last delivered block on a second line of the `.offset` file:

```
12345
## 2026-09-06 14:40 · from head-orchestrator · task #pine-124
```

This is format-compatible with every existing reader: they do
`parseInt(readFileSync(...).trim(), 10)`, and `parseInt` stops at the first
non-digit, so an old hubd on the same node keeps reading `12345` and ignores the
rest. `.qstate` is node-local and gitignored, so nothing about this touches the
mesh or the file format.

On a shrink, the watermark decides:

- **Watermark found in the new content** → the purge removed blocks before it. Set
  the offset just past that block. Nothing is re-delivered, nothing is skipped.
  (Unless nothing follows that block: the file may be cut short, see
  [Cut short](#cut-short--a-file-caught-while-it-is-written).)
- **Watermark absent** → it was purged along with everything before it, so every
  remaining block postdates it and is genuinely undelivered. Offset `0` is correct.
  (A file that was truly *recreated* lands in the same branch and gets the same
  right answer. A file *rolled back* to an older version does not: see
  [Rolled back](#rolled-back--a-merge-that-failed-in-the-live-hub) below.)

Where the same header appears more than once — the timestamp is minute-resolution,
so one sender can produce two identical headers — take the **last** occurrence.
That biases toward delivering less rather than twice, which is the direction the
at-most-once contract points.

**Report the shrink.** A cursor whose recorded offset exceeds the file's current
size is direct evidence that the file was truncated after that cursor last read it.
That needs no git and has no false positives — unlike the commit-author check,
which flags renamed files (`*.pine-legacy.*`), nodes outside the git mesh
(their files are committed by whoever received them), hostname case, and history
already resolved. The author check is a better *forensic* tool than a monitor; the
cursor comparison is what `hub doctor` should carry.

### Layer 2 — give the missing operations a home

**`hub queue compact <role|file>`** — drop blocks that every known cursor has
already passed, then repair those cursors. This is what the 15531-line purge was
reaching for. In-band, it can be correct: the tool knows every cursor, so it knows
exactly which prefix is safe to drop and where each cursor must land afterwards.
Out of band it cannot be, and the watermark above is only damage control.

**`hub queue resolve <file>`** — block-level union of a conflicted queue, in the
shape `hub card resolve` already has: identical blocks collapse to one, order by
timestamp, refuse to touch a hunk whose block structure is ambiguous. It must also
repair cursors, which is exactly computable: count the blocks before each cursor in
the old file, place it after the same count in the new one.

### Layer 3 — cursors keyed by identity, not position

Only needed to make queues conflict-free *by construction*, i.e. to make union
safe. The message header already has an extensible tail (`· task #<id>` is appended
after the sender, and readers match the `## <ts> · from ` prefix), so `· id <hex>`
would be backward compatible. Cursors become "last delivered id, plus a bounded set
delivered out of order", and mid-file insertion stops meaning anything. Migration is
mechanical: on first read, translate an existing offset into the id at that block
boundary.

## What is being built, and what is not

**Layer 1 now.** It fixes a live correctness bug — silent mass re-delivery after a
purge — and makes the out-of-band edits visible the day they happen.

**Layer 2 next**, `compact` before `resolve`: the purge is routine and the conflict
was a one-off.

**Layer 3 and `merge=union`: not now.** The invariant is sound; what broke it was a
missing operation, and Layer 2 supplies that. Paying for a format change, a cursor
migration and a new class of state — in order to enable a merge strategy that
should not be needed — is the wrong trade. Revisit if the invariant breaks again
from a *different* cause: that would be evidence it cannot be held, and then Layer 3
earns its cost.

## Rolled back — a merge that failed in the live hub

The third way a file shrinks. Measured on a mesh node: `mesh-sync` merged in the
live hub dir, and the merge stopped on a conflict in other files. For over an hour
every run opened the merge and aborted it. While it stood open, the queue file held
the other side's version, 1315 bytes longer by one block, and a waiting reader took
that block. The abort put the local version back. The watermark, that block's
header, was not in it, so "absent" sent the cursor to `0` and the worker was handed
its whole queue again: 337132 bytes, and 336091 on the next failed run. The ack log
could not have caught it. It travels with the mesh, the abort rolled it back too,
and the one block ended up with three "delivered" lines.

Two fixes, either enough for this case:

- **No merge stands open in the hub.** `mesh-sync` fetches and tries the merge
  outside the working tree first (`git merge-tree --write-tree`, git 2.38+). A
  conflicted merge never reaches the hub: the run exits 2 and touches nothing. Only
  a clean merge is made in place. An older git merges in place as before.
- **The cursor tells a rollback from a purge.** Everything in an older version of a
  file was handed out before the watermark was. So when the watermark is absent but
  the file holds blocks not newer than it (an id not above its id, a time not after
  its time), resume after the last of them. When the file comes forward again, the
  watermark turns up *ahead* of the cursor: everything through its block was handed
  out, so it is skipped. Only a header with an id is unique enough for either rule.
  Without one, the rules above hold, and a file recreated with its ids from 1 again
  is told apart by its times.

## Cut short — a file caught while it is written

The fourth way a file shrinks, and the only one that undoes itself. Measured on a
mesh node: a reader was handed the same 411 bytes twice in one afternoon, the tail
of a message without its header. The node's git history had caught its shard cut
at 9216 bytes, in the middle of a character inside the last block that reader had
been handed, and whole again a minute later. Something on that node wrote the file
in place instead of appending to it; hubd's own writers append. The shorter file
still held the watermark, and the watermark's block ran to the cut, so the cursor
went to the cut. Once the file was whole, the cursor stood inside that block, and
the rest of the block went out as if it were new.

Three fixes:

- **A shorter file that holds nothing past the watermark is left alone, cursor and
  all.** Its last header is the watermark, or a block not newer than it, so there
  is nothing to hand out, and the cursor is right again the moment the file is
  whole. Until then `hub doctor` reports the cursor past the end of the file, which
  is true. A poll while the file stays short reads its last 64 KB. A shorter file
  that holds a block newer than the watermark is a purge or a recreation, and the
  rules above apply.
- **A cursor is checked against its watermark when the file is not shorter.** The
  last header before the offset must be the watermark. When it is not — a file
  purged and written past the old offset before the next poll, one recreated, one
  whose earlier blocks changed length — the offset points into some other block,
  and the reader resumes after the watermark, as for a shorter file.
- **A block ends at the next whole header.** Resuming after the watermark stopped
  at the next line that started with `## `, so a message holding a markdown heading
  was cut there, and the rest of it went out as a message of its own.

What it cannot see: an edit in place that leaves the cursor inside the watermark's
own block, where the last header before it is still the watermark. Telling that
apart needs the bytes that were there before. A cursor an older hubd left at such a
cut, with the file whole again and not yet read, is trusted the same way.

## Read marks — the position every node can see

A cursor never leaves its node, so every count taken anywhere but on the reader's
own node was wrong. Measured on a live mesh: one role, 71 messages; the node that
wrote them said 44 pending, the node that read them said 0. The ack log could not
settle it either: every reader, taps included, appended "delivered" for every block
it was handed, and one queue handed out from its start seventeen times over left
361 lines for 61 ids.

So the reader publishes its position. `queues/read/<role>.<node>.json` is written
by the node that read, and by no other, and travels with the mesh. One writer per
file, as with the queue files themselves, so no merge can conflict:

```json
{ "files": { "worker.pine.queue.md": { "mark": "## 2026-10-02 07:32 · from head · id 61", "off": 30124, "at": "2026-10-02 07:32" } },
  "subs":  { "<subscriber>": { "<file>": { "mark": "...", "off": 0, "at": "..." } } } }
```

- **Written** only by a role's own reader, after a delivery: the shared cursor
  (`files`), or a subscriber of a broadcast role (`subs`). A tap
  (`hub_queue_wait_all`) reads for nobody, so it writes no mark and no ack.
- **Read** by every count: `hub queue status`, the depth a send reports, `hub
  brief`, `hub doctor`, ghost and stranded queues. A file counts as read up to the
  furthest of this node's cursor and every node's mark. `hub queue status` says
  which node that was, and when.
- **The header is trusted, not the offset.** Offsets agree across nodes only while
  nobody trims the file. The offset is used when the last header before it is the
  mark; otherwise the mark is looked for in the file (last occurrence first), the
  same rule the watermark follows. Trimmed above the mark, the file still reads as
  read to its end; recreated under the same name, it does not inherit the mark.
- **Delivery is unchanged.** A reader still starts from its own cursor. The mark
  changes what is counted, not what is handed out.

Two smaller fixes travel with it. The ack log gets at most one "delivered" per id,
however many times a block is handed out. And block ids continue past the highest
id in the ack log, so a file emptied by hand does not start a second id 1 that the
old log would answer for. Archiving a queue file moves its ack log with it.

Since 0.9.54 a block id is `<node>-<N>`, N counted by the writing node across every
queue of the hub (a counter in its `.qstate`, taken under a lock), so no two blocks
share one; before, a bare number counted per file stood in a dozen headers of one
hub. A node without its counter starts past the highest N in its own queue files
and their ack logs. Bare ids from before stay readable: in one file they all come
before the first `<node>-<N>`, which is the order a rolled-back file is cut by.

A reader on a hubd from before read marks leaves none, and two things cover it.
Once upgraded, a reader publishes its cursor's watermark at the start of every
wait where it differs from the published mark, so a queue it read to the end
before the upgrade shows as read without waiting for the next message — which a
queue counted full would refuse from every node but the reader's own. And the
send limit counts a file as read up to the last block its ack log names: a
reader hands a file out in order, so every block above that one was handed out
too, including blocks written before ids, which no ack can name. A reader that
leaves neither — one that reads the file itself — stays invisible; `hub doctor`
says so where it reports queues no node has read, and the hub lists such a role
in `queue.exempt` of `limits.json`.
