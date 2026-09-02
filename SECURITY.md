# Security

## Reporting

Open a [private security advisory](https://github.com/bzdOS/hubd/security/advisories/new)
rather than a public issue. There is no security@ address to write to; the
advisory is the channel.

## What the threat model actually is

hubd is a local tool by default: a CLI and an MCP server over stdio, reading and
writing one folder you own. In that shape there is no network surface at all, and
the security question is about **what leaves the machine**, not about who can
reach it.

Three properties are deliberate, and a bug in any of them is a security bug:

- **Runtime state never syncs.** `presence/`, `.qstate/`, `.env-state.json` and
  `journal.life.jsonl` are node-local and gitignored. The life braid in
  particular is opt-in, local-only, and never mesh-synced by design.
- **A private report stays private.** `hub_report({private:true})` routes to the
  local-only journal. Prefixed lines that would write into a *card* are refused
  in that mode, because cards are synced and the two together would publish what
  you asked to keep local.
- **Nothing is uploaded.** There is no telemetry, no phone-home, no vendor API in
  the loop. The package has zero runtime dependencies.

## Running it for a team

`hubd --http` is the one networked mode. It binds `127.0.0.1` unless told
otherwise, requires `HUBD_TOKEN` of 16+ characters (compared with
`timingSafeEqual`), and disables the tools that would let a remote caller reach
the host's filesystem or hold a connection open — `hub_sync` and both blocking
queue waits. Multi-tenant mode gives every token its own isolated workspace. See
[docs/self-hosting.md](docs/self-hosting.md). Put it behind TLS if it leaves
localhost; hubd does not terminate TLS itself.

## Not vulnerabilities

An agent writing something wrong into your hub is not a vulnerability — every
write is attributed and append-only precisely so you can see who did it and when.
