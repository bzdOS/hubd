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

# ── exit 2: a genuine content clash on a non-union file ───────────────────────
git clone -q "$TMP/origin" "$TMP/b"
printf 'b writes here\n' > "$TMP/b/notes.md"
git -C "$TMP/b" add -A && git -C "$TMP/b" -c user.name=t -c user.email=t@t commit -q -m b
git -C "$TMP/b" push -q origin main
printf 'a writes something else\n' > "$TMP/a/notes.md"
HUBD_DIR="$TMP/a" sh "$SCRIPT" >"$TMP/out2" 2>&1; rc=$?
ok "$([ $rc -eq 2 ] && echo 1 || echo 0)" "conflict: a real content clash exits 2 (got $rc)"
ok "$(grep -q 'real content conflict' "$TMP/out2" && echo 1 || echo 0)" "conflict: and is named a content conflict"
ok "$(grep -q 'CONFLICT\|Merge conflict' "$TMP/out2" && echo 1 || echo 0)" "conflict: git's own output is shown, not swallowed"
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

echo ""
echo "$pass pass, $fail fail"
[ "$fail" -eq 0 ] || exit 1
