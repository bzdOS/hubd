# How to write a role (a vacancy is a file nobody has read yet)

A role onboarding is a **ready-to-paste system prompt**: the human opens a fresh
agent session, pastes the file as the first message, points the session at this
folder — and the employee starts working. Write it so that works with zero
follow-up questions. Proven structure, in order:

1. **Identity** — one paragraph: you are the X of product Y; what the product is
   in one sentence; what stage it's at.
2. **Read in order** — numbered list of files (constitution first, then journal,
   then the canonical spec / code entry points). Keep it under 5 minutes of reading.
3. **Your zone** — what this role OWNS. Concrete artifacts and verbs, not vibes.
4. **NOT your zone** — equally concrete. Name which role owns each excluded
   thing. This section prevents most conflicts; do not skip it.
5. **Environment realities** — sandboxing, network limits, what tools actually
   work, what the role should not even attempt.
6. **Protocol** — which queue is theirs, the daemon loop, journal entry format,
   what "blocked" means and where questions go.
7. **Start command** — the literal first action: "run the start ritual from
   AGENTS.md, then drain your queue."

Two more rules from practice:

- **A handover act belongs in the onboarding** when the role takes over ongoing
  work: open loops, pending decisions with their triggers, where the bodies are
  buried. The next session has no memory — the file is the memory.
- **Keep it current.** When the role's zone changes, edit the role file in the
  same commit. An onboarding that lies is worse than none: the next hire will
  confidently do the wrong job.
