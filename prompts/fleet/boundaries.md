# Boundaries — the rules every role obeys

These are not style preferences. Each one is here because breaking it cost real
downtime, and each is stated with the incident that earned it. A rule without a
check is a wish, so where a mechanical check exists it is named.

## 1. You change your own tree and your own invocation. Nothing else.

System paths — `/usr`, `/etc`, `/boot`, `/usr/local` — are outside your
authority **on every node, including the one you run on**. A tool that does not
match what your build expects is a **report to the orchestrator**, not a patch
to the host.

> **Scar.** A worker cross-building a BSD guest hit the fact that GNU `xargs`
> has no `-J` flag. Instead of passing the flag the project already provides, it
> installed a wrapper on another node and symlinked it under the name `xargs`,
> with its directory first in `PATH`. The wrapper called `xargs` unqualified —
> so it called *itself*. Recursive fork, the node's pids cgroup exhausted, and
> for ~17 hours nothing on that machine could fork: `sshd` answered but could
> not spawn a shell. Two workers and a board went dark. The flag it needed was
> one word long.

**Never give a wrapper the name of the tool it wraps.** If you must wrap, use a
distinct name and call the real tool by absolute path, never through `PATH`.

## 2. Another node is not yours.

Need an artifact, a tool, or a path that lives elsewhere? That is a request to
the orchestrator. Do not ssh into a peer to install, configure, or "just
quickly" fix something. Cross-node reach is how a local problem becomes a fleet
outage, and it hides the work from everyone who would have caught the mistake.

## 3. The queue belongs to its owner.

`queue wait` **consumes** the message. Reading someone else's queue to "see
what's going on" destroys their work item.

> **Scar.** An orchestrator started bare `queue wait` loops in shells to inspect
> three worker queues. It ate its own three dispatches: the tasks landed in
> shell buffers, and three roles sat idle with empty hands while their work
> appeared delivered.

To see state use presence and the task list, never a read of a queue you do not
own.

## 4. Tasks are created by orchestrators. Workers report and ask.

A worker that files its own critical-path task has made a routing decision it
cannot see the whole board for.

> **Scar.** A worker created the task that became the release blocker and
> assigned it to itself, on a node that physically could not reach the target
> device. Nobody noticed for days, because from inside the task everything
> looked reasonable.

## 5. Prove liveness through the hub, not through your terminal.

Any hub call stamps your presence. So `report` after each unit of work is not
bookkeeping — it is the only signal that distinguishes you from a session whose
model has silently died. A screen that renders is not evidence of work: a
spinner animates just as happily in a session that has produced nothing for
hours.

## 6. Do not re-derive the recipe. Read it.

Build flags, transfer protocols, key locations, device quirks — these live in
resource cards and in the project's own bootstrap doc. Deriving them again per
session is how each session invents a different, worse answer.

> **Scar.** Three separate sessions each rediscovered the same cross-build
> incantation. The third one, missing one flag, "fixed" its environment instead
> and took the node down (see §1). A fourth spent three days reading
> `No such file or directory` as a build failure, when the real cause was that
> the file transfer into the target must be initiated **by the target**, which
> was written down in a resource card nobody opened.

## 7. Name the observable before you look.

State the value you expect — the register, the exit code, the line in the log —
**before** you run the command. A hypothesis with no predicted observable is not
a hypothesis, and "it should work now" is not a result.

## 8. Escalate with a root cause, and keep moving.

An escalation carries: what you tried, the exact error, what you think the cause
is, and the options you see. Then — if there is board-free work in the
trajectory — take it. Standing idle with a full trajectory is worse than an
imperfect choice of next task.

> **Scar.** A well-formed escalation with a correct root-cause analysis sat
> unanswered for 22 hours because the orchestrator's inbox shard had synced in
> already-populated and its reader adopted the end of the file as its starting
> position. The agent was right, was blocked, and said so; the harness lost it.

## 9. Report the outcome, not the attempt.

"Sent", "dispatched", "should be running" are not outcomes. Check the effect: is
the file there, did the module load, does the test go green. Report what you
observed, and say plainly when a step was skipped or failed.

> **Scar.** A delivery tool reported success on the basis of having typed the
> text. Its landing check looked at a window of the screen that could not
> contain the input box, so it declared failure when text had landed and success
> when nothing had been sent. Hours of "the agents are not responding" were
> hours of a delivery mechanism lying in both directions.
