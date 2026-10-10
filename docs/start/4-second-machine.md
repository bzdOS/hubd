# 4. A second machine — one hub on two nodes

**What you get.** The same hub on every machine your agents run on, kept in step by
git: no server, no service to keep alive, any remote you can push to. A message sent
on one node is read on another; a task added offline never collides with one added
elsewhere; a card edited on two nodes at once merges by section.

Fifteen minutes. This continues [3. Queues](3-queues.md). The second machine is
simulated: a second clone of the hub on the same computer, under its own node name,
`elm`. On real machines nothing changes but the remote's address.

```bash
export HUBD_DIR=/tmp/hub-tour HUBD_TEAM_DIR=/tmp/hub-tour HUBD_NODE=oak
MS="$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"
elm() ( export HUBD_DIR=/tmp/hub-tour-elm HUBD_TEAM_DIR=/tmp/hub-tour-elm HUBD_NODE=elm; "$@" )
```

`elm …` runs one command as the second node.

## Why two nodes do not conflict

Everything a node logs goes to files that bear its name: `journal.oak.jsonl`,
`tasks.oak.events.jsonl`, `queues/worker.oak.queue.md`. Each has one writer and only
grows, so a pull merges them without a question. Task and message ids carry the
node's name too (`oak-3`, `elm-1`), so two nodes offline all day still never hand
out the same one. Cards are the one kind of file several nodes rewrite; they get a
merge driver of their own, below.

## Put the hub in git

Any remote you can push to works: a bare repository over ssh on a box you own, a
private repository anywhere. Here it is a folder:

```bash
git init -q --bare -b main /tmp/hub-tour-remote.git
git -C "$HUBD_DIR" init -q -b main
git -C "$HUBD_DIR" add -A && git -C "$HUBD_DIR" commit -qm hub
git -C "$HUBD_DIR" remote add origin /tmp/hub-tour-remote.git
git -C "$HUBD_DIR" push -q -u origin main
```

`hub init` wrote a `.gitignore` that keeps each node's runtime state (cursors,
locks, `tasks.json`, `HUBD.md`) out of the repository; every node keeps its own.

The second node clones it:

```bash
git clone -q /tmp/hub-tour-remote.git /tmp/hub-tour-elm
elm hub task add "write the refund policy page" -p shop --by dev-elm
elm hub queue send worker "check the PayCo webhook signature on staging" --from dev-elm
```

```text
Task #elm-1 added: write the refund policy page
→ worker.elm.queue.md delivered
```

## Sync

The package ships the loop, so you do not write one:

```bash
elm sh "$MS"
sh "$MS"
```

```text
mesh-sync: ok (elm 2026-10-07 13:00, main)
mesh-sync: ok (oak 2026-10-07 13:00, main)
```

It commits, fetches, merges, pushes and packs, and exits in milliseconds when there is
nothing to do. On oak now:

```bash
hub task list -p shop
hub queue wait worker --timeout 3
```

```text
! #oak-2 [shop] wire the hosted payment page into checkout
  #oak-4 [shop] load-test checkout with 200 items
  #oak-5 [shop] @worker rotate the staging API key
  #elm-1 [shop] write the refund policy page
(4 tasks)
## 2026-10-07 13:00 · from dev-elm · id elm-1
check the PayCo webhook signature on staging
```

A message sent on elm, read by a worker on oak. A role's reader publishes how far it
got (`queues/read/`), so `hub queue status` gives the same count on every node.

