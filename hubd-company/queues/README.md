# queues/

One file per role: `<role>.queue.md` — created on first send.
Read offsets live in `.qstate/` (gitignored, machine-local: NEVER sync or commit).
Smoke-test queues only via the throwaway role `smoketest`.

## One consumer per role

Each role queue is read by exactly one live waiting session. A second concurrent
`hub queue wait` on the same role prints a warning, and messages may be split
between waiters.

Commands:

```
hub queue send <role> "<text>" [--from <who>]
hub queue wait <role> [--timeout <seconds>]
```
