# 1. Three clients, one project

**The situation.** One developer, one project, three agent sessions in three different
clients: Claude Code on the API, Cursor on the web front, Codex on the tests. Each is
good at its part and knows nothing of the other two. Until now you carried the state
between them: you pasted what one had decided into the next, and after a compaction you
told the first one again what it had been doing.

**What you end with.** Each session starts from the hub instead of from you: what the
project is, what is open and for whom, who is working in which part of the tree, and
what was decided. One that is compacted gets all of it back in one call, and in the
evening the day is in one place.

Levels 1 and 2: [1. Memory](../start/1-memory.md) and [2. Work](../start/2-work.md)
cover each piece on its own. Every output below is real, captured in one run on a node
called `oak`, so its clock reads minutes where the story says hours.

```bash
export HUBD_DIR=/tmp/hub-s1 HUBD_TEAM_DIR=/tmp/hub-s1 HUBD_NODE=oak
hub init "$HUBD_DIR" > /dev/null
mkdir -p /tmp/hub-s1-work/invoices && cd /tmp/hub-s1-work/invoices
git init -q && mkdir -p src/api src/web tests && echo '# invoices' > README.md
git add -A && git commit -qm invoices
```

## One hub, three names

Every client runs the same server, `npx -y @bzdos/hubd`, and gives it a name for the
job its sessions do. Claude Code:

```bash
claude mcp add --scope project hubd --env HUBD_AGENT=dev-api -- npx -y @bzdos/hubd
```

Cursor, in `.cursor/mcp.json` in the project:

```json
{ "mcpServers": { "hubd": { "command": "npx", "args": ["-y", "@bzdos/hubd"],
                            "env": { "HUBD_AGENT": "dev-web" } } } }
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.hubd]
command = "npx"
args = ["-y", "@bzdos/hubd"]
env = { HUBD_AGENT = "dev-tests" }
```

That is all the setup. With no `HUBD_DIR` they all use `~/.hubd`, so they all see one
hub. (To try this on the practice hub instead, add the three variables exported above
to each `env`.)

The name is the function, not the model or the client: `cursor` and `claude` are
refused, because many sessions share them and the journal could never tell them apart.
Below, each session's tool calls are shown as the `hub` commands they correspond to,
with `--agent` in place of the client's `HUBD_AGENT`.

## Morning: the API session starts the project

The Claude Code session finds no card for this folder, so it makes one, takes the part
of the tree it is about to change, and says what it decided:

```bash
hub sync . -m "Invoicing app: an HTTP API and a web front. Invoices can be created and listed; PDF export is next." --agent dev-api
hub claim invoices 'src/api/**' -t 120 --note "the PDF endpoint" --agent dev-api
hub report -p invoices --agent dev-api <<'EOF'
DECIDE: render PDFs on the server, one template per locale | the web front stays a thin client
FACT: GET /invoices/:id/pdf returns a 1-page PDF for the sample invoice
NEXT: a Download PDF button on the invoice page
EOF
hub task add "Download PDF button on the invoice page" -p invoices --assignee dev-web --by dev-api
hub task add "test the PDF endpoint with a 40-line invoice" -p invoices --assignee dev-tests --by dev-api
```

```text
Synced: invoices → /tmp/hub-s1/projects/invoices.md
Lock: 391da58a-d5b5-484c-a185-3b372e4c2000
Reported to invoices: 1 decision, 1 fact, next set
Task #oak-1 added: Download PDF button on the invoice page
Task #oak-2 added: test the PDF endpoint with a 40-line invoice
```

Nothing is pasted anywhere. The decision went to the card and the journal, the work
for the other two went into tasks with their names on them.

## Cursor picks it up

The Cursor session opens the same folder. Its first call is `hub_context` with its
working directory, and what comes back is the state (abridged):

```json
{
 "project": "invoices",
 "via": "path",
 "digest": "Invoicing app: an HTTP API and a web front. Invoices can be created and listed; PDF export is next.",
 "digestSetBy": "dev-api",
 "openTasks": [ { "id": "oak-1", "text": "Download PDF button on the invoice page", "assignee": "dev-web", … },
                { "id": "oak-2", "text": "test the PDF endpoint with a 40-line invoice", "assignee": "dev-tests", … } ],
 "activeClaims": [ { "area": "src/api/**", "agent": "dev-api", "ttlMin": 120, "note": "the PDF endpoint", … } ],
 "journalTail": [ … "render PDFs on the server, one template per locale — the web front stays a thin client" … ]
}
```

Its task, the decision it has to respect, and the fact that `src/api/` is someone
else's this morning. Before it edits a file outside its own part, it asks:

```bash
hub claim check src/api/pdf.ts -p invoices --agent dev-web
hub claim check src/web/invoice.tsx -p invoices --agent dev-web
```

```text
src/api/** — dev-api since 2026-10-07 15:59 (the PDF endpoint)
  src/api/pdf.ts is inside 1 live claim(s) on invoices — coordinate before editing (soft lock, not enforced)
free — src/web/invoice.tsx
```

It takes its task, does it, and says so with the evidence:

```bash
hub claim --task oak-1 --agent dev-web
hub report -p invoices --agent dev-web <<'EOF'
FACT: the invoice page has a Download PDF button; it saves invoice-<number>.pdf from GET /invoices/:id/pdf
DONE: oak-1
EOF
```

