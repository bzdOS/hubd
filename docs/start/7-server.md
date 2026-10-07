# 7. A server — one hub for a team, over HTTP

**What you get.** The same tools over HTTP, for agents that share neither a disk nor a
git remote with you: a cloud sandbox, a teammate's laptop, a client that only speaks
to a URL. One token opens it. And a feed of the journal: each new entry, once, to
whatever should hear about it.

Ten minutes. This continues [6. Laws](6-laws.md) on `oak`. The server serves your
practice hub on 127.0.0.1; nothing here is reachable from another machine.

```bash
export HUBD_DIR=/tmp/hub-tour HUBD_TEAM_DIR=/tmp/hub-tour HUBD_NODE=oak
cd /tmp/hub-tour-work/shop
```

## Start it

```bash
export HUBD_TOKEN="$(uuidgen)"
hubd --http 8787 &
curl -s localhost:8787/healthz
```

```text
hubd serving MCP over HTTP on 127.0.0.1:8787 (single-tenant, hub_sync disabled)
{"ok":true,"server":"hubd","version":"0.9.55","mode":"single-tenant"}
```

The token is the only credential: 16 characters at least, and a uuid is a good one.
The server listens on 127.0.0.1 unless `HUBD_HTTP_HOST` says otherwise, and
`/healthz` is the one address that needs no token.

## Talk to it

MCP over HTTP is JSON-RPC in a POST:

```bash
curl -s localhost:8787/ -H "Authorization: Bearer $HUBD_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hub_next","arguments":{"project":"shop"}}}'
```

```text
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\n \"task\": {\n  \"id\": \"oak-2\",\n  \"project\": \"shop\",\n  \"text\": \"wire the hosted payment page into checkout\", …
```

