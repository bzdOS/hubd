#!/usr/bin/env bash
# What scripts/mesh-sync.sh says when a pull does not go through.
#
# The script had one message for every failure: "(real content conflict) — resolve by hand".
# It was wrong twice. Once for a missing git identity, and once for two tracked paths differing
# only by case, where git refuses BEFORE merging anything — no conflict exists, and resolving by
# hand cannot help. One node retried that failure every 60 seconds for 228 commits of the other
# nodes' history while its log confidently named the wrong cause.
#
# So the distinction is now behaviour, with its own exit code, and it is tested.
set -u
cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/mesh-sync.sh"
pass=0; fail=0
ok() { if [ "$1" = 1 ]; then pass=$((pass+1)); echo "PASS $2"; else fail=$((fail+1)); echo "FAIL $2"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_NOSYSTEM=1 HOME="$TMP/home"
mkdir -p "$HOME"

# A node whose git answers in Russian. Where this git has no Russian messages, the locale cases
# cannot fail here, and the run says so.
RU='LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8'
[ "$(env $RU git -C "$HOME" rev-parse 2>&1)" != "$(LC_ALL=C git -C "$HOME" rev-parse 2>&1)" ] ||
  echo "NOTE: git here has no Russian messages; the locale cases pass without testing anything"

mkhub() {    # mkhub <dir> — a hub-shaped git repo with the union attributes the mesh uses
  mkdir -p "$1" && git -C "$1" init -q -b main
  printf 'journal.*.jsonl   merge=union\ntasks.*.events.jsonl merge=union\n' > "$1/.gitattributes"
  printf '{"ts":"2026-09-01 10:00","kind":"note","text":"seed"}\n' > "$1/journal.seed.jsonl"
  git -C "$1" add -A && git -C "$1" -c user.name=t -c user.email=t@t commit -q -m seed
}

# ── exit 0: an ordinary round trip ────────────────────────────────────────────
mkhub "$TMP/origin"
git clone -q "$TMP/origin" "$TMP/a" && git -C "$TMP/a" config receive.denyCurrentBranch ignore
git -C "$TMP/origin" config receive.denyCurrentBranch ignore
printf '{"ts":"2026-09-01 11:00","kind":"note","text":"from a"}\n' >> "$TMP/a/journal.a.jsonl"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out0" 2>&1; rc=$?
ok "$([ $rc -eq 0 ] && echo 1 || echo 0)" "ok: a clean sync exits 0 (got $rc)"
ok "$(grep -q 'mesh-sync: ok' "$TMP/out0" && echo 1 || echo 0)" "ok: and says so"
# the commit carries HUBD_NODE, normalised as the file names are, so history and files name one node
printf '{"ts":"2026-09-01 11:01","kind":"note","text":"named"}\n' >> "$TMP/a/journal.a.jsonl"
HUBD_NODE='Pine_Box 2.local' HUBD_DIR="$TMP/a" sh "$SCRIPT" >/dev/null 2>&1
cn="$(git -C "$TMP/a" log -1 --format=%cn)"
ok "$([ "$cn" = 'pine_box-2' ] && echo 1 || echo 0)" "node name: commits under HUBD_NODE, normalised like journal.<node>.jsonl (got $cn)"

# ── exit 2: a genuine content clash on a non-union file ───────────────────────
git clone -q "$TMP/origin" "$TMP/b"
# The merge is tried outside the tree first, and a union file written on both sides must still
# merge there: a node that reads it as a conflict would stop syncing for good.
mkdir -p "$TMP/b/queues"; printf '\n## 2026-09-01 12:00 · from b · id 1\nfirst\n' > "$TMP/b/queues/r.b.queue.md"
printf '{"ts":"2026-09-01 12:00","kind":"note","text":"b"}\n' >> "$TMP/b/journal.seed.jsonl"
git -C "$TMP/b" add -A && git -C "$TMP/b" -c user.name=t -c user.email=t@t commit -q -m q && git -C "$TMP/b" push -q origin main
printf '{"ts":"2026-09-01 12:00","kind":"note","text":"a"}\n' >> "$TMP/a/journal.seed.jsonl"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out1" 2>&1; rc=$?
ok "$([ $rc -eq 0 ] && [ "$(grep -c '"text":"[ab]"' "$TMP/a/journal.seed.jsonl")" = 2 ] && echo 1 || echo 0)" "union: a file both sides appended to merges cleanly (got $rc)"
git -C "$TMP/b" pull -q origin main
printf '\n## 2026-09-01 12:01 · from b · id 2\nsecond\n' >> "$TMP/b/queues/r.b.queue.md"
printf 'b writes here\n' > "$TMP/b/notes.md"
git -C "$TMP/b" add -A && git -C "$TMP/b" -c user.name=t -c user.email=t@t commit -q -m b
git -C "$TMP/b" push -q origin main
printf 'a writes something else\n' > "$TMP/a/notes.md"
# A merge that stood open in the hub put the other side's version of every file it touched there
# until the abort put it back; a queue reader took a block from it, and lost its place when the
# file came back shorter. The file a reader polls must not change at all.
fstat() { node -e 'const s = require("fs").statSync(process.argv[1]); console.log(s.ino, s.mtimeMs, s.ctimeMs)' "$1"; }
qa="$TMP/a/queues/r.b.queue.md"; qbefore="$(fstat "$qa") $(cksum < "$qa")"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out2" 2>&1; rc=$?
ok "$([ $rc -eq 2 ] && echo 1 || echo 0)" "conflict: a real content clash exits 2 (got $rc)"
ok "$(grep -q 'real content conflict' "$TMP/out2" && echo 1 || echo 0)" "conflict: and is named a content conflict"
ok "$(grep -q 'CONFLICT\|Merge conflict' "$TMP/out2" && echo 1 || echo 0)" "conflict: git's own output is shown, not swallowed"
ok "$([ "$(fstat "$qa") $(cksum < "$qa")" = "$qbefore" ] && echo 1 || echo 0)" \
  "conflict: a queue file the other side appended to is never touched - same inode, times and bytes"
git -C "$TMP/a" checkout -q -- . 2>/dev/null; git -C "$TMP/a" merge --abort 2>/dev/null

# ── exit 5: git refuses before merging, so nothing conflicted ─────────────────
# Built with plumbing, because the filesystem this matters on cannot create the pair: two paths
# differing only by case go into the INDEX, which is where the collision lives.
probe="$TMP/CaseProbe"; : > "$probe"
if [ -e "$TMP/caseprobe" ]; then
  # Stage one: the mesh holds only the LEGACY spelling, and this node checks it out normally.
  mkhub "$TMP/origin2"
  git -C "$TMP/origin2" config receive.denyCurrentBranch ignore
  mkdir -p "$TMP/origin2/queues"
  printf 'legacy spelling\n' > "$TMP/origin2/queues/r.Node.queue.md"
  git -C "$TMP/origin2" add -A && git -C "$TMP/origin2" -c user.name=t -c user.email=t@t commit -q -m legacy
  git clone -q "$TMP/origin2" "$TMP/c"

  # Stage two: hubd starts writing the node name lowercased, so a second path joins the first in
  # the mesh. On a case-sensitive node that is two files and nothing breaks.
  meshadd() {   # meshadd <path> <content> — put a path into origin2's tree without a worktree
    b=$(printf '%s\n' "$2" | git -C "$TMP/origin2" hash-object -w --stdin)
    git -C "$TMP/origin2" update-index --add --cacheinfo 100644,"$b","$1"
    t=$(git -C "$TMP/origin2" write-tree)
    c=$(git -C "$TMP/origin2" -c user.name=t -c user.email=t@t commit-tree "$t" -p HEAD -m "$1")
    git -C "$TMP/origin2" update-ref refs/heads/main "$c"
  }
  meshadd queues/r.node.queue.md 'current spelling'
  git -C "$TMP/c" -c user.name=t -c user.email=t@t pull --no-rebase --no-edit -q origin main

  # This node now holds ONE file for TWO index entries, and that is not a state it can leave.
  # git maps the file on disk to the lowercase entry, which matches; the other entry stays
  # modified with no file that can ever satisfy it. So `git add -A` stages nothing and the commit
  # is empty -- which is exactly why "resolve by hand" was impossible advice, not merely unclear.
  git -C "$TMP/c" add -A
  ok "$(git -C "$TMP/c" diff --cached --quiet && echo 1 || echo 0)" \
    "case: the colliding path cannot be staged away - add -A has nothing to offer it"
  ok "$(git -C "$TMP/c" status --porcelain | grep -q 'r.Node.queue.md' && echo 1 || echo 0)" \
    "case: and the hub stays permanently dirty on that path"

  # Stage three: the far node edits the LEGACY path, so the merge must write the one file this
  # node can never make clean. This is the failure that repeated for 228 commits.
  meshadd queues/r.Node.queue.md 'legacy spelling, updated'
  HUBD_DIR="$TMP/c" sh "$SCRIPT" >"$TMP/out5" 2>&1; rc=$?
  ok "$([ $rc -eq 5 ] && echo 1 || echo 0)" "case: a pull refused before merging exits 5, not 2 (got $rc)"
  ok "$(grep -q 'REFUSED' "$TMP/out5" && grep -q 'nothing conflicted' "$TMP/out5" && echo 1 || echo 0)" \
    "case: and does not tell a human to resolve a conflict that does not exist"
  ok "$(grep -q 'differing only by case' "$TMP/out5" && echo 1 || echo 0)" "case: it names the actual cause"
  ok "$(grep -q 'hub doctor' "$TMP/out5" && echo 1 || echo 0)" "case: and where to see which paths collide"
  # This failure is told apart by git's own words, and on a node whose git speaks Russian those
  # words are translated: the refusal fell through to "merge failed".
  env $RU HUBD_DIR="$TMP/c" sh "$SCRIPT" >"$TMP/out5r" 2>&1; rc=$?
  ok "$([ $rc -eq 5 ] && grep -q 'REFUSED' "$TMP/out5r" && echo 1 || echo 0)" "locale: under a Russian locale the refusal is still exit 5 (got $rc)"

  # doctor is the other half: it must name the pair even though this hub cannot check it out.
  coll=$(HUBD_DIR="$TMP/c" HUBD_TEAM_DIR="$TMP/c" node hub/cli.mjs doctor 2>&1 | grep -c 'r.Node.queue.md')
  ok "$([ "$coll" -ge 1 ] && echo 1 || echo 0)" "doctor: names a case-colliding path that only the REMOTE has"
else
  echo "SKIP case-collision cases (filesystem is case-sensitive; the collision cannot be reproduced here)"
fi

# ── exit 4: the append-only guard still fires before anything else ────────────
printf '{"ts":"2026-09-01 10:00","ev":"add","id":"n-1"}\n' > "$TMP/a/tasks.n.events.jsonl"
git -C "$TMP/a" add -A && git -C "$TMP/a" -c user.name=t -c user.email=t@t commit -q -m ev
: > "$TMP/a/tasks.n.events.jsonl"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out4" 2>&1; rc=$?
ok "$([ $rc -eq 4 ] && echo 1 || echo 0)" "append-only: a truncated event log still refuses with 4 (got $rc)"

git -C "$TMP/a" checkout -q -- . 2>/dev/null

# ── exit 4: a DELETED log file is the same damage by another route ────────────
rm -f "$TMP/a/journal.seed.jsonl"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out6" 2>&1; rc=$?
ok "$([ $rc -eq 4 ] && echo 1 || echo 0)" "deleted log: removing an append-only log refuses with 4 (got $rc)"
ok "$(grep -q 'journal.seed.jsonl' "$TMP/out6" && echo 1 || echo 0)" "deleted log: the refusal names the file"
ok "$(grep -q 'gc --apply' "$TMP/out6" && echo 1 || echo 0)" "deleted log: and points at the operation that retires a queue properly"
git -C "$TMP/a" checkout -q -- . 2>/dev/null

# ── the one accepted deletion: a move into an archive, bytes intact ───────────
# hub gc (and hub queue gc) retire a queue by moving it to queues/archive/. The guard used to
# refuse exactly the operation its own message recommended.
mkdir -p "$TMP/a/queues"
printf '\n## 2026-01-01 00:00 · from x\nold order\n' > "$TMP/a/queues/dead.n.queue.md"
git -C "$TMP/a" add -A && git -C "$TMP/a" -c user.name=t -c user.email=t@t commit -q -m q
mkdir -p "$TMP/a/queues/archive" && mv "$TMP/a/queues/dead.n.queue.md" "$TMP/a/queues/archive/"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out9" 2>&1; rc=$?
ok "$([ $rc -ne 4 ] && echo 1 || echo 0)" "archive: a queue moved to queues/archive/ with its bytes intact is accepted (got $rc)"
ok "$([ -z "$(git -C "$TMP/a" status --porcelain)" ] && git -C "$TMP/a" cat-file -e HEAD:queues/archive/dead.n.queue.md 2>/dev/null && echo 1 || echo 0)" "archive: and the move is committed as a move"
printf '\n## 2026-01-01 00:00 · from x\nanother\n' > "$TMP/a/queues/dead2.n.queue.md"
git -C "$TMP/a" add -A && git -C "$TMP/a" -c user.name=t -c user.email=t@t commit -q -m q2
mv "$TMP/a/queues/dead2.n.queue.md" "$TMP/a/queues/archive/" && printf 'edited\n' >> "$TMP/a/queues/archive/dead2.n.queue.md"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out10" 2>&1; rc=$?
ok "$([ $rc -eq 4 ] && echo 1 || echo 0)" "archive: a moved copy whose bytes changed is still a deletion and refused (got $rc)"
rm -f "$TMP/a/queues/archive/dead2.n.queue.md"; git -C "$TMP/a" checkout -q -- . 2>/dev/null

# ── hub gc on two nodes: A archives its own shard while B appends to its own ──
# A shard has one writer, the node in its name. gc once archived other nodes' shards too, and the
# owner node, appending meanwhile, was left with a modify/delete conflict and a stopped sync. So gc
# moves only this node's shards, and the two nodes' changes never touch one file.
CLI="node $PWD/hub/cli.mjs"
mkhub "$TMP/origin4"; git -C "$TMP/origin4" config receive.denyCurrentBranch ignore
mkdir -p "$TMP/origin4/queues"
printf '\n## 2026-01-01 00:00 · from x\nold order to w on na\n' > "$TMP/origin4/queues/w.na.queue.md"
printf '\n## 2026-01-01 00:00 · from x\nold order to w on nb\n' > "$TMP/origin4/queues/w.nb.queue.md"
git -C "$TMP/origin4" add -A && git -C "$TMP/origin4" -c user.name=t -c user.email=t@t commit -q -m queues
git clone -q "$TMP/origin4" "$TMP/na"; git clone -q "$TMP/origin4" "$TMP/nb"
HUBD_DIR="$TMP/na" HUBD_TEAM_DIR="$TMP/na" HUBD_NODE=na $CLI resource set live --type role --attr rank=worker --attr project=p --by t >/dev/null 2>&1
# nb is a live node: it publishes its presence snapshot, as every heartbeating node does
printf '{"node":"nb","written":"%s","agents":[]}\n' "$(date -u '+%Y-%m-%d %H:%M')" > "$TMP/nb/presence.nb.json"
HUBD_DIR="$TMP/na" sh "$SCRIPT" >/dev/null 2>&1; HUBD_DIR="$TMP/nb" sh "$SCRIPT" >/dev/null 2>&1; HUBD_DIR="$TMP/na" sh "$SCRIPT" >/dev/null 2>&1
HUBD_DIR="$TMP/na" HUBD_TEAM_DIR="$TMP/na" HUBD_NODE=na $CLI gc --apply --by t >"$TMP/out11" 2>&1
ok "$([ -f "$TMP/na/queues/archive/w.na.queue.md" ] && [ -f "$TMP/na/queues/w.nb.queue.md" ] && echo 1 || echo 0)" "gc two nodes: A archives its own shard and leaves B's where it is"
printf '\n## 2026-09-30 12:00 · from x\nnew order to w on nb\n' >> "$TMP/nb/queues/w.nb.queue.md"
HUBD_DIR="$TMP/nb" sh "$SCRIPT" >"$TMP/out12" 2>&1; rcb=$?
HUBD_DIR="$TMP/na" sh "$SCRIPT" >"$TMP/out13" 2>&1; rca=$?
HUBD_DIR="$TMP/nb" sh "$SCRIPT" >"$TMP/out14" 2>&1; rcb2=$?
ok "$([ $rcb -eq 0 ] && [ $rca -eq 0 ] && [ $rcb2 -eq 0 ] && echo 1 || echo 0)" "gc two nodes: both sync cleanly across the archive and the append (got B $rcb, A $rca, B $rcb2)"
ok "$(grep -q 'new order to w on nb' "$TMP/na/queues/w.nb.queue.md" && [ ! -e "$TMP/nb/queues/w.na.queue.md" ] && [ -f "$TMP/nb/queues/archive/w.na.queue.md" ] && echo 1 || echo 0)" "gc two nodes: A has B's append, B has A's archive"

# ── project cards: a conflict in any locale, and a merge by section ───────────
# A card is the file several nodes rewrite within the same minute. One node appends to the card's
# last section, the other adds a section after it: for git's text merge that is one clash.
card() { printf -- '---\nslug: p\n---\n# p\n\n- slug: p\n- set: 2026-09-01 10:00 by t\n\n## Digest\n\nwhat p is\n\n## Facts\n\n- one\n- two\n\n## Next step\n\n- ship it\n'; }
mkcards() {   # mkcards <origin> <node1> <node2> — one card in the mesh, two nodes holding it
  mkhub "$1"; git -C "$1" config receive.denyCurrentBranch ignore
  mkdir -p "$1/projects"; card > "$1/projects/p.md"
  git -C "$1" add -A && git -C "$1" -c user.name=t -c user.email=t@t commit -q -m card
  git clone -q "$1" "$2"; git clone -q "$1" "$3"
}
edit_sections() {   # edit_sections <node1> <node2> — two different sections, both at the end of the card
  printf -- '- later, from the first node\n' >> "$1/projects/p.md"
  printf -- '\n## Notes\n\n- from the second node\n' >> "$2/projects/p.md"
}
subst() { node -e 'const fs = require("fs"), [f, a, b] = process.argv.slice(1); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(a, b))' "$@"; }
markers() { grep -cE '^(<<<<<<<|=======|>>>>>>>)' "$1"; }

# Without the driver, and with no union attribute for cards: a real conflict, named as one in
# Russian too. The measured node said "pull failed" here, and its mesh stood for 2.5 and 4.5 hours.
mkcards "$TMP/oc" "$TMP/c1" "$TMP/c2"
edit_sections "$TMP/c1" "$TMP/c2"
HUBD_DIR="$TMP/c1" sh "$SCRIPT" >/dev/null 2>&1
env $RU HUBD_DIR="$TMP/c2" sh "$SCRIPT" >"$TMP/out15" 2>&1; rc=$?
ok "$([ $rc -eq 2 ] && echo 1 || echo 0)" "locale: a card conflict under a Russian locale exits 2 (got $rc)"
ok "$(grep -q 'real content conflict' "$TMP/out15" && echo 1 || echo 0)" "locale: and is named a content conflict, not a failed pull"

# With the driver, installed on each node by hubd: the same two edits converge.
mkcards "$TMP/od" "$TMP/d1" "$TMP/d2"
for n in d1 d2; do HUBD_DIR="$TMP/$n" HUBD_TEAM_DIR="$TMP/$n" HUBD_NODE=$n $CLI card merge-driver >"$TMP/out-$n" 2>&1; done
ok "$(grep -qx 'projects/\*.md merge=hubd-card' "$TMP/d2/.git/info/attributes" && ! grep -q hubd-card "$TMP/d2/.gitattributes" && echo 1 || echo 0)" \
  "driver: hub card merge-driver installs it in the node's own .git, not in the shared attributes"
edit_sections "$TMP/d1" "$TMP/d2"
HUBD_DIR="$TMP/d1" sh "$SCRIPT" >/dev/null 2>&1; r1=$?
HUBD_DIR="$TMP/d2" sh "$SCRIPT" >"$TMP/out16" 2>&1; r2=$?
HUBD_DIR="$TMP/d1" sh "$SCRIPT" >/dev/null 2>&1; r3=$?
ok "$([ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ $r3 -eq 0 ] && echo 1 || echo 0)" "driver: two nodes editing different sections of one card both sync cleanly (got $r1 $r2 $r3)"
ok "$(cmp -s "$TMP/d1/projects/p.md" "$TMP/d2/projects/p.md" && grep -q 'later, from the first node' "$TMP/d1/projects/p.md" && grep -q 'from the second node' "$TMP/d1/projects/p.md" && ! grep -q '<!-- hubd:' "$TMP/d1/projects/p.md" && echo 1 || echo 0)" \
  "driver: and converge on one card holding both edits, nothing marked"
ok "$([ "$(git -C "$TMP/d1" rev-parse 'HEAD^{tree}')" = "$(git -C "$TMP/d2" rev-parse 'HEAD^{tree}')" ] && echo 1 || echo 0)" "driver: the two nodes hold the same tree"

# One section, changed on both nodes: both versions are kept and marked, and nothing stops.
subst "$TMP/d1/projects/p.md" '- ship it' '- ship it today'
subst "$TMP/d2/projects/p.md" '- ship it' '- wait for review'
HUBD_DIR="$TMP/d1" sh "$SCRIPT" >/dev/null 2>&1; r1=$?
HUBD_DIR="$TMP/d2" sh "$SCRIPT" >"$TMP/out17" 2>&1; r2=$?
ok "$([ $r1 -eq 0 ] && [ $r2 -eq 0 ] && grep -q 'ship it today' "$TMP/d2/projects/p.md" && grep -q 'wait for review' "$TMP/d2/projects/p.md" && echo 1 || echo 0)" \
  "driver: the same section changed on both nodes keeps both versions (got $r1 $r2)"
ok "$(grep -q '<!-- hubd: two nodes changed this section' "$TMP/d2/projects/p.md" && [ "$(markers "$TMP/d2/projects/p.md")" = 0 ] && echo 1 || echo 0)" \
  "driver: marked for a person to look at, with no conflict markers in the card"

# hubd moved and the driver's path went stale: the merge falls back to a union, and goes on.
for n in d1 d2; do git -C "$TMP/$n" config merge.hubd-card.driver "$(git -C "$TMP/$n" config merge.hubd-card.driver | sed 's#card-merge\.mjs#card-merge-moved.mjs#')"; done
HUBD_DIR="$TMP/d1" sh "$SCRIPT" >/dev/null 2>&1
subst "$TMP/d1/projects/p.md" '- one' '- one, from the first node'
subst "$TMP/d2/projects/p.md" '- one' '- one, from the second node'
HUBD_DIR="$TMP/d1" sh "$SCRIPT" >/dev/null 2>&1; r1=$?
HUBD_DIR="$TMP/d2" sh "$SCRIPT" >"$TMP/out18" 2>&1; r2=$?
ok "$([ $r1 -eq 0 ] && [ $r2 -eq 0 ] && grep -q 'one, from the first node' "$TMP/d2/projects/p.md" && grep -q 'one, from the second node' "$TMP/d2/projects/p.md" && [ "$(markers "$TMP/d2/projects/p.md")" = 0 ] && echo 1 || echo 0)" \
  "driver: a stale driver path falls back to a union merge; the mesh does not stop (got $r1 $r2)"

# ── a file one node rewrites whole: the newer version, in a merge and a rebase ──
# One node's snapshot, rewritten in two clones at once: history repaired so that its writes sit on
# both sides, or one node name in two clones. Every line with a time differs, and git stops.
snap() { printf '{\n "v": 1,\n "node": "fir",\n "ts": "%s",\n "sessions": [{"session": "s", "state": "%s"}]\n}\n' "$1" "$2"; }
mksnaps() {   # mksnaps <origin> <clone1> <clone2> — one snapshot in the mesh, two clones holding it
  mkhub "$1"; git -C "$1" config receive.denyCurrentBranch ignore
  snap 2026-10-05T14:00:00Z IDLE > "$1/snapshot.fir.json"
  git -C "$1" add -A && git -C "$1" -c user.name=t -c user.email=t@t commit -q -m snap
  git clone -q "$1" "$2"; git clone -q "$1" "$3"
}
put() { snap "$2" "$3" > "$1/snapshot.fir.json" && git -C "$1" -c user.name=t -c user.email=t@t commit -qam "snap $2"; }
newer() { grep -q '"ts": "2026-10-05T14:06:30Z"' "$1/snapshot.fir.json" && [ "$(markers "$1/snapshot.fir.json")" = 0 ]; }

mksnaps "$TMP/osn" "$TMP/sn1" "$TMP/sn2"
put "$TMP/sn1" 2026-10-05T14:05:00Z WORKING && git -C "$TMP/sn1" push -q origin main
put "$TMP/sn2" 2026-10-05T14:06:30Z DOWN
git -C "$TMP/sn2" -c user.name=t -c user.email=t@t pull -q --rebase origin main >/dev/null 2>&1; rc=$?
git -C "$TMP/sn2" rebase --abort >/dev/null 2>&1
ok "$([ $rc -ne 0 ] && echo 1 || echo 0)" "state: without the driver, two rewrites of one snapshot stop a pull --rebase (got $rc)"

mksnaps "$TMP/ost" "$TMP/st1" "$TMP/st2"
for n in st1 st2; do HUBD_DIR="$TMP/$n" HUBD_TEAM_DIR="$TMP/$n" HUBD_NODE=$n $CLI card merge-driver >/dev/null 2>&1; done
put "$TMP/st1" 2026-10-05T14:05:00Z WORKING && git -C "$TMP/st1" push -q origin main
put "$TMP/st2" 2026-10-05T14:06:30Z DOWN
git -C "$TMP/st2" -c user.name=t -c user.email=t@t pull -q --rebase origin main >"$TMP/out-st1" 2>&1; rc=$?
ok "$([ $rc -eq 0 ] && newer "$TMP/st2" && echo 1 || echo 0)" "state: with the driver, pull --rebase goes through and keeps the newer snapshot, the replayed one (got $rc)"
git -C "$TMP/st2" push -q origin main
put "$TMP/st1" 2026-10-05T14:06:00Z IDLE
git -C "$TMP/st1" -c user.name=t -c user.email=t@t pull -q --rebase origin main >"$TMP/out-st2" 2>&1; rc=$?
ok "$([ $rc -eq 0 ] && newer "$TMP/st1" && echo 1 || echo 0)" "state: and keeps upstream's when the replayed one is older (got $rc)"

put "$TMP/st1" 2026-10-05T14:07:00Z WORKING
put "$TMP/st2" 2026-10-05T14:08:00Z DOWN
HUBD_DIR="$TMP/st1" sh "$SCRIPT" >/dev/null 2>&1; r1=$?
HUBD_DIR="$TMP/st2" sh "$SCRIPT" >"$TMP/out-st3" 2>&1; r2=$?
HUBD_DIR="$TMP/st1" sh "$SCRIPT" >/dev/null 2>&1; r3=$?
ok "$([ $r1 -eq 0 ] && [ $r2 -eq 0 ] && [ $r3 -eq 0 ] && grep -q '14:08:00Z' "$TMP/st1/snapshot.fir.json" && cmp -s "$TMP/st1/snapshot.fir.json" "$TMP/st2/snapshot.fir.json" && echo 1 || echo 0)" \
  "state: mesh-sync merges the two rewrites and both clones hold the newer one (got $r1 $r2 $r3)"

# hubd moved and the driver's path went stale: the file keeps git's ours, and the mesh goes on.
for n in st1 st2; do git -C "$TMP/$n" config merge.hubd-state.driver "$(git -C "$TMP/$n" config merge.hubd-state.driver | sed 's#state-merge\.mjs#state-merge-moved.mjs#')"; done
put "$TMP/st1" 2026-10-05T14:10:00Z WORKING
put "$TMP/st2" 2026-10-05T14:09:00Z DOWN
HUBD_DIR="$TMP/st1" sh "$SCRIPT" >/dev/null 2>&1; r1=$?
HUBD_DIR="$TMP/st2" sh "$SCRIPT" >"$TMP/out-st4" 2>&1; r2=$?
ok "$([ $r1 -eq 0 ] && [ $r2 -eq 0 ] && grep -q '14:09:00Z' "$TMP/st2/snapshot.fir.json" && [ "$(markers "$TMP/st2/snapshot.fir.json")" = 0 ] && echo 1 || echo 0)" \
  "state: a stale driver path keeps ours, whole; the mesh does not stop (got $r1 $r2)"

# ── a shared hub stays group-writable after a pull ────────────────────────────
# The fleet case: this script runs as root, the roles run as another user in the group. Anything
# a pull creates is the puller's, and a role then reads everything and writes nothing.
mkhub "$TMP/origin3"; git -C "$TMP/origin3" config receive.denyCurrentBranch ignore
git clone -q "$TMP/origin3" "$TMP/s"; chmod 2775 "$TMP/s"
mkdir -p "$TMP/origin3/queues" && printf 'x\n' > "$TMP/origin3/queues/r.n.queue.md"
git -C "$TMP/origin3" add -A && git -C "$TMP/origin3" -c user.name=t -c user.email=t@t commit -q -m q
HUBD_DIR="$TMP/s" sh "$SCRIPT" >"$TMP/out7" 2>&1
gw() {   # gw <path> -> 1 when the group-write bit is set
  case "$(ls -ld "$1" | cut -c1-10)" in
    ?????w*) echo 1 ;;
    *) echo 0 ;;
  esac
}
perm=$(ls -ld "$TMP/s/queues" | cut -c1-10)
ok "$(gw "$TMP/s/queues")" "shared hub: a directory the pull created is group-writable ($perm)"
ok "$(gw "$TMP/s/queues/r.n.queue.md")" "shared hub: so is the file in it"
# A sync that stops still wrote: the commit and the fetch put objects into .git.
git clone -q "$TMP/origin3" "$TMP/s2"; chmod 2775 "$TMP/s2"
printf 'mesh side\n' > "$TMP/origin3/notes.md"
git -C "$TMP/origin3" add -A && git -C "$TMP/origin3" -c user.name=t -c user.email=t@t commit -q -m notes
printf 'node side\n' > "$TMP/s2/notes.md"
(umask 022; HUBD_DIR="$TMP/s2" sh "$SCRIPT" >"$TMP/out19" 2>&1); rc=$?
nw=$(find "$TMP/s2/.git" -type d ! -perm -g+w | wc -l | tr -d ' ')
ok "$([ $rc -eq 2 ] && [ "$nw" = 0 ] && echo 1 || echo 0)" "shared hub: a sync that stops on a conflict still leaves .git group-writable (got $rc, $nw dirs without g+w)"
# A private hub is left exactly as it was.
git clone -q "$TMP/origin3" "$TMP/p"; chmod 700 "$TMP/p"
printf 'y\n' > "$TMP/origin3/queues/r2.n.queue.md"
git -C "$TMP/origin3" add -A && git -C "$TMP/origin3" -c user.name=t -c user.email=t@t commit -q -m q2
HUBD_DIR="$TMP/p" sh "$SCRIPT" >"$TMP/out8" 2>&1
ok "$([ "$(gw "$TMP/p")" = 0 ] && echo 1 || echo 0)" "private hub: modes are not touched"

