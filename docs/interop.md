# Reading your hub with any tool

hubd stores everything as plain text in one folder you own — no database, no
binary format, no app-specific dialect. So your hub is readable by far more than
hubd itself: any text editor, `grep`, a Markdown knowledge tool, or GitHub.
hubd is only the coordination layer on top; the data outlives it. If hubd
vanished tomorrow, your hub is still fully readable as-is.

## What's in the folder

| Layer | Format | Notes |
|---|---|---|
| Project cards | Markdown + YAML frontmatter | `projects/<slug>.md`, one per project |
| Resource cards | Markdown + YAML frontmatter | `resources/<slug>.md` — hosts / services / endpoints, with typed `[[edge]]` links |
| Notes / views | Markdown | cross-cutting docs (system view, themes, channels) |
| Team journal (human) | Markdown | `INBOX.md` — the log you read with your eyes |
| Roles, queues | Markdown | role onboardings, per-role message queues |
| Tasks, structured journal, locks | JSONL / JSON | append-only event logs |

Everything human-facing is Markdown. The append-only logs (tasks, structured
journal) are JSONL — still plain text you can read and `grep`, just a log rather
than a document a Markdown reader renders. They're JSONL on purpose: each machine
appends to its own file, so several machines syncing one hub never conflict.

## Open it in…

- **Any editor / `grep` / `cat`** — it's text. Nothing to install, nothing to
  trust. This is the floor every other tool sits on.
- **A Markdown knowledge tool (Obsidian, Logseq, Foam, Dendron, …)** — point it
  at the hub folder. Cards and notes render; YAML frontmatter shows as
  properties; any `[[slug]]` links between cards become a graph with backlinks.
- **GitHub / GitLab** — keep the hub as a private repo and every card renders in
  the web UI: frontmatter as a table, `- [ ]` lines as checkboxes.
- **hubd itself** — the CLI (`hub status`, `hub brief`) and the read-only kanban
  (`hub serve`) give the live operational view; agents use the MCP tools.

None of these are exclusive — the same files serve all of them at once. The
`[[slug]]` edges in card frontmatter form hubd's own typed graph too (`hub graph`)
— the same links a Markdown tool renders as backlinks.

## The format is the contract

hubd commits to an **open subset** that every tool above understands:

- **CommonMark** + GitHub-flavored task lists (`- [ ]` / `- [x]`),
- **YAML frontmatter** for metadata (the Jekyll-era convention, read by static
  site generators, Pandoc, GitHub and every Markdown knowledge tool),
- **`[[slug]]` wikilinks** resolved by filename (the wiki convention, read by
  Obsidian, Logseq, Foam, Dendron, GitHub wikis…).

These are open, decades-old conventions — not any one app's invention. hubd
deliberately does **not** store anything in a tool-specific dialect (an Obsidian
plugin's inline fields, a `.base` file, Logseq block refs, …). Those are fine as
optional read-layers if you happen to use that app, but they are never the source
of truth. You should never need a particular program to read your own work.

> One honest caveat: `[[ ]]` wikilinks are a widespread convention, not a single
> formal spec — tools differ slightly in how they resolve a link. hubd uses the
> most portable rule (resolve by file name / slug), so Obsidian, Logseq and Foam
> all agree.

## Transport: how a queue crosses machines

The folder is the interface; moving it between nodes is a separate, replaceable
concern. Two transports are in production use, and they are not alternatives —
they run concurrently on the same `queues/` directory:

| Transport | Mechanism | Configured by |
|---|---|---|
| `scripts/mesh-sync.sh` | git over ssh; each node commits its own files and merges peers | cron/systemd on each node; "the server is any machine you can ssh into" |
| [mrgd](https://github.com/bzdOS/mrgd)'s hubd bridge | each role becomes a Matrix room, blocks are ingested and materialised as room events | `MATRIX_HS_HUBD_QUEUES_DIR`, `MATRIX_HS_HUBD_NODE` on the homeserver — unset means the bridge is off |

Per-host filenames (`<role>.<node>.queue.md`) are what let both work at once: a
node only ever appends to its own file, so two transports touching the same
directory cannot produce a conflicting write. The room side is
[mrgd](https://github.com/bzdOS/mrgd), whose public repository carries the code,
the protocol (`docs/WIRE.md`) and the design reasoning; its deployment records
and the bridge's own document are kept private, so there is deliberately no file
link here to follow. Its summary of the arrangement is "the room is the
transport, the file is the interface, unchanged, on both ends", which is exactly
the split this document describes.

Why this is worth stating rather than leaving implicit: on 2026-08-27 three agents
on two machines used these queues to debug a to-device delivery bug **in mrgd
itself**, while mrgd was one of the two transports carrying the conversation. The
coordination survived because the git path is genuinely independent of the Matrix
path — not because anyone had planned for that. A single transport would have put
the conversation inside the outage.

Two practical consequences, both learned the hard way that day:

- **Do not report a transport outage over that transport.** Keep the other route
  tested in both directions before you need it. Direct ssh between nodes is the
  simplest one, and it is already a prerequisite of `mesh-sync.sh`.
- **Silence in a queue does not mean "nothing to report."** It can equally mean
  delivery has stalled, or that the counterpart is blocked waiting on you. Depth
  (`hub_brief`'s per-role queue count) answers "how much is pending", not "is
  replication converging" — so a quiet queue currently cannot be distinguished
  from a stopped one without checking the transport directly.

### Determining what is actually enabled

Configuration lives in the environment of the running processes, so neither this
document nor a peer project's README is authoritative about a given deployment:

```sh
# is the Matrix bridge on for this homeserver?
# pgrep -x matches the executable NAME, so it cannot match this command line
# itself the way `pgrep -f <pattern>` can -- and it returns one pid per process,
# so loop rather than interpolating (a bare $(pgrep) with two matches produces
# an invalid path and a misleading "No such file or directory").
for pid in $(pgrep -x matrix-hs); do
  echo "pid $pid:"
  tr '\0' '\n' < "/proc/$pid/environ" | grep HUBD || echo "  (no HUBD_* set -- bridge off)"
done

# is git mesh-sync actually committing?
git -C ~/.hubd log --oneline -5 -- queues/
```

Both commands answer about *one node*. `hub_brief` in 0.9.1+ reports this
centrally via `transportHealth()`, which deliberately reports a transport with no
observable artifact as UNKNOWN rather than healthy — the two are not the same
claim, and treating them as one is how a stalled transport reads as a quiet one.

Note that `mesh-sync`'s commits say `mesh-sync: <node>` regardless of which
transport put the content in the directory, so that log shows *that* sync ran —
not which path delivered a particular message.
