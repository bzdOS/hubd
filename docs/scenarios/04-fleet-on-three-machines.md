# 4. A fleet on three machines

**The situation.** Your agents run on three machines. The head works on your laptop,
the builds run on a box with the fast disks, and the backups run on a third. To know
how they stand you open three terminals, and a build reaches the head as a path on a
machine it cannot see, or as a file pasted into a chat.

**What you end with.** One hub on all three, kept in step by git. Each machine says
which of its roles are alive and how its disks are. A file one role makes for another
travels as a file and arrives with its size and checksum on record. One screen, on any
of the three, shows all of it.

Level 4: [4. A second machine](../start/4-second-machine.md) sets up the mesh between
two nodes and explains why they never conflict. Every output below is real, captured in
one run on three simulated nodes on one computer, so its clock reads minutes where the
story says hours.

```bash
export HUBD_DIR=/tmp/hub-s4-oak HUBD_TEAM_DIR=/tmp/hub-s4-oak HUBD_NODE=oak
MS="$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"
hub init "$HUBD_DIR" > /dev/null
git init -q --bare -b main /tmp/hub-s4-remote.git
git -C "$HUBD_DIR" init -q -b main
git -C "$HUBD_DIR" add -A && git -C "$HUBD_DIR" commit -qm hub
git -C "$HUBD_DIR" remote add origin /tmp/hub-s4-remote.git
git -C "$HUBD_DIR" push -q -u origin main
git clone -q /tmp/hub-s4-remote.git /tmp/hub-s4-elm
git clone -q /tmp/hub-s4-remote.git /tmp/hub-s4-cedar
on() ( n=$1; shift; export HUBD_DIR=/tmp/hub-s4-$n HUBD_TEAM_DIR=/tmp/hub-s4-$n HUBD_NODE=$n; "$@" )
for n in oak elm cedar; do on $n hub card merge-driver > /dev/null; done
sync() { for n in elm cedar oak elm cedar; do on $n sh "$MS" | grep -v '^mesh-sync: ok'; done; }
```

`oak` is the laptop, `elm` the build box, `cedar` the backup box. `on elm …` runs a
command as elm. On real machines each node runs mesh-sync every minute on its own;
here `sync` runs it on each node in turn, the first two twice so that each gets what
the last one pushed, and prints only a run that was not ok.

## Three machines, three roles

The roles are cards, so each one says where it runs and whom it answers to:

```bash
hub card shop -m "Web shop: catalogue, cart, checkout. 1.4.2 is the next release." --by alice
hub resource set head-shop --type role --attr rank=head --attr project=shop -m "Runs the shop track. On oak." --by alice
hub resource set builder --type role --attr project=shop --link head:head-shop -m "Builds and tests the release artifacts. On elm." --by alice
hub resource set backup --type role --attr project=shop --link head:head-shop -m "Nightly backups of the shop database. On cedar." --by alice
```

```text
Card set: shop → /tmp/hub-s4-oak/projects/shop.md
Resource set: head-shop → /tmp/hub-s4-oak/resources/head-shop.md
Resource set: builder → /tmp/hub-s4-oak/resources/builder.md
Resource set: backup → /tmp/hub-s4-oak/resources/backup.md
```

Each node's sessions send heartbeats to the hub on their own node:

```bash
hub heartbeat head-shop --role head-shop --status waiting
on elm hub heartbeat builder --role builder --status "building 1.4.2"
on cedar hub heartbeat backup --role backup --status waiting
sync
hub presence
```

```text
Heartbeat: head-shop -> /tmp/hub-s4-oak/presence/head-shop.json
Heartbeat: builder -> /tmp/hub-s4-elm/presence/builder.json
Heartbeat: backup -> /tmp/hub-s4-cedar/presence/backup.json
  seen from: cedar 1m (1) · elm 1m (1) · oak (here, 1)
  ● builder           builder    building … 2026-10-07 16:17  ←elm
  ● backup            backup     waiting    2026-10-07 16:17  ←cedar
  ● head-shop         head-shop  waiting    2026-10-07 16:17
(3 agents, generated 2026-10-07 16:17)
```