# ── packing: one gc a run, in the foreground ──────────────────────────────────
# git's own gc forks into the background. On macOS the forked process crashed and left
# .git/gc.log.lock, and every background gc after it stopped on that lock without a word: one hub
# went seven weeks unpacked. Two packs and gc.autoPackLimit=1 make a gc due here; the stale lock is
# the one that hub had. The origin packs on its own after a push (receive.autogc); that is the
# peer's housekeeping, not this node's, so it is off here and the trace counts only the node.
mkhub "$TMP/origin5"; git -C "$TMP/origin5" config receive.denyCurrentBranch ignore
git -C "$TMP/origin5" config receive.autogc false
git clone -q "$TMP/origin5" "$TMP/h" && git -C "$TMP/h" repack -q
printf 'more\n' > "$TMP/h/notes.md"
git -C "$TMP/h" add -A && git -C "$TMP/h" -c user.name=t -c user.email=t@t commit -q -m more
git -C "$TMP/h" repack -q && git -C "$TMP/h" config gc.autoPackLimit 1
: > "$TMP/h/.git/gc.log.lock"
printf '{"ts":"2026-09-01 13:00","kind":"note","text":"h"}\n' >> "$TMP/h/journal.h.jsonl"
GIT_TRACE="$TMP/trace" HUBD_DIR="$TMP/h" sh "$SCRIPT" >"$TMP/out9" 2>&1; rc=$?
packs=$(ls "$TMP/h/.git/objects/pack" | grep -c '\.pack$')
ok "$([ $rc -eq 0 ] && [ "$packs" = 1 ] && echo 1 || echo 0)" "gc: a gc that is due packs, past a stale gc.log.lock (got $rc, $packs packs)"
gcs=$(grep -c 'built-in: git gc ' "$TMP/trace"); mnt=$(grep -c 'maintenance run' "$TMP/trace")
ok "$([ "$gcs" = 1 ] && [ "$mnt" = 0 ] && echo 1 || echo 0)" \
  "gc: one gc a run, none started by the commit, fetch or merge (got $gcs gc, $mnt maintenance)"
# A failed push still packs: a peer down for days must not leave the node unpacked for days.
git -C "$TMP/h" config remote.origin.pushurl "$TMP/nowhere"
printf '{"ts":"2026-09-01 13:01","kind":"note","text":"h2"}\n' >> "$TMP/h/journal.h.jsonl"
: > "$TMP/trace"
GIT_TRACE="$TMP/trace" HUBD_DIR="$TMP/h" sh "$SCRIPT" >"$TMP/out10" 2>&1; rc=$?
gcs=$(grep -c 'built-in: git gc ' "$TMP/trace")
ok "$([ $rc -eq 3 ] && [ "$gcs" = 1 ] && grep -q 'push failed' "$TMP/out10" && echo 1 || echo 0)" \
  "gc: a failed push still packs, and still exits 3 and says so (got $rc, $gcs gc)"

echo ""
echo "$pass pass, $fail fail"
[ "$fail" -eq 0 ] || exit 1
