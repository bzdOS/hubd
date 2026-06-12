<!-- snapshot synced from hubd root; edit the root copy, then re-sync -->
# The Harvest Protocol

Dialogs are where work actually happens — and where it evaporates. Decisions,
action items, and project state live in a chat scrollback until the context
window closes over them.

**Harvest** is a copy-paste procedure that extracts structure from any dialog
with any model and lands it in hubd. It needs zero new tooling: agents with
hubd connected write directly; agents without it emit shell commands you paste
into a terminal.

## The prompt

Paste this at the end of any working dialog (or whenever you feel state piling up):

```
Harvest this dialog into my hub. Extract:

1. PROJECTS — for every project touched here: slug, 3–6 line digest
   (current state, what THIS dialog changed).
2. ACTION ITEMS — one per line: [project] action · owner (role or person)
   · due date if any · importance high/med/normal. Include implicit ones
   ("we should...", "later we'll..." = normal).
3. DECISIONS — each in one line, with the "why".
4. ROLES & AGREEMENTS — who owns what, if it changed.
5. OPEN QUESTIONS — unresolved items that need an answer.

If you have hubd MCP tools available:
- check hub_task_list first and skip duplicates;
- hub_card_set each project with its digest;
- hub_task_add each action item (mention "from dialog <date>" in the text);
- hub_report decisions, role changes and open questions to the journal.

If you do NOT have hubd tools: output ONE shell code block containing only
ready-to-paste `hub` CLI commands (hub card / hub task add / hub report),
properly quoted, nothing else in the block.
```

## Tips

- **Make it a two-word trigger.** If your agent reads a rules file
  (`AGENTS.md`, `CLAUDE.md`), add: *"When I say 'harvest' (pick any trigger),
  run the Harvest Protocol from HARVEST.md."* Then the whole procedure is two
  words.
- **OS text replacement** works for foreign chats: bind the prompt to a
  snippet like `;harvest`.
- **Harvest beats memory.** Run it before closing a long dialog — the next
  agent's `hub_brief` will know everything this one learned.