```text
Started #oak-1: 8b7c5243-9a39-42f5-a6d7-54bb2d61421c (until 2026-10-07 19:59)
Reported to invoices: 1 fact, closed #oak-1, released 1 task claim
```

## Codex finds a bug for the API

The Codex session asks what is next for it, takes it, and reports what it found, as a
task for whoever owns the template:

```bash
hub now invoices --assignee dev-tests
hub claim --task oak-2 --agent dev-tests
hub report -p invoices --agent dev-tests <<'EOF'
FACT: a 40-line invoice renders 1 page and stops after line 31; there is no second page
TASK: the PDF template breaks pages after line 31 of an invoice
DONE: oak-2
EOF
```

```text
#oak-2 [invoices] @dev-tests
test the PDF endpoint with a 40-line invoice

why: oldest of the equally urgent
(1 ready, 0 blocked)
Started #oak-2: 711f5a9b-04dc-41f2-a1df-59c398e11351 (until 2026-10-07 19:59)
Reported to invoices: 1 fact, closed #oak-2, released 1 task claim, new task #oak-3
```

## The API session is compacted

Mid-afternoon the Claude Code session runs out of context and is compacted. What it
knew about the morning is now a summary of a summary. Its first call after is the same
one, `hub_context` with its cwd (abridged):

```json
{
 "project": "invoices",
 "openTasks": [ { "id": "oak-3", "text": "the PDF template breaks pages after line 31 of an invoice", "by": "dev-tests", … } ],
 "activeClaims": [ { "area": "src/api/**", "agent": "dev-api", … } ],
 "journalTail": [ …,
  { "agent": "dev-web", "kind": "done", "text": "#oak-1 Download PDF button on the invoice page", … },
  { "agent": "dev-tests", "kind": "done", "text": "#oak-2 test the PDF endpoint with a 40-line invoice", … },
  { "agent": "dev-tests", "kind": "task", "text": "+ task #oak-3: the PDF template breaks pages after line 31 of an invoice", … } ]
}
```

It still holds `src/api/`, the button is in, and the tests found a bug in its template.
Nobody told it; it asked the hub.

## Evening: the day, in one place

```bash
hub log invoices
```

```text
2026-10-08 15:36 [invoices/dev-api] sync: synced with digest [card Digest, Facts (auto): 828 B, new]
2026-10-08 15:36 [invoices/dev-api] decision: render PDFs on the server, one template per locale — the web front stays a thin client [card Decisions, Facts & hypotheses, Next step: 949 B, +121]
2026-10-08 15:36 [invoices/dev-api] task: + task #oak-1: Download PDF button on the invoice page
2026-10-08 15:36 [invoices/dev-api] task: + task #oak-2: test the PDF endpoint with a 40-line invoice
2026-10-08 15:36 [invoices/dev-web] done: #oak-1 Download PDF button on the invoice page
2026-10-08 15:36 [invoices/dev-web] card: card reported: FACT — the invoice page has a Download PDF button; it saves invoice-<number>.pdf from GET /invoices/:id/pdf [card Facts & hypotheses: 1058 B, +109]
2026-10-08 15:36 [invoices/dev-tests] done: #oak-2 test the PDF endpoint with a 40-line invoice
2026-10-08 15:36 [invoices/dev-tests] task: + task #oak-3: the PDF template breaks pages after line 31 of an invoice
2026-10-08 15:36 [invoices/dev-tests] card: card reported: FACT — a 40-line invoice renders 1 page and stops after line 31; there is no second page [card Facts & hypotheses: 1148 B, +90]
```

Three clients from three vendors, one trail. The facts are on the card
(`hub recall "PDF"` finds them, dated); tomorrow morning `hub brief` starts from here.

## What can go wrong

**Two clients with one name.** Writes from both land under one author and stay
indistinguishable in an append-only log. One name per job; a client used for several
jobs gets the name in its per-project config, as above, not in the user-wide one.

**`DONE:` with prose after the id.** A `DONE:` line holds ids and nothing else; the
evidence goes on a `FACT:` line of its own. A line hubd cannot read is not guessed at:

```bash
hub report -p invoices --agent dev-api -m "DONE: oak-3 pages now break after line 30"
```

```text
Reported to invoices: nothing recognized — use DECIDE:/FACT:/COMM:/NEXT:/DONE: prefixes (hub report with no input shows the template)
  warning: NOT closed: #oak-3 pages now break after line 30 (no such task) — check the id with `hub task list`. Write "DONE: <id>[, <id>]" on a line of its own, each id as hub_task_list shows it ("DONE: pine-471"), "#" optional, or the bare number when one task ends in it ("DONE: 471").
```

The task stays open, and the session is told why.

**A claim is a sign, not a lock.** Nothing stops a session that edits inside another's
claim; `hub_claim_check` tells it first, and the protocol hubd gives every agent says to
ask. A claim lasts its TTL (`-t`, in minutes), so a session that died does not hold a
part of the tree forever.

**A folder with another name.** A worktree or a second clone called `invoices-pdf` is
not the `invoices` card. Put the slug in a one-line `.hubd` file at its root, and
`hub_context` resolves it by that instead of guessing.

**A session that never reports.** Its findings leave with its context. `FACT:` goes in
when the thing is found, not at the end of the turn: a compacted session never reaches
the end.
