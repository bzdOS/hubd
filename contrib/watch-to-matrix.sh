#!/bin/sh
# watch-to-matrix.sh: post each new hub journal entry to a Matrix room.
# hub watch shows each entry once, through mesh merges, resets and log rotation; its cursor
# "matrix" survives a restart. It hands each entry to the command below on stdin and marks it only
# when the post succeeds: a failed post is handed over again on the next pass (every 5 s), and one
# the script is killed holding is posted on the next start. The transaction id is the entry's
# HUBD_WATCH_KEY, the same on every attempt, so the server drops a repeat.
# Needs hub, curl and jq. MATRIX_HS=https://matrix.example.org MATRIX_ROOM='!room:example.org'
# MATRIX_TOKEN=<access token>. Extra arguments go to hub watch (-p <project>, --since 1h).
set -eu
: "${MATRIX_HS:?}" "${MATRIX_TOKEN:?}"
MATRIX_ROOM_URI=$(jq -rn --arg r "${MATRIX_ROOM:?}" '$r|@uri')
export MATRIX_HS MATRIX_TOKEN MATRIX_ROOM_URI
exec hub watch --as matrix --follow "$@" --exec '
  jq -c "{msgtype: \"m.text\", body: \"\(.ts) [\(.project)/\(.agent)] \(.kind): \(.text)\"}" |
  curl -fsS -m 15 -X PUT -H "Authorization: Bearer $MATRIX_TOKEN" -H "Content-Type: application/json" --data @- \
    "$MATRIX_HS/_matrix/client/v3/rooms/$MATRIX_ROOM_URI/send/m.room.message/hubd-$HUBD_WATCH_KEY" >/dev/null'
