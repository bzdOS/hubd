# Model routing — pick by task, verify by probe

For orchestrators choosing which model runs a task, and for anyone maintaining
the ladders. Companion to [boundaries.md](boundaries.md) and
[orchestrator.md](orchestrator.md).

## Availability is a measurement, not a list

Never encode "model X works" as knowledge. It depends on the **node** (some
tiers are geo-locked and answer only through an egress in another region), on
the hour (free quotas exhaust daily), and on the provider's mood.

So a model slot is a **ladder** — an ordered list of candidates — and the
spawner **probes each rung with a real one-shot request**, taking the first that
answers, trying direct first and a proxied egress second.

> **Scar.** A measurement across two nodes on one afternoon: one tier answered
> directly on both; one answered only through a proxy on both and refused
> directly with "not available in your country"; one answered directly on one
> node and returned `Forbidden` on the other; two more refused everywhere. Any
> hardcoded list would have been wrong for at least half the fleet.

## Three ways a model dies, and only one is loud

1. **Explicit refusal** — `Forbidden`, `not available in your country`, `403`,
   quota exhausted, `subscribe to …`. Detectable in the session text. Note that
   some clients prettify these and strip the HTTP status, so match the wording,
   not the code.
2. **Transient** — `503`, `429`, rate-limited. Retry the same model; do not
   restart the session.
3. **Silence** — no answer, no error, until the timeout. Undetectable from the
   text, and the client keeps showing its busy indicator, so from the outside
   the session looks like it is working.

> **Scar.** Two orchestrators and a worker sat on a tier that answered nothing
> at all — a probe waited the full 300 seconds for a one-word reply and got
> neither answer nor error. Its retry banner counted down once a second, so the
> frame changed constantly and the monitor read all three as *working*. The
> fleet's two heads were dead and looked healthy.

**Consequence:** liveness at the model level can only be established by asking
and getting something back. Probe before you place work, and treat "busy
indicator plus no output and no hub call" as a stall, not as work.

## Classify the task before choosing

Five axes, scored 0–2, all knowable before the run:

| Axis | 0 | 1 | 2 |
|---|---|---|---|
| Search space | files named | one module | search the repo |
| Judgement points | none | a few local | many / design |
| Domain knowledge outside context | none | mainstream framework | niche (hypervisor levels, PHY registers) |
| Horizon (expected tool calls) | <10 | 10–50 | >50 / multi-session |
| Feedback latency | seconds | minutes | human or device in the loop |

Sum → tier: **0–2** cheap executor · **3–5** strong free · **6–7** mid paid ·
**8–10** flagship, then a human.

**The cheapest lever is domain knowledge** — the only axis retrieval lowers. Put
the spec in the context and the task drops a tier.

## Task classes and what actually fits

| Class | Route | Verification |
|---|---|---|
| **(a) mechanical, by a plan** (mass renames, cherry-picks, flag flips) | **not an LLM first**: have a strong model write a script plus an audit sample; run the script; send only the remainder to a cheap model | `grep -c`, `diff --stat`, the build. A thousand LLM calls for what `sed` does is wasted quota |
| **(b) bug fix** | two-phase: cheap scout reproduces and localises → fixer applies. Do not put a weak-at-code model on the fix itself | failing test before, green after. The scout's claim of a repro must be **reproduced** before handoff |
| **(c) QA on a real device** | cheap executor; a vision-capable model when screenshots matter. **The verdict is not the executor's job** | artefacts mandatory (screenshot, log). Verdict from a deterministic check or a stronger model |
| **(d) low-level debugging** | flagship. Exception: pure forensics (dump against spec) suits a long-context model | the agent must name the expected register/trace value **before** looking |
| **(e) design / architecture** | flagship, never a free tier | owner review plus a cheap adversarial pass (a classification-strong model listing claims that cite no file) |
| **(f) coordination** | strongest available; measure by owner interruptions and mis-routes | share of tasks needing a re-ask |
| **(g) extraction from logs / transcripts** | a classification-strong, fast model; long context if the input is huge | schema validation plus spot-checks; demand **line numbers** so checking is mechanical |

## Hard gates — they beat any score

| Gate | Rule |
|---|---|
| No machine-checkable acceptance **and** the mistake is irreversible (push, deploy, flash) | free tier forbidden |
| Vision needed (screenshot, UI diff, schematic) | only a genuinely multimodal model; text-only tiers cannot see |
| Context larger than the model's window | that rung is out, regardless of quality |
| Source under a licence that forbids third-party training | exclude tiers whose terms claim training rights |

## Split failure paths deliberately

Do not put both project heads on the same rung. One quota wall or one dead
egress should not take out every orchestrator at once. Give the second head a
different first rung, ideally on a different route.

## Watch the escalation rate

If a cascade escalates ~30% of the time or more, it is **more expensive** than
going straight to the stronger model: the cheap attempt is adding latency
instead of value. A cascade that silently escalates 90% of tasks is worse than
no routing at all.

## What is over-engineering here

- **Trained routers.** They need preference data you do not have, and published
  wins come from single-benchmark pairs that do not transfer.
- **Confidence-threshold cascades.** A terminal UI gives you no calibrated
  logprobs to threshold on.
- **LLM-as-judge as the primary verifier.** Measured disagreement with a
  deterministic verifier runs about a third of cases. Deterministic checks win
  whenever they exist.
- **Predicting difficulty from the task text.** Poorly correlated in practice;
  models cannot even predict their own token cost. If you must route
  dynamically, route on a cheap scout's **trajectory**, not on the description.