Asked on oak, `hub presence` knows all three, and which node each one runs on. A
heartbeat says a session is alive; it says nothing about the machine it runs on.

## Each node says how it stands

hubd does not measure the machine. A monitor on each node, a cron script of yours or
your fleet tool, writes `snapshot.<node>.json` into the hub every minute: the node's
sessions as its session manager sees them, its disks as `df` sees them, the relays it
runs. The mesh carries it to every node, like the presence files. Here a function
stands in for the three monitors:

```bash
snapshot() (   # node role state disk-used-% free-GB [relay]
  n=$1 ts=$(date -u +%FT%TZ) relays=
  [ -n "$6" ] && relays="{ \"pair\": \"$6\", \"active\": true, \"failed\": false, \"last_ok\": \"$ts\" }"
  cat > /tmp/hub-s4-$n/snapshot.$n.json <<EOF
{ "v": 1, "node": "$n", "ts": "$ts",
  "sessions": [ { "session": "$2", "role": "$2", "state": "$3", "hub_age_min": 0, "motion_min": 1 } ],
  "disks": [ { "mount": "/", "used_pct": $4, "free_gb": $5 } ],
  "relays": [ $relays ] }
EOF
)
snapshot oak head-shop IDLE 61 180 "elm→oak"
on elm snapshot elm builder WORKING 48 410
on cedar snapshot cedar backup IDLE 93 21
```

Each node writes only its own file, so the three never conflict. Oak runs one relay,
from elm to oak, which the next section uses.

## A build travels as a file

On elm, `builder` builds the release into its outbox for the head, and hands it in:
the result as a `FACT:`, the file with its path, size and checksum.

```bash
O=/tmp/hub-s4-files/elm/outbox/head-shop
mkdir -p $O && seq 1 40000 | gzip -n > $O/shop-1.4.2.tgz
on elm hub report -p shop --agent builder -k done <<EOF
FACT: shop 1.4.2 builds clean; unit and e2e suites 412/412
shop-1.4.2.tgz handed in on elm: $O/shop-1.4.2.tgz, $(wc -c < $O/shop-1.4.2.tgz | tr -d ' ') B, sha256 $(shasum -a 256 $O/shop-1.4.2.tgz | cut -c1-64)
EOF
sync
```

```text
Reported to shop: 1 fact, note
```

The report reaches oak with the next sync; the file does not. A path on elm is no use
to a head on oak, and an 86 KB archive does not belong in a message (hubd refuses one
over 16 KB). Files travel by relay: a program of yours, `rsync` over ssh on real
machines, that copies what is in a role's outbox on one node to its inbox on another,
checks the copy, and records the delivery in the journal. Here is what the elm-to-oak
relay does for one file:

```bash
relay() (   # role file
  src=/tmp/hub-s4-files/elm/outbox/$1/$2 dst=/tmp/hub-s4-files/oak/inbox/$1/$2
  mkdir -p "${dst%/*}" && cp "$src" "$dst"
  a=$(shasum -a 256 < "$src" | cut -c1-64) b=$(shasum -a 256 < "$dst" | cut -c1-64)
  [ "$a" = "$b" ] || { echo "relay: $2 changed on the way" >&2; exit 1; }
  hub report "elm → $1: $2 $(wc -c < "$dst" | tr -d ' ') B sha256 $b" -k delivery -p shop --agent mail-relay
)
relay head-shop shop-1.4.2.tgz
sync
hub log shop
```

