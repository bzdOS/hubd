#!/bin/sh
# 08 · watch --as --exec: a journal entry runs a command, and is marked only when it succeeds.
#
# Rule: a standing reaction to the journal is a named cursor (watch --as) and a command
#       (--exec) that gets each new entry on stdin. An entry is marked only when the command
#       exits 0, so a reaction that cannot act yet is retried on the next pass, not lost.
# Scar: accepted task branches stayed in the remote after their merge, and the sensor raised each
#       copy of one for acceptance again.
. "$(dirname "$0")/lib.sh"
R=$WORK/relay
make_repo "$R"
run resource set relay-head --attr repo="$R/origin.git" --attr review="$R/review" --attr private='\.internal\b' --by owner
HANDLER="$(cd "$(dirname "$0")" && pwd)/delete-merged-branch.sh"
export REPO="$R/review"

say "The janitor's cursor starts now."
run watch --as janitor
push_branch "$R" task/backoff backoff.txt "retry with exponential backoff, capped at 60 s" "retry: back off"
run sense relay-head verdict task/backoff accept "backoff is capped"
expect_rc 0
SHA=$(git -C "$R/work" rev-parse task/backoff)

say "Accepted but not merged yet: the handler declines, so the entry stays unmarked."
run watch --as janitor --exec "sh '$HANDLER'"
sh_run "git -C '$R/origin.git' branch --list task/backoff"
expect "task/backoff"

say "The worker merges, as the order says. The next pass deletes the branch."
sh_run "git -C '$R/work' push -q origin $SHA:refs/heads/main"
run watch --as janitor --exec "sh '$HANDLER'"
expect_rc 0
sh_run "git -C '$R/origin.git' branch --list task/backoff"
expect_not "task/backoff"

say "Done once: the next pass has nothing to do."
run watch --as janitor --exec "sh '$HANDLER'"
expect_not "deleted"
