# 9. A company server

**The situation.** Some of your agents share no disk with the hub. A sandbox starts in
the cloud for each pull request and is gone an hour later; a contractor works from their
own laptop. They cannot run `hub`, read the folder, or join the mesh. And one client's
project is under NDA: its cards may not sit in the team's hub, where every agent reads
them.

**What you end with.** One machine that serves the team's hub over HTTPS and is a node
of the mesh as well, so a sandbox and your laptop work on one hub. On the same machine,
a second server with a workspace per client, each behind its own token, that opens no
more workspaces than you have clients. Both behind a TLS proxy, as services of their own
user, with backups. And what you will do to them later: change a token, give a
workspace a new one, close a workspace for good.

Level 7: [7. A server](../start/7-server.md) starts a server and talks to it, and
[Self-hosting](../self-hosting.md) is its reference. This scenario uses a demo hub, a
week of an invented team's work, as the team's hub. Every output below is real,
captured in one run on two simulated nodes on one computer, so its clock reads minutes
where the story says hours.

```bash
hub demo /tmp/hub-s9-cedar > /dev/null
MS="$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"
git init -q --bare -b main /tmp/hub-s9-remote.git
git -C /tmp/hub-s9-cedar init -q -b main
git -C /tmp/hub-s9-cedar add -A && git -C /tmp/hub-s9-cedar commit -qm hub
git -C /tmp/hub-s9-cedar remote add origin /tmp/hub-s9-remote.git
git -C /tmp/hub-s9-cedar push -q -u origin main
git clone -q /tmp/hub-s9-remote.git /tmp/hub-s9-oak
export HUBD_DIR=/tmp/hub-s9-oak HUBD_TEAM_DIR=/tmp/hub-s9-oak HUBD_NODE=oak
on() ( n=$1; shift; export HUBD_DIR=/tmp/hub-s9-$n HUBD_TEAM_DIR=/tmp/hub-s9-$n HUBD_NODE=$n; "$@" )
for n in oak cedar; do on $n hub card merge-driver > /dev/null; done
sync() { for n in cedar oak; do on $n sh "$MS" | grep -v '^mesh-sync: ok'; done; }
```

`cedar` is the machine that will serve the hub, `oak` your laptop, and `on cedar …`
runs a command as cedar. `sync` runs mesh-sync on both and prints only a run that was
not ok.

## The server

```bash
T="$(openssl rand -hex 24)"
HUBD_DIR=/tmp/hub-s9-cedar HUBD_TEAM_DIR=/tmp/hub-s9-cedar HUBD_NODE=cedar HUBD_TOKEN="$T" hubd --http 8787 &
team=$!
curl -s localhost:8787/healthz; echo
```

```text
hubd serving MCP over HTTP on 127.0.0.1:8787 (single-tenant, hub_sync disabled)
{"ok":true,"server":"hubd","version":"0.9.56","mode":"single-tenant"}
```

The server's hub is cedar's copy of the mesh, and its writes are cedar's: they go into
cedar's files, and cedar's sync carries them to every node, like the writes of an agent
on cedar's own disk. `/healthz` is the one request that needs no token, for a monitor.

## An agent with no disk

A sandbox starts for pull request 212. Its agent connects with a URL and the token:

```sh
claude mcp add --transport http hubd https://hub.example.com/ --header "Authorization: Bearer $HUBD_TOKEN"
```

`HUBD_TOKEN` comes from the sandbox's secrets, never from the repository: whoever reads
it has the whole hub. Here `call` stands in for the agent's MCP client, one POST for
each tool call. The agent asks what to do, and marks the task started:

```bash
call() { curl -s "localhost:$1/" -H "Authorization: Bearer $2" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$3\",\"arguments\":$4}}" | jq -r '.result.content[0].text'; }
call 8787 "$T" hub_next '{"project":"atlas","assignee":"atlas-dev"}' | jq -c '{task: .task.id, text: .task.text, why}'
call 8787 "$T" hub_claim '{"task":"fir-1","agent":"atlas-dev","note":"sandbox for PR 212"}' | jq -c '{ok, area: .claim.area, ttlMin: .claim.ttlMin}'
```

