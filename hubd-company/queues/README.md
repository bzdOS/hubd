# queues/

One file per role PER HOST: `<role>.<node>.queue.md` — created on first send.
Each machine appends only to its own file, so mesh-synced nodes never conflict.
(The legacy shared `<role>.queue.md` is still read, never written.)

## Message block format

```
## YYYY-MM-DD HH:MM · from <sender>
<message text>
```

## Sending and receiving

```
hub queue send <role> "<text>" --from <your-role>
hub queue wait <role> [--timeout <seconds>]
```

## Delivery

A role is a competing-worker queue by default: run ONE live `hub queue wait`
per role — a message goes to exactly one reader. Roles listed in
`subscriber-roles.json` (in the team root, next to this folder) broadcast
instead: every waiting session keeps its own cursor and sees every message.

## State

Read offsets live in `.qstate/` — one `<file>.offset` per queue file, plus
per-subscriber cursors under `.qstate/<subscriber>/`. Never commit or sync
`.qstate/` — it is local consumer state.

Smoke-test queues only via the throwaway role `smoketest` — never against a
live queue (offsets are state).
