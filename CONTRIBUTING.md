# Contributing

## What this project wants

Reports of the tool **misleading its reader** outrank feature requests here. A
number that is wrong, a list that ended early without saying so, a tool
description that sends an agent down the wrong path — those are the bugs this
codebase is mostly made of fixing. If something cost you round-trips but never
errored, that is a [friction report](.github/ISSUE_TEMPLATE/friction.md), and it
is welcome.

## Running it

No dependencies, no build step. Node 20+.

```bash
git clone https://github.com/bzdOS/hubd && cd hubd
node tests/test_logic.mjs      # unit + integration
sh tests/smoke_cli.sh          # the CLI end to end
sh tests/smoke_mcp.sh          # the MCP server over stdio
sh tests/test_sync_preserve.sh # card writes never drop a hand-written section
sh tests/check_clean.sh        # no private names or non-English in tracked files
```

Point everything at a throwaway hub while you work — `HUBD_DIR=/tmp/hub` — and
never at `~/.hubd`. The suites do this themselves; a stray command run from your
shell will not.

## What a change looks like here

**Every behaviour change carries a test that fails without it.** Not coverage for
its own sake: the test is the description of the failure, so write the message as
the sentence you would want to read when it goes red in a year.

**Comments explain WHY, and name the incident.** This codebase is unusually
commented on purpose — most of its rules are scars, and a rule whose reason is
missing gets "simplified" back into the bug it prevents. If you are fixing
something real, say what it did.

**Data is append-only.** Task event logs and journals only ever grow. A migration
appends events; it never rewrites a line or drops a field. The data is
deliberately richer than the current schema — an unrecognised field is meaning,
not cruft. `tests/check_clean.sh` and the mesh-sync guard both enforce this.

**Never invent a number.** If the hub cannot observe something — how long an
agent took, what it cost — the tool says it cannot, and takes the value from
whoever can. Measured and supplied stay in separate columns.

## Pull requests

One change per PR, with the reasoning in the message rather than the diff.
Run all five suites before pushing; `check_clean.sh` will also stop you
committing a private name into a public repo, which is exactly why it exists.
