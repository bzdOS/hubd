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

None of these are exclusive — the same files serve all of them at once.

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

## Coming in 0.2.0: tasks as Markdown too

The task backlog stays JSONL at its core (for conflict-free multi-machine sync),
but hubd will also render a read-only `tasks.md` — GFM checkboxes with inline
fields — so a Markdown reader shows your board natively, no hubd required. Same
rule as the kanban: read-only for humans, writes flow through hubd.
