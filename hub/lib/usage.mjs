/* usage.mjs — what the work cost: `hub usage`, hub_usage and hub_usage_add. */
import fs from 'node:fs';
import path from 'node:path';
import {
  canonProject, HUB, JOURNAL_NODE, journalSince, loadTasks, now, parseTs, requireAuthor, shareMode,
} from './core.mjs';

/* ── Usage: how long, how many tokens, how much ──
 * The hub knows WHO did WHAT. It does not know what that cost, and the PMF question for a solo
 * operator running a fleet is "what does each project cost me per week". So this exists — with one
 * hard line through the middle of it:
 *
 *   MEASURED is what the hub can observe in its own logs: a task's open-to-close span, and events
 *   per project. It is derived, never stored, and cannot be wrong about itself.
 *
 *   SUPPLIED is seconds, tokens and money — none of which the hub can see. Only the client knows
 *   them, so they arrive by explicit call and are labelled as reported, not observed.
 *
 * The split is the feature. A cost number that quietly mixes a measured span with a guessed rate
 * is worse than no number, because it will be quoted later as if someone had counted. Per-host
 * append-only (usage.<node>.jsonl), same shape as the journal and the task log, so several
 * machines can report into one hub without conflicting — and it IS mesh-synced, because
 * "what did the fleet cost" is a fleet-wide question. */
export function usageFile() { return path.join(HUB, `usage.${JOURNAL_NODE}.jsonl`); }
export function usageFiles() {
  try { return fs.readdirSync(HUB).filter(f => /^usage\..+\.jsonl$/.test(f)).sort().map(f => path.join(HUB, f)); }
  catch { return []; }
}

// An ABSENT value must stay absent: Number(null) is 0, and a 0 that means "not reported" is the
// exact lie this log exists to avoid — an empty entry would have recorded a $0 session.
// `true` appears because the CLI's flag parser returns it for a bare flag with no value.
const num = (v) => {
  if (v === null || v === undefined || v === '' || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function runUsageAdd(a = {}) {
  const agent = requireAuthor(a.agent ?? a.by, 'agent');
  const rec = {
    ts: now(), node: JOURNAL_NODE, agent,
    project: a.project ? canonProject(a.project) : null,
    task: (a.task ?? null) === null ? null : String(a.task),
    seconds: num(a.seconds), tokensIn: num(a.tokensIn), tokensOut: num(a.tokensOut),
    costUsd: num(a.costUsd), model: a.model ? String(a.model) : null,
  };
  if (rec.seconds === null && rec.tokensIn === null && rec.tokensOut === null && rec.costUsd === null) {
    throw new Error('nothing to record: pass at least one of seconds, tokensIn, tokensOut, costUsd — this log holds what only YOU can see, so an empty entry says nothing');
  }
  fs.appendFileSync(usageFile(), JSON.stringify(rec) + '\n');
  shareMode(usageFile());
  return { ok: true, recorded: rec };
}

export function runUsage(a = {}) {
  const days = a.days ?? 7;
  const cutoff = Date.now() - days * 86400000;
  const proj = a.project ? canonProject(a.project) : null;

  const supplied = { calls: 0, seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byProject: {}, byAgent: {}, models: {} };
  for (const f of usageFiles()) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (!e.ts || parseTs(e.ts).getTime() < cutoff) continue;
        if (proj && e.project !== proj) continue;
        if (a.agent && e.agent !== a.agent) continue;
        supplied.calls++;
        for (const k of ['seconds', 'tokensIn', 'tokensOut', 'costUsd']) supplied[k] += Number(e[k]) || 0;
        const pk = e.project || 'unassigned', ak = e.agent || 'unknown';
        supplied.byProject[pk] = supplied.byProject[pk] || { seconds: 0, tokens: 0, costUsd: 0 };
        supplied.byProject[pk].seconds += Number(e.seconds) || 0;
        supplied.byProject[pk].tokens += (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
        supplied.byProject[pk].costUsd += Number(e.costUsd) || 0;
        supplied.byAgent[ak] = supplied.byAgent[ak] || { seconds: 0, tokens: 0, costUsd: 0 };
        supplied.byAgent[ak].seconds += Number(e.seconds) || 0;
        supplied.byAgent[ak].tokens += (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
        supplied.byAgent[ak].costUsd += Number(e.costUsd) || 0;
        if (e.model) supplied.models[e.model] = (supplied.models[e.model] || 0) + 1;
      }
    } catch {}
  }
  supplied.costUsd = Math.round(supplied.costUsd * 100) / 100;

  // Measured: the hub's own arithmetic over its own logs. A closed task's span is real; nothing
  // here is inferred from a rate card.
  const closed = loadTasks().tasks.filter(t => t.status === 'done' && t.done && t.created &&
    parseTs(t.done).getTime() >= cutoff && (!proj || t.project === proj));
  const spans = closed.map(t => (parseTs(t.done).getTime() - parseTs(t.created).getTime()) / 86400000)
    .filter(d => d >= 0).sort((x, y) => x - y);
  const median = spans.length ? Math.round(spans[Math.floor(spans.length / 2)] * 10) / 10 : null;
  const events = {};
  for (const e of journalSince(days * 24)) {
    if (!e.project || (proj && e.project !== proj)) continue;
    events[e.project] = (events[e.project] || 0) + 1;
  }

  return {
    windowDays: days, project: proj,
    supplied,
    measured: { tasksClosed: closed.length, medianDaysToClose: median, journalEventsByProject: events },
    note: supplied.calls
      ? 'seconds/tokens/cost here are SUPPLIED by callers (hub_usage_add); what a session spent is READ by hub stats, apart. tasksClosed and journal events are MEASURED from its own logs.'
      : 'nothing supplied in this window: what the hub can neither measure nor read arrives through hub_usage_add (a session\'s tokens are read by hub stats). The measured half below is the hub\'s own arithmetic.',
    generated: now(),
  };
}
