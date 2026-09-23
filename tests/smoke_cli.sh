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
# Pin the team root with HUBD_TEAM_DIR, not the legacy HUBD_QUEUE_DIR: resolution is
# `HUBD_TEAM_DIR || HUBD_QUEUE_DIR`, so a developer who has HUBD_TEAM_DIR exported for
# their own hub used to win over this. The suite then ran doctor and the queue cases
# against that real team root — writing test messages into live queues, while the
# offset/waiter cases silently asserted nothing.
export HUBD_TEAM_DIR="$TMP/team"
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
# The template must describe the CURRENT queue model (per-host files, fan-out roles),
# not the pre-0.4 one — a fresh team root otherwise gets a manual contradicting HUBD.md.
grep -q "subscriber-roles.json" "$TMP/team/queues/README.md"
check "init: queues/README.md documents fan-out (subscriber-roles.json)" $?
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
# Create a minimal queue file so doctor enumerates it, then set an oversized offset.
# The offset is keyed by the FULL filename (.qstate/<file>.offset) — the path the
# real consumer (lib/queue.mjs) writes, and the one doctor must read.
: > "$TMP/team/queues/smoketest.queue.md"
printf '999999' > "$TMP/team/.qstate/smoketest.queue.md.offset"

OUT6=$(cd "$TMP/team" && $CLI doctor 2>&1)
RC6=$?
[ "$RC6" -ne 0 ]
check "doctor offset-beyond-size: non-zero exit" $?
# Match the warning itself, not the word "offset" — every queue line prints an offset,
# so the loose pattern passed even when the warning never fired.
echo "$OUT6" | grep -qi "offset beyond file size"
check "doctor offset-beyond-size: output mentions offset warning" $?

rm -f "$TMP/team/.qstate/smoketest.queue.md.offset" "$TMP/team/queues/smoketest.queue.md"

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

# ── Case 7b: doctor reads the REAL offset and sees a live waiter ────────────
# The wait above consumed everything; doctor must show pending 0B — the
# filename-minus-suffix bug read a never-written path and showed the full size.
OUT7D=$(cd "$TMP/team" && $CLI doctor 2>&1)
echo "$OUT7D" | grep -q "smoketest.*pending 0B"
check "doctor queue: consumed queue shows pending 0B" $?

$CLI queue wait smoketest --timeout 6 >/dev/null 2>&1 &
WPID=$!
BG_PIDS="$BG_PIDS $WPID"
sleep 1
OUT7L=$(cd "$TMP/team" && $CLI doctor 2>&1)
echo "$OUT7L" | grep -q "live waiter: pid $WPID"
check "doctor queue: live waiter shown with its pid" $?
kill "$WPID" 2>/dev/null || true
wait "$WPID" 2>/dev/null

# ── Case 7c: the sender is an author — no --from, no HUBD_AGENT -> refused ──
OUT7A=$(HUBD_AGENT= $CLI queue send smoketest "no author" 2>&1)
RC7A=$?
[ "$RC7A" -ne 0 ]
check "queue send: refused without --from / HUBD_AGENT" $?
echo "$OUT7A" | grep -q "from required"
check "queue send: error names the missing flag" $?
HUBD_AGENT=dev-smoke $CLI queue send smoketest "floored" >/dev/null 2>&1
check "queue send: HUBD_AGENT floors an omitted --from" $?

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

# ── Case 11: a flag where the task text belongs is refused, not filed ───────
# `hub task add -p x --by y` used to create a task whose text was "-p"; that task
# lives in the append-only event log forever, so the command must die before writing.

OUT11=$($CLI task add -p smoketest --by smoke 2>&1)
RC11=$?
[ "$RC11" -ne 0 ]
check "task add with flag as text: non-zero exit" $?
echo "$OUT11" | grep -q 'Text required'
check "task add with flag as text: prints usage" $?
[ ! -s "$HUBD_DIR/tasks.$(hostname -s | tr 'A-Z' 'a-z').events.jsonl" ] || ! grep -q '"text":"-p"' "$HUBD_DIR"/tasks.*.events.jsonl
check "task add with flag as text: nothing written" $?

# ── Case 12: queue send keeps the body whatever the argument order ──────────
# Measured in production (task macbook-pro-63): bodies that were literally "--from",
# "--text", "--agent" — the parser took args[3] blindly and reported success.

QDIR="$TMP/team/queues"
qblocks() { cat "$QDIR"/qs.*.queue.md 2>/dev/null | grep -c '^## '; }
qbody_last() {   # body of the last block: everything after the last header line
  cat "$QDIR"/qs.*.queue.md | awk '/^## [0-9]{4}-/{buf=""; next} {buf=buf $0 "\n"} END{printf "%s", buf}'
}

