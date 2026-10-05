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
npm test                       # every suite, side by side: node tests/run.mjs
node tests/run.mjs queue       # only the suites whose name contains "queue"
node tests/logic/queue.mjs     # one file on its own
```

The runner takes half the cores at nice 10, so the machine stays usable while it runs;
`HUBD_TEST_JOBS=N` sets how many suites run at once.

`tests/logic/` holds the engine and CLI tests, one file per area, sharing
`tests/logic/_h.mjs` (a throwaway hub, `ok()`, `cli()` and `run()` for the CLI,
temp dirs removed at exit). The shell suites next to it cover the MCP server
over stdio (`smoke_mcp.sh`), card writes that must keep hand-written sections
(`test_sync_preserve.sh`), what the mesh sync says when a pull does not go
through (`test_mesh_sync.sh`), and no private names or non-English in tracked
files (`check_clean.sh`).

Wire the commit-message hook once per clone:

```bash
git config core.hooksPath .githooks
```

`check_clean.sh` scans the git log, and a message enters the log only *after* the
commit is made — so the gate cannot catch the commit that breaks it. It passed
honestly three times in a row here while three non-English messages went in, and
the next release was blocked until they had to be rewritten with `commit-tree`.
The hook runs the same denylist over the message while rewriting it is still free.

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
