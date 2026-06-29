# hubd

**The project tracker for teams of humans and AI agents — in plain files.**

You run two, three, five agent sessions — different tools, different vendors —
across your projects. Each one is brilliant, and each one has no idea the
others exist. You are the coordination layer: copy-pasting context,
re-explaining state, discovering on Monday what an agent did on Friday.

hubd replaces you in that job with the most boring technology available:
**plain files**. A shared headquarters for your whole team — agents *and*
humans: a journal of what everyone did, task queues every agent can wait on,
cross-project tasks, and a read-only kanban to watch it all. All markdown and
JSONL, in a folder you own.

**Not a runner.** Orchestrators launch your coding agents and stream their
output — that's making coding faster. hubd manages the *work*: which projects,
what's next, who does it and when, what already happened. An orchestrator can
run your agents; hubd runs your projects. They compose.

## The Unix pair

- **`hubd`** — the daemon: an MCP server (stdio, JSON-RPC 2.0) that agents talk to.
- **`hub`** — the CLI: the same data for humans, no LLM required.

Like `sshd` and `ssh`. The daemon serves agents; the CLI serves you.

## Quick start

**Option A — start a company (GitHub template).** Use the **"Use this template"**
button on the [`hubd-company/`](hubd-company/) directory — or clone and copy
that folder into an existing private repo. You get a ready org structure:
constitution (AGENTS.md), role onboardings, project cards, queues, recipes.
Hiring an agent = a fresh session reads a role file. This template is NOT
included in the npm package; it comes from the repo.

**Option B — add the binaries to what you have:**

```bash
npm i -g @bzdos/hubd   # installs both binaries: hubd (MCP server) + hub (CLI)
hub init             # scaffold a team folder: AGENTS.md, INBOX.md, queues/
hub doctor           # check hub base, team root, locks and queues
hub status           # every project at a glance
hub brief            # morning brief: tasks, journal, locks
hub serve            # read-only kanban on localhost
# one-off, without install: npx -p @bzdos/hubd hub status
```

The npm package ships: `hub/` (binaries + lib), `prompts/`, `README.md`,
`LICENSE`, and `HARVEST.md`. It does NOT include `hubd-company/`.

Connect your agent (any MCP client):

```bash
claude mcp add --scope user hubd -- npx -y @bzdos/hubd
```

No MCP? No problem — every model that can read and write files can join:
paste the matching block from [`prompts/`](prompts/) (Claude Code, Cursor,
or any no-MCP agent) and it knows the protocol.

**Running it for a team?** hubd also speaks MCP over HTTP — one shared hub all
your agents point at, token-gated and multi-tenant. See
[self-hosting](docs/self-hosting.md).

## Updating, and where your data lives

hubd is a tool, like `git` or `node`: you install the **code**, and your **data**
is a folder you own. They are two separate things — and that is the whole point.

- **Code** — the npm package. Update like any global CLI:
  `npm i -g @bzdos/hubd@latest` (or run one-off with `npx -y @bzdos/hubd`). A new
  version ships the engine; it never touches your data.
- **Data** — `HUBD_DIR` (default `~/.hubd`): plain markdown + JSONL, yours to keep.
- **Several machines?** Make `HUBD_DIR` a git repo and sync it however you like —
  a private remote over SSH works, no GitHub needed. Each machine installs the
  code from npm; your data travels in your own git. Two separate tracks: code from
  the package, data in your folder. Upgrading the code never migrates or deletes
  your data — the event logs are append-only and richer than any one version's schema.

## How it works

- **Journal & structured reports** — append-only team log (INBOX.md) you read
  with your eyes. At session end an agent files a `hub report` of prefix-tagged
  lines (`DECIDE: … | why`, `FACT:`, `COMM:`, `NEXT:`, `DONE: ids`) that fan into
  the project card's sections — structure in fields, not one prose blob. "What
  changed" is read from git, not retyped. The card's section headings (in any
  language) come from one file, `HUB/sections.json`, which drives both the card
  scaffold and the report router — so they never drift.
- **Queues** — per-role message queues. Send work; an agent blocks on `wait`
  until something arrives, then goes back to waiting. No polling you, no
  prodding them. A queue has one live consumer — run a single waiting session per role.
- **Projects & tasks** — one card per project; cross-project tasks with
  owners (agent or human) and claims as soft locks, so two agents don't
  clobber each other.
- **Resources & relationships** — infra is a card too: hosts, vms, services,
  endpoints, providers under `resources/`, with structured frontmatter
  (type, address, os, provider, status) and **typed `[[wikilink]]` edges**
  (`runs_on`, `depends_on`, `deploys_to`, `exposes`, `part_of`, ...). The same
  edge mechanism reads project cards, so `hub graph` renders one topology
  across projects ↔ resources; a task links to what it touches with
  `--resource`. Facts go in fields, not prose.
- **Kanban (read-only)** — cards move because agents move them. The only
  button is **⚙ Rules**, and it opens AGENTS.md. You don't manage the
  agents — you manage the rules.
- **Harvest** — one pasted prompt turns any working dialog into project
  digests, tasks and logged decisions. See [HARVEST.md](HARVEST.md).
- **MCP + files, two levels of compatibility** — smart clients connect over
  MCP; everything else uses the files directly. If hubd is down, your data
  is still just markdown.

## Principles (violating these = not this product)

Files first. Dumb server, smart agents — **no AI inside**: hubd stores and
serves, intelligence comes from your agents. Human-readable everything. Zero
dependencies. Read-only for the human; write access flows through rules.
Graceful degradation: no MCP → files; no hubd → files still readable as-is — in
any editor, `grep`, or a Markdown app like Obsidian. See
[Reading your hub with any tool](docs/interop.md).

## What hubd is not

Not an orchestrator (doesn't launch agents or stream output). Not vector
memory (the journal stores facts you can read, not embeddings). Not a Jira
for humans (the human here is a spectator and a legislator, not an assignee).
Not another chat (talk to hubd through *your* agent; hands — CLI; eyes —
kanban).

## Built by the team it coordinates

hubd's own development runs through hubd: one human and a few agents on
models from different vendors, coordinating through nothing but the files
above. It's our daily dogfood — and the most honest illustration we can offer
of the protocol under real use, including the evening a tooling failure forced
everything back to plain files and the work simply kept moving. One team's
story, lightly anonymized and self-reported, not a benchmark:
[the case study](docs/case-study.md).

The human's main job was editing the rules.

## Pricing

The core is MIT, forever. Personal use is free, forever. If a hosted team
plan ever exists, the line is simple: **agents are free, humans are billed.**

## Roadmap

Already shipped: multi-machine sync (per-host append-only logs, conflict-free)
and remote access over HTTP (token-gated, multi-tenant) — see
[self-hosting](docs/self-hosting.md).

Next (v0.2) — a graph/semantic layer: `[[project]] / #task / @role` links the
tools resolve, task kinds with their own lifecycles (a *communicative* task
knows it's waiting on a reply), and `hub next` to surface your top unblocked
task. Later: an end-to-end remote mode (the server never reads your work) and a
gateway that proxies your personal MCP servers. The file format is the stable
contract; everything else is negotiable.

## License

MIT.
