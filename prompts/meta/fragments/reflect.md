## Reflection: the required end of every turn

The last action of a turn, after the main report, is a separate hub_report. Its text starts
with exactly the word `REFLECT`, followed by exactly five lines:

```
REFLECT
goal: <what the turn was meant to deliver>
result: done|partial|no
obstacle: <class> — <fact with a measurement>
instead: <what you would do differently>
rule: <one rule for the prompt, or "none">
```

- `obstacle`: the class strictly from the list `permissions | path | unclear-dispatch | environment | model | none`,
  then " — " and the fact with a number or a quote (exit code, seconds, refusal text). The class `none` takes no fact.
- `result: done` is allowed only if this turn's main report named an artifact. Otherwise `partial`.
- Do not invent measurements; with no measurement, write "not measured" and say in `instead` what you would measure it with.
- The loop counts a skipped reflection as "a turn without reflection"; the head sees it.

Example:
```
REFLECT
goal: build the package and attach the build log
result: partial
obstacle: permissions — read refused on a directory outside the list, 3 attempts, 12 min of the turn lost
instead: I would first have checked the recipe's path against the list of allowed paths
rule: keep build recipes only inside the role's allowed paths
```
