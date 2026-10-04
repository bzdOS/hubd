#!/bin/sh
# smoke_mcp.sh — MCP stdio acceptance smoke for the hubd daemon.
# Emulates a client handshake and exercises the edges. Exit 1 on any failure.
#
#   sh tests/smoke_mcp.sh
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
HUBD_DIR="$(mktemp -d)"; export HUBD_DIR
trap 'rm -rf "$HUBD_DIR"' EXIT

# A >64KB single line stress-tests stdin chunking (readline must not split it). A task that big is
# refused (a message is prose, not cargo), and the refusal counting all 70000 bytes is the proof the
# line arrived whole; the compact reply is checked on a task under the limit.
BIG=$(node -e 'process.stdout.write("x".repeat(70000))')
MID=$(node -e 'process.stdout.write("word ".repeat(3000))')
# 24 long reports, so hub_get, hub_whatsnew and hub_task_list have something to be compact about
LONG=$(node -e 'process.stdout.write("long journal line ".repeat(40))')
RPT=""; i=1
while [ $i -le 24 ]; do
  RPT="$RPT{\"jsonrpc\":\"2.0\",\"id\":$((100 + i)),\"method\":\"tools/call\",\"params\":{\"name\":\"hub_report\",\"arguments\":{\"project\":\"smoke\",\"agent\":\"smoke-suite\",\"text\":\"report $i: $LONG\"}}}
"; i=$((i + 1))
done

