#!/bin/sh
# 03 · Handing a project to a new head: declare, move the workers, switch the old head off, move
#      its open work, then let lint confirm nothing stayed behind.
#
# Rule: a project has one live head. Its laws are the live head's to rule on, its workers name it
#       as head, and no open task stays with a head that was switched off.
# Scar: a head handed its project over and was switched off. Its release task stayed open under
#       its name, read by no loop, and the old head could still rule on the project's laws.
. "$(dirname "$0")/lib.sh"

say "1. The new head."
run resource set relay-lead --type role --attr rank=head --attr project=relay --by owner
expect_rc 0

say "2. Each worker answers to it."
run resource set relay-dev --attr 'head=[[relay-lead]]' --by owner
run resource get relay-lead
expect "relay-dev"

say "3. The old head is switched off. Its open work is now flagged."
run resource set relay-head --attr status=off --by owner
run lint
expect "\"relay-head\", which is a role switched off"
REL=$(printf '%s\n' "$OUT" | sed -n 's/.*"relay-head", which is a role switched off[^#]*#\([^ ,]*\).*/\1/p' | head -1)
[ -n "$REL" ] || fail "no task id on the old head"

say "4. Its open work moves to the new head."
run task update "$REL" --assignee relay-lead --by relay-lead
expect "@relay-lead"
run lint
expect_not "\"relay-head\""

say "5. The project's laws are the new head's now, not the old one's."
run reflect --law "Cut a release only from a green main." --project relay --by relay-head
expect_rc 1; expect "(relay-lead)"
run reflect --law "Cut a release only from a green main." --project relay --by relay-lead
expect_rc 0

say "6. The new head hears from its own sensor."
run sense relay-lead status
expect "\"relay-dev\""
expect_rc 0
