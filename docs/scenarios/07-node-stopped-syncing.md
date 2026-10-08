# 7. A node stopped syncing

**The situation.** Your hub runs on two machines. One day the work done on one of them
stops showing on the other. Nothing failed loudly: the agents there keep writing, every
write succeeds, and the sync that runs every minute fails every minute, into a log
nobody reads. From inside, each node looks healthy.

**What you end with.** Which node stopped and why, from `hub doctor` on it, and the fix
for each of three causes: a card two nodes changed in the same place, a freeze nobody
lifted, a queue cursor that belongs to another account. And the cures that make it
worse.

Level 4: [4. A second machine](../start/4-second-machine.md) sets up the mesh and
explains why two nodes almost never conflict. Every output below is real, captured in
one run on two simulated nodes on one computer, so its clock reads minutes where the
story says hours.

```bash
export HUBD_DIR=/tmp/hub-s7-oak HUBD_TEAM_DIR=/tmp/hub-s7-oak HUBD_NODE=oak
MS="$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"
hub init "$HUBD_DIR" > /dev/null
git init -q --bare -b main /tmp/hub-s7-remote.git
git -C "$HUBD_DIR" init -q -b main
git -C "$HUBD_DIR" add -A && git -C "$HUBD_DIR" commit -qm hub
git -C "$HUBD_DIR" remote add origin /tmp/hub-s7-remote.git
git -C "$HUBD_DIR" push -q -u origin main
git clone -q /tmp/hub-s7-remote.git /tmp/hub-s7-elm
on() ( n=$1; shift; export HUBD_DIR=/tmp/hub-s7-$n HUBD_TEAM_DIR=/tmp/hub-s7-$n HUBD_NODE=$n; "$@" )
hub card merge-driver > /dev/null
sync() { for n in oak elm oak; do on $n sh "$MS" | grep -v '^mesh-sync: ok'; done; }
```

`oak` is your laptop, `elm` the build box, and `on elm …` runs a command as elm. Elm
joined the mesh in a hurry: nobody ran `hub card merge-driver` there. On real machines
each node runs mesh-sync every minute and its output goes to `.mesh-sync.log` in the
hub; here `sync` runs it on oak, elm and oak again, and prints only a run that was not
ok.

## The first sign

The shop card goes to both nodes. Then you and the builder each add a line to its
Metrics, at about the same time:

```bash
hub card shop -m "Web shop: catalogue, cart, checkout. 1.4.2 is the next release." --by alice > /dev/null
sync
on elm hub section add shop metrics "e2e 412/412 on 1.4.2" --by builder
hub section add shop metrics "checkout conversion 3.1% last week" --by alice
sync
hub log shop
```

```text
shop → ## Metrics
shop → ## Metrics
projects/shop.md

Auto-merging projects/shop.md
CONFLICT (content): Merge conflict in projects/shop.md
mesh-sync: real content conflict on main — nothing was merged, the hub was not touched; resolve by hand in /tmp/hub-s7-elm
2026-10-08 15:37 [shop/alice] note: card set: Web shop: catalogue, cart, checkout. 1.4.2 is the next release. [card Digest: 580 B, new]
2026-10-08 15:37 [shop/alice] note: Metrics: checkout conversion 3.1% last week [card Metrics: 609 B, +29]
```

On oak, the builder's line is not in the log. The sync on elm said why, once; on a real
machine it says it again every minute, into the log.

## Ask the node that stopped

```bash
on elm hub doctor | sed -n '/  mesh:/,/hub card merge-driver/p'
```

```text
  mesh:     origin/main: 1 behind, 1 ahead  WARNING
            this hub is not receiving the other nodes' work - the sync is not completing
  drivers:  2 merge driver(s) will not run on this node  WARNING
            hubd-card: not installed - cards merge as the hub's .gitattributes says
            hubd-state: not installed - a snapshot, presence, sense or read-mark file rewritten on two nodes stops the sync
            on this node: hub card merge-driver (nothing it sets travels with the mesh)
```