```text
Reported to shop: note
  hint: a note-only report is usually coordination — "I'm on it" is a `hub claim`, not a report (see HUBD.md).
2026-10-07 16:17 [shop/builder] done: shop-1.4.2.tgz handed in on elm: /tmp/hub-s4-files/elm/outbox/head-shop/shop-1.4.2.tgz, 86236 B, sha256 7d3cfa9ebc166b49eed519d1a5469e6de5ccf28abdb505deec4393502c5a04c1
2026-10-07 16:17 [shop/alice] note: card set: Web shop: catalogue, cart, checkout. 1.4.2 is the next release.
2026-10-07 16:17 [shop/mail-relay] delivery: elm → head-shop: shop-1.4.2.tgz 86236 B sha256 7d3cfa9ebc166b49eed519d1a5469e6de5ccf28abdb505deec4393502c5a04c1
```

A delivery is a journal line of kind `delivery` in one fixed form, `<from> → <to>:
<name> <bytes> B sha256 <hex>`, so a program can read it. On oak, the head checks the
file it has against both lines:

```bash
shasum -a 256 /tmp/hub-s4-files/oak/inbox/head-shop/shop-1.4.2.tgz
```

```text
7d3cfa9ebc166b49eed519d1a5469e6de5ccf28abdb505deec4393502c5a04c1  /tmp/hub-s4-files/oak/inbox/head-shop/shop-1.4.2.tgz
```

The same 64 hex characters three times: as built on elm, as delivered, as it is on
oak. What the head accepts is that file.

## One screen

`hub serve` on any node shows the Summary: every track with its mail, and every node
from its own snapshot, with what is wrong in red. The same data, from its API:

```bash
hub serve -p 7790 &
curl -s localhost:7790/api/summary | jq -c '.nodes[] | {node, ageMin, stale, disks: [.disks[] | {mount, usedPct, full}], relays: [.relays[] | {pair, down}]}'
curl -s localhost:7790/api/summary | jq -c '.tracks[] | select(.project == "shop") | .mail[] | {from, to, name, bytes}'
kill %1
```

```text
hubd kanban  http://127.0.0.1:7790
  Summary: where each track stands   Tracks: roles, done, next, waiting for you   Live: kanban   History: sparkline + event playback
Ctrl+C to stop
{"node":"cedar","ageMin":0,"stale":false,"disks":[{"mount":"/","usedPct":93,"full":true}],"relays":[]}
{"node":"elm","ageMin":0,"stale":false,"disks":[{"mount":"/","usedPct":48,"full":false}],"relays":[]}
{"node":"oak","ageMin":0,"stale":false,"disks":[{"mount":"/","usedPct":61,"full":false}],"relays":[{"pair":"elm→oak","down":false}]}
{"from":"elm","to":"head-shop","name":"shop-1.4.2.tgz","bytes":86236}
```

cedar's disk is at 93%, and tonight's backup goes to it. Nobody had to log in to cedar
to find that out. The build sits with the head's track, because the head is its
recipient.

## What can go wrong

**A monitor that stopped.** Its node's last snapshot stays in the hub and looks as it
did. After 5 minutes without a new one the node reads `stale`, in red: how it stands
is no longer known, which is not the same as fine.

**A relay that died.** The files stay in the outbox and nothing says so on the
receiving side. A monitor that reports its relays as `active` and `failed` turns that
into `down` on the Summary, before anyone asks where the build is.

**A delivery line in another form.** The journal keeps it as written, but with no
recipient it can read, the line belongs to no track and shows on no track's mail. The
form is fixed so that nothing has to guess.

**The artifact in a message.** A message is prose. One over 16 KB, or one that carries
a diff, is refused, with the reason
([3. Queues](../start/3-queues.md#what-hubd-refuses-here-and-why)): put the file in an
outbox, send its path, size and sha256.

**A node that is silent.** No presence file from a node means nothing there has sent a
heartbeat, which is not the same as dead ([4. A second
machine](../start/4-second-machine.md#is-the-mesh-healthy)): `hub doctor` says
`SILENT` and why.

**Two nodes with one name.** The node's name is in the names of the files it writes and
in its ids. Unset, it is the first label of the host name, so `ci.eu.example` and
`ci.us.example` would both be `ci`, writing the same files and handing out the same
ids. Set `HUBD_NODE` on every node, in the sessions' environment and in mesh-sync's.
