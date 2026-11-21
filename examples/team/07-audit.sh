#!/bin/sh
# 07 · The audit: declarations against behaviour, each finding filed once, quoting your own rule.
#
# Rule: rules.json holds the team's own laws (laws: the words and the date) and the checks it
#       enforces (strict). audit --apply files one incident per finding, quoting that law, and
#       never files the same finding twice.
# Scar: gates expired silently for weeks while the rule sat plainly written down. A finding in the
#       engine's words was argued with; one quoting the team's own dated rule was acted on.
. "$(dirname "$0")/lib.sh"

say "A question to the owner, nine days old (the demo's week is too young to have one)."
node -e '
  const fs = require("fs"), dir = process.argv[1];
  const d = new Date(Date.now() - 9 * 86400000).toISOString(), ts = d.slice(0, 10) + " " + d.slice(11, 16);
  const t = { id: "elm-90", project: "relay", text: "Approve the paid tier for relay-api", importance: "high",
    assignee: "owner", status: "open", created: ts, by: "relay-head", depends_on: [], tags: [] };
  fs.appendFileSync(dir + "/tasks.elm.events.jsonl", JSON.stringify({ ts, node: "elm", ev: "add", id: t.id, t }) + "\n");
' "$HUBD_DIR" || fail "could not seed the question"

say "The team's own law for it, with the day it was written, and one lint check enforced."
cat > "$HUBD_DIR/rules.json" <<'JSON'
{
  "laws": {
    "owner-backlog": { "text": "A question to the owner is answered or withdrawn within a week.", "since": "2026-03-02", "source": "AGENTS.md" }
  },
  "strict": { "assignee-outside-roster": true }
}
JSON

run audit --apply --by coord
expect "[owner-backlog]"
expect "A question to the owner is answered or withdrawn within a week. (recorded 2026-03-02)"
expect "filed 1 incident"

say "The next pass files nothing new: the finding is keyed."
run audit --apply --by coord
expect "filed 0 incident"; expect "1 already open"
run task list -p general
expect "AUDIT owner-backlog"

say "strict marks a lint check as enforced."
run lint
expect "Enforced: assignee-outside-roster"
