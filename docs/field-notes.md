# Twelve weeks running a real project with an AI team that coordinates through git and markdown

In June I hired a CTO by pasting a markdown file into a fresh chat session.

The file was a role description: what you own, what you never do, how a work
session starts, where your inbox is. No system prompt engineering, no
framework, no memory of any previous conversation. The session read the file,
read the team constitution it pointed to, read the journal, and asked one
clarifying question. By the end of the day there was a written spec with
acceptance criteria in the repo, and I had approved it the way I'd approve any
employee's plan.

That was the whole hiring process. It still is. Twelve weeks later the same
folder of markdown files has coordinated a mixed team of AI agents and one
human across three machines, and this post is the field notes: what I
believed going in, what broke, and what the fixes turned into.

## The workload

The project being managed is [bsdOS](https://github.com/bzdOS/bsdos) — a
privacy-first mobile OS built on FreeBSD for ARM64: jailed apps instead of an
app store, a [Zenoh](https://github.com/eclipse-zenoh/zenoh) mesh instead of cloud
accounts, zero-copy Wayland streaming instead of a heavyweight display stack.
It is exactly as unfinished as you'd expect an OS started in June to be, and
it is not the hero of this post — it's the load on the test bench. What
matters here is its shape: eight public repos (an OCI-shaped jail runtime, a
HAL daemon in Zig, a streaming wire format, viewers, tooling), three machines,
and far more surface area than one person can hold in their head.

Which is the point. A project this size is impossible solo — unless most of
the team doesn't sleep.

## The bet: files, not a platform

The coordination tool is [hubd](https://github.com/bzdOS/hubd). The bet it
makes is that the source of truth for a team of agents should be **plain files
in git**, and the tool should only be a comfortable way to read and write
them.

Concretely, authority descends like this:

**git** (truth about code) → **spec files** (assignments, with reports and
acceptance appended in place) → **the journal** (append-only, newest first) →
**queues** (addressed delivery).

Everything below git is markdown and JSONL in one folder. There is no
database, no server-side intelligence, no embeddings, no vendor API in the
loop. Any model that can read and write files is already a team member;
[MCP](https://modelcontextprotocol.io) makes it comfortable, not possible.
When tooling breaks — and it did, mid-flight — the protocol degrades to its
floor: write into the journal file by hand and keep moving.

That's the bet. The rest of this post is the price I paid for it, episode by
episode. Every fix described below exists because something first failed in a
way that cost real work.

## What breaking actually looks like

Before the episodes, the thing they all turned out to have in common — it took
me most of these twelve weeks to name it.

I expected the failure mode of a tool for agents to be *breaking*: a crash, a
malformed response, a call that times out. Those turned out to be the harmless
kind. An agent that gets an error reads it and works around it, usually without
even mentioning it, because that is precisely what these models are good at.

The expensive failures were all the same shape instead: **the tool answered,
confidently, and the answer was wrong.** A list that hit an output limit and
ended without saying it had ended. A digest that returned an entire card where
one line was promised. A count that was mostly duplicates. A task close that
landed on somebody else's id. In every case nothing errored, no exception was
raised, and the tool looked like it was working — because by every check it
had, it was.

What makes this sharper with agents than with people is the reader. A human
looking at a board with 1,507 cards on it stops: *I did not create fifteen
hundred tasks.* That reaction is outside knowledge, and an agent has none of
it. It has the number you handed it and a strong prior that tools tell the
truth. So it takes the number, and the number becomes an input to a summary,
which becomes an input to a decision, which gets written into the journal in
confident prose. Wrongness doesn't stay one wrong field; it laminates.

And in a system that reports on itself, nothing external ever contradicts it.
The morning brief, the audit, the agenda and the trajectory view all read the
same corrupted cache and all agreed with each other, which reads exactly like
corroboration. The tool I had written specifically to catch problems was
sitting on the same lie as everything else. Nothing drifted into wrongness; it
marched there, in step, sounding fine.

So the rule this codebase converged on is narrower than "don't have bugs":
**never sound more certain than the data.** Truncate, but say that you
truncated. Report what you can't observe as unobserved instead of estimating
it. Keep the raw record in a shape that survives your own wrong summary of it.
Most of the fixes below are that one rule, learned an incident at a time.

## Scar tissue

### 1. The task file that ate its own edits

v1 of task state was the obvious thing: one `tasks.json`. Then the folder
started syncing between two machines over git, and the obvious thing became a
merge conflict on every pull — two nodes, one mutable file, no winner.

The fix is event sourcing, folk edition: each machine appends task events
(add/set/del) to its own log, `tasks.<node>.events.jsonl`, and `tasks.json`
is demoted to a **generated cache**, gitignored, rebuilt by folding all logs
by timestamp. Append-only logs from a single writer never conflict. Merge
problem gone.

Then the demotion bit back: edits an older code path had written directly
into the cache silently vanished on the next fold — reworded task titles
just reverted. Nothing was corrupted; the cache was simply rebuilt from logs
that had never heard of those edits. The rule that came out of it is tattooed
on the codebase now: *the cache is not the truth, and anything that writes to
the cache directly is a bug, not a shortcut.*

The same design failed once more, subtler: two machines, both offline,
minted task ids from the same counter — and an update meant for `#3` on one
node closed `#3` on the other. Ids became node-scoped (`planck-3`), minted
from the node's own log. Distributed systems 101, relearned at markdown
scale.

### 2. The ghost employee

The journal had the same shared-mutable-file problem, so it got the same
medicine: each machine writes `journal.<node>.jsonl`, readers merge all of
them by timestamp. Single writer per file, conflicts impossible.

Then a machine got renamed, and the team acquired a ghost: entries from a
node named `m` that no one had ever hired, sitting in the merged history next
to the same machine's entries under its old name. Nothing was lost — but node
identity was implicit (derived from the hostname), so an ops-level rename
silently became an org-level event.

The general lesson generalizes hard with agents: **identity must be explicit,
or you will meet employees you never hired.**

### 3. The message nobody received

Queues started as one file per role — `dev.queue.md`, append a block to send.
Same disease, worse symptom: two offline nodes appended to the same file,
git hit a merge conflict, the sync aborted, and a message a waiting agent
depended on was never delivered. A coordination tool that can silently drop
an assignment is worse than no tool.

Queues became per-host files too (`dev.<node>.queue.md`, readers merge), and
delivery state moved out of the synced data entirely. A delivered block looks
like this — the format is the protocol:

```
## 2026-07-25 03:13 · from tester
hello smoke
```

(That one is real, from the throwaway role our smoke tests are confined to —
a rule that itself exists because a smoke test once consumed a live queue's
offset and ate pending jobs.)

### 4. Everyone was named claude

For a while, writes arrived signed `claude`, `cursor`, `mcp` — or nothing.
Three concurrent sessions, all named `claude`, are not three authors; they're
one label covering everybody, which is to say nobody. Our queue archive
still contains a message from a sender literally named `unknown`. When the
journal is the audit trail for who decided what, that's not a cosmetic
problem.

The current release made authorship mandatory and opinionated: every write
requires an author, and bare model, client, and placeholder names are
**refused** — many sessions share them, so they identify nobody. For
infrastructure that can't ask, an environment variable supplies a per-node
floor (`HUBD_AGENT=dev-planck`) plus a per-session suffix, so two sessions on
one box stay distinguishable. A role is a mailbox; the author is whoever is
sitting at it, and a delivered block says "from \<sender\>" forever.

### 5. You can't explain anything once

Sessions have no memory. This sounds like a footnote and is actually the
central operational fact of running a team of agents: **you cannot brief
anyone once.** Every process change must be *delivered*, repeatedly, to
readers who weren't there when it was decided.

That turned protocol distribution into a product feature. The protocol lives
in a generated file (`HUBD.md`), rematerialized on every run from the
installed package and stamped with its version — update the code, and even
agents that only read files can't follow stale instructions. A `whatsnew`
call answers "what did I miss since I was last here," per section, hashed
individually, so an agent re-reads the paragraph that moved instead of the
whole manual. Environment problems (a missing config, a role that should be
declared) surface the same way, each item naming its remedy and who can fix
it.

And then the relapse, seven weeks in — the same week the fleet was found running three
different versions of the tool: the starter-kit templates shipped
*copies* of prompt files from the repo root, hand-maintained, and the copies
rotted — they were confidently teaching agents a protocol two releases old.
A stale instruction is worse than no instruction, because it carries
authority. The copies are now generated by a sync script, and CI fails if a
snapshot drifts from its source. The compiler-shaped fix, as always, beat
the discipline-shaped one.

### 6. Version 0

For about a month, the always-on server ran the daemon from a hand-copied
tree of the code — which was missing its `package.json`, so it reported its
version as `0` — while the CLI on the same machine was installed from npm,
three releases behind. Two desynced copies of the tool, on one box,
coordinating a team. Nobody noticed, because both copies mostly worked.

The same disease turned up twice more. A second machine was found serving the
public endpoints from a git checkout of the *first* public release, nine
versions behind, missing the very file the protocol is generated from — so
that box could not have told an agent what the current rules were even if
asked. Three instances of one root cause is not bad luck; it is a delivery
model that was never decided. There turned out to be a fourth, below.

The fix was a hard line, and it's written into the data folder's
`.gitignore` as a tombstone:

```gitignore
# vendored code — comes from the @bzdos/hubd npm package, not stored in the data hub
hub/
```

The synced folder now carries **data only**. Code travels one way: npm
publish, then install per node. Data travels another: the git mesh. The
month of confusion came from letting the two flows share a channel.

That fix separated the channels. It did not make the version *observable*, and
a fourth instance was waiting on the least likely machine. Right after
publishing the release that fixed the duplicated logs, I checked the `hub` on
my own `PATH` — the laptop hubd is developed on. It was **0.4.8**. Nine
releases behind, for weeks, while every tool call in every session went to the
source checkout and worked perfectly.

Two things had to be true at once for that to hide. The MCP server pointed at
the checkout, so nothing an agent did ever touched the stale copy. And there
was no way to ask: no `hub version`, no `--version`, no `-v`. Finding out took
`npm ls -g`. A tool built on the claim that systems fail by answering
confidently and wrong had, for nine releases, no answer at all to *what are
you*.

So `hub version` now prints the number and the path of the copy that printed
it, because on a real machine those are one question. And every journal line
carries the version that appended it — the log is the only artifact the whole
mesh reads, so it is the only place a version can be seen from another
machine. `hub doctor` now says which node is behind, whether *this* copy is
the stale one, and whether two installs are writing into the same log. That
last check is the shape this scar has had all four times.

### 7. The thousand tasks nobody created

Twelve weeks in, I pulled a task off a queue and the backlog disagreed with
itself: "Redeploy prod hubd" listed ten times, a four-item bundle listed ten
times each, and closing one copy left the other nine open. The tracker said
1,507 tasks. The real number was 427.

It took two separate bugs stacked on each other, and neither of them ever
raised so much as a warning.

**Stage one: the merge that multiplies.** The data folder syncs between machines
as an ordinary git repo, and its `.gitattributes` says the thing that looks
obviously right for append-only logs:

```gitattributes
journal.*.jsonl       merge=union
tasks.*.events.jsonl  merge=union
```

Union merge takes both sides of a conflicting hunk and keeps them, in order,
instead of stopping to ask. For two machines appending different lines that is
exactly right, and it is the reason this mesh has never once produced a sync
conflict. What union does *not* do is deduplicate. When a line is present on
both sides of the merge it is kept twice — and the next merge sees the doubled
file as one side of the next union. Pulling in both directions for a few weeks
compounds that geometrically. One `tasks.planck.events.jsonl` holds 5,359
events, of which 519 are distinct. Individual journal lines appear up to 33
times.

Nothing caught it, because from every available angle it looks like success.
Git reports a clean merge. The files are still valid JSONL. Every line in them
is a line somebody really did write. Even the append-only rule was never
broken: the log only ever grew, which is precisely what it was promised to do.

**Stage two: the fold that mints.** Task state is rebuilt by folding every event
log into a cache. A replayed `add` is supposed to land back on the task it
already created — idempotent folding is the entire promise of event sourcing.
But the fold's collision guard, which exists because two offline nodes can mint
the same id (scar #1), compared against the *raw* id instead of the remapped
one. Once a key had been relocated, every later replay of that key mismatched
again and minted yet another task, each repeat moving the target so the next
one mismatched too. A single duplicated line multiplied without limit, and
every copy looked like honest work in every count the hub produces.

The quiet half was worse than the noisy one. Eleven tasks ended up sharing a
single origin, and updates key on that origin — so closing "the" task reached
exactly one of the eleven and the other ten stayed open, unreachable by any id
anyone had. That had been silently costing real work for weeks: tasks I had
closed, and reported as closed, were not closed.

The repair is three lines — a key that already has a home keeps it, and a
replayed add overwrites its own task. On the live hub 1,507 tasks fold to 427,
977 open become 153, and the 104 groups sharing an origin become zero.
**Nothing was deleted and no log was rewritten.** The events had been right the
entire time; only the view built from them was wrong. That is the strongest
argument for append-only I have from this whole project — the bug was weeks
old, had touched every number on every dashboard, and was still completely
reversible, because the mistake had never been written down as truth.

Two things worth admitting about how it was found. First, I got there after two
confident wrong guesses — a stale cache, then a cross-node id collision — both
of which the data flatly refused; instrumenting the fold answered it in one
run. Second, stage one was still open when this section was first drafted, and
writing the Numbers section below is what closed it. Deduplication had three
candidate homes and only one of them doesn't fight the design: shrinking a log
on disk would trip the append-only guard in the sync script on every *other*
node, and a custom git merge driver lives in per-clone config, which is exactly
the rot of scar #6. So it went in the **reader**. Byte-identical lines are
indistinguishable to every reader by construction, which makes keeping the
first lossless in the only sense available — and the cost gets stated instead
of buried: two genuinely separate events that serialize identically now count
once. Scoping it per node rather than globally matters, too. A journal entry
carries no node field, so the file name is the only place that distinction
lives, and a global `sort -u` would have silently merged three events that two
different machines really did both write.

The files still carry the duplicates, and that part is deliberate. A reader that
quietly served the corrected number over a directory growing at fourteen times
its real size would be this whole post's failure mode one level down — so
`hub doctor` now prints both figures, names every inflated log, and says what
causes it. Every count in the Numbers section below is a distinct-line count.

### 8. The node that left the mesh

An hour after publishing the release that made versions observable, I used it.
`hub doctor` on the laptop said what I expected about versions — and then, from
a check added in the same release, said something I did not expect at all: this
hub was **228 commits behind** the mesh.

Not hours behind. Two hundred and twenty-eight commits of every other machine's
work that this one had never received. Its sync ran on a 60-second timer:
commit, pull, push. The pull had been failing every single time. The job logged
a line, exited non-zero, and a minute later was restarted to fail identically.
Nobody reads a log that says the same thing 20,000 times.

And nothing else could have told me. `hub status`, `hub brief`, `hub doctor` all
read the local hub and found it healthy — which it was. It was a perfectly
healthy copy of a hub that had stopped being part of the mesh. A retrying sync
loop is indistinguishable from a working one unless something counts the
commits.

The cause was a pair of file names. Queue files used to be named from the raw
hostname, `Planck`, while journals went through the node variable, which
lowercases: `planck`. Unifying them was correct, and the safety argument was
right — readers match `<role>.<anything>.queue.md`, so no message written under
the old name is stranded. I checked that carefully at the time. What I did not
check was what two spellings of one node would mean, three machines away, to a
filesystem that does not distinguish them.

On macOS the pair is one file for two index entries. Git maps the file on disk
to one of them; the other can never be satisfied by anything. `git add -A`
stages nothing. `git commit` reports an empty commit. And any merge that has to
write the unsatisfiable path refuses — so the sync's advice, printed 20,000
times, was not merely unhelpful. It was impossible: *resolve by hand* a conflict
that does not exist, in a state that no commit can leave.

That message was wrong in a familiar way. It read `(real content conflict)`
unconditionally, for every kind of pull failure. It had already been wrong once
before, for a node with no git identity configured, and the fix then had gone
into the code while the sentence was left saying the same wrong thing. The
comment explaining that earlier scar sits three lines above the hardcoded
diagnosis it should have corrected.

So: the sync now distinguishes a refusal from a conflict and has its own exit
code for it, git's own words get printed instead of swallowed, and `hub doctor`
counts the divergence and names every colliding pair — including pairs that
exist only in the remote's tree, which is the case that actually blocks you,
because the node that cannot pull is the node that does not have the second
name yet.

Six pairs had accumulated. All six are on the far side of the mesh, and
resolving them means choosing what happens to old queue messages, which is not
a decision code gets to make for you. But the day one machine goes silent, the
count says so in one line.

## What survived unchanged

Not everything got rewritten. A few early choices took the full twelve weeks
without a scratch:

- **Rules as refusals.** The protocol mostly says what *not* to do (don't
  write to the cache, don't sign as a model name, don't smoke-test a live
  queue). Refusals compose; prescriptions conflict.
- **The session-start ritual.** Constitution → git log → journal → your own
  queue. Every agent, every session, same four reads. It has survived every
  model swap because it's four file reads, not a capability.
- **The spec file as the unit of work.** Assignment, report, and acceptance
  live in one file, appended in place. The negotiation *is* the artifact.
- **The read-only kanban.** The dashboard renders the folder as a board with
  exactly one button, which opens the rules file. Cards move because agents
  move them ([a recording](https://raw.githubusercontent.com/bzdOS/hubd/main/docs/media/kanban.gif)
  — a throwaway hub, edited mid-capture, no animation faked). Nobody has asked
  for a second button.
- **Append-only everything, git as the only database.** Every failure above
  was recoverable *because* the history was all there, in formats `grep`
  understands. Scar #7 is the load test of that claim: a bug that had corrupted
  every number in the system for weeks was undone by editing three lines and
  re-reading files nobody had touched.

## What this doesn't do

Honest limits, before the comments section finds them:

- **Flat markdown has a ceiling.** At tens of cards it's instant; at hundreds
  it will need indexing that doesn't exist yet. The search tool greps.
- **Data sync is manual git.** The mesh moves when someone runs it. That's a
  choice (no third party in the loop) but also a chore.
- **This is not an orchestrator.** Nobody launches anybody; agents are
  sessions someone opens, and the human stays in the decision loop — that's
  the design, but if you want autonomous swarms, this is not that.
- **Bus factor: one.** One human designed it, runs it, and wrote this post.
- **The numbers below are self-reported texture, not a benchmark.** No
  control group, no blinded evaluation, one team.

## Numbers

Twelve weeks of data, one team, three nodes. Every count below is **distinct
lines**, for the reason described in scar #7:

- **1,919 journal entries** and **919 task events**. Count raw lines instead and
  the very same files hand you 27,464 and 5,766. Both numbers come out of one
  directory and only one of them is real; the other is a sync artifact. I found
  that out while fact-checking this section, which is how scar #7 got written.
- **354 queue messages across 63 queue files** — a good share of them throwaway
  test roles (see scar #3).
- **15 role onboarding docs**; hiring remains "paste one into a fresh session."
- The engine: 6,226 lines across six files, zero runtime dependencies,
  450 tests in four suites, plus a cleanliness gate that refuses to publish
  private names.
- The workload: twelve original public repos in the
  [bzdOS org](https://github.com/bzdOS), from an OCI jail runtime to a Wayland
  streaming stack.

For the zoomed-in version — one evening of this, hour by hour, including the
part where the tooling broke and the protocol degraded to writing the journal
by hand — see [a day in the journal](case-study.md).

## The takeaway

Twelve weeks in, the files have survived every idea I had about how agents
should talk. Every mechanism that assumed shared mutable state died on
contact with two offline machines; everything append-only, single-writer,
and explicit about identity is still standing. That's not a novel result —
it's distributed systems folklore — but it's striking how exactly it
reproduces at the scale of one human, a few chat sessions, and a folder of
markdown.

The part I didn't expect is the other one. The dangerous failure in a tool built
for agents isn't the one that stops the work — it's the one that lets the work
continue on a wrong number. Agents are unusually good at routing around errors
and unusually bad at doubting answers, and a coordination tool is nothing but
answers. Two of the seven scars above are exactly that, and the newest one spent
weeks making all of my own dashboards agree with each other.

Which is the actual argument for the boring stack, and it isn't an aesthetic
one. Plain append-only files in git prevented none of the bugs in this post.
What they did was make every one of them **reversible**. The fold that invented
a thousand tasks was undone by a three-line change and a re-read of data that
had been correct the entire time. Had the cache been the truth, that would have
been an outage with an apology attached instead of a patch release.

If you want to poke at the thing itself: [hubd on GitHub](https://github.com/bzdOS/hubd),
`npm i -g @bzdos/hubd`, and the [company-in-a-folder template](https://github.com/bzdOS/hubd/tree/main/hubd-company)
this team actually runs on.
