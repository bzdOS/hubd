# hubd — server inventory prompt

Point an agent at a box where services pile up and it writes them as hubd
**resource cards** (hosts, vms, services, endpoints) with a typed relationship
graph — instead of you describing it by hand. Run your coding agent on (or
SSH'd into) the machine and paste:

```
Inventory this server into hubd resources. Facts only — never guess what a
service does from its name; check configs/logs. Unknown = write "unknown", it's
a finding too. Discover read-only; change nothing.

1. DISCOVER (read-only):
   - services: systemctl list-units --type=service --state=running (+ enabled-but-dead)
   - containers: docker ps -a / docker compose ls
   - schedulers: crontab -l, /etc/cron.*, systemd timers
   - web: nginx/caddy/traefik configs — server_name, ports, upstreams
   - listeners: ss -tlnp — every listening port and its process
   - code: ls /opt /srv /home/*/apps, git remotes

2. WRITE one resource per entity with `hub resource set`:
   - host:     hub resource set <name> --type host --addr <ip> --os "<os>" --status live -m "<one line>"
   - service:  hub resource set <host>-<svc> --type service --status <live|down> -m "<what it is, who uses it>" \
                 --link runs_on:<name> --link depends_on:<db-or-cache> --link exposes:<domain>
   - endpoint: hub resource set <domain> --type endpoint --status live --link part_of:<host>-<svc>
   Edge types: runs_on / depends_on / deploys_to / exposes / part_of / connects.

3. RISKS -> tasks: one `hub task add "<risk>" -p <slug> --resource <host>-<svc>` per
   finding (no backups, port open to the world, dead unit, unknown owner).

4. Then `hub graph` shows the whole topology. Re-run monthly — the diff is your
   drift report.

No hub on the box? Write the same as resources/<slug>.md files (frontmatter
`kind: resource`, type, address, status + typed `[[wikilink]]` edges) into
~/.hubd, or print them as one block to place by hand.
```

**Privacy.** Resource cards are *data*, not code: they live in `~/.hubd` and
never belong in a code repository — least of all a public one. Back them up by
making `~/.hubd` its own *private* git repo; the hubd code repo stays clean of
your internals by construction.