```text
{"task":"fir-1","text":"Ship search ranking v2","why":"importance high"}
{"ok":true,"area":"task:fir-1","ttlMin":240}
```

It does the work, and reports before the sandbox goes:

```bash
call 8787 "$T" hub_report '{"project":"atlas","agent":"atlas-dev","text":"ranking v2 merged in PR 212; the A/B switch defaults to off\nDONE: fir-1"}' | jq -c '{ok, done, note}'
```

```text
{"ok":true,"done":["fir-1"],"note":true}
```

The sandbox is deleted with the pull request. What it did is in the hub.

## On your laptop

```bash
sync
hub log atlas | tail -2
hub task list -p atlas
```

```text
2026-10-07 16:55 [atlas/atlas-dev] done: #fir-1 Ship search ranking v2
2026-10-07 16:55 [atlas/atlas-dev] note: ranking v2 merged in PR 212; the A/B switch defaults to off
  #fir-5 [atlas] Audit third-party scripts on the landing page
  #fir-2 [atlas] @atlas-head Turn ranking v2 on for 10% of traffic
  #fir-4 [atlas] @atlas-dev Rewrite the onboarding copy
(3 tasks)
```

A minute later on a real mesh, here at once: the task closed, the note, and the list
without `fir-1`. The agents on your laptop and the ones in sandboxes work on one hub,
and neither needs to know how the other reaches it.

## Clients, one workspace each

The harbor contract is under NDA. Its cards go on a second server, in multi-tenant
mode: there is no team token, and every token is a workspace of its own. This server is
not a node of the mesh, so nothing in it leaves the machine.

```bash
HUBD_MULTITENANT=1 HUBD_MAX_TENANTS=1 HUBD_DIR=/tmp/hub-s9-clients HUBD_NODE=cedar hubd --http 8788 &
clients=$!
C="$(openssl rand -hex 24)"
call 8788 "$C" hub_card_set '{"project":"harbor","digest":"The port authority portal. Under NDA.","by":"harbor-lead"}' | jq -c .
folder() { printf %s "$1" | shasum -a 256 | cut -c1-40; }
ls /tmp/hub-s9-clients/tenants
folder "$C"
```

```text
hubd serving MCP over HTTP on 127.0.0.1:8788 (multi-tenant, token = workspace, hub_sync disabled)
{"ok":true,"project":"harbor","section":"Digest","bytes":37}
e1925a4d10d40122bdcc848735cb85494cde0bb0
e1925a4d10d40122bdcc848735cb85494cde0bb0
```

You make the workspace with its first request, then hand the token to the client's
agents. Its folder is named by a hash of the token, so the disk never holds the token.
`HUBD_MAX_TENANTS` is the number of clients you have: past it, a token nobody has used
before is refused.

```bash
code() { curl -s -o /dev/null -w '%{http_code}\n' "localhost:$1/" -H "Authorization: Bearer $2" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }
code 8788 "$C"
code 8788 "$(openssl rand -hex 24)"
code 8788 "$T"
code 8787 "$C"
```

```text
200
403
403
401
```

The client, in its workspace. A stranger's token, which would have been a new
workspace past the cap. The team's token, which is no different here: to this server it
is one more stranger. And the client's token on the team server, which is a wrong
token. A new client is the cap raised by one, a restart, and the workspace made by you
before its token is handed out.

## A new token

The contractor who had the team's token leaves, and the harbor token was pasted into a
ticket. Both change:

```bash
kill $team $clients; wait $team $clients 2>/dev/null
T2="$(openssl rand -hex 24)"; C2="$(openssl rand -hex 24)"
mv "/tmp/hub-s9-clients/tenants/$(folder "$C")" "/tmp/hub-s9-clients/tenants/$(folder "$C2")"
HUBD_DIR=/tmp/hub-s9-cedar HUBD_TEAM_DIR=/tmp/hub-s9-cedar HUBD_NODE=cedar HUBD_TOKEN="$T2" hubd --http 8787 &
team=$!
HUBD_MULTITENANT=1 HUBD_MAX_TENANTS=1 HUBD_DIR=/tmp/hub-s9-clients HUBD_NODE=cedar hubd --http 8788 &
clients=$!
code 8787 "$T"; code 8787 "$T2"
code 8788 "$C"; code 8788 "$C2"
```

```text
hubd serving MCP over HTTP on 127.0.0.1:8787 (single-tenant, hub_sync disabled)
hubd serving MCP over HTTP on 127.0.0.1:8788 (multi-tenant, token = workspace, hub_sync disabled)
401
200
403
200
```

The team's token is one line in the server's environment, and the old one stops at
the restart, for everyone who held it: every sandbox and laptop needs the new one, so
keep it in one secret store they all read. A workspace has no token on the disk to
change. It takes a new one when its folder takes the new token's name. The old token is
refused, and with the cap full it cannot open a new workspace either.

## The end of a contract

The harbor work is done. The client takes its workspace home, and nobody gets in again:

```bash
kill $clients; wait $clients 2>/dev/null
mkdir -p /tmp/hub-s9-archive
mv "/tmp/hub-s9-clients/tenants/$(folder "$C2")" /tmp/hub-s9-archive/harbor
HUBD_MULTITENANT=1 HUBD_MAX_TENANTS=0 HUBD_DIR=/tmp/hub-s9-clients HUBD_NODE=cedar hubd --http 8788 &
clients=$!
code 8788 "$C2"
HUBD_DIR=/tmp/hub-s9-archive/harbor HUBD_TEAM_DIR=/tmp/hub-s9-archive/harbor hub status
```

```text
hubd serving MCP over HTTP on 127.0.0.1:8788 (multi-tenant, token = workspace, hub_sync disabled)
403
slug                      synced                open  digest
──────────────────────────────────────────────────────────────────────────────────────────
harbor                    2026-10-07 16:55 by … 0     The port authority portal. Under NDA.
```

A multi-tenant server keeps no list of tokens, so there is none to revoke: the cap is
what refuses the old one. Stop the server before you move the folder, and start it with
the cap at the number of workspaces left. The archive is a hub like any other: `hub
status` reads it, and a tar of it is what the client takes home.

## Running for good

On a Linux machine, the two servers and the sync run as one user of their own, `hubd`,
and a TLS proxy faces the network. Here, `kill $team $clients` stops the practice
servers.

The user, its folders, and the team's hub, cloned with a deploy key that can push:

```sh
useradd --system --create-home --home-dir /var/lib/hubd --shell /usr/sbin/nologin hubd
install -d -o hubd -g hubd -m 700 /var/lib/hubd/clients /var/backups/hubd
sudo -u hubd git clone git@git.example.com:team/hub.git /var/lib/hubd/team
sudo -u hubd env HUBD_DIR=/var/lib/hubd/team hub card merge-driver
sudo -u hubd sh -c 'echo .mesh-sync.log >> /var/lib/hubd/team/.gitignore'
```

One environment file for each server, readable by root and the `hubd` group only. The
port in `HUBD_HTTP_PORT` starts the server in HTTP mode:

```sh
# /etc/hubd/team.env
HUBD_DIR=/var/lib/hubd/team
HUBD_NODE=cedar
HUBD_HTTP_PORT=8787
HUBD_TOKEN=<openssl rand -hex 24>

# /etc/hubd/clients.env
HUBD_DIR=/var/lib/hubd/clients
HUBD_NODE=cedar
HUBD_HTTP_PORT=8788
HUBD_MULTITENANT=1
HUBD_MAX_TENANTS=3
```