(cd "$TMP/team" && $CLI queue send qs "$(printf 'line one\nline two')" --from smoke >/dev/null 2>&1)
check "queue send: multiline positional body accepted" $?
qbody_last | grep -q '^line one$' && qbody_last | grep -q '^line two$'
check "queue send: both lines land in the queue" $?

(cd "$TMP/team" && $CLI queue send qs --from smoke "flag before text" >/dev/null 2>&1)
check "queue send: --from before the text accepted" $?
qbody_last | grep -q '^flag before text$'
check "queue send: body is the text, not the word --from" $?

(cd "$TMP/team" && $CLI queue send qs --from smoke --text "- starts with a dash" >/dev/null 2>&1)
check "queue send: --text carries a body that starts with -" $?
qbody_last | grep -q '^- starts with a dash$'
check "queue send: dash body intact via --text" $?

(cd "$TMP/team" && $CLI queue send qs --agent smoke "agent alias" >/dev/null 2>&1)
check "queue send: --agent accepted as the sender" $?
qbody_last | grep -q '^agent alias$'
check "queue send: body intact with --agent" $?

N_BEFORE=$(qblocks)
OUT12=$(cd "$TMP/team" && $CLI queue send qs "-oops" --from smoke 2>&1); RC12=$?
[ "$RC12" -ne 0 ] && echo "$OUT12" | grep -q 'unknown flag -oops'
check "queue send: bare body starting with - is refused with an explicit error" $?
OUT12b=$(cd "$TMP/team" && $CLI queue send qs "text" --nope x --from smoke 2>&1); RC12b=$?
[ "$RC12b" -ne 0 ] && echo "$OUT12b" | grep -q 'unknown flag --nope'
check "queue send: unknown flag is an error, not a swallowed body" $?
OUT12c=$(cd "$TMP/team" && $CLI queue send qs --from smoke 2>&1); RC12c=$?
[ "$RC12c" -ne 0 ]
check "queue send: missing body is non-zero" $?
[ "$(qblocks)" -eq "$N_BEFORE" ]
check "queue send: refused sends wrote nothing" $?

BIG="$TMP/big.txt"
{ i=0; while [ $i -lt 120 ]; do printf 'line %d: "quotes" $dollars `ticks` \\backslash %%percent -- ünïcødé\n' $i; i=$((i+1)); done; } > "$BIG"
[ "$(wc -c < "$BIG")" -gt 8000 ] || fail "queue send: big fixture is under 8 KB"
(cd "$TMP/team" && $CLI queue send qs - --from smoke < "$BIG" >/dev/null 2>&1)
check "queue send: stdin body accepted" $?
qbody_last | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$TMP/got.txt"
cmp -s "$BIG" "$TMP/got.txt"
check "queue send: 8 KB body with quotes/dollars arrives byte-for-byte" $?

# ── Case 13: hub whereami answers from any directory, fast, read-only ──────

W="$TMP/wrepo"; mkdir -p "$W" && printf 'wsmoke\n' > "$W/.hubd"
(cd "$W" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "first light") 2>/dev/null
OUT13=$(cd "$W" && HUBD_AGENT=smoke $CLI whereami 2>&1); RC13=$?
check "whereami: exit 0" $RC13
echo "$OUT13" | grep -q "^project:  wsmoke" && echo "$OUT13" | grep -q "first light"
check "whereami: names the project from the marker and lists the commit subjects" $?
OUT13J=$(cd "$W" && $CLI whereami --json 2>&1)
echo "$OUT13J" | grep -q '"project": "wsmoke"' && echo "$OUT13J" | grep -q '"commits"'
check "whereami --json: machine-readable" $?
OUT13N=$(cd "$TMP" && $CLI whereami 2>&1); RC13N=$?
[ "$RC13N" -eq 0 ] && echo "$OUT13N" | grep -q "project:  (none)"
check "whereami: outside any project it still answers, with (none)" $?

# ── Case 14: the other positional commands read past flags too ─────────────

OUT14=$(cd "$TMP/team" && $CLI claim --agent smoke -t 5 smokeproj 'src/**' 2>&1); RC14=$?
[ "$RC14" -eq 0 ] && echo "$OUT14" | grep -q "^Lock: "
check "claim: flags before the positionals still claim the right area" $?
(cd "$TMP/team" && $CLI claim check src/a.ts -p smokeproj --agent other >/dev/null 2>&1); RC14B=$?
[ "$RC14B" -eq 1 ]
check "claim: the area claimed was 'src/**', not '--agent' (check finds it)" $?
OUT14C=$(cd "$TMP/team" && $CLI claim smokeproj 'x' --bogus 1 --agent smoke 2>&1); RC14C=$?
[ "$RC14C" -ne 0 ] && echo "$OUT14C" | grep -q "unknown flag --bogus"
check "claim: an unknown flag is refused, not swallowed as the area" $?
TID=$(cd "$TMP/team" && $CLI task add "close me" -p smokeproj --by smoke 2>&1 | sed -n 's/^Task #\([^ ]*\) added.*/\1/p')
OUT14D=$(cd "$TMP/team" && $CLI task done --by smoke "$TID" 2>&1); RC14D=$?
[ "$RC14D" -eq 0 ] && echo "$OUT14D" | grep -q "closed"
check "task done: --by before the id closes the id, not the word --by" $?