REQS=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","method":"notifications/somethingUnknown"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_status","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hub_task_add","arguments":{"project":"smoke","text":"$BIG","by":"smoke-suite"}}}
{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"hub_task_add","arguments":{"project":"smoke","text":"$MID","by":"smoke-suite"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hub_brief","arguments":{}}}
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"hub_card_set","arguments":{"project":"smoke","digest":"smoke digest line","by":"smoke-suite"}}}
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"hub_kanban","arguments":{}}}
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"hub_context","arguments":{"cwd":"$HUBD_DIR"}}}
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"hub_heartbeat","arguments":{"agent":"smoke-agent","role":"smoke"}}}
{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"hub_presence","arguments":{}}}
{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"hub_card_set","arguments":{"project":"smoke","appendLine":"a patched line","by":"smoke-suite","verbose":true}}}
$RPT{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"hub_get","arguments":{"project":"smoke"}}}
{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"hub_get","arguments":{"project":"smoke","full":true}}}
{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"hub_whatsnew","arguments":{"agent":"smoke-reader"}}}
{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"hub_whatsnew","arguments":{"agent":"smoke-reader-full","since":"2020-01-01T00:00:00Z","full":true}}}
{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"hub_task_list","arguments":{"project":"smoke"}}}
{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"hub_task_list","arguments":{"project":"smoke","full":true}}}
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
// Assert the KNOWN tools are present rather than an exact count — the count
// grows as tools are added (queue_send/wait/wait_all, onboarding, whatsnew, …)
// and a brittle === N assertion just goes stale on every addition.
ok(byId[2] && Array.isArray(byId[2].result.tools), "tools/list returns an array");
{
  const names = new Set((byId[2] && byId[2].result.tools || []).map(t => t.name));
  const required = ["hub_status","hub_report","hub_task_add","hub_task_list","hub_brief",
                    "hub_queue_send","hub_queue_wait","hub_onboarding","hub_whatsnew","hub_context",
                    "hub_heartbeat","hub_presence"];
  const missing = required.filter(n => !names.has(n));
  ok(missing.length === 0, "tools/list has required tools (" + names.size + " total, missing: " + (missing.join(",") || "none") + ")");
}
ok(byId[3] && byId[3].result && byId[3].result.isError === false, "hub_status ok");
ok(byId[4] && byId[4].result && byId[4].result.isError === true && /70000 bytes, over the 16384-byte limit/.test(byId[4].result.content[0].text),
  "hub_task_add with a >64KB line arrives whole, and is refused as cargo");
{
  // The 15 KB text went in; the reply must not carry it back (task maple-83).
  const txt = byId[13] && byId[13].result ? byId[13].result.content[0].text : "";
  let r = null; try { r = JSON.parse(txt); } catch {}
  ok(r && r.ok === true && r.id != null && typeof r.textPreview === "string" && r.textPreview.length <= 81 && txt.length < 400,
    "hub_task_add reply is compact (" + txt.length + " bytes, textPreview, no full echo)");
}
ok(byId[5] && byId[5].result && byId[5].result.isError === false, "hub_brief ok");
ok(byId[5] && byId[5].result.content[0].text.includes("\"buttons\""), "hub_brief includes a buttons rollup");
ok(byId[8] && byId[8].result && byId[8].result.isError === false, "hub_card_set ok");
const J = (id) => { try { return JSON.parse(byId[id].result.content[0].text); } catch { return null; } };
{
  // The digest was just written by the caller; the reply says where and how much, not what.
  const txt = byId[8] ? byId[8].result.content[0].text : "", r = J(8) || {};
  ok(r.ok === true && r.project === "smoke" && r.section === "Digest" && r.bytes === Buffer.byteLength("smoke digest line") &&
    !("digest" in r) && !("card" in r) && txt.length < 200,
    "hub_card_set reply is compact: {ok, project, section, bytes} (" + txt.length + " bytes: " + txt.replace(/\s+/g, " ") + ")");
  const v = J(14) || {};
  ok(v.ok === true && typeof v.card === "string" && /a patched line/.test(v.digest || "") && Array.isArray(v.patched),
    "hub_card_set verbose:true returns the card path, the patches applied and the new digest");
}
{
  // A role run by a shell loop has hub_heartbeat denied: the text every client gets does not send it there.
  const tools = byId[2] && byId[2].result.tools || [];
  const hb = tools.find(t => t.name === "hub_heartbeat") || {};
  ok(!/hub_heartbeat/.test(byId[1].result.instructions) && /right after hub_report/.test(hb.description || ""),
    "server instructions do not tell every client to call hub_heartbeat; the tool description still does");
}
{
  // Compact by default: the newest 5 journal entries cut to 240 chars and the head of the card; full:true the rest.
  const g = J(20) || {}, gf = J(21) || {};
  const jt = (g.journal || []).map(e => (e.text.match(/^report (\d+):/) || [])[1]).join(",");
  ok(jt === "20,21,22,23,24" && g.journal.every(e => e.text.length <= 240) && g.truncated && g.truncated.journal.textCut === 5,
    "hub_get is compact by default: the 5 NEWEST journal entries, texts cut to 240 (got " + jt + ")");
  ok((gf.journal || []).length === 15 && gf.journal.some(e => e.text.length > 600) && gf.truncated === undefined,
    "hub_get full:true: 15 journal entries, whole");
  ok(JSON.stringify(g).length * 2 < JSON.stringify(gf).length, "hub_get compact is under half the full view (" + JSON.stringify(g).length + " vs " + JSON.stringify(gf).length + ")");
  const w = J(22) || {}, wf = J(23) || {};
  ok(Array.isArray(w.entries) && w.entries.length <= 20 && w.entries.length < w.newEntries && w.entries.every(e => e.text.length <= 240) && w.truncated && w.truncated.entries.textCut > 0,
    "hub_whatsnew is compact by default: at most 20 entries, texts cut to 240 (" + (w.entries || []).length + " of " + w.newEntries + ")");
  ok(Array.isArray(wf.entries) && wf.entries.length === wf.newEntries && wf.entries.some(e => e.text.length > 600),
    "hub_whatsnew full:true: every entry, whole");
  const t = J(24) || {}, tf = J(25) || {};
  const big = (t.tasks || []).find(x => /^word word/.test(x.text)), bigF = (tf.tasks || []).find(x => /^word word/.test(x.text));
  ok(big && big.text.length === 160 && !("_origin" in big) && t.truncated && t.truncated.tasks.textCut === 1,
    "hub_task_list is compact by default: texts cut to 160, bookkeeping left out");
  ok(bigF && bigF.text.length === 15000 && "_origin" in bigF, "hub_task_list full:true: whole texts and every field");
}
ok(byId[9] && byId[9].result && byId[9].result.isError === false, "hub_kanban ok");
ok(byId[10] && byId[10].result && byId[10].result.isError === false, "hub_context ok");
ok(byId[11] && byId[11].result && byId[11].result.isError === false, "hub_heartbeat ok");
ok(byId[12] && byId[12].result && byId[12].result.isError === false, "hub_presence ok");
ok(byId[12] && /smoke-agent/.test(JSON.stringify(byId[12].result)), "hub_presence sees the heartbeat just sent");
ok(byId[6] && byId[6].result && byId[6].result.isError === true, "unknown tool -> isError true (not a crash)");
ok(byId[7] && byId[7].result && Object.keys(byId[7].result).length === 0, "ping -> {}");

