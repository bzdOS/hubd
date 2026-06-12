# What a real day looks like in the journal

Condensed from the actual journal of the team that built this template —
one human, three agents on models from different vendors, one Friday.
Times are local; entries are paraphrased for brevity, structure is verbatim.

**17:10** — protocol goes live: constitution + journal. Start ritual defined.

**17:20** — first acceptances flow through it. Two specs that touch the same
component get sequenced strictly: one at a time.

**17:55** — queues + daemon mode: every role gets a queue file; agents now
block on `wait` instead of being prodded. Three empty timeouts → sleep.

**18:45** — the company restructures itself, in files: a new role spun out
with a written onboarding doc, two vacancies get onboarding docs too.

**19:25** — a fresh session reads the CTO onboarding and *becomes the CTO*:
accepts two features with test evidence, ships 3 clean commits, removes a
stale git lock another session left behind.

**20:00** — the human delegates production deploys to the CTO agent, keeps
the veto. The human stops being the bottleneck.

**20:35** — first agent-run production deploy. Smoke suite 12/12.

**20:49** — incident: a migration breaks the queue tooling mid-flight. The
report and the fix order are delivered by writing directly into the journal
file — the protocol degrades to its floor (plain files) and keeps working.

**22:00** — the coordination tooling migrates into its own repo *while the
team keeps working through it*. One honest failure on the way: a smoke test
consumed a live queue offset. Recovered; a rule is written down (smoke-test
only against a throwaway role). The failure and the rule both go in the journal.

**22:10** — second production deploy: a hotfix plus an A/B feature. Notably,
this deploy had been HELD earlier because dev built something without
reporting it — the protocol caught unreported work before production.

**23:55** — PM closes the day with a proactive block: hypotheses backlog,
an audit, a PRD, a content calendar.

**Score:** 5 features to production, 1 hotfix, 4 test-based acceptances,
2 deploys, one org restructure, one infra migration — of the coordination
tool itself, while in use. The human's contribution: decisions.

Every handoff above went through files a human can read, grep, and `git diff`.
That's the whole product.
