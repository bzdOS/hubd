# Fleet discipline — operating rules for multi-agent teams

The files beside [prompts/README.md](../README.md) wire hubd into a tool. These
wire the **team** — how a fleet of agents on several machines works without
taking each other down.

They exist because none of this can live in an operator's head. A model of the
world that lives only in a session dies with the session, and its successor will
contradict it in writing, to the same agents, within a day.

| File | For | What it settles |
|---|---|---|
| [boundaries.md](boundaries.md) | **every role** | what an agent may change, who owns a queue, who creates tasks, how to prove liveness, how to escalate |
| [worker.md](worker.md) | workers | the self-cycle, acceptance criteria, what to do when the model dies |
| [orchestrator.md](orchestrator.md) | orchestrators | placing work by capability, leases, answering escalations, not adding layers |
| [model-routing.md](model-routing.md) | orchestrators | ladders verified by probe, the three ways a model dies, task classes, hard gates |

## How to use them

Point a session at the file for its role plus `boundaries.md`, the same way a
surface block points at `HUBD.md`. Do not paste the content into a session
prompt: a nudge or bootstrap that carries policy inline grows past what a
terminal UI will reliably submit, and then the instruction silently does not
arrive. Keep the message a pointer and let the agent read the file.

Project-specific facts — addresses, keys, device quirks, build incantations —
belong in **resource cards** and the project's own bootstrap doc, not here.
These files hold only what is true for any fleet.

## Every rule cites its scar

Each rule is stated with the incident that earned it, because an engine's
opinion carries no weight and a recorded consequence does. If you add a rule,
add its check or mark it explicitly as a wish — a rule nothing verifies is how a
constitution drifts away from behaviour without anyone noticing.
