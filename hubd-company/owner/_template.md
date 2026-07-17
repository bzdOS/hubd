# <owner-handle> — operator card
*The one human the whole machine routes around. Copy to `owner/<handle>.md`, fill,
delete the hints. Agents may READ everything here; the **Boundaries** section is
edited by the owner only — that rule is the point of the file.*

## Who this is in the system
The owner role (see `owner-roles.json` / AGENTS.md). All "buttons" — queue items
only a human can press — land here. The owner's job is decisions, exits to the
outside world, and boundaries. Everything else is delegable to agents.

## Rhythm (fill from observation, not aspiration)
- Discretionary budget for this work: ~<N> h/week, in these windows: <mornings /
  lunch / evenings / weekends>.
- Weekly shape: strong days <…>, dead days <…>. Schedule buttons and asks on the
  strong ones; plan nothing willpower-heavy on the dead ones.
- Unit of completion: what actually ships fits in <N> days. Cut money-steps to
  that length.

## Interface (how the system should talk to this human)
- <e.g. framing that works: experiment/curiosity vs duty; direct vs padded;
  one question at a time vs batches>
- Probes (see `recipes/probe.md`): ≤1 question-button per day, batched on
  <best day/time>. Never invent urgency.
- Whose judgment does the owner actually accept? <e.g. "own past decisions with
  dates" — then agents should cite those, not say "you should">.

## Current season
- Active bet(s): <project + its gate + date>.
- What funds life meanwhile: <job / savings / revenue> — so agents can tell
  survival-critical from optional.

## Boundaries of collection (OWNER-ONLY section)
The hub tracks *the work* and *the operator at work*. Private life is out of
scope unless explicitly opted in. Defaults — edit to taste:
- ✅ Collected: tasks, decisions + why, ships, opt-in one-line mood/energy
  check-ins (owner's own words, never paraphrased), rhythm metrics from
  timestamps, plan-vs-fact.
- ⛔ Not collected, not structured: <family, health beyond voluntary check-ins,
  named third parties, anything else you fence off>.
- 🔒 Life braid (optional): `journal.life.jsonl` only — local, gitignored,
  never synced. Agents read it solely to write the weekly chronicle chapter and
  never quote it verbatim into synced files.
- Mentions of fenced-off zones in dialogs are NOT carried into cards or journals
  (unless the owner says "write this down").
