# The queue invariant, and what happens when it breaks

A design note. It documents a contract hubd depends on, three ways the contract
was found broken in a live mesh, and what is being done about each — including one
tempting fix that is rejected and why.

## The contract

`queues/<role>.<node>.queue.md` — one file per role per node, appended to only by
that node, never rewritten. Cursors are **byte offsets** into that file, stored in
`.qstate/<file>.offset`, node-local and never mesh-synced.

Both halves are load-bearing, and the module says so in its own header:

> Per-host files are conflict-free by construction (single writer each), and the
> byte offset stays valid because each file only ever grows by clean append from
> one writer.

Single writer buys conflict-free merges. Append-only buys valid byte offsets. Lose
either and the other stops being true.

## Three ways it was found broken

**1. A real content conflict.** `queues/barechat.planck.queue.md` diverged: 120
message blocks on one node, 1 on another — and the 1 was newer. The mesh sync
stopped, correctly, and refused to guess. Resolved by hand as a union of blocks;
either side alone would have lost data (`--ours` would have dropped 1 message,
`--theirs` 102).

**2. Cross-node writes.** Comparing the node in each filename against the authors
of its non-merge commits: `barechat.fedora.queue.md` has only `fedora`,
`hv.planck.queue.md` only `Planck` — but `barechat.planck.queue.md` carried commits
from `MacBook-Pro`, `Planck` **and** `fedora`. One file, three writers.

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
## 2026-09-06 14:40 · from fleet-orchestrator · task #planck-124
```

This is format-compatible with every existing reader: they do
`parseInt(readFileSync(...).trim(), 10)`, and `parseInt` stops at the first
non-digit, so an old hubd on the same node keeps reading `12345` and ignores the
rest. `.qstate` is node-local and gitignored, so nothing about this touches the
mesh or the file format.

On a shrink, the watermark decides:

- **Watermark found in the new content** → the purge removed blocks before it. Set
  the offset just past that block. Nothing is re-delivered, nothing is skipped.
- **Watermark absent** → it was purged along with everything before it, so every
  remaining block postdates it and is genuinely undelivered. Offset `0` is correct.
  (A file that was truly *recreated* lands in the same branch and gets the same
  right answer.)

Where the same header appears more than once — the timestamp is minute-resolution,
so one sender can produce two identical headers — take the **last** occurrence.
That biases toward delivering less rather than twice, which is the direction the
at-most-once contract points.

**Report the shrink.** A cursor whose recorded offset exceeds the file's current
size is direct evidence that the file was truncated after that cursor last read it.
That needs no git and has no false positives — unlike the commit-author check,
which flags renamed files (`*.planck-legacy.*`), nodes outside the git mesh
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