# ── Case 15: HUBD_TEAM_DIR alone names the whole hub, not just the queues ──
# A fleet that passes one directory to every role expects presence, journal and tasks there
# too; until 0.9.17 they went to the role's own ~/.hubd (task macbook-pro-88).

ONLY="$TMP/only"; mkdir -p "$ONLY"
OUT15=$(cd "$ONLY" && env -u HUBD_DIR -u HUBD_QUEUE_DIR HUBD_TEAM_DIR="$ONLY" node "$REPO/hub/cli.mjs" doctor 2>&1)
echo "$OUT15" | grep -q "path:     $ONLY  (via env HUBD_TEAM_DIR)"
check "team dir: HUBD_TEAM_DIR without HUBD_DIR is the hub base, and doctor says so" $?
(cd "$ONLY" && env -u HUBD_DIR -u HUBD_QUEUE_DIR HUBD_TEAM_DIR="$ONLY" node "$REPO/hub/cli.mjs" task add "one dir" -p onlyproj --by smoke >/dev/null 2>&1)
ls "$ONLY"/tasks.*.events.jsonl >/dev/null 2>&1
check "team dir: a task filed under HUBD_TEAM_DIR lands in that directory" $?
OUT15B=$($CLI doctor 2>&1)
echo "$OUT15B" | grep -q "path:     $HUBD_DIR  (via env HUBD_DIR)"
check "team dir: HUBD_DIR still wins when both are set" $?

# ── Case 16: freeze is the stop-cock, and a forgotten one is not silent ────

OUT16=$($CLI freeze 2>&1); RC16=$?
[ "$RC16" -ne 0 ] && echo "$OUT16" | grep -q "say why"
check "freeze: refused without a reason" $?
OUT16B=$($CLI freeze "purge duplicate blocks" --by dev-smoke 2>&1); RC16B=$?
[ "$RC16B" -eq 0 ] && [ -f "$HUBD_DIR/.mesh-freeze" ]
check "freeze: writes the marker mesh-sync looks for" $?
(cd "$TMP/team" && $CLI doctor 2>&1 | grep -q "mesh: FROZEN")
check "freeze: doctor states it, so a forgotten freeze is visible" $?
HUBD_DIR="$HUBD_DIR" sh "$REPO/scripts/mesh-sync.sh" 2>&1 | grep -q "FROZEN"
check "freeze: mesh-sync skips the run and says why" $?
OUT16C=$($CLI unfreeze 2>&1); RC16C=$?
[ "$RC16C" -eq 0 ] && [ ! -f "$HUBD_DIR/.mesh-freeze" ] && echo "$OUT16C" | grep -q "Unfrozen"
check "unfreeze: removes it and says the mesh runs again" $?

# ── Case 17: a card is held to being a snapshot ────────────────────────────

OUT17=$($CLI card capproj -m "$(node -e 'process.stdout.write("x".repeat(70000))')" --by smoke 2>&1); RC17=$?
[ "$RC17" -ne 0 ] && echo "$OUT17" | grep -q "over this hub's limit"
check "card cap: a 70 KB digest is refused" $?
$CLI card capproj -m "a real snapshot" --by smoke >/dev/null 2>&1
OUT17B=$($CLI card capproj --append-line "- 2026-09-23: shipped it" --by smoke 2>&1); RC17B=$?
[ "$RC17B" -ne 0 ] && echo "$OUT17B" | grep -q "hub_report"
check "card cap: a dated appendLine is refused and names hub_report" $?
PAD=$(node -e 'process.stdout.write("y".repeat(400))')
i=0; while [ $i -lt 40 ]; do $CLI report -p capproj --agent smoke -m "FACT: finding $i $PAD" >/dev/null 2>&1; i=$((i+1)); done
[ -s "$HUBD_DIR/projects/history/capproj.md" ] && grep -q "finding 0 " "$HUBD_DIR/projects/history/capproj.md"
check "card cap: the oldest facts are moved into history, not dropped" $?
OUT17C=$(cd "$TMP/team" && $CLI cards compact 2>&1); RC17C=$?
[ "$RC17C" -eq 0 ] && echo "$OUT17C" | grep -q "Would compact\|already inside the limit"
check "cards compact: dry run reports without writing" $?

# ── Summary ─────────────────────────────────────────────────────────────────

printf '\n%d pass, %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