`behind` is what the other nodes pushed and elm does not have; `ahead` is what elm wrote
and nobody else has. Both grow for as long as the nodes work and the merge fails. hubd
counts them from git, not from the log, because the log says what the script thought,
and once it thought wrong for 228 commits.

You will not always know which node to ask. From any other node, `hub doctor` names a
peer that has not appeared in the shared history for six hours while the rest of the
mesh moved, under `peers:`.

## Cause: one card section, changed on two nodes

Journals, task events and queues are one file per node, so they never conflict. A
card is one file every node rewrites, and two lines added to the end of one section are
two changes to the same place. Without the driver, git stops on it. mesh-sync tried the
merge outside the hub first, so the folder your agents read holds no conflict markers.

Merge it by hand once, on elm:

```bash
git -C /tmp/hub-s7-elm merge -q origin/main
on elm hub card resolve
git -C /tmp/hub-s7-elm commit -qam "shop card: both metrics kept"
sync
hub log shop
```

```text
Auto-merging projects/shop.md
CONFLICT (content): Merge conflict in projects/shop.md
Automatic merge failed; fix conflicts and then commit the result.
  shop.md: 1 list hunk(s) unioned
Rewrote 1 card(s). Review, then commit.
2026-10-08 15:37 [shop/builder] note: Metrics: e2e 412/412 on 1.4.2 [card Metrics: 595 B, +15]
2026-10-08 15:37 [shop/alice] note: card set: Web shop: catalogue, cart, checkout. 1.4.2 is the next release. [card Digest: 580 B, new]
2026-10-08 15:37 [shop/alice] note: Metrics: checkout conversion 3.1% last week [card Metrics: 609 B, +29]
```

`hub card resolve` keeps both sides of a list and leaves a prose conflict for you. Then
make sure it does not stop again:

```bash
on elm hub card merge-driver > /dev/null
on elm hub doctor | grep -A1 '  mesh:'
```

```text
  mesh:     origin/main: in sync
  drivers:  hubd-card, hubd-state: in place
```

