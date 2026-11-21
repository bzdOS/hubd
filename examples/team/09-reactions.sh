#!/bin/sh
# 09 · Reactions: the MCP server runs the rules, and only commands the hub declares.
#
# Rule: a standing reaction is declared in the hub (reactions.json) by the owner or the project's
#       head, and runs inside the MCP server every agent session already starts, one runner per
#       rule per node. A rule names a declared command; journal text reaches it only on stdin.
# Scar: the janitor of 08 was a `hub watch --follow` somebody had to keep running; it stopped with
#       the terminal it ran in, and merged branches piled up again for a week.
. "$(dirname "$0")/lib.sh"
R=$WORK/relay
make_repo "$R"
run resource set relay-head --attr repo="$R/origin.git" --attr review="$R/review" --attr private='\.internal\b' --by owner
HANDLER="$(cd "$(dirname "$0")" && pwd)/delete-merged-branch.sh"

say "The head declares the janitor. A worker's rule, and a rule with a command line in it, are refused."
cat > "$HUBD_DIR/reactions.json" <<JSON
{ "commands": { "delete-merged": "REPO='$R/review' sh '$HANDLER'" },
  "rules": [
    { "id": "janitor", "by": "relay-head", "project": "relay",
      "on": { "kind": "decision", "match": "^ACCEPT " }, "run": "delete-merged" },
    { "id": "shortcut", "by": "relay-dev", "every": "1m", "run": "delete-merged" },
    { "id": "inline", "by": "owner", "every": "1m", "run": "git push origin --delete main" } ] }
JSON
run reactions
expect_rc 1; expect 'REFUSED: by "relay-dev"'; expect "is not a command declared in commands"

say "Two agent sessions on this node: two MCP servers. One of them takes the janitor's lease."
export HUBD_REACTIONS_TICK_S=1
# each server reads a fifo held open below, as a session holds the server's stdin
mkfifo "$WORK/s1" "$WORK/s2"
$HUBD <"$WORK/s1" >/dev/null 2>&1 & S1=$!
$HUBD <"$WORK/s2" >/dev/null 2>&1 & S2=$!
trap 'kill $S1 $S2 2>/dev/null' EXIT
exec 3>"$WORK/s1" 4>"$WORK/s2"
wait_for 10 "test -f '$HUBD_DIR/.reactions/janitor.elm.lease'" || fail "nobody took the lease"
run reactions
expect "lease: pid"

say "The head accepts a branch; the worker merges it. Nobody runs a watcher."
push_branch "$R" task/backoff backoff.txt "retry with exponential backoff, capped at 60 s" "retry: back off"
run sense relay-head verdict task/backoff accept "backoff is capped"
expect_rc 0
SHA=$(git -C "$R/work" rev-parse task/backoff)
sh_run "git -C '$R/work' push -q origin $SHA:refs/heads/main"
wait_for 15 "! git -C '$R/origin.git' branch --list task/backoff | grep -q ." || fail "the merged branch was not deleted"
sh_run "git -C '$R/origin.git' branch --list"
expect_not "task/backoff"

say "The firing is in the journal, once, though two servers were running."
sleep 2
run log relay -n 3
expect "janitor: fired on decision"; expect "deleted task/backoff"
[ "$(printf '%s\n' "$OUT" | grep -c 'janitor: fired')" = 1 ] || fail "the rule fired more than once"
