# hubd — server inventory prompt

Got a box where services pile up for years? Don't describe it by hand — point
an agent at it. Run your coding agent on (or SSH'd into) the machine and paste:

```
Inventory this server into hubd project cards (plain markdown files).

1. DISCOVER, read-only — do not change anything:
   - systemd: systemctl list-units --type=service --state=running (and enabled but dead)
   - containers: docker ps -a / docker compose ls (if present)
   - schedulers: crontab -l for relevant users, /etc/cron.*, systemd timers
   - web: nginx/caddy/traefik configs — server_name, ports, upstreams
   - listeners: ss -tlnp — every listening port and its process
   - code: ls /opt /srv /home/*/apps (or wherever code lives), git remotes

2. WRITE the hierarchy — one card per entity:
   - host card  host-<name>.md : OS, CPU/RAM/disk, access notes, backup state
   - service card <host>-<svc>.md with frontmatter `parent: host-<name>`,
     and related: [[other-svc]] links where one service depends on another.

3. CARD FORMAT (keep each section to 1–3 lines):
   What         one sentence — what this service is and who uses it
   Run          how it runs: unit/container/command, restart policy
   Source       repo or directory the code comes from
   Net          ports, domain(s), upstream/downstream
   Deps         [[links]] to other cards (db, cache, queue)
   State        running? version? last deploy if discoverable
   Risks/TODO   anything alarming: no backups, port open to world, dead unit

4. DELIVER: if hubd MCP/CLI is available — hub_sync each card. If not —
   write the .md files into ~/.hubd/projects/ (create it) or print them
   as one block for manual placement. Also output a TASKS list: one line
   per Risk/TODO found, ready for `hub task add`.

Rule: facts only — never guess what a service does from its name; check
configs/logs. Unknown = write "unknown", it's a finding too.
```

Ten minutes later you have a tree: host → services → risks-as-tasks, all
greppable, all linked, all watchable from the kanban. Re-run it monthly —
the diff IS your drift report.

**Privacy note.** Inventory cards are *data*, not code: they live in `~/.hubd`
on your machine and never belong in any code repository — least of all a
public one. Want them backed up? Make `~/.hubd` its own *private* git repo.
The hubd code repo stays clean of your internals by construction.
