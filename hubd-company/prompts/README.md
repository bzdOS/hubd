# Ready-made prompts for every surface

hubd's mechanics — how to report, claim, queue, use resources — live in
**`HUBD.md`**, which the tool regenerates on every node to match the installed
version. Agents READ HUBD.md and follow it. These per-surface blocks just
**wire hubd into a given tool** and point at HUBD.md — they deliberately do NOT
re-teach the mechanics (that would go stale the moment the product moves).

| Surface | File | How to install |
|---|---|---|
| Claude Code | [claude-code.md](claude-code.md) | append to your project's `CLAUDE.md` |
| Cursor | [cursor.md](cursor.md) | append to `.cursorrules` |
| Codex CLI / agents.md-aware tools | [agents-md.md](agents-md.md) | append to `AGENTS.md` |
| Claude Desktop / any MCP chat | [mcp-chat.md](mcp-chat.md) | paste as first message / custom instructions |

No MCP at all? [HARVEST.md](../HARVEST.md) already degrades: the agent outputs
one paste-able block of `hub` CLI commands. Server inventory →
[../recipes/inventory.md](../recipes/inventory.md).

*The four surface files are snapshots synced from the hubd repo root — edit the
root copies, not these.*
