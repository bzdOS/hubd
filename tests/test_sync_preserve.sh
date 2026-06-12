#!/bin/sh
# test_sync_preserve.sh — sync must not destroy hand-written card content.
# Harvest-format cards carry YAML frontmatter (status/parent/related/owner_kind)
# and a hand-written "## Facts" section; runSync owns only the meta block,
# "## Digest" and "## Facts (auto)". Exit 1 on any failure.
#
#   sh tests/test_sync_preserve.sh
set -u

REPO="$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)" || exit 1
CLI="node $REPO/hub/cli.mjs"

PASS=0
FAIL=0

ok() {
  PASS=$((PASS + 1))
  printf 'PASS %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL %s\n' "$1"
}

check() {
  # check <label> <condition: 0=true>
  if [ "$2" -eq 0 ]; then
    ok "$1"
  else
    fail "$1"
  fi
}

TMP=$(mktemp -d)
export HUBD_DIR="$TMP/hub"
mkdir -p "$TMP/hub/projects" "$TMP/proj/widget" "$TMP/proj/plain"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

CARD="$TMP/hub/projects/widget.md"
HIST="$TMP/hub/projects/history/widget.md"

cat > "$CARD" <<'EOF'
---
slug: widget
status: background-slow-burn
parent: null
related: [[hubd]]
owner_kind: human
---
## Digest

Old digest line.

## Facts

- hand fact one
- hand fact two
EOF

# -- Case 1: sync over a harvest card keeps every hand-written part ----------

$CLI sync "$TMP/proj/widget" -m "New digest line." > /dev/null 2>&1
check "sync harvest card: exit 0" $?

head -1 "$CARD" | grep -qx -- '---'
check "frontmatter: card still starts with ---" $?

for FIELD in 'slug: widget' 'status: background-slow-burn' 'parent: null' 'related: [[hubd]]' 'owner_kind: human'; do
  grep -qF -- "$FIELD" "$CARD"
  check "frontmatter field kept: $FIELD" $?
done

grep -qF -- '- hand fact one' "$CARD"
check "hand Facts: fact one kept" $?
grep -qF -- '- hand fact two' "$CARD"
check "hand Facts: fact two kept" $?

grep -qF -- 'New digest line.' "$CARD"
check "digest: updated" $?
grep -qF -- '## Facts (auto)' "$CARD"
check "auto facts: block written" $?

[ -f "$HIST" ] && grep -qF -- 'Old digest line.' "$HIST"
check "history: old digest archived" $?

# Section order: hand Facts must stay between Digest and Facts (auto)
awk '/^## Digest/{d=NR} /^## Facts$/{f=NR} /^## Facts \(auto\)/{a=NR} END{exit !(d<f && f<a)}' "$CARD"
check "section order: Digest < Facts < Facts (auto)" $?

# -- Case 2: second sync (keep-digest path) does not duplicate or lose -------

echo "" | $CLI sync "$TMP/proj/widget" > /dev/null 2>&1
check "second sync: exit 0" $?

[ "$(grep -cF -- 'status: background-slow-burn' "$CARD")" -eq 1 ]
check "second sync: frontmatter not duplicated" $?
[ "$(grep -cF -- '- hand fact one' "$CARD")" -eq 1 ]
check "second sync: hand facts not duplicated" $?
grep -qF -- 'New digest line.' "$CARD"
check "second sync: digest survived" $?
head -1 "$CARD" | grep -qx -- '---'
check "second sync: frontmatter still first" $?

# -- Case 3: plain cards keep the plain template ------------------------------

PLAIN="$TMP/hub/projects/plain.md"

$CLI sync "$TMP/proj/plain" -m "Plain digest." > /dev/null 2>&1
check "plain sync: exit 0" $?

head -1 "$PLAIN" | grep -q '^# plain'
check "plain card: no frontmatter invented" $?
grep -Eq -- '^## Facts[ \t]*$' "$PLAIN"
RC=$?
[ "$RC" -ne 0 ]
check "plain card: no hand Facts section invented" $?
grep -qF -- '## Facts (auto)' "$PLAIN"
check "plain card: auto facts present" $?

# -- Summary ------------------------------------------------------------------

printf '\n%d pass, %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