With the driver, the same two edits merge by themselves, both kept under a line that
asks a person to look ([4. A second machine](../start/4-second-machine.md#cards-merge-by-section)).
The driver lives in `.git/config` and `.git/info/attributes`, which never travel: run it
on every node.

## Cause: a freeze nobody lifted

Before a restore, someone stops the sync on elm, as they should. The restore is done,
and the freeze stays:

```bash
on elm hub freeze "restoring the outbox from last night's backup" --by alice
hub queue send builder "Build 1.4.3 from main when the e2e suite is green." --from alice
sync
on elm hub queue wait builder --timeout 1
on elm hub doctor | sed -n '/^mesh: FROZEN/,/unfreeze/p'
```

```text
Frozen: mesh-sync on this node will skip every run until you unfreeze.
  /tmp/hub-s7-elm/.mesh-freeze
Local writes still work and stay local. Back up before you touch anything:
  tar czf ~/hub-backup-20261008.tgz -C "/tmp" "hub-s7-elm"
Other writers on this directory are NOT stopped by this — check them too:  hub doctor
→ builder.oak.queue.md delivered
mesh-sync: FROZEN — skipping (/tmp/hub-s7-elm/.mesh-freeze). Run: hub unfreeze
NO_CHANGES
mesh: FROZEN — this node neither sends nor receives
  since 2026-10-08 15:37 (0h) by alice: restoring the outbox from last night's backup
  hub unfreeze
```

The message was delivered, to oak's copy of the queue. The builder waits on elm and
hears nothing. A forgotten freeze looks exactly like a mesh that works: nothing errors.
`hub doctor` states a freeze while it lasts, with who set it and why, and after six
hours marks it `WARNING`, as longer than any operation should take.

```bash
on elm hub unfreeze
sync
on elm hub queue wait builder --timeout 1
```

```text
Unfrozen. mesh-sync runs again on its next tick (was frozen since 2026-10-07 16:32 by alice).
Run it once now to catch up:  sh "$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"
## 2026-10-07 16:32 · from alice · id oak-1
Build 1.4.3 from main when the e2e suite is green.
```

## Cause: a cursor that belongs to another account

The hub syncs, the messages arrive, and the builder still gets nothing. Each reader
keeps its place in each queue in a cursor file under `.qstate/`, and the user that
reads must be able to write it. One `sudo hub queue wait builder` on elm, run once to
look, leaves a cursor that belongs to root. Here `chmod a-w` stands in for that:

```bash
chmod a-w /tmp/hub-s7-elm/.qstate/builder.oak.queue.md.offset
hub queue send builder "Build 1.4.4 as well; the release notes are in the shop card." --from alice
sync
on elm hub queue wait builder --timeout 1
on elm hub doctor | sed -n '/CANNOT WRITE/,/chmod -R/p'
```

```text
→ builder.oak.queue.md delivered
Error: queue cursor for builder.oak.queue.md.offset cannot be written (EACCES): messages cannot be delivered and would be silently held forever. Fix the owner/permissions of /tmp/hub-s7-elm/.qstate/builder.oak.queue.md.offset and its directory (on a fleet node: chgrp -R <group> and chmod -R g+rwX over the hub dir), then retry.
  1 queue cursor(s) THIS USER CANNOT WRITE — delivery is stopped  WARNING
    builder.oak.queue.md (EACCES): 2 message(s) in the file
    a wait on these roles can only answer NO_CHANGES; nothing sent to them will ever arrive.
    hint: fix ownership of /tmp/hub-s7-elm/.qstate — on a fleet node the hub dir is shared,
          so: chgrp -R <group> "/tmp/hub-s7-elm" && chmod -R g+rwX "/tmp/hub-s7-elm"
```

The wait refuses rather than answering "nothing new" forever. On a real node the fix is
the owner: `sudo chown -R` the `.qstate` folder back to the user the agents run as, or,
on a node where the sync and the agents run as two users, one group with write on the
whole hub folder, as the hint says. mesh-sync keeps group write on what a pull creates,
once the folder has it. Here:

```bash
chmod u+w /tmp/hub-s7-elm/.qstate/builder.oak.queue.md.offset
on elm hub queue wait builder --timeout 1
```

```text
## 2026-10-07 16:32 · from alice · id oak-2
Build 1.4.4 as well; the release notes are in the shop card.
```

## What can go wrong

**Starting the node over.** `git reset --hard origin/main`, or a fresh clone, makes the
warning go away, and with it everything the node wrote while it was stuck: the `ahead`
in `hub doctor` is that work. Merge, never reset.

**`merge=union` in `.gitattributes`.** It looks like the cure for a conflict that keeps
coming back, and the sync never stops again. It also never removes a line: a line on
both sides survives twice, the next merge doubles it again, and nothing says so. One hub
reached 27,464 journal lines holding 1,919 entries. hubd's readers drop byte-identical
repeats and `hub doctor` reports the duplicates under `logs:`, so the counts stay right,
but the files keep growing. Let a real conflict stop the sync, and fix it once.

**Two paths that differ only by case.** On Linux they are two files. On macOS and
Windows they are one file for two index entries: git can satisfy only one, `git add -A`
stages nothing, and every merge that must write the other refuses, with an error about
local changes that no commit or stash clears. mesh-sync exits 5 and says nothing
conflicted; `hub doctor` lists the pair under `paths:`, including a pair that exists only
in the remote's tree. A host name spelled `Pine` in old queue names and `pine` in new
ones once kept a node out of its own mesh for 228 commits. The fix is to remove one of
each pair from the mesh. hubd does not create such a pair itself.

**A deleted log.** mesh-sync refuses to commit it and exits 4, with the command that
restores it ([4. A second machine](../start/4-second-machine.md#what-hubd-refuses-here-and-why)
has the other exit codes).

**A driver that names a file that is gone.** hubd or Node moved, say with an upgrade
under a version manager: the card merge falls back to git's union merge, and the state files to the side git
calls ours, without a word. `hub doctor` says which and what a merge does instead. Run
`hub card merge-driver` again.

**The same node name on two machines.** Two clones writing one node's files are two
writers of a file that has one. Their merges conflict on lines that are each one
node's own. Set `HUBD_NODE` on every node, to a name no other node has.
