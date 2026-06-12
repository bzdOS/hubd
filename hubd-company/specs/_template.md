# SPEC_<name> — <one-line goal>

*An assignment from cto to an executor (dev/runner). The constitution makes
`specs/SPEC_*.md` the channel for work: cto writes the spec, the executor appends
`## Report`, cto appends `## Acceptance`. Copy this file to `SPEC_<name>.md` and fill it in.*

## 30-second context
Why this exists and what it serves. Link the PRD or the project card — the
executor should not have to reconstruct intent.

## Constraints
What must hold no matter what: compatibility, performance budget, zero new
dependencies, files or areas NOT to touch. Deviation is allowed only toward
strictness/reliability, and must be recorded in the report.

## Data / interfaces (verbatim)
Exact signatures, file paths, formats, example inputs/outputs — copied, not
paraphrased. Ambiguity here becomes a wrong guess in the code.

## Structure
The approach: which files to add or change, in what order. Enough that the
executor builds the right thing, not so much that it stops thinking.

## Acceptance tests (numbered)
Observable, checkable outcomes — cto accepts strictly by these.
1. <e.g. `make test` exits 0 and prints "N pass, 0 fail">
2. <e.g. a request to /x returns 401 without a token>

## What NOT to do
Out of scope, tempting-but-wrong, and things to leave for a later spec.

---
## Report
*(executor fills in: what was done, deviations with reasons, test output)*

## Acceptance
*(cto fills in: accepted / changes required, against the numbered tests)*
