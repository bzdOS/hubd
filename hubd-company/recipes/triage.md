# Recipe: triage — turn an incoming pile into tasks

Paste into any agent session that can see this folder. Works with hubd MCP/CLI;
degrades to writing files directly.

```
Triage the following input into the team's task base.

INPUT: <paste anything: meeting notes, a brain dump, an email thread,
a TODO comment harvest, a list of complaints>

1. EXTRACT every actionable item. One item = one outcome someone can finish.
   Split compounds ("fix X and tell Y") into separate items.
2. For each item determine:
   - project: which existing project it belongs to (read the project cards);
     if none fits, propose ONE new project, don't scatter.
   - cat: technical (artifact when done) / communicative (someone must reply —
     note the counterpart) / decision (someone must choose — note whose call).
   - owner_kind: agent or human. Default agent; humans get only what
     genuinely needs a human.
   - importance: high / med / normal. Be stingy with "high".
3. DEDUPLICATE against existing tasks before adding anything.
4. DELIVER: via hubd if available (hub task add ...); otherwise append to the
   tasks file. Then write a journal entry: how many items in, how many tasks
   out, what was dropped as non-actionable and why.

Rule: do not silently drop anything. Every input item ends up as a task,
a duplicate-reference, or a one-line "dropped because ___" in the journal.
```
