# hubd — block for AGENTS.md (Codex CLI and agents.md-aware tools)

```markdown
## Coordination via hubd
This project is coordinated through hubd (shared journal, tasks, claims).
- Start: run `hub brief` (CLI) or call hub_brief (MCP) and read it.
- Finish: `hub report "<what you did>" -p <slug>` + `hub sync <path> -m "<fresh digest>"`.
- New tasks: `hub task add "<text>" -p <slug>` the moment they appear.
- Soft-lock shared areas with `hub claim` / `hub release`.
- On "harvest": see HARVEST.md — extract structure from the dialog into the hub.
```
