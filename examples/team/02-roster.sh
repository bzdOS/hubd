#!/bin/sh
# 02 · The role registry: role names come from resource cards, and lint checks every assignee.
#
# Rule: the role registry (resource cards of type role) is the only source of role names; work
#       assigned to any other name is nobody's.
# Scar: a task assigned to a misspelt role stayed open for good. No loop waits under that name,
#       and no head counted it as anyone's idle time, so nothing ever said it was stuck.
. "$(dirname "$0")/lib.sh"

say "A task for a role nobody declared."
run task add "Retry webhook delivery on 5xx" -p relay --assignee relay-worker --by relay-head
expect_rc 0
ID=$(printf '%s\n' "$OUT" | sed -n 's/^Task #\([^ :]*\) added.*/\1/p')
[ -n "$ID" ] || fail "no task id in the output"

run lint
expect "[assignee-outside-roster]"; expect "\"relay-worker\", which is neither a declared role"

say "Either declare the role ..."
run resource set relay-worker --type role --attr rank=worker --attr project=relay --attr head=relay-head --by owner
run lint
expect_not "relay-worker"

say "... or, once it is switched off, its open work is nobody's again until it is moved."
run resource set relay-worker --attr status=off --by owner
run lint
expect "\"relay-worker\", which is a role switched off"
run task update "$ID" --assignee relay-dev --by relay-head
expect_rc 0
run lint
expect_not "relay-worker"
