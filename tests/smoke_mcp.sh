#!/bin/sh
# smoke_mcp.sh — MCP stdio acceptance smoke for the hubd daemon.
# Emulates a client handshake and exercises the edges. Exit 1 on any failure.
#
#   sh tests/smoke_mcp.sh
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
HUBD_DIR="$(mktemp -d)"; export HUBD_DIR
trap 'rm -rf "$HUBD_DIR"' EXIT

# A >64KB single line stress-tests stdin chunking (readline must not split it).
BIG=$(node -e 'process.stdout.write("x".repeat(70000))')

REQS=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","method":"notifications/somethingUnknown"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_status","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hub_task_add","arguments":{"project":"smoke","text":"$BIG"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hub_brief","arguments":{}}}
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"hub_card_set","arguments":{"project":"smoke","digest":"smoke digest line"}}}
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"hub_kanban","arguments":{}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}
{"jsonrpc":"2.0","id":7,"method":"ping"}
EOF
)

printf '%s\n' "$REQS" | node hub/index.mjs | node -e '
const fs = require("fs");
const lines = fs.readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const byId = {};
for (const m of lines) if (m.id != null) byId[m.id] = m;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };

ok(byId[1] && byId[1].result && byId[1].result.serverInfo.name === "hubd", "initialize -> serverInfo.name=hubd");
ok(byId[1].result.serverInfo.version && /^[0-9]+\./.test(byId[1].result.serverInfo.version), "version present (" + byId[1].result.serverInfo.version + ")");
// notifications (no id) must produce NO response line
ok(!lines.some(m => m.id == null && (m.error || m.result)), "notifications got no response");
ok(byId[2] && Array.isArray(byId[2].result.tools) && byId[2].result.tools.length === 13, "tools/list -> 13 tools (got " + (byId[2] && byId[2].result.tools.length) + ")");
ok(byId[3] && byId[3].result && byId[3].result.isError === false, "hub_status ok");
ok(byId[4] && byId[4].result && byId[4].result.isError === false, "hub_task_add with >64KB payload ok");
ok(byId[5] && byId[5].result && byId[5].result.isError === false, "hub_brief ok");
ok(byId[8] && byId[8].result && byId[8].result.isError === false, "hub_card_set ok");
ok(byId[9] && byId[9].result && byId[9].result.isError === false, "hub_kanban ok");
ok(byId[6] && byId[6].result && byId[6].result.isError === true, "unknown tool -> isError true (not a crash)");
ok(byId[7] && byId[7].result && Object.keys(byId[7].result).length === 0, "ping -> {}");

console.log("\n" + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
'
