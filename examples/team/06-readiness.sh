#!/bin/sh
# 06 · Readiness is a heartbeat with a ttl, not a line in a card.
#
# Rule: a resource is ready while the check that measures it keeps heartbeating within its ttl;
#       presence --alive lists only those. A card's "status: up" is a claim written once.
# Scar: a card said a service was up after it had stopped. Nothing written once can go stale on
#       its own; a heartbeat with a ttl does.
. "$(dirname "$0")/lib.sh"

say "A check command measures the service and heartbeats only if it passed (here: true)."
sh_run "true"
[ "$RC" = 0 ] && run heartbeat relay-api --role relay-api --status "health 200" --ttl 10
expect_rc 0
run presence --alive
expect "relay-api"

say "The check stops running. Pretend its last pass was 20 minutes ago, past the 10 min ttl."
node -e '
  const fs = require("fs"), f = process.argv[1];
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const d = new Date(Date.now() - 20 * 60000).toISOString();
  r.last_seen = d.slice(0, 10) + " " + d.slice(11, 16);
  fs.writeFileSync(f, JSON.stringify(r, null, 1));
' "$HUBD_DIR/presence/relay-api.json" || fail "could not age the heartbeat"
run presence --alive
expect_not "relay-api"

say "The card still says up. Only the heartbeat could tell."
run resource get relay-api
expect "status: up"
