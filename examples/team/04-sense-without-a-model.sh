#!/bin/sh
# 04 · The head's sensor: measurements are code, the head only decides. No model runs here.
#
# Rule: the sensor takes the measurements (fast-forward, commits, build products, private text)
#       and wakes the head only with what needs a decision (exit 0), else stays silent (exit 1).
#       An acceptance is refused while the checklist fails, and private text in a branch bound for
#       a public repo goes to the fleet at once, without waiting on the head.
# Scar: "nothing private" was printed by a check that had no patterns to check with, and a branch
#       bound for a public repo went through on it.
. "$(dirname "$0")/lib.sh"
R=$WORK/relay
make_repo "$R"
run resource set relay-head --attr repo="$R/origin.git" --attr review="$R/review" --attr private='\.internal\b' --by owner

say "A branch that carries a private host name."
push_branch "$R" task/proxy-conf proxy.ini "upstream = build-7.internal" "proxy: point at the build box"
run sense relay-head check task/proxy-conf
expect_rc 1; expect "FAIL PRIVATE content"
run sense relay-head verdict task/proxy-conf accept "proxy config"
expect_rc 1; expect "accept REFUSED"

say "The sensor wakes the head, and has already escalated the leak to the fleet."
export HUBD_SENSE_ESCALATIONS="$WORK/escalations.log"
run sense relay-head events
expect_rc 0; expect "[CRITICAL] BRANCH FOR ACCEPTANCE: task/proxy-conf"
sh_run "cat '$HUBD_SENSE_ESCALATIONS'"
expect "carries private content"

say "The head returns it with remarks; the worker gets them in its queue."
run sense relay-head verdict task/proxy-conf reject "drop the host name; read it from the environment"
expect_rc 0
run queue list relay-dev -n 1
expect "drop the host name"

say "A clean branch: formally acceptable, and the head accepts it."
push_branch "$R" task/backoff backoff.txt "retry with exponential backoff, capped at 60 s" "retry: back off"
run sense relay-head check task/backoff
expect_rc 0; expect "formally acceptable"
run sense relay-head verdict task/backoff accept "backoff is capped"
expect_rc 0; expect "order -> relay-dev"

say "Nothing new since: the sensor stays silent, and nobody was woken for nothing."
run sense relay-head events
expect_rc 1
