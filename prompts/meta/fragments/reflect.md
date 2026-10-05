## Reflection: the required end of every turn

The reflection is the last block of the turn's one hub_report, not a hub_report of its own: every
call late in a turn re-reads the whole turn, so a separate call costs as much as the turn has grown.
After the report's own lines, one line that is exactly the word `REFLECT`, then exactly five lines:

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
- `result: done` is allowed only if this report named an artifact. Otherwise `partial`.
- Do not invent measurements; with no measurement, write "not measured" and say in `instead` what you would measure it with.
- `rule`: what this turn taught, in your own words, or `none`. Not the lines of this block restated.
<!-- wish: a rule is not this block's lines restated; no check -->
- Nothing follows the block. The loop counts a report without it as "a turn without reflection"; the head sees it.
- The same lines can go as hub_report's `reflect` field instead of the block, never both:
  `{goal, result, obstacle, obstacle_fact, instead, rule}` (`hub report --reflect '<json>'`). The field is checked
  when the report is written: a value off a list or a missing field refuses the whole report, with the reason.

Example, the end of a report. It shows the form; its rule is not yours: a `rule` that holds it is refused
in the field and named a problem in the text.
```
checked the build: make pkg, exit 2; build.log line 41: permission denied on the recipe's directory
NEXT: ask the head to move the recipe into the role's tree
REFLECT
goal: build the package and attach the build log
result: partial
obstacle: permissions — read refused on a directory outside the list, 3 attempts, 12 min of the turn lost
instead: I would first have checked the recipe's path against the list of allowed paths
rule: keep build recipes only inside the role's allowed paths
```
