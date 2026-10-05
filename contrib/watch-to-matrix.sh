#!/bin/sh
# watch-to-matrix.sh: post each new hub journal entry to a Matrix room.
# hub watch shows each entry once, through mesh merges, resets and log rotation; its cursor
# "matrix" survives a restart. An entry counts as shown once it is written into this pipe, so a
# post that fails is retried here, and one the script is killed holding is not sent again.
# Needs hub, curl and jq. MATRIX_HS=https://matrix.example.org MATRIX_ROOM='!room:example.org'
# MATRIX_TOKEN=<access token>. Extra arguments go to hub watch (-p <project>, --since 1h).
set -eu
room=$(jq -rn --arg r "$MATRIX_ROOM" '$r|@uri')
n=0
hub watch --as matrix --follow --json "$@" | while IFS= read -r entry; do
  n=$((n + 1))
  body=$(printf '%s' "$entry" | jq -c '{msgtype: "m.text", body: "\(.ts) [\(.project)/\(.agent)] \(.kind): \(.text)"}')
  until curl -fsS -X PUT -H "Authorization: Bearer $MATRIX_TOKEN" -H 'Content-Type: application/json' --data "$body" \
    "$MATRIX_HS/_matrix/client/v3/rooms/$room/send/m.room.message/hubd-$$-$(date +%s)-$n" >/dev/null; do sleep 10; done
done
