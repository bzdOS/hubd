#!/bin/sh
# smoke_cli.sh — CLI acceptance smoke for hubd commands.
# Tests init, doctor, queue, and help against the behavioral contract.
# Exit 1 on any failure.
#
#   sh tests/smoke_cli.sh
set -u

REPO="$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)" || exit 1
CLI="node $REPO/hub/cli.mjs"

PASS=0
FAIL=0
BG_PIDS=""

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
export HUBD_QUEUE_DIR="$TMP/team"
mkdir -p "$TMP/team"

cleanup() {
  for pid in $BG_PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── Case 1: init scaffolds ──────────────────────────────────────────────────

OUT=$($CLI init "$TMP/team" 2>&1)
RC=$?
check "init: exit 0" $RC
echo "$OUT" | grep -qi "created"
check "init: output mentions created" $?
[ -f "$TMP/team/AGENTS.md" ]
check "init: AGENTS.md created" $?
[ -f "$TMP/team/INBOX.md" ]
check "init: INBOX.md created" $?
[ -f "$TMP/team/queues/README.md" ]
check "init: queues/README.md created" $?
[ -f "$TMP/team/.gitignore" ]
check "init: .gitignore created" $?

# ── Case 2: init idempotent ─────────────────────────────────────────────────

# Capture checksums before second run
SUM_AGENTS=$(md5 -q "$TMP/team/AGENTS.md" 2>/dev/null || md5sum "$TMP/team/AGENTS.md" | awk '{print $1}')
SUM_INBOX=$(md5 -q "$TMP/team/INBOX.md" 2>/dev/null || md5sum "$TMP/team/INBOX.md" | awk '{print $1}')
SUM_QREADME=$(md5 -q "$TMP/team/queues/README.md" 2>/dev/null || md5sum "$TMP/team/queues/README.md" | awk '{print $1}')

OUT2=$($CLI init "$TMP/team" 2>&1)
RC2=$?
check "init idempotent: exit 0" $RC2
echo "$OUT2" | grep -qi "exists"
check "init idempotent: output mentions exists" $?

SUM_AGENTS2=$(md5 -q "$TMP/team/AGENTS.md" 2>/dev/null || md5sum "$TMP/team/AGENTS.md" | awk '{print $1}')
SUM_INBOX2=$(md5 -q "$TMP/team/INBOX.md" 2>/dev/null || md5sum "$TMP/team/INBOX.md" | awk '{print $1}')
SUM_QREADME2=$(md5 -q "$TMP/team/queues/README.md" 2>/dev/null || md5sum "$TMP/team/queues/README.md" | awk '{print $1}')

[ "$SUM_AGENTS" = "$SUM_AGENTS2" ]
check "init idempotent: AGENTS.md unchanged" $?
[ "$SUM_INBOX" = "$SUM_INBOX2" ]
check "init idempotent: INBOX.md unchanged" $?
[ "$SUM_QREADME" = "$SUM_QREADME2" ]
check "init idempotent: queues/README.md unchanged" $?

# ── Case 3: init missing path ───────────────────────────────────────────────

$CLI init "$TMP/nope" 2>/dev/null
RC3=$?
[ "$RC3" -ne 0 ]
check "init missing path: non-zero exit" $?

# ── Case 4: doctor ok ───────────────────────────────────────────────────────

# Run from the team dir so queue resolution finds it
OUT4=$(cd "$TMP/team" && $CLI doctor 2>&1)
RC4=$?
check "doctor ok: exit 0" $RC4
LAST4=$(printf '%s' "$OUT4" | tail -1)
printf '%s' "$LAST4" | grep -qi "doctor:"
check "doctor ok: last line contains doctor:" $?
printf '%s' "$LAST4" | grep -qi "ok"
check "doctor ok: last line contains ok" $?

# ── Case 5: doctor stale lock ───────────────────────────────────────────────

mkdir -p "$HUBD_DIR"
touch "$HUBD_DIR/tasks.json.lock"
# Set mtime to ~2 minutes in the past (120s) — BSD-portable via perl
perl -e 'my $t = time() - 120; utime($t, $t, $ARGV[0]);' "$HUBD_DIR/tasks.json.lock"

OUT5=$(cd "$TMP/team" && $CLI doctor 2>&1)
RC5=$?
[ "$RC5" -ne 0 ]
check "doctor stale lock: non-zero exit" $?
echo "$OUT5" | grep -qi "stale"
check "doctor stale lock: output mentions stale" $?

rm -f "$HUBD_DIR/tasks.json.lock"

# ── Case 6: doctor offset-beyond-size ──────────────────────────────────────

mkdir -p "$TMP/team/.qstate" "$TMP/team/queues"
# Create a minimal queue file so doctor enumerates it, then set an oversized offset
: > "$TMP/team/queues/smoketest.queue.md"
printf '999999' > "$TMP/team/.qstate/smoketest.offset"

OUT6=$(cd "$TMP/team" && $CLI doctor 2>&1)
RC6=$?
[ "$RC6" -ne 0 ]
check "doctor offset-beyond-size: non-zero exit" $?
echo "$OUT6" | grep -qi "truncat\|offset\|beyond\|warning"
check "doctor offset-beyond-size: output mentions offset warning" $?

rm -f "$TMP/team/.qstate/smoketest.offset" "$TMP/team/queues/smoketest.queue.md"

# ── Case 7: queue roundtrip ─────────────────────────────────────────────────

$CLI queue send smoketest "hello smoke" --from tester
RC7S=$?
check "queue send: exit 0" $RC7S

OUT7W=$(cd "$TMP/team" && $CLI queue wait smoketest --timeout 1 2>&1)
RC7W=$?
check "queue wait: exit 0" $RC7W
echo "$OUT7W" | grep -qi "hello smoke"
check "queue wait: output contains hello smoke" $?

OUT7W2=$(cd "$TMP/team" && $CLI queue wait smoketest --timeout 1 2>&1)
RC7W2=$?
[ "$RC7W2" -eq 2 ]
check "queue second wait: exit 2" $?
echo "$OUT7W2" | grep -qi "no_changes"
check "queue second wait: output contains NO_CHANGES" $?

# ── Case 8: waiter guard ────────────────────────────────────────────────────

mkdir -p "$TMP/team/.qstate"
# Write a waiter marker with the current shell PID (alive)
SHELL_PID=$$
SINCE=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
printf '{"pid":%d,"since":"%s"}' "$SHELL_PID" "$SINCE" > "$TMP/team/.qstate/smoketest.waiter"

OUT8=$(cd "$TMP/team" && $CLI queue wait smoketest --timeout 1 2>"$TMP/stderr8.txt")
RC8=$?
STDERR8=$(cat "$TMP/stderr8.txt")
echo "$STDERR8" | grep -qi "another waiter"
check "waiter guard: stderr mentions another waiter" $?
# Waiter warning is advisory — wait still runs and exits 2 (timeout, no messages)
[ "$RC8" -eq 2 ] || [ "$RC8" -eq 0 ]
check "waiter guard: exit code is 0 or 2 (advisory, not fatal)" $?

rm -f "$TMP/team/.qstate/smoketest.waiter"

# ── Case 9: unknown command ─────────────────────────────────────────────────

OUT9=$($CLI definitely-not-a-cmd 2>&1)
RC9=$?
[ "$RC9" -ne 0 ]
check "unknown command: non-zero exit" $?
echo "$OUT9" | grep -qi "unknown command"
check "unknown command: output mentions Unknown command" $?

# ── Case 10: help ───────────────────────────────────────────────────────────

OUT10=$($CLI 2>&1)
RC10=$?
check "help: exit 0" $RC10
echo "$OUT10" | grep -qi "init"
check "help: output contains init" $?
echo "$OUT10" | grep -qi "doctor"
check "help: output contains doctor" $?

# ── Summary ─────────────────────────────────────────────────────────────────

printf '\n%d pass, %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
