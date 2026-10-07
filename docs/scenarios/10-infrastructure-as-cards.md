# 10. Infrastructure as cards

**The situation.** The shop runs on two VMs on a server in the office, and its backups
on a second machine. Where each thing runs lives in two heads, a wiki page last edited
in spring, and the transcripts of sessions that ended long ago. An agent sent to renew
the shop's certificate finds two answers to where the site is served. The night the
office server dies, nobody can say in a minute what died with it.

**What you end with.** Every machine and service as a card: its facts in fields, its
links to other cards typed. What runs on a machine, and what a service needs, in one
command each. Tasks that name the cards they touch. And two gaps the hub finds by
itself: a link to a card nobody wrote, and a card still `planned` after the work that
made it real.

Levels 2 and 5: [2. Work](../start/2-work.md) has tasks, and
[5. Roles](../start/5-roles.md) writes roles as resource cards, the same kind of card
as here. Every output below is real, captured in one run on a node called `oak`, so
its clock reads minutes where the story says hours.

```bash
export HUBD_DIR=/tmp/hub-s10 HUBD_TEAM_DIR=/tmp/hub-s10 HUBD_NODE=oak
hub init "$HUBD_DIR" > /dev/null
hub card shop -m "Web shop: catalogue, cart, checkout." --by alice > /dev/null
```

## Write down what you have

Machines first, one card each, the facts in flags:

```bash
hub resource set pine --type host --addr 192.0.2.12 --os "FreeBSD 15.0" --status live -m "The office server." --by alice
hub resource set maple --type host --addr 192.0.2.13 --os "Debian 13" --status live -m "Holds the backups." --by alice
hub resource set web-1 --type vm --addr 192.0.2.21 --os "Debian 13" --status live --link runs_on:pine --by alice
hub resource set db-1 --type vm --addr 192.0.2.22 --os "Debian 13" --status live --link runs_on:pine --by alice
```

```text
Resource set: pine → /tmp/hub-s10/resources/pine.md
Resource set: maple → /tmp/hub-s10/resources/maple.md
Resource set: web-1 → /tmp/hub-s10/resources/web-1.md
Resource set: db-1 → /tmp/hub-s10/resources/db-1.md
```

Then what runs on them:

```bash
hub resource set shop-web --type service --addr https://shop.example.com --status live --attr tls=caddy --link runs_on:web-1 --link depends_on:shop-db --link part_of:shop -m "The storefront." --by alice
hub resource set shop-db --type service --addr 192.0.2.22:5432 --status live --link runs_on:db-1 --link part_of:shop -m "Postgres 16: orders and customers." --by alice
hub resource set shop-backup --type service --status live --attr schedule="nightly 02:00" --attr keep=30d --link runs_on:maple --link backs_up:shop-db -m "pg_dump of shop-db." --by alice
hub graph
```

```text
Resource set: shop-web → /tmp/hub-s10/resources/shop-web.md
Resource set: shop-db → /tmp/hub-s10/resources/shop-db.md
Resource set: shop-backup → /tmp/hub-s10/resources/shop-backup.md
db-1 (vm·192.0.2.22)
  └─ runs_on → pine (host·192.0.2.12)
shop-backup (service)
  └─ runs_on → maple (host·192.0.2.13)
  └─ backs_up → shop-db (service·192.0.2.22:5432)
shop-db (service·192.0.2.22:5432)
  └─ runs_on → db-1 (vm·192.0.2.22)
  └─ part_of → shop
shop-web (service·https://shop.example.com)
  └─ runs_on → web-1 (vm·192.0.2.21)
  └─ depends_on → shop-db (service·192.0.2.22:5432)
  └─ part_of → shop
web-1 (vm·192.0.2.21)
  └─ runs_on → pine (host·192.0.2.12)
```

`--link <relation>:<slug>` is a typed link. The relation is any word you choose
(`runs_on`, `depends_on`, `part_of`, `backs_up`), and the target any card, a resource
or a project: `part_of → shop` points at the shop's project card. `--attr` holds any
other one-line fact. Types and relations are an open vocabulary; pick a few and keep
to them.

## One card

```bash
hub resource get shop-web
```

```text
---
kind: resource
type: service
address: https://shop.example.com
status: live
tls: caddy
runs_on: [[web-1]]
depends_on: [[shop-db]]
part_of: [[shop]]
---
# shop-web

- slug: shop-web
- set: 2026-10-07 17:04 by alice

## Digest

The storefront.

→ out:
   runs_on → web-1
   depends_on → shop-db
   part_of → shop
```

A resource card is a file in `resources/`: Markdown with frontmatter. The fields are
what a tool reads, the digest is a line for people, and the links are `[[wikilinks]]`,
so the folder opens as a graph in a Markdown tool too ([reading your hub with any
tool](../interop.md)). Under the card, `hub resource get` lists its links both ways.
An agent asks the same with `hub_resource_get` and `hub_graph`. The one sent to renew
the certificate reads `tls: caddy` on the storefront, which runs on web-1, and stops
looking.

## The night pine goes down

```bash
hub resource set pine --status down --by alice
hub resource list --type host
hub resource get pine | sed -n '/^← in:/,$p'
hub resource get web-1 | sed -n '/^← in:/,$p'
hub resource get db-1 | sed -n '/^← in:/,$p'
```

```text
Resource set: pine → /tmp/hub-s10/resources/pine.md
  maple                 host       live     192.0.2.13
  pine                  host       down     192.0.2.12
(2 resources)
← in:
   db-1 —runs_on→
   web-1 —runs_on→
← in:
   shop-web —runs_on→
← in:
   shop-db —runs_on→
```

