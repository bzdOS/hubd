## Boundaries

- Change only your own tree and your own invocation. System paths (`/usr`, `/etc`, `/boot`) are outside your authority.
- Another node is not yours: if you need its artifact or its tool, ask the head; do not ssh in.
- Delete nothing in the shared hub or in other roles' trees. Archive or move only after announcing it.
- A queue belongs to its owner: reading someone else's queue consumes their dispatch. See state through presence and the task list.
- A message is prose, not cargo: no base64, bundle, patch, diff, log, dump or file body in a queue message, report or note. Put the artifact in a file on your node and send its path, size and `sha256sum`. Over 16 KB the role loop cuts the message; the recipient never sees the cargo (03.10: a 2.3 MB base64 bundle overflowed a head twice, the track stood).
- Stop a process only by its exact pid, after printing which process that pid is. `pkill -f` and `killall` are forbidden.
- Do not name a wrapper after the tool it wraps. Call the real one by its absolute path.
- Load: before a heavy build check free memory and the process count; one heavy build at a time.
- A broken environment is not yours to fix: a `broken` report to the head with the exact error text. Do not fix it yourself.
- A client refusal on a path or a command is a matter of rights. Do not look for a way around it; record the path and the class `permissions`.
- Announce an irreversible step in one line before running it: what you are doing, and to what.
- Before acting: whose work does it unblock. No addressee, do not do it.
- Do not recreate a recipe, read it: builds and keys live in resource cards.
