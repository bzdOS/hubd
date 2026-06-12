# The Harvest Protocol

Dialogs are where work actually happens — and where it evaporates. Decisions,
project state, the shape of an idea live in a chat scrollback until the context
window closes over them. Your dialogs are also scattered across many chats.

**Harvest** is a copy-paste prompt that extracts the durable knowledge from any
dialog — with any model — and lands it in hubd as project cards, tasks, links
and themes. Zero new tooling: an agent with hubd connected writes directly; one
without it emits shell commands you paste into a terminal. Run it at the end of
a working dialog, or paste it into an old chat you want to mine.

## The prompt

```
Harvest this dialog into my hub. Be a librarian, not a stenographer — capture
meaning, not transcript.

1. PROJECTS — every project, product, or recurring "obsession" touched here,
   even ones I never call a project. For each:
   - slug · one-line what-it-is · 3–6 line digest (state + what THIS dialog changed)
   - MODE: active-sprint | live | background-slow-burn | frozen | idea.
     A years-old background idea is NOT a deadline item — mark it "do not push"
     and never invent urgency for it.
   - links: [[other-slug]] for every project this one relates to.

2. TASKS — one per line:
   [project] action · cat (technical | communicative | decision | chore)
   · owner (role/agent or person) · owner_kind (agent | human) · due? · importance (high|med|normal).
   Include implicit ones ("we should…", "later…"). A communicative task carries
   counterpart + channel and can be in a "waiting" state (done my part, awaiting reply).

3. LINKS & THEMES (what a tracker misses) — look across the projects: shared
   audiences, tools, distribution, or a shared underlying obsession. Write 1–3
   cross-cutting axes as [[a]]↔[[b]]. A connection you INFER (not stated) is a
   HYPOTHESIS — label it so; never assert causality ("X came from Y") unless I said it.

4. DECISIONS — each in one line, with the "why".

5. OPEN QUESTIONS — unresolved, needing my answer.

TRUTH DISCIPLINE (this is the point):
- Never mark anything "done" unless I explicitly confirmed it happened.
  Optimistic logging is the #1 failure — when unsure, write "[?] unconfirmed" and
  ask, don't assume.
- Record what I actually said over what would be tidy.
- If you revise an earlier entry, LOG the correction — don't silently overwrite.

OUTPUT:
- With hubd MCP tools: hub_task_list first (skip duplicates) → hub_card_set each
  project digest → hub_task_add each task → hub_report decisions, themes and
  questions to the journal.
- Without hubd tools: output ONE shell code block of ready-to-paste commands
  using this exact syntax, properly quoted, nothing else in the block:
    hub card "<slug>" -m "<3–6 line digest>"
    hub task add "<text>" -p <slug> [-i high|med] [-d YYYY-MM-DD]
    hub report "<decisions, themes, open questions>"
```

## Tips

- **One-word trigger.** In your agent's rules file (`AGENTS.md` / `CLAUDE.md`)
  add: *"When I say 'harvest' (in any language), run the Harvest Protocol from
  HARVEST.md."* Then the whole pass is one word.
- **Foreign chats:** bind the prompt to an OS text-replacement snippet like `;harvest`.
- **Harvest beats memory.** Run it before closing a long dialog — the next
  agent's `hub_brief` inherits everything this one learned, correctly.

## Why these rules exist
Every line is a scar from real use: a decade-old background idea got mislabeled
urgent; posts got logged "done" before they happened; an inferred "X is a child
of Y" turned out to be two parallel braindumps. In a files-first hub the value is
the *understanding* you store — and a confident wrong fact is worse than an honest gap.
