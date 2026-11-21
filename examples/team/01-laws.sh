#!/bin/sh
# 01 · Laws: a rule the head dictates is a line in the project card, read by every role.
#
# Rule: a project's rule lives in its card's Laws section, put there by the project's head
#       (hub reflect --law); hub_context hands it to every role of the project at session start.
# Scar: a rule said in one session's chat is gone the next session. The head repeated it to each
#       worker in turn, and the worker who started after the chat broke it the same day.
. "$(dirname "$0")/lib.sh"
LAW="Rebase a branch on the current main before handing it in."

say "A worker may not make a law for the project; the project's head may."
run reflect --law "$LAW" --project relay --by relay-dev
expect_rc 1; expect "its head's to rule on (relay-head)"

run reflect --law "$LAW" --project relay --by relay-head
expect_rc 0; expect "in its card's Laws section"

say "The same law twice is refused: one line, one wording."
run reflect --law "$LAW" --project relay --by relay-head
expect_rc 1; expect "already says"

say "Every role of relay reads it (hub_context returns the same list as laws)."
run reflect --laws --project relay
expect "- $LAW"
