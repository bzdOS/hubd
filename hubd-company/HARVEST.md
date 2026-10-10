<!-- snapshot synced from the hubd repo root; edit the root copy, then run: node scripts/sync-templates.mjs -->
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
   - slug · one-line what-it-is · 3–6 line digest of where it stands now
   - MODE: active-sprint | live | background-slow-burn | frozen | idea.
     A years-old background idea is NOT a deadline item — mark it "do not push"
     and never invent urgency for it.
   - links: [[other-slug]] for every project this one relates to.
   - communication: what has gone OUT (channel · what · date) and what's still
     queued. A project isn't finished until it's been communicated.

2. TASKS — one per line:
   [project] action · cat (technical | communicative | decision | chore)
   · assignee (role, agent or person) · due? · importance (high|med|normal).
   Include implicit ones ("we should…", "later…"). A communicative task names
   its counterpart and channel in its text; "my part is done, waiting for a
   reply" is a COMM: line, not a task status.

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
- Never copy a secret into the hub: no password, key, token, private link or
  someone's personal data. Write that it exists and where it is kept, not its value.

OUTPUT (structured — facts land in card fields, never one prose blob):
- With hubd MCP tools: hub_task_list first (skip duplicates) -> hub_get each
  project -> a project the hub does not have: hub_card_set with the digest; one
  it has: patch only the lines that are now wrong (replace / appendLine), never
  rewrite the owner's digest -> hub_task_add each task -> hub_report the
  decisions / facts / hypotheses / communication as structured lines (below).
  What THIS dialog changed goes into the report, not into the digest.
- Without hubd tools: output ONE shell code block of ready-to-paste commands,
  this exact syntax, properly quoted, nothing else in the block. <you> is the
  name the entries are signed with: mine in the hub if I gave it, otherwise
  harvest. hub card replaces a whole digest, so it is only for a project the
  hub does not have yet; for the rest, the report carries the change:
    hub card "<slug>" -m "<3-6 line digest>" --by <you>
    hub task add "<text>" -p <slug> [-i high|med] [-d YYYY-MM-DD] [--cat <cat>] [--assignee <who>] --by <you>
    hub report -p <slug> --agent <you> <<'EOF'
    DECIDE: <decision> | <why>
    FACT: <confirmed fact>
    HYPO: <inferred connection, still unproven>
    COMM: <what went out / what is waiting on a reply>
    NEXT: <the one next action>
    EOF
```

## Tips

- **One-word trigger.** In your agent's rules file (`AGENTS.md` / `CLAUDE.md`)
  add: *"When I say 'harvest' (in any language), run the Harvest Protocol from
  HARVEST.md."* Then the whole pass is one word.
- **Foreign chats:** bind the prompt to an OS text-replacement snippet like `;harvest`.
- **Harvest beats memory.** Run it before closing a long dialog — the next
  agent's `hub_context` inherits everything this one learned, correctly.

## Why these rules exist
Every line is a scar from real use: a decade-old background idea got mislabeled
urgent; posts got logged "done" before they happened; an inferred "X is a child
of Y" turned out to be two parallel braindumps. In a files-first hub the value is
the *understanding* you store — and a confident wrong fact is worse than an honest gap.
