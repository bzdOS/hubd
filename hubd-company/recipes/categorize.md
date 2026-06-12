# Recipe: categorize — harvest projects and tasks from a dialog

Paste into any agent session at the END of a working conversation (or feed it
a transcript). Works with hubd MCP/CLI; degrades to writing files directly.

```
Harvest this conversation into the team's base.

1. PROJECTS: did this dialog mention work that is an ongoing effort with a
   goal (not a one-off task)? For each: match to an existing project card or
   propose a new one (name, one-line goal, status).
2. TASKS: extract commitments and open items — anything someone said they
   would do, should do, or is waiting on. For each: project, cat
   (technical / communicative / decision), owner, what "done" looks like.
3. DECISIONS MADE: anything decided in this dialog → one journal line each:
   what was decided and WHY (the why is the valuable part).
4. OPEN QUESTIONS: unresolved forks → tasks of cat decision, addressed to
   whoever owns the call.
5. DELIVER: via hubd if available; otherwise append to the tasks file and
   journal. Print a summary table: projects touched / tasks added / decisions
   logged / questions raised.

Rule: harvest what was SAID, not what you infer should happen. Inference is
allowed only in the "open questions" section, marked as yours.
```
