# How to write a role (a vacancy is a file nobody has read yet)

A role here is three things, and only one of them is prose you write:

- **Its card in the hub**: an entry in `roles/team.json` with its `rank` (`head` or
  `worker`), its `head` and a one-line `digest`. `node scripts/team.mjs declare
  --by <you>` writes it. The board, the escalations and the laws read the card.
- **Its rules**: `roles/rules/<role>.md`, rendered by `node scripts/team.mjs
  render` from hubd's templates for its rank, with the track's goal, its facts and
  the owner's decisions. How a worker or a head works is the same for every role of
  that rank, so nobody writes it twice, and nobody edits the rendered file.
- **Its zone**: `roles/<role>.md`, the file a fresh session gets as its first
  message. Write it so that works with zero follow-up questions:

1. **Identity**: one paragraph. You are X at product Y; what the product is in one
   sentence; the name it signs every hub write with.
2. **Read first**: its rules file, `AGENTS.md`, `hub_context`, then what this role
   needs (the spec, the canon, the code's entry points). Under 5 minutes of reading.
   Say where each file is: the session starts in the product's repository, and the
   company's files are in `$HUBD_DIR`.
3. **Your zone**: what this role owns. Concrete artifacts and verbs.
4. **Not your zone**: just as concrete, naming which role owns each excluded thing.
   This section prevents most conflicts; do not skip it.
5. **Routes**: where its work comes from and whom it hands in to.
6. **Start**: the literal first command, `hub queue wait <role> --tasks`.

Two more rules from practice:

- **A handover act belongs in the zone file** when the role takes over ongoing
  work: open loops, pending decisions with their triggers, where the bodies are
  buried. The next session has no memory; the file is the memory.
- **Keep it current.** When the role's zone changes, edit its file in the same
  commit. A file that lies is worse than none: the next hire will confidently do
  the wrong job.
