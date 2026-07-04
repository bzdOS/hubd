# Ready-made prompts for every surface

hubd's mechanics — how to report, claim, use resources, harvest — live in
**`HUBD.md`**, which the tool regenerates on every node to match the installed
version (generated from [protocol.md](protocol.md)). Agents READ HUBD.md and
follow it; it is the single, always-current source of truth.

These per-surface blocks just **wire hubd into a given tool** and point at
HUBD.md — they deliberately do NOT re-teach the mechanics (that would go stale
the moment the product moves).

| Surface | File | How to install |
|---|---|---|
| Claude Code | [claude-code.md](claude-code.md) | append to your project's `CLAUDE.md` |
| Cursor | [cursor.md](cursor.md) | append to `.cursorrules` |
| Codex CLI / agents.md-aware tools | [agents-md.md](agents-md.md) | append to `AGENTS.md` |
| Claude Desktop / any MCP chat | [mcp-chat.md](mcp-chat.md) | paste as first message / custom instructions |

**Harvest** is a first-class prompt now: pick `harvest` from your MCP client, or
run `hub harvest` — no need to fetch a file. Server inventory →
[inventory.md](inventory.md).