pine reads `down` for every agent now. A card knows its own links and the links that
point at it, one hop away. pine carries web-1 and db-1; they carry the storefront and
the database. `hub resource get shop-db` would name what needs the database: the
storefront and the backup. hubd does not walk further by itself: a question that
crosses hops is one command per hop, or `hub graph`, which prints every link at once.

The repair is a task, linked to what it touches:

```bash
hub task add "restore pine: the disk controller died" -p infra -i high --resource pine --by alice
hub task list -p infra
```

```text
Task #oak-1 added: restore pine: the disk controller died  [⛬pine]
! #oak-1 [infra] ⛬pine restore pine: the disk controller died
(1 tasks)
```

`⛬pine` in the list, and `hub task get` names the cards too, so `hub task list | grep
⛬pine` answers what is open on pine, however each task was worded.

## Moving the database

While pine is down, the database comes back on a new VM on maple, from last night's
dump. The VM is written down before it exists, as `planned`:

```bash
hub resource set db-2 --type vm --addr 192.0.2.23 --os "Debian 13" --status planned --link runs_on:maple --by alice
hub task add "bring shop-db up on db-2 from last night's dump" -p shop -i high --resource db-2 --resource shop-db --by alice
```

```text
Resource set: db-2 → /tmp/hub-s10/resources/db-2.md
Task #oak-2 added: bring shop-db up on db-2 from last night's dump  [⛬db-2 ⛬shop-db]
```

An hour later the shop takes orders again, and the task is closed:

```bash
hub task done oak-2 --by alice
```

```text
Task #oak-2 closed
  note: closed, but its linked resource(s) still read not-live: db-2 (planned). If this work made them real, say so: hub_resource_set({slug:"<one>", status:"live", by:"<you>"}) — nothing here guesses that for you.
```

Closing a task changes no card. Only the one who did the work knows whether db-2 is
live now, so hubd names the card that still says otherwise and leaves the fact to you:

```bash
hub resource set db-2 --status live --by alice
hub resource set shop-db --addr 192.0.2.23:5432 --link runs_on:db-2 --by alice
hub resource get shop-db | sed -n '/^→ out:/,$p'
```

```text
Resource set: db-2 → /tmp/hub-s10/resources/db-2.md
Resource set: shop-db → /tmp/hub-s10/resources/shop-db.md
→ out:
   runs_on → db-1
   runs_on → db-2
   part_of → shop
← in:
   shop-backup —backs_up→
   shop-web —depends_on→
```

A link is added to the ones already there, never put in their place, so the card now
says the database runs in two places. An empty `--attr` removes a field, and with it
the old link:

```bash
hub resource set shop-db --attr runs_on= --link runs_on:db-2 --by alice
hub resource get shop-db | sed -n '/^→ out:/,$p'
```

```text
Resource set: shop-db → /tmp/hub-s10/resources/shop-db.md
→ out:
   part_of → shop
   runs_on → db-2
← in:
   shop-backup —backs_up→
   shop-web —depends_on→
```

## What the hub finds by itself

Checkout takes card payments through an outside provider. Someone links the storefront
to it before anyone writes its card:

```bash
hub resource set shop-web --link depends_on:payments --by alice
hub graph -p shop-web
hub doctor | sed -n '/^links:/,/^$/p'
```

```text
Resource set: shop-web → /tmp/hub-s10/resources/shop-web.md
shop-web (service·https://shop.example.com)
  └─ runs_on → web-1 (vm·192.0.2.21)
  └─ depends_on → shop-db (service·192.0.2.23:5432)
  └─ depends_on → payments ⚠missing
  └─ part_of → shop

⚠ dangling (target has no card — create it or it stays a note):
  shop-web —depends_on→ payments
links: 1 dangling (target has no card)
  shop-web —depends_on→ payments
```

A link to a card that does not exist is kept, as a note: `⚠missing` in the graph, and
a line in every `hub doctor` until someone writes the card.

```bash
hub resource set payments --type provider --addr https://api.payments.example --status live -m "Card payments for checkout." --by alice
hub graph -p shop-web
```

```text
Resource set: payments → /tmp/hub-s10/resources/payments.md
shop-web (service·https://shop.example.com)
  └─ runs_on → web-1 (vm·192.0.2.21)
  └─ depends_on → shop-db (service·192.0.2.23:5432)
  └─ depends_on → payments (provider·https://api.payments.example)
  └─ part_of → shop
```

## What can go wrong

**Facts in prose.** "The database is on 192.0.2.22" in a digest is read by people only:
`hub resource list` and `hub graph` do not see it, and the day the address changes, the
field is updated and the sentence is not. A fact goes in a field; the digest says what
the thing is for.

**A status nobody updates.** A card that says `live` about a machine turned off last
month is worse than no card: the agents believe it. Nothing changes a card but a write
to it. A machine that is gone gets `--status retired`, not a deleted file: the card
keeps what ran there, and the links to it stay whole.

**Two names for one thing.** `db1` and `db-1` are two cards, and a link to the one
nobody updates still resolves. Pick the slug once, the way the machine names itself.
There is no rename: write the new card, move every link to it, and mark the old one
`retired`; `hub resource get <old>` lists the links still pointing at it.

**A password in a card.** A card goes to every node and stays in the hub's git history
after you delete the line. Keep the value with `hub secret set`, in a folder outside
the hub on each machine, and let the card name it: `--attr secret=shop-db-password`.
