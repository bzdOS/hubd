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
constitution (AGENTS.md), role onboardings, project cards, an operator card,
queues, recipes, and a weekly agent-written `chronicle/`
([the narrative layer](docs/narrative-layer.md)).
Hiring an agent = a fresh session reads a role file. This template is NOT
included in the npm package; it comes from the repo.

**Option B — add the binaries to what you have:**

```bash
npm i -g @bzdos/hubd   # installs both binaries: hubd (MCP server) + hub (CLI)
hub init             # scaffold a team folder: AGENTS.md, INBOX.md, queues/
hub doctor           # check hub base, team root, locks, queues, ghost queues
hub status           # every project at a glance (⚠ marks a card behind its journal)
hub brief            # morning brief: tasks, journal, locks
hub queue gc         # list queues nobody ever consumed (--apply archives them)
hub serve            # read-only kanban on localhost
# one-off, without install: npx -p @bzdos/hubd hub status
```

The npm package ships: `hub/` (binaries + lib), `prompts/`, `docs/`, `README.md`,
`LICENSE`, and `HARVEST.md`. It does NOT include `hubd-company/`.

New here? Two guides: the [quick start](docs/quickstart.md) walks the whole
path — install → team folder → first agent → queues — and
[recipes](docs/recipes.md) gives complete scenarios (a standing worker, an
orchestrator fleet, owner buttons, harvesting a chat, infra topology).

Connect your agent (any MCP client):

```bash
claude mcp add --scope user hubd --env HUBD_AGENT=dev-<yourproject> -- npx -y @bzdos/hubd
```

`HUBD_AGENT` is worth setting on day one. Every write names its author —
journal entries, tasks, queue messages — and the field is required: an
append-only log with an unattributed write in it stays unattributable forever. `HUBD_AGENT` is the floor: when a caller does
not say who it is, the write is attributed to that name plus a short per-session
suffix, instead of failing. Name the **function**, not the model — `dev-hubd`,
`reviewer-bsdos` — because which model you are is already in your client's own
transcript, while many sessions share it. Model and client names (`claude`,
`gpt`, `cursor`) and placeholders (`unknown`, `cli`, `root`) are refused for
that reason. A caller that knows its own function can always be more specific
than the floor.

No MCP? No problem — every model that can read and write files can join:
paste the matching block from [`prompts/`](prompts/) (Claude Code, Cursor,
Codex/AGENTS.md, or an MCP chat) — it wires hubd in and points at `HUBD.md`,
the always-current protocol.

**Running it for a team?** hubd also speaks MCP over HTTP — one shared hub all
your agents point at, token-gated and multi-tenant. See
[self-hosting](docs/self-hosting.md).

## Updating, and where your data lives

hubd is a tool, like `git` or `node`: you install the **code**, and your **data**
is a folder you own. They are two separate things — and that is the whole point.

- **Code** — the npm package. Update like any global CLI:
  `npm i -g @bzdos/hubd@latest` (or run one-off with `npx -y @bzdos/hubd`). A new
  version ships the engine ([changelog](CHANGELOG.md)); it never touches your data.
- **Data** — `HUBD_DIR` (default `~/.hubd`): plain markdown + JSONL, yours to keep.
- **Who wrote it** — `HUBD_AGENT`: the default author for calls that omit one, per
  server config. Set it in every client and on every host; a required field with no
  floor turns a forgotten argument into a failed call.
- **Several machines?** Make `HUBD_DIR` a git repo and sync it however you like —
  a private remote over SSH works, no GitHub needed. Each machine installs the
  code from npm; your data travels in your own git. Two separate tracks: code from
  the package, data in your folder. Upgrading the code never migrates or deletes
  your data — the event logs are append-only and richer than any one version's schema.
- **What an upgrade needs from you** — sometimes a new version wants something outside
  the code: a variable in a client's config, a role declared in the hub, a protocol
  section worth re-reading. hubd works that out and tells the agents itself:
  `hub_whatsnew` returns an `environment` list, every item saying what is wrong, what
  fixes it, and **who can** — the agent, the agent plus a client restart, or you. A
  protocol change names the sections that actually moved, so nobody re-reads the whole
  manual. `hub doctor` shows the same list to a human. Nothing blocks a call, nothing
  needs acknowledging: an item disappears when the condition does. Per-node state in
  `.env-state.json`, never mesh-synced — three machines have three environments.

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
  prodding them. A queue has one live consumer by default — run a single waiting
  session per role. Roles listed in `<team>/subscriber-roles.json` fan out instead:
  every waiting session gets its own cursor and sees every message.
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
- **Harvest** — one prompt turns any working dialog into project digests, tasks
  and logged decisions. Served as an MCP prompt (`harvest`) and `hub harvest`, so
  you invoke it straight from your client — no fetching the file. See
  [HARVEST.md](HARVEST.md).
- **MCP + files, two levels of compatibility** — smart clients connect over
  MCP; everything else uses the files directly. If hubd is down, your data
  is still just markdown.
- **Instructions that stay current** — your team rules live in `AGENTS.md` (yours
  to write); hubd's own mechanics live in `HUBD.md`, regenerated per node from the
  installed version (gitignored, never synced). Update the code → the next `hub`
  run (or `hub upgrade`) refreshes `HUBD.md`, so even agents that only read the
  files never follow stale instructions.

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

Shipped: multi-machine sync (per-host append-only logs, conflict-free); remote
access over HTTP (token-gated, multi-tenant, see [self-hosting](docs/self-hosting.md));
a typed **relationship graph** (`[[wikilink]]` edges across projects and resources,
`hub graph`); **resources** as first-class cards (hosts / services / endpoints);
**structured reports** that fan into card sections; one-file section **i18n**
(`sections.json`); a per-node **`HUBD.md`** protocol that regenerates to match the
installed version; **harvest** as an MCP prompt; cwd → project auto-bootstrap
(`hub_context`: marker file / recorded sync path / folder-name guess, no manual
`hub_get` needed); a **presence registry** (`hub_heartbeat`/`hub_presence`,
TTL freshness like claims) so MCP/headless agents show up next to screen-scraped
ones, with queue depth surfaced in `hub_brief`; and **buttons** — owner-decision
queue items rolled up in `hub_brief` as "N buttons waiting (oldest X days)"
(`HUB/owner-roles.json` names the human roles).

Next: task kinds with their own lifecycles (a *communicative* task knows it's
waiting on a reply); an end-to-end remote mode (the server never reads your
work); a gateway that proxies your personal MCP servers; and the
**narrative layer** promoted into the server — `hub_chronicle` / `hub_probe`
plus mood/check-in journal kinds, once the file-first version proves itself
([design](docs/narrative-layer.md), templates in `hubd-company/`). The file
format is the stable contract; everything else is negotiable.

## License

MIT.
