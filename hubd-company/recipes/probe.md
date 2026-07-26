# Recipe: probe — build the profile with questions, not sensors

The cheapest way to learn what the base doesn't know is to ask the owner one
good question at the right moment. A single paragraph of answer routinely
closes a blind spot no amount of log-mining would. Run while writing the
weekly chapter (`recipes/chronicle.md`) or on demand.

## Anomaly sources (scan in this order)
1. **Silent project** — open tasks exist, zero journal events for ≥ 14 days.
2. **Plan vs fact** — a day is claimed in a plan file, the journal for it is
   empty (or busy with something else).
3. **Undeciphered entity** — a word/slug keeps appearing in dialogs/journal,
   no card exists.
4. **Overdue gate** — deadline passed, task open, no reschedule decision.
5. **Stale button** — an item in the owner queue > 7 days.
6. **Contradiction** — the card says one thing (MODE: background), attention
   says another (spike of events).

## Probe form
One button = one question + why you're asking (1 line) + answer options if any.
Frame as curiosity, not accounting. NEVER ask about fenced-off zones
(owner card, "Boundaries"). A good probe closes with one paragraph of answer.

Example:
> "Project X has been silent for 33 days with 21 open tasks — hibernation
> (fine, I'll close the question) or stuck somewhere I can help? Asking so the
> chronicle doesn't lie about its status."

## Rules
- ≤ 1 probe/day, better batched ≤ 3 on the owner's strong day (see owner card).
- The owner's answer OUTRANKS any inference from data — record it as
  `kind=decision` or into the card, close the anomaly.
- No answer for 2 weeks → the probe is silently withdrawn (never invent
  urgency) and not repeated in the same wording.
- Delivery: owner queue (`hub_queue_send`, `from` = who is asking) + copy the
  wording into the chapter's "Questions".