On real machines, schedule the script every minute on each node: launchd on macOS, a
systemd user timer, cron, or the Task Scheduler on Windows ([A Windows
node](#a-windows-node)). One cron trap: an ssh key with a passphrase cannot work
there unattended, because cron has no ssh agent; launchd and systemd user services
inherit one.

## Cards merge by section

Run this once on each node:

```bash
hub card merge-driver
elm hub card merge-driver
```

```text
Card merge driver installed in /tmp/hub-tour
  .git/info/attributes   + projects/*.md merge=hubd-card
  git config           merge.hubd-card.driver = '…/node' '…/@bzdos/hubd/scripts/card-merge.mjs' %O %A %B || git merge-file --union %A %O %B
State file merge driver installed in /tmp/hub-tour
…
This node only: nothing here travels with the mesh, so run it on every node that syncs.
Different ## sections changed on two nodes now merge cleanly. One section changed on both keeps
both versions under a marker line for a person to review. A snapshot, presence, sense or read-mark
file rewritten on both sides takes the version with the later time. If node or hubd moves, cards
fall back to a union merge and those files to the side git calls ours, until this is run again.
```

Now both nodes edit the `shop` card at the same time, in different sections:

```bash
hub section add shop gates "kill card payments if refunds exceed 2% of orders in the first month" --by alice
elm hub section add shop metrics "staging: 200-item cart checks out in 2 s" --by dev-elm
elm sh "$MS"; sh "$MS"
```

```text
shop → ## Gates
shop → ## Metrics
mesh-sync: ok (elm 2026-10-07 13:00, main)
mesh-sync: ok (oak 2026-10-07 13:00, main)
```

Both lines are in the card on both nodes. Then both edit the same section:

```bash
hub section add shop metrics "staging p95 checkout: 1.4 s" --by worker-1
elm hub section add shop metrics "staging: 0 errors in 1000 checkouts" --by dev-elm
elm sh "$MS"; sh "$MS"
sed -n '/## Metrics/,/## Market/p' "$HUBD_DIR/projects/shop.md"
```

```text
shop → ## Metrics
shop → ## Metrics
mesh-sync: ok (elm 2026-10-07 13:00, main)
mesh-sync: ok (oak 2026-10-07 13:00, main)
## Metrics
<!-- hubd: two nodes changed this section at once; both versions are kept. Review, then delete this line. -->

- 2026-10-07 13:00: staging: 200-item cart checks out in 2 s
- 2026-10-07 13:00: staging p95 checkout: 1.4 s
- 2026-10-07 13:00: staging: 0 errors in 1000 checkouts

## Market
```

Nothing stopped, nothing was guessed, and a line asks a person to look. Without the
driver, the same edit stops the sync and waits for `hub card resolve`
([7. A node stopped syncing](../scenarios/07-node-stopped-syncing.md#cause-one-card-section-changed-on-two-nodes)
has that path).

## Is the mesh healthy

```bash
hub doctor
```

```text
hub base:
  path:     /tmp/hub-tour  (via env HUBD_DIR)
  projects: 1
  resources:0
  tasks:    4 open
  claims:   1 active, 0 expired
  journal:  2 file(s), 18 entries
  writers:  elm 0.9.56 - oak 0.9.56
  fleet:    elm SILENT - oak (here, 2)  WARNING
            no registry at all from elm - a role running there is
            invisible here, which is NOT the same as dead. Each node publishes
            presence.<node>.json on heartbeat; a node on hubd < 0.9.13 never will.
  mesh:     origin/main: in sync
  drivers:  hubd-card, hubd-state: in place
…
```

Which variable chose the hub, which version each node writes with, when each node
was last heard from, whether this node is behind its remote, and whether the merge
drivers will run. Nothing on elm has sent a heartbeat yet, so elm is `SILENT`, with
the reason: invisible is not the same as dead. One `hub heartbeat` there, synced,
and it shows with its age.

## Before you touch the hub folder

A restore, a purge, anything that rewrites files: stop the sync on that node first,
so a tick in the middle cannot hand a half-finished state to every peer.

```bash
hub freeze "restoring yesterday's backup" --by alice
sh "$MS"
hub unfreeze
```

```text
Frozen: mesh-sync on this node will skip every run until you unfreeze.
  /tmp/hub-tour/.mesh-freeze
Local writes still work and stay local. Back up before you touch anything:
  tar czf ~/hub-backup-20261008.tgz -C "/tmp" "hub-tour"
Other writers on this directory are NOT stopped by this — check them too:  hub doctor
mesh-sync: FROZEN — skipping (/tmp/hub-tour/.mesh-freeze). Run: hub unfreeze
Unfrozen. mesh-sync runs again on its next tick (was frozen since 2026-10-08 15:36 by alice).
Run it once now to catch up:  sh "$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"
```

You do not need to remember whether this node runs launchd, cron or a timer. `hub
doctor` states a freeze while it lasts, and warns when it has outlived any plausible
operation: a forgotten freeze is a node that quietly stopped syncing.

## One folder, several users

A node whose agents run under one account and whose sync runs under another shares
the hub folder through a group. Whatever a pull creates belongs to whoever ran it, and
a user that cannot write a queue cursor gets a queue that answers "nothing new"
forever. Keep the folder group-writable: mesh-sync restores group write after every
pull on a hub that already has it, and `hub doctor` names any cursor this user cannot
advance.

## A Windows node

mesh-sync is a POSIX shell script. On Windows it runs in the bash that Git for Windows
installs, which brings the `sh`, `ssh` and `git` it needs. Install Node and hubd as
anywhere, then do the rest in Git Bash: `hub` works there as it does elsewhere, and
`~` is your user folder, so `~/.hubd` is the default hub for `hub` and mesh-sync alike.

The sync runs from a scheduled task, with nobody there to type a passphrase or accept
a host key, and its ssh runs in batch mode and picks no key itself. Give it a key of
its own, without a passphrase, named for the remote's host:

```sh
ssh-keygen -t ed25519 -N '' -C hub-mesh-pine -f ~/.ssh/id_hub_mesh
cat >> ~/.ssh/config <<'EOF'
Host git.example.com
  User git
  IdentityFile ~/.ssh/id_hub_mesh
  IdentitiesOnly yes
EOF
```

Add `~/.ssh/id_hub_mesh.pub` where the remote takes keys. Copy the remote's host key
from a node that already syncs (`ssh-keygen -F git.example.com` there prints its line)
into `~/.ssh/known_hosts` here: batch mode refuses an unknown host instead of asking.

Clone with line-ending conversion off. Git for Windows installs with
`core.autocrlf=true`, which checks every hub file out with CRLF while hubd appends
lines that end in LF. Off, the files on disk are the bytes in the repository:

```sh
git clone -c core.autocrlf=false git@git.example.com:team/hub.git ~/.hubd
hub card merge-driver
```

The drivers name `node.exe` by its full path, and git starts them through its own `sh`,
so they run as they do on any node.

Name the node. Without `HUBD_NODE` it takes the computer's name, and Windows names
computers like `DESKTOP-4F2K9QA`. Set it in the script the schedule runs,
`~/hub-mesh-sync.sh`:

```sh
export HUBD_NODE=pine
exec sh "$APPDATA/npm/node_modules/@bzdos/hubd/scripts/mesh-sync.sh" >> ~/.hubd/.mesh-sync.log 2>&1
```

`$APPDATA/npm` is npm's global folder on Windows; `npm root -g` says where if yours is
elsewhere. `.mesh-sync.log` is where `hub doctor` looks for the last error; add it to the
hub's `.gitignore` if it is not there yet. Run the script once by hand, and the log's
last line reads `mesh-sync: ok (pine ...)`.

Then schedule it every minute, from a PowerShell run as administrator. S4U logon runs
the task whether or not you are logged on, stores no password, and opens no console
window every minute:

```powershell
$a = New-ScheduledTaskAction -Execute 'C:\Program Files\Git\bin\bash.exe' -Argument "-l `"$HOME\hub-mesh-sync.sh`""
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
$p = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName hub-mesh-sync -Action $a -Trigger $t -Principal $p -Settings $s
```

The path is Git's default; use yours if it is installed elsewhere. The account comes
from the process token, not from `$env:USERDOMAIN`: in some sessions, an ssh one for
instance, that reads `WORKGROUP`, and the task is refused with "No mapping between
account names and security IDs". `IgnoreNew` skips a tick while the last run is still
going. `Unregister-ScheduledTask hub-mesh-sync` takes the task out.

Last, the agent. `hub setup` writes the `HUBD_NODE` of the shell it runs in into the
agent's config, so the agent's records carry the same node name as the sync's commits:

```sh
HUBD_NODE=pine hub setup --harness omp --agent dev-pine
```

After its first heartbeat and the next sync, `hub doctor` on any other node lists
`pine` under `fleet:`.

## What hubd refuses here, and why

**A deleted log.** Committing it would delete that history on every peer at the next
push.

```bash
elm rm /tmp/hub-tour-elm/queues/worker.elm.queue.md
elm sh "$MS"
```

```text
mesh-sync: REFUSED — an append-only log file was DELETED, not appended to:
    queues/worker.elm.queue.md
  Committing this would remove that history from every peer on the next push.
  Restore it, then re-sync:
    git -C "/tmp/hub-tour-elm" checkout -- queues/worker.elm.queue.md
  (Retiring a queue on purpose? hub gc --apply --by <you> MOVES it to queues/archive/ instead.)
```

It exits 4. The same refusal stops a task log that lost or changed a line: that is a
history rewritten instead of appended to, and syncing it would spread the damage.
Restore the file as it says, and the next run goes through.

Exit 4 also stops a commit in which another node's journal, queue or acks file lost
lines. Only that node writes them, so a shorter copy here is a tree older than the
branch, and committing it would take those lines out on every peer. A line that moved
into the file's archive (a journal's month, a block `hub queue dedupe` folded) is not
lost. A node that writes under more than one name lists the others in `HUBD_SYNC_OWN`.

The other exit codes say what to do next: `2` a merge conflict (a card without the
driver), `3` a failed push (retried on the next run; the commit is already local),
`5` a merge git refused before starting, such as two paths that differ only by case on
a case-insensitive disk; nothing conflicted, run `hub doctor`. `6` a git damaged by a
crash (below) on a node with no origin to repair it from. A push that lost a race
to another node's push is not a failure: the same run fetches, merges and pushes again,
up to `HUBD_SYNC_PUSH_TRIES` times in all (3 by default).

**A merge in place.** mesh-sync tries each merge outside the hub first, so a
conflicted one never reaches the folder your agents read: no conflict markers, no files
that change and change back. (A git older than 2.38 merges in place and aborts.)

**A node that died mid-commit.** A panic or a power cut inside a commit leaves empty
object files and a branch that names one, and every git command after it fails on a bad
object. mesh-sync repairs that in its next run. What is broken moves to
`.git/hubd-quarantine/<time>/`, nothing is deleted, and the branch goes to origin's.
Every file that is not this node's then takes origin's version, the tree's copy kept in
the quarantine; this node's own files stay as they are. The tree is the one from before
the crash: committed as it was, it would roll back every line the other nodes wrote
meanwhile.

**git's own background gc.** mesh-sync turns it off for its commit, fetch and merge,
and runs one `git gc --auto` itself after the push, in the foreground: on macOS a
background gc can crash and leave a lock that silently stops every gc after it.

## What you have now

One hub on two nodes, a sync that refuses to spread damage, and cards that merge by
section. When a folder turns out to have been a hub of its own all along, `hub absorb`
joins it as a new node instead of a hand copy ([12. Absorb](../scenarios/12-absorb.md)).
The warnings about mixed filesystems and `merge=union` are in
[7. A node stopped syncing](../scenarios/07-node-stopped-syncing.md#what-can-go-wrong).

Next: [5. Roles](5-roles.md) — a team with heads and workers, and the board that shows it.
