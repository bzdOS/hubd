# Self-hosting a shared hubd for a team

By default `hubd` runs locally over stdio: one owner, one machine, agents spawn
it on demand. To let a **team** point their agents at one shared hub, run the
daemon in HTTP mode — it speaks MCP over Streamable HTTP (JSON-RPC over POST),
token-gated, zero dependencies.

> Status: experimental. Single-tenant by default, or multi-tenant (a workspace per token, below). Either way the
> server stores and reads the team's tasks and journal — it is **not** the
> end-to-end model. Review the security notes before putting sensitive work in it.

## Run the server

```bash
npm i -g @bzdos/hubd

# generate a secret (keep it private)
export HUBD_TOKEN="$(openssl rand -hex 24)"

# data lives here — back it up; it's just markdown + jsonl
export HUBD_DIR=/opt/hubd-team

# bind localhost and put TLS in front (recommended), or HUBD_HTTP_HOST=0.0.0.0 to expose directly
hubd --http 8787
```

Run it under a process manager (systemd, pm2, tmux) so it survives restarts.
The daemon refuses to start without `HUBD_TOKEN` of at least 16 characters.

## Multi-tenant: a workspace per token

To host one server for many independent teams (this is how hubd.net runs), set
`HUBD_MULTITENANT=1` instead of a fixed `HUBD_TOKEN`:

```bash
export HUBD_DIR=/var/lib/hubd          # tenants live under $HUBD_DIR/tenants/
HUBD_MULTITENANT=1 hubd --http 8787
```

Now **every Bearer token is its own isolated workspace** — stored at
`tenants/<sha256(token)>/`, created on the first request. No signup, no accounts:
the token *is* the key. Onboarding is one line that mints a strong token
client-side, so nobody has to invent one:

```bash
claude mcp add --transport http hubd https://mcp.hubd.net \
  --header "Authorization: Bearer $(uuidgen)"
```

Share that exact line to bring teammates into the same workspace (same token →
same hub). Because the token is the only credential, it must be high-entropy — a
uuid is ideal; a short or guessable token is a guessable workspace (the server
rejects anything under 16 chars, but that is a floor, not real strength).

### TLS is required

A bearer token over plain HTTP is a leaked token. Terminate TLS in front of the
daemon. With [Caddy](https://caddyserver.com) it is one line:

```
mcp.hubd.net {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy provisions HTTPS automatically. Expose only 443; keep 8787 internal.
Health check (no auth): `curl https://mcp.hubd.net/healthz`.

## Connect an agent

Each teammate adds the remote MCP server (Claude Code shown; other clients take
a URL + `Authorization` header in their MCP config):

```bash
claude mcp add --transport http hubd https://mcp.hubd.net/ \
  --header "Authorization: Bearer $HUBD_TOKEN"
```

Agents then create work with `hub_task_add`, read the shared backlog with
`hub_task_list`, and log to the shared journal with `hub_report` — a shared task
intake for agents, over the network.

## What changes in HTTP mode

- **`hub_sync` is disabled.** It reads an arbitrary filesystem path and runs
  `git` on the host — safe locally, a hole on a shared server. Every other tool
  (tasks, journal, status, search, brief, claims, cards, resources, graph) is
  available.
- Every other tool behaves exactly as over stdio — the transport is the only
  difference.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `HUBD_TOKEN` | — | single-tenant bearer secret (≥16 chars; required unless multi-tenant) |
| `HUBD_MULTITENANT` | off | `1` → every token is its own workspace at `tenants/<hash>/` |
| `HUBD_DIR` | `~/.hubd` | where data lives |
| `HUBD_HTTP_HOST` | `127.0.0.1` | bind address (keep it localhost behind a TLS proxy) |
| `HUBD_HTTP_PORT` | `8787` | port (or pass `--http <port>`) |
| `HUBD_RATE_LIMIT` | `120` | max POSTs per minute per client IP (over the limit → 429) |
| `HUBD_MAX_TENANTS` | `1000` | cap on new tenant creation in multi-tenant mode (over the cap → 403) |

## The hub directory is data, not code

`HUBD_DIR` holds only your data — cards, journal, tasks. The code comes from the
installed package; don't copy hubd's source into the hub directory. Keeping the
two separate means `npm update -g @bzdos/hubd` upgrades the code without touching
your data, and the data folder stays a clean thing you can back up or open in any
Markdown tool (see [interop](interop.md)).

## Security notes

- **One token = full access** (single-tenant) or **one token = one workspace**
  (multi-tenant). Anyone holding a token can read and write that hub — treat it
  like a key. Rotate a single-tenant secret by changing `HUBD_TOKEN` and restarting.
- **Not end-to-end.** The server reads the data. Trust in the host is the model
  here; an end-to-end personal mode is on the roadmap, separately.
- **Abuse guards are built in.** A per-IP request rate limit (`HUBD_RATE_LIMIT`)
  and a cap on tenant creation (`HUBD_MAX_TENANTS`) bound the obvious disk-fill
  and flood vectors. Still: put it behind TLS and harden before exposing widely —
  there is no audit log yet.
- Back up `HUBD_DIR`; it is plain files and git-friendly.
