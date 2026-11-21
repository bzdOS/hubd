#!/bin/sh
# 05 · The queue is the channel: a role is addressed through it, and status says what was read.
#
# Rule: work for a role goes to its queue (queue send), the role blocks on it (queue wait), and
#       queue status counts what was delivered by the reader's own cursor: "read to N/N".
# Scar: an order given in one session's chat never reached the worker that started after it, and
#       a role that read its queue but never acked looked like a stopped consumer.
. "$(dirname "$0")/lib.sh"

run queue send relay-dev "Rate-limit headers on the public API: branch task/rate-limit" --from relay-head
expect_rc 0; expect "delivered"
run queue status relay-dev
expect "1 pending"

say "The worker's loop blocks until there is something, then reads it."
run queue wait relay-dev --timeout 5
expect_rc 0; expect "Rate-limit headers"
run queue status relay-dev
expect "0 pending"; expect "read to"

say "Nothing new: the wait times out and says so; nothing is read twice."
run queue wait relay-dev --timeout 1
expect_not "Rate-limit headers"
[ "$RC" != 0 ] || fail "an empty wait should not exit 0"
