# 8. Notifications

**The situation.** You are away from the terminal, and the team works on. A chat room
that gets every journal line is muted within a day. One that gets none means you learn
about a blocked worker from the board, hours later, and about a question waiting for
you when you next sit down.

**What you end with.** Three feeds from one hub, each with its own filter and its own
place in the journal. The team's Matrix room gets decisions and blocked work, from
every project. The `relay` channel in Slack gets what that project decided and
finished. Your phone, through ntfy, gets blocked work and every message to your queue.
A post that fails is retried until it goes through, and nothing goes twice to a
service that drops repeats.

Level 7: [7. A server](../start/7-server.md#a-feed-of-what-happens) introduces
`hub watch`, and [Reading your hub with any tool](../interop.md#following-the-journal-hub-watch)
says why it keeps a cursor of entries, not of bytes. This scenario uses a demo hub, a
week of an invented team's work, whose owner role is `owner`. Every output below is
real, captured in one run on a node called `oak`, so its clock reads minutes where the
story says hours.

```bash
hub demo /tmp/hub-s8 > /dev/null
export HUBD_DIR=/tmp/hub-s8 HUBD_TEAM_DIR=/tmp/hub-s8 HUBD_NODE=oak
```

## A stand-in for the three services

Each feed ends in one HTTP request: a PUT to Matrix, a POST to a Slack webhook, a POST to
an ntfy topic. Here one small server stands in for all three. It prints what each one
received, and answers 503 while the file `/tmp/hub-s8-down` exists:

```bash
cat > /tmp/hub-s8-recv.py <<'EOF'
import http.server, json, os, sys
class Recv(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        if os.path.exists("/tmp/hub-s8-down"):
            self.send_response(503); self.end_headers(); return
        if self.path.startswith("/_matrix/"): print("matrix |", json.loads(body)["body"], flush=True)
        elif self.path.startswith("/services/"): print("slack  |", json.loads(body)["text"], flush=True)
        else: print("ntfy   |", self.headers["Title"], "|", body.strip(), flush=True)
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    do_PUT = do_POST
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Recv).serve_forever()
EOF
python3 /tmp/hub-s8-recv.py 7808 &
export MATRIX_HS=http://127.0.0.1:7808 MATRIX_ROOM='!team:example.org' MATRIX_TOKEN=stand-in
export SLACK_WEBHOOK=http://127.0.0.1:7808/services/T000/B000/stand-in
export NTFY_URL=http://127.0.0.1:7808/hubd-oak-k7q2m9
```

On real services, `MATRIX_HS` is your homeserver and `MATRIX_TOKEN` a bot account's
access token, `SLACK_WEBHOOK` the incoming webhook of the channel, and `NTFY_URL` a
topic on ntfy.sh or your own ntfy server. On ntfy.sh anyone who knows a topic's name
can read it, so make the name one nobody would guess.

## One filter per feed

`hub watch --exec` hands each new journal entry to a command, as one line of JSON on
stdin, and marks the entry passed only when the command exits 0. So a feed is a small
script: pick the entries it wants, post them, and exit 0 for the ones it skips as well,
because a skipped entry is taken too.

```bash
B=/tmp/hub-s8-bin && mkdir -p $B
cat > $B/to-matrix <<'EOF'
#!/bin/sh
# the team's room: decisions and blocked work, every project
m=$(jq -c 'select(.kind == "decision" or .kind == "blocked")
  | {msgtype: "m.text", body: "[\(.project)/\(.agent)] \(.kind): \(.text)"}') || exit 1
[ -n "$m" ] || exit 0
room=$(jq -rn --arg r "$MATRIX_ROOM" '$r|@uri')
printf '%s\n' "$m" | curl -fsS -m 15 -X PUT -H "Authorization: Bearer $MATRIX_TOKEN" --data @- \
  "$MATRIX_HS/_matrix/client/v3/rooms/$room/send/m.room.message/hubd-$HUBD_WATCH_KEY" > /dev/null
EOF
cat > $B/to-slack <<'EOF'
#!/bin/sh
# the relay channel: what relay decided and finished
m=$(jq -c 'select(.project == "relay" and (.kind == "decision" or .kind == "done"))
  | {text: "\(.agent) \(.kind): \(.text)"}') || exit 1
[ -n "$m" ] || exit 0
printf '%s\n' "$m" | curl -fsS -m 15 -H "Content-Type: application/json" --data @- "$SLACK_WEBHOOK" > /dev/null
EOF
cat > $B/to-phone <<'EOF'
#!/bin/sh
# your phone: blocked work, every project
m=$(jq -r 'select(.kind == "blocked") | "\(.project)/\(.agent): \(.text)"') || exit 1
[ -n "$m" ] || exit 0
printf '%s\n' "$m" | curl -fsS -m 15 -H "Title: blocked" -H "Priority: high" --data-binary @- "$NTFY_URL" > /dev/null
EOF
chmod +x $B/*
```

Each feed has a cursor of its own, named by `--as`, kept in the hub's `.watch/` folder.
The first pass places it:

```bash
for f in matrix slack phone; do hub watch --as $f --exec $B/to-$f; done
```

```text
watch matrix: a new cursor; entries written from now on are shown. --since 1h on a new cursor starts earlier.
watch slack: a new cursor; entries written from now on are shown. --since 1h on a new cursor starts earlier.
watch phone: a new cursor; entries written from now on are shown. --since 1h on a new cursor starts earlier.
```

A new cursor starts now: a feed added to a hub with a year of history does not post the
year.

## A day's news

The relay worker finishes the retry fix and hits a wall on the next task. Its head
decides around the wall and cuts the release. The atlas worker finishes a task:

```bash
hub report -p relay --agent relay-dev -m "DONE: pine-2"
hub report -p relay --agent relay-dev -k blocked <<'EOF'
FACT: the API gateway drops response headers above 8 KB
pine-4: the rate-limit headers never reach the client; blocked until the gateway is patched
EOF
hub decide "ship relay 2.4.1 without the rate-limit headers" --why "the gateway patch is a week out; the retry fix should not wait for it" -p relay --by relay-head
hub report -p relay --agent relay-head -m "DONE: pine-3"
hub report -p atlas --agent atlas-dev -m "DONE: fir-1"
```

```text
Reported to relay: closed #pine-2
Reported to relay: 1 fact, note
Decided on relay: +1 → ## Decisions
Reported to relay: closed #pine-3
Reported to atlas: closed #fir-1
```

Five journal entries. Each feed takes what is new to it:

```bash
for f in matrix slack phone; do hub watch --as $f --exec $B/to-$f; done
```

```text
matrix | [relay/relay-dev] blocked: pine-4: the rate-limit headers never reach the client; blocked until the gateway is patched
matrix | [relay/relay-head] decision: ship relay 2.4.1 without the rate-limit headers — the gateway patch is a week out; the retry fix should not wait for it
slack  | relay-dev done: #pine-2 Retry webhook delivery with backoff
slack  | relay-head decision: ship relay 2.4.1 without the rate-limit headers — the gateway patch is a week out; the retry fix should not wait for it
slack  | relay-head done: #pine-3 Cut release 2.4.1
ntfy   | blocked | relay/relay-dev: pine-4: the rate-limit headers never reach the client; blocked until the gateway is patched
```

The atlas task went nowhere: no feed asked for it. The fact went nowhere either, because
it is on the relay card, not in the journal. A feed carries what happened; the card is
where it is kept.

## What waits for you

The most urgent thing for your phone is not in the journal at all. A question for you,
a button, is a message to the `owner` queue, and messages never pass through the
journal. The phone reads the queue itself, beside you, with a cursor of its own. For
that, the hub must know that `owner` has more than one reader:

```bash
echo '["owner"]' > "$HUBD_DIR/subscriber-roles.json"
cat > $B/buttons-to-phone <<'EOF'
#!/bin/sh
# each message to the owner's queue, pushed to the phone; your own reading of the queue is not touched
while m=$(hub queue monitor owner --as phone "$@"); do
  printf '%s\n' "$m" | curl -fsS -m 15 -H "Title: waiting for you" --data-binary @- "$NTFY_URL" > /dev/null
done
EOF
chmod +x $B/buttons-to-phone
hub queue send owner "The 2.4.1 notes name the gateway's 8 KB limit. Publish them as written, or leave the limit out?" --from relay-head
$B/buttons-to-phone --once --timeout 1
hub board | sed -n '/owner queue/,/your tasks/p'
```

```text
→ owner.oak.queue.md delivered
ntfy   | waiting for you | ## 2026-10-07 16:12 · from atlas-head · id fir-44
Ranking v2 can go to 10% of traffic once fir-1 is in. Turn it on Tuesday, or wait for the Thursday release?
## 2026-10-07 16:42 · from relay-head · id oak-1
The 2.4.1 notes name the gateway's 8 KB limit. Publish them as written, or leave the limit out?
  owner queue (2)
    owner  0d  from atlas-head  Ranking v2 can go to 10% of traffic once fir-1 is in. Turn it on Tuesday, or wa…
    owner  0d  from relay-head  The 2.4.1 notes name the gateway's 8 KB limit. Publish them as written, or leav…
  your tasks (1)
```

The phone's first read brought the question that has waited since the morning as well.
The board still shows both, and `hub queue wait owner` still returns both: the phone
read them for itself. Run as a service, the script waits for the next message forever;
here `--once --timeout 1` stops it when the queue is empty.

## When a service is down

The Slack webhook starts answering 503. The relay head writes one more decision:

```bash
touch /tmp/hub-s8-down
hub decide "move the gateway patch to Monday's window" --why "the vendor's fix ships Friday night; nobody deploys over a weekend" -p relay --by relay-head
hub watch --as slack --exec $B/to-slack; echo "exit $?"
```

```text
Decided on relay: +1 → ## Decisions
curl: (22) The requested URL returned error: 503
watch slack: the command exited 22 on the entry of 2026-10-07 16:42 [relay/relay-head]; it and the entries after it are handed over again on the next run
exit 1
```

The entry stays new for the `slack` cursor, and the ones after it wait behind it, so
the channel never gets them out of order. When the webhook is back:

```bash
rm /tmp/hub-s8-down
hub watch --as slack --exec $B/to-slack
```

```text
slack  | relay-head decision: move the gateway patch to Monday's window — the vendor's fix ships Friday night; nobody deploys over a weekend
```

So each entry reaches each service at least once. It can reach it twice: a post the
service took, whose answer was lost on the way back, counts as failed and is sent
again. Matrix drops the repeat, because the transaction id in the URL is
`HUBD_WATCH_KEY`, the same on every attempt. Slack and ntfy show it twice.

## Running for good

`--follow` keeps a watch running: a pass every five seconds, when the journal changed,
and on a failure a retry every five seconds until the command exits 0. On Linux, one
systemd user unit serves all three journal feeds:

```sh
# ~/.config/systemd/user/hubd-feed@.service
[Unit]
Description=hubd feed %i
[Service]
EnvironmentFile=%h/.config/hubd/feeds.env
ExecStart=/bin/sh -c 'exec hub watch --as %i --follow --exec "$HOME/bin/to-%i"'
Restart=always
RestartSec=30
[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now hubd-feed@matrix hubd-feed@slack hubd-feed@phone
```

`feeds.env` holds `HUBD_DIR`, `HUBD_NODE`, a `PATH` that has `hub`, `jq` and `curl`, and
the three services' addresses and tokens; make it readable by you alone. The button feed
is one more unit with `ExecStart=%h/bin/buttons-to-phone`. On a Mac, a launchd agent with
`KeepAlive` does the same. With cron, drop `--follow`: one pass a minute, and a pass that
fails exits 1, which cron mails to you.

Run each feed on one node. The cursors stay on the node that keeps them (`.watch/` does
not travel with the mesh), and every node has the whole journal. An entry written on
another node reaches the feed with the next sync, a minute later.

`contrib/watch-to-matrix.sh`, shipped with hubd, is the Matrix feed without a filter:
every entry, every project, as one service. Here, `kill %1` stops the stand-in.

## What can go wrong

**The feed that carries everything.** Every note and every task line, in one room, is
read for a day and then muted, and with it the line that mattered. Start from the two
kinds a person must act on, `blocked` and `decision`, and add a kind when someone asks
for it.

**A filter that fails on what it skips.** `jq -e` exits 1 when its answer is false. A
filter built on it, without an `exit 0` for that case, fails on the first entry it does
not want, and that entry is handed over again on every pass, forever, with nothing after
it delivered. `--follow` says so once, on stderr, and goes on retrying. The opposite
mistake loses entries without a word: a filter that exits 0 when `jq` or `curl` is
missing. Exit 0 means taken.

**The same feed on two nodes.** Each node keeps its own cursor and has the whole
journal, so the room gets every entry twice. Matrix drops the repeat only when both
nodes post with one access token.

**News that is not in the journal.** Messages, buttons and escalations are queue
messages. A journal feed never sees them, which is why the phone has a second reader on
`owner`. An escalation to the coordinator is answered on the coordinator's card
([6. The owner's day](06-owners-day.md#an-escalation-answer-it-on-the-card)), and the
board is where it waits.

**A feed that was off for a week.** The cursor remembers the entries it passed for seven
days. An entry older than that when the feed reaches it is passed without being posted;
`hub log` still has it. A deleted cursor starts again from now, and the gap is never
posted.

**A private entry.** A report with `--private` goes to the node's own journal, which
never syncs, and `hub watch` skips it unless asked with `--private`. A team room should
never ask.