console.log("\n" + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
' || exit 1

# ── Attribution: one explicit author under ANY of agent/by/from beats the HUBD_AGENT floor ──
# hub_report({agent: X}) used to be journaled under the floor because it reads `by ?? agent`
# and the floor had filled `by` (task maple-75). Every write path, one author.
HUBD_DIR2="$(mktemp -d)"; HUBD_TEAM_DIR="$HUBD_DIR2"; export HUBD_TEAM_DIR
REQS2=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hub_report","arguments":{"project":"attr","agent":"doc-auditor@proj-29","kind":"done","text":"DECIDE: attribution test | must keep the explicit name\nNOTE: explicit agent, empty by"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_task_add","arguments":{"project":"attr","text":"attribution task","by":"doc-auditor@proj-29"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"attr-role","text":"sent with agent, not from","agent":"doc-auditor@proj-29"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hub_report","arguments":{"project":"attr","text":"NOTE: nobody named — the floor applies"}}}
EOF
)
OUT2=$(printf '%s\n' "$REQS2" | HUBD_DIR="$HUBD_DIR2" HUBD_AGENT=owner-floor node hub/index.mjs 2>/dev/null)
P2=0; F2=0
chk() { if [ "$2" -eq 0 ]; then P2=$((P2+1)); echo "PASS $1"; else F2=$((F2+1)); echo "FAIL $1"; fi; }
printf '%s\n' "$OUT2" | grep -q '"id":2,.*"isError":false' || printf '%s\n' "$OUT2" | grep -q '"id":2'
chk "attribution: hub_report with agent accepted" $?
J2=$(cat "$HUBD_DIR2"/journal.*.jsonl 2>/dev/null)
[ "$(printf '%s\n' "$J2" | grep -c '"agent":"doc-auditor@proj-29"')" -ge 3 ]
chk "attribution: decision, done and task lines all carry the explicit agent" $?
! printf '%s\n' "$J2" | grep -v 'nobody named' | grep -q 'owner-floor'
chk "attribution: the floor signed nothing that had an explicit author" $?
printf '%s\n' "$J2" | grep 'nobody named' | grep -q '"agent":"owner-floor'
chk "attribution: a call that named nobody is signed by the floor" $?
grep -q 'from doc-auditor@proj-29' "$HUBD_DIR2"/queues/attr-role.*.queue.md 2>/dev/null
chk "attribution: hub_queue_send with agent (no from) is sent from that agent" $?
rm -rf "$HUBD_DIR2"
printf '\n%d pass, %d fail (attribution)\n' "$P2" "$F2"
[ "$F2" -eq 0 ] || exit 1

# ── a send reports depth, and knows what that depth can mean on THIS node ──
# A role whose reader left no read mark (a hubd from before them, on another machine) reads as
# permanently unconsumed here. Warning about that as if nothing consumed it would be wrong.
D4="$(mktemp -d)"
REQS4=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"local","text":"first","from":"o"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_queue_wait","arguments":{"role":"local","timeout":2}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"local","text":"a","from":"o"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"local","text":"b","from":"o"}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"remote","text":"a","from":"o"}}}
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"remote","text":"b","from":"o"}}}
EOF
)
OUT4=$(printf '%s\n' "$REQS4" | HUBD_DIR="$D4" HUBD_AGENT=dev-t node hub/index.mjs 2>/dev/null)
P4=0; F4=0
chk4() { if [ "$2" -eq 0 ]; then P4=$((P4+1)); echo "PASS $1"; else F4=$((F4+1)); echo "FAIL $1"; fi; }
printf '%s\n' "$OUT4" | grep -q '"id":5' && printf '%s\n' "$OUT4" | sed -n 's/.*"id":5.*/&/p' | grep -q 'IS consumed on this node'
chk4 "send depth: a role consumed HERE gets the real warning" $?
printf '%s\n' "$OUT4" | sed -n 's/.*"id":7.*/&/p' | grep -q 'never consumed this role'
chk4 "send depth: a role read nowhere visible gets the caveat, not an accusation" $?
printf '%s\n' "$OUT4" | sed -n 's/.*"id":7.*/&/p' | grep -qv 'nothing is consuming'
chk4 "send depth: and is not told that nothing is consuming it" $?
rm -rf "$D4"
printf '\n%d pass, %d fail (send depth)\n' "$P4" "$F4"
[ "$F4" -eq 0 ] || exit 1

# ── One directory: a server declared with HUBD_TEAM_DIR alone writes EVERYTHING there ──
# Presence, journal and queues. Until 0.9.17 the queues went to HUB (the server ignored the
# variable) and the base itself stayed ~/.hubd (task maple-88).
D3="$(mktemp -d)"
REQS3=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hub_heartbeat","arguments":{"agent":"fleet-role","role":"fleet-role","status":"waiting"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_queue_send","arguments":{"role":"head-orchestrator","text":"escalation","from":"fleet-role"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hub_report","arguments":{"project":"onedir","agent":"fleet-role","text":"FACT: one directory"}}}
EOF
)
printf '%s\n' "$REQS3" | env -u HUBD_DIR -u HUBD_QUEUE_DIR HUBD_TEAM_DIR="$D3" node hub/index.mjs >/dev/null 2>&1
P3=0; F3=0
chk3() { if [ "$2" -eq 0 ]; then P3=$((P3+1)); echo "PASS $1"; else F3=$((F3+1)); echo "FAIL $1"; fi; }
ls "$D3"/presence/*.json >/dev/null 2>&1
chk3 "one dir: heartbeat lands in HUBD_TEAM_DIR/presence" $?
ls "$D3"/queues/head-orchestrator.*.queue.md >/dev/null 2>&1
chk3 "one dir: queue message lands in HUBD_TEAM_DIR/queues" $?
grep -q 'one directory' "$D3"/projects/onedir.md 2>/dev/null
chk3 "one dir: the report's FACT lands on the card under HUBD_TEAM_DIR" $?
rm -rf "$D3"
printf '\n%d pass, %d fail (one directory)\n' "$P3" "$F3"
[ "$F3" -eq 0 ] || exit 1