One unit serves both, and a timer runs the sync every minute, as the same user, so
every file in the hub has one owner ([7. A node stopped syncing](07-node-stopped-syncing.md#cause-a-cursor-that-belongs-to-another-account)
has what a second owner does):

```sh
# /etc/systemd/system/hubd@.service
[Unit]
Description=hubd %i
After=network-online.target
Wants=network-online.target
[Service]
User=hubd
EnvironmentFile=/etc/hubd/%i.env
ExecStart=/usr/local/bin/hubd
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/hubd
[Install]
WantedBy=multi-user.target

# /etc/systemd/system/hubd-mesh-sync.service
[Service]
Type=oneshot
User=hubd
EnvironmentFile=/etc/hubd/team.env
ExecStart=/bin/sh -c 'exec sh /usr/local/lib/node_modules/@bzdos/hubd/scripts/mesh-sync.sh >> "$HUBD_DIR/.mesh-sync.log" 2>&1'

# /etc/systemd/system/hubd-mesh-sync.timer
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
```

```sh
systemctl daemon-reload
systemctl enable --now hubd@team hubd@clients hubd-mesh-sync.timer
```

The paths are where `npm i -g` put hubd on this machine: `command -v hubd` and `npm
root -g` say where. The sync's output goes to `.mesh-sync.log`, where `hub doctor`
quotes its last error. The proxy, with Caddy:

```
hub.example.com {
    reverse_proxy 127.0.0.1:8787
}
clients.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

The team's hub needs no backup of its own: every node holds all of it, and so does the
remote. The client workspaces are on this disk only:

```sh
# /etc/cron.d/hubd-backup
15 3 * * * hubd tar czf /var/backups/hubd/clients-$(date +\%F).tgz -C /var/lib/hubd clients
```

Copy the file off the machine, encrypted: it is every client's workspace in one file.
The tokens are not in it, and a restored folder opens with the client's own token, as
before.

On FreeBSD, [Self-hosting](../self-hosting.md#freebsd-rcd-and-daemon8) has the rc.d
script. The second server is a copy of it named `hubd_clients`, with `name` and its
variables renamed to match, and the sync is a cron line of the `hubd` user.

## What can go wrong

**The server facing the network itself.** With `HUBD_HTTP_HOST=0.0.0.0` and no proxy,
the token crosses the network as plain text, and the rate limit trusts an
`X-Forwarded-For` that any caller can write. Keep the server on 127.0.0.1, the default,
with the proxy in front.

**A name is a claim.** A token says which hub, not who calls. `agent`, `by` and `from`
are what the caller writes, so whoever holds the team's token can write as `owner` or
as a head. Give it only to agents you would trust with any name; the journal keeps the
name each one gave.

**One token for everyone.** Changing it cuts off everyone at once, so a leak or a
departure costs a morning of handing out the new one, unless every agent reads it from
one secret store. A contractor who works for one client needs that client's workspace,
not the team's token.

**Many sandboxes behind one address.** The rate limit counts requests from each client
address, 120 a minute by default, and a cloud's sandboxes often leave it through one.
They share the limit and start getting 429. Raise `HUBD_RATE_LIMIT` on the team server.

**A workspace that comes back.** A running server remembers every workspace it has
seen: remove a folder under it, and the next request with that token makes it again,
empty. Stop the server first. A cap above the number of workspaces lets an old token
open a new one after the restart.

**A lost workspace token.** The disk holds only its hash, so neither you nor the
server can recover it. The workspace is not lost: give it a new token, as above.

**The board on the network.** `hub serve` has no token of its own. On the team's hub it
shows everything to whoever reaches its port. In multi-tenant mode it opens a workspace
by its token or by its folder name, so a folder name in a log or a screenshot is enough
to read that board. Keep it on 127.0.0.1, its default, and open it through an SSH
tunnel.

**A wait in a sandbox.** `hub_queue_wait` and `hub_sync` are off on the server
([7. A server](../start/7-server.md#what-changes-over-http)). A role that waits for work
runs where the hub is on disk, on cedar or on a node of the mesh; sending to it over
HTTP works.

**A claim on the other side.** Claims are node state and do not travel with the mesh:
a sandbox's claim is seen by every agent that calls the server, and by none on your
laptop. Dispatch a task to one side, not both.