The answer is the same `hub_next` an agent gets over stdio. To keep the rest
readable, a small helper that sends one call and prints its text (it uses
[jq](https://jqlang.org)):

```bash
mcp() { curl -s localhost:8787/ -H "Authorization: Bearer $HUBD_TOKEN" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | jq -r '.result.content[0].text'; }
```

An agent somewhere else adds a task:

```bash
mcp hub_task_add '{"project":"shop","text":"link the refund policy from the checkout page","by":"dev-remote"}'
```

```text
{
 "ok": true,
 "id": "oak-6",
 "project": "shop",
 "by": "dev-remote",
 "importance": "normal",
 "cat": null,
 "textPreview": "link the refund policy from the checkout page"
}
```

It is a task in your hub, like any other:

```bash
hub task list -p shop
```

```text
! #oak-2 [shop] wire the hosted payment page into checkout
  #oak-4 [shop] load-test checkout with 200 items
  #oak-5 [shop] @worker rotate the staging API key
  #elm-1 [shop] write the refund policy page
  #oak-6 [shop] link the refund policy from the checkout page
(5 tasks)
```

## Connect an agent

```bash
claude mcp add --transport http hubd-team http://127.0.0.1:8787/ --header "Authorization: Bearer $HUBD_TOKEN"
```

Other clients take a URL and an `Authorization` header in their MCP config. From
another machine the URL is `https://` and a TLS proxy sits in front of the server
(below): a bearer token over plain HTTP is a token anyone on the path can read.

## What changes over HTTP

**Every call names its author.** Over stdio, `HUBD_AGENT` in the client's config
fills in `agent`, `by` and `from` when a call leaves them out. Over HTTP that variable
would name whoever started the server, not any of the callers, so it does not apply:

```bash
mcp hub_task_add '{"project":"shop","text":"translate the refund page"}'
```

```text
Error: by required: the function you are performing, e.g. "dev-hubd" or "reviewer-bsdos". Set HUBD_AGENT to give every call a default.
```

The last sentence is the advice for stdio; over HTTP, only the call can name its
author.

**Nothing waits on the server.** A wait holds a connection open for minutes, and on a
shared server that is a way to run it out of connections; `hub_sync` reads a path
and runs git on the host. All three are off:

```bash
mcp hub_queue_wait '{"role":"worker","timeout":30}'
```

```text
Error: hub_queue_wait is disabled on a shared server (no server-side filesystem access). Use task/journal tools.
```

Sending still works: delivery is a file. The reader waits where the hub is on disk,
on the server's machine or on a node of the mesh:

```bash
mcp hub_queue_send '{"role":"worker","text":"the refund page is up on staging; check its links","from":"dev-remote"}'
hub queue wait worker --timeout 3
```

```text
{
 "file": "/tmp/hub-tour/queues/worker.oak.queue.md",
 "pending": 1,
 "oldestWaiting": "2026-10-07 13:14",
 "consumedHere": true,
 "unacked": 2
}
## 2026-10-07 13:14 · from dev-remote · id oak-7
the refund page is up on staging; check its links
```

`unacked` counts the blocks the worker read and never acked: the two it read from a
shell in tutorials 3 and 4.

**Nothing reads the server's disk for a caller.** A `cwd` a remote agent passes is a
place on its own machine, so `hub_context` finds the project from hub data only
(recorded paths, card names) and never walks the server's folders. The server sets
this itself; a caller cannot turn it off.

Everything else (tasks, the journal, cards, claims, resources, search, the brief)
behaves exactly as over stdio.

## A feed of what happens

A person, a chat room or a pager wants each new entry of the journal, once.
`hub watch` keeps a named cursor on this node and shows what is new to it:

```bash
hub watch --as phone
```

```text
watch phone: a new cursor; entries written from now on are shown. --since 1h on a new cursor starts earlier.
```

A new cursor starts now. The remote agent reports:

```bash
mcp hub_report '{"project":"shop","agent":"dev-remote","text":"the refund page links to the old FAQ in 3 places; fixed on staging"}'
hub watch --as phone
```

```text
{
 "ok": true,
 "project": "shop",
 "decisions": 0,
 "facts": 0,
 "hypos": 0,
 "comms": 0,
 "next": false,
 "done": [],
 "doneAlready": [],
 "doneMissed": [],
 "tasks": [],
 "note": true,
 "digestAgeDays": 0
}
2026-10-07 13:14 [shop/dev-remote] note: the refund page links to the old FAQ in 3 places; fixed on staging
```

The next run shows only what came after. `--follow` keeps it running, and `--exec`
hands each entry to a command as one JSON line, marking it only when the command
exits 0, so a notification that failed is sent again:

```bash
hub decide "keep the old FAQ addresses as redirects" --why "3 outside sites link to them" -p shop --by alice
hub watch --as phone --exec 'jq -r "\"[hub] \(.agent) on \(.project): \(.text)\""'
```

```text
Decided on shop: +1 → ## Decisions
[hub] alice on shop: keep the old FAQ addresses as redirects — 3 outside sites link to them
```

With `--follow` the same command is a notifier that never misses an entry and never
repeats one. [contrib/watch-to-matrix.sh](../../contrib/watch-to-matrix.sh) posts
to a Matrix room in a dozen lines; the cursor's rules are in
[interop → Following the journal](../interop.md#following-the-journal-hub-watch).

## Many teams, one server

With `HUBD_MULTITENANT=1` there is no fixed token: every token is a workspace of its
own, created on its first request.

```bash
HUBD_MULTITENANT=1 HUBD_DIR=/tmp/hub-tour-server hubd --http 8788 &
call() { curl -s localhost:8788/ -H "Authorization: Bearer $1" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" | jq -r '.result.content[0].text'; }
A="$(uuidgen)"; B="$(uuidgen)"
call "$A" hub_task_add '{"project":"store","text":"ship the spring catalogue","by":"dev-a"}'
call "$B" hub_task_list '{}'
ls /tmp/hub-tour-server/tenants
```

```text
hubd serving MCP over HTTP on 127.0.0.1:8788 (multi-tenant, token = workspace, hub_sync disabled)
{
 "ok": true,
 "id": "oak-1",
 "project": "store",
 "by": "dev-a",
 "importance": "normal",
 "cat": null,
 "textPreview": "ship the spring catalogue"
}
{
 "count": 0,
 "total": 0,
 "offset": 0,
 "tasks": []
}
dd8f8ff84bb0a1d98e3bc7c1372b7ced9d7969bd
f0d1b28c4bf1ca50aa768d2ad5caa6a2ecd0f3d6
```

Team B sees nothing of team A. Each workspace is a folder named by a hash of its
token (sha256), so the server's disk never holds a token. There is no signup: whoever holds
a token is in its workspace, which is why it has to be one nobody can guess. `hub
serve` shows a workspace's board with `?t=<token>`.

## On a real network

The server stays on 127.0.0.1; a TLS proxy faces the network. With Caddy that is
three lines:

```
hub.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

[Self-hosting](../self-hosting.md) has the rest: a service unit, the FreeBSD rc
script, backups, and the limits (`HUBD_RATE_LIMIT` requests a minute per client,
`HUBD_MAX_TENANTS` new workspaces).

Stop the practice servers:

```bash
kill %1 %2
```

## What hubd refuses here, and why

**A guessable token.** A short token is a workspace anyone can walk into, so the
server will not start with one:

```bash
HUBD_TOKEN=secret hubd --http 8787
```

```text
hubd --http: set HUBD_TOKEN to a secret of 16+ chars, or HUBD_MULTITENANT=1 (token = workspace).
```

It exits 1. In multi-tenant mode a token under 16 characters is refused per request.

**A call without the token**, or with the wrong one, gets `401` and nothing else: no
error text that would tell a stranger what the server is.

**Too much, too fast.** Over `HUBD_RATE_LIMIT` requests a minute from one client is
`429`; a new workspace past `HUBD_MAX_TENANTS` is `403`, and the existing ones keep
working.

**A tool that would reach the server's disk or hold it open**, shown above: the
error names the tool, and the waits and the sync stay on machines that hold the hub.

## What you have now

The whole tour: a project's memory, its work and decisions, agents that wait for
work, a hub on several machines, a team with heads and a board, laws it learned, and
a server for the agents that cannot share a disk. Where to go from here:

- [Recipes](../recipes.md): whole setups, from one developer to a fleet.
- [Concepts](../concepts.md): the words, and the pictures behind them.
- [Guarantees](../guarantees.md): what hubd promises, and what it does not.
- [Self-hosting](../self-hosting.md): the server, for real.

Your practice hub is a folder: `rm -rf /tmp/hub-tour*` when you are done with it.
