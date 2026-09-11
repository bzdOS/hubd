# Client hooks: `hub whereami` at session start, `hub claim check` before an edit

Two moments an editor can hand the agent hub state without the agent having to remember:
when a session starts or its context is compacted (`hub whereami`), and right before it
writes a file (`hub claim check`). Both commands are read-only, need no network, and exit
in well under three seconds on every host that has hubd. The table says what each client
can do today; a row that says "works" without having been run is worse than one that says
"unknown", so fill it in only after running it.

## Session start / after compaction: `hub whereami`

| client | mechanism | status |
| --- | --- | --- |
| Claude Code | `SessionStart` + `PostCompact` hooks running `hub whereami`, output goes into context | works — recipe below |
| Cursor | no documented session-start hook known to us | prose fallback (HUBD.md: first action of a session — `hub whereami`) |
| OpenCode | no documented session-start hook known to us | prose fallback |
| CommandCode | no documented session-start hook known to us | prose fallback |
| GLM-based clients | no documented session-start hook known to us | prose fallback |

`~/.claude/settings.json` — user level, so it covers every repository that carries a `.hubd`
marker (a repository without one still gets the git inventory and a `(none)` project):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "command -v hub >/dev/null && hub whereami \"$PWD\" 2>/dev/null || true" } ] }
    ],
    "PostCompact": [
      { "hooks": [ { "type": "command", "command": "command -v hub >/dev/null && hub whereami \"$PWD\" 2>/dev/null || true" } ] }
    ]
  }
}
```

The `.hubd` marker's optional second line names a project-local inventory script
(`scripts/where_am_i.py`); `hub whereami` runs it last and appends its output, capped at 4 KB
and 5 seconds. Project-specific registers stay in the project — the engine only knows how to
call them.

## Before the edit: `hub claim check`

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
