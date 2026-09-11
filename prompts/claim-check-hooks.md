# Warning before the edit: `hub claim check` per client

A claim is soft by constitution — it informs, it does not forbid. The point of a hook is
that the information arrives BEFORE the edit, from whatever editor the agent is using,
instead of after a conflict. `hub claim check <path>` exits 0 when the file is free (or the
claim is your own, with `--agent`), 1 with one line per holder when it is not. Never make
the hook block; print, and let the agent coordinate.

| client | mechanism | status |
| --- | --- | --- |
| Claude Code | `PreToolUse` hook on `Write\|Edit` reading `tool_input.file_path`, output as `additionalContext` | works — recipe below |
| Cursor | no documented pre-edit hook known to us | prose fallback (HUBD.md) |
| OpenCode | no documented pre-edit hook known to us | prose fallback |
| CommandCode | no documented pre-edit hook known to us | prose fallback |
| GLM-based clients | no documented pre-edit hook known to us | prose fallback |

"Prose fallback" means the one line in HUBD.md: *before editing a shared file — `hub claim
check <path>`*. Fill the table in when a client's hook is verified; a row that says "works"
without having been run is worse than one that says "unknown".

## Claude Code — `~/.claude/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "f=$(jq -r '.tool_input.file_path // empty'); [ -n \"$f\" ] && out=$(hub claim check \"$f\" --agent \"${HUBD_AGENT:-}\" 2>&1) || exit 0; [ $? -eq 0 ] || printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":%s}}' \"$(printf '%s' \"hubd claim check: $out\" | jq -Rs .)\"; exit 0"
          }
        ]
      }
    ]
  }
}
```

The hook exits 0 in every case — a claim that blocked would not be a soft lock. What the agent
gets is a line like `src/**/*.ts — agent-a since 2026-09-11 09:02 (macbook-pro-63)` in its
context, before the write lands. `HUBD_AGENT` in the environment makes your own claims read
as free.

## The same question from MCP

`hub_claim_check({path, agent})` is the tool form; `hub_context({cwd, agent})` additionally
returns `claimsTouched` — live claims of OTHER agents whose glob covers a file changed in this
checkout in the last 30 minutes — which is the "you are already in somebody's zone" that a
per-edit hook cannot see once the edit has happened.
