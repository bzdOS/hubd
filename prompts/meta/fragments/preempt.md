## Preempting with a dispatch

A head may mark a dispatch with `PREEMPT` as its first line.
- The loop stops the worker's running turn by its pid, and the next turn starts with exactly this dispatch.
- Worker: when you see `PREEMPT`, drop what you were doing, do not finish it. Leave the earlier step in the report as a `NEXT` line.
  Do not kill an unfinished build some other way: record its pid and its log in the report.
- A turn is limited to 40 minutes. Anything longer goes to the background with a log; the next turn checks the log instead of waiting.
- Head: mark `PREEMPT` only what is urgent, what cannot wait until the current turn ends
  (the owner's goal, another role's blocker). Everything else is an ordinary dispatch. The mark does not speed up
  an unclear dispatch: a preempting dispatch must carry an acceptance criterion.
- Workers never set `PREEMPT`, neither for themselves nor for others.
