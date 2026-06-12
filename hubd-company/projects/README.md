# projects/ — one card per project

A project card is the unit everything else hangs off: tasks point to it, the
kanban draws a lane for it, briefs summarize it. One markdown file per project.

## Card format

```markdown
---
status: active        # active | paused | done
owner: product        # role or human responsible
parent:               # optional — sub-project or host this belongs to
related: []           # [[links]] to other cards
---
# project-slug

Goal     one sentence: what done looks like and for whom.
Now      3–6 line digest: current state, what changed last.
Links    repo, prod URL, key docs.
Next     the one thing that should happen next.
Risks    anything alarming, one line each.
```

Keep digests short and current — a card that lies is worse than no card.
Agents update `Now` on handoff (`hub_sync` or by editing the file).

## Where cards come from

- **By hand:** copy `_example.md`, rename, fill.
- **From a dialog:** run `recipes/categorize.md` or the Harvest Protocol
  (`HARVEST.md`) — agents extract projects from conversations.
- **From a machine:** run `recipes/inventory.md` against a server — it writes
  host and service cards here with `parent`/`related` links, and risks as tasks.
  Re-run it monthly; the diff is your drift report.
