/* board.mjs — the owner's board: every track, and what waits for the owner, on one screen.
 *
 * The question it answers is the one an owner otherwise asks a coordinator: "what is each role
 * doing, what got done this week, what is next, and what is waiting for me". Every piece of that
 * was already in the hub — presence, the journal, tasks, cards, queues — spread over five tools and
 * a registry that lived outside it. This module only joins them; it writes nothing.
 *
 * A TRACK is a project that has a head: a role card of rank `head` (see roleRegistry in core).
 * Its rows are the head and every role whose `head` link points at it. With no roles declared,
 * every project with open work is a track with no rows, so a hub that never declared roles still
 * gets its done / next / blocked lists.
 *
 * Kept out of core.mjs because it needs the queue module, which imports core.
 */
import {
  now, parseTs, slugify, escRe, loadTasks, loadClaims, activeClaims, readCard, sectionBody, projectSlugSet,
  journalSinceMs, roleRegistry, ownerRoles, runPresence, eligibleOpen, byUrgency, isOwnerTask, taskTitle, taskClaimArea, parseVerdict,
} from './core.mjs';

export { taskTitle, parseVerdict };
import { ownerQueueItems, recentBlocks } from './queue.mjs';
import { senseSnapshots } from './sense.mjs';

const firstLine = (s, n) => {
  const l = String(s || '').split('\n').map(x => x.trim()).find(Boolean) || '';
  return l.length > n ? l.slice(0, n - 1) + '…' : l;
};

export function runBoard(a = {}) {
  const nowMs = Date.now();
  const days = Math.max(1, Math.min(90, parseInt(a.days, 10) || 7));
  const limitMsgs = Math.max(1, parseInt(a.messages, 10) || 30);   // newest escalations / answers kept
  const sinceMs = nowMs - days * 86400000;
  const today3 = new Date(nowMs + 3 * 86400000).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const ageMin = (ts) => { const ms = ts ? parseTs(ts).getTime() : NaN; return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / 60000)) : null; };

  const roles = roleRegistry();
  const owners = new Set(ownerRoles());
  const tasks = loadTasks().tasks;
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  const { list: ready, blocked } = eligibleOpen(tasks);
  const readyIds = new Set(ready.map(t => String(t.id)));
  const known = (who) => !roles.size || !who || roles.has(slugify(who)) || owners.has(who);
  const isOwner = isOwnerTask(owners);

  /* A window, not the whole journal: this runs on every refresh of an open board, and a year of
   * journal read every 30 seconds to find each role's last line is the cost of the board, not of
   * the answer. A role silent for longer than the window says so ("no journal entry in N days"). */
  const journalDays = Math.max(days, 30);
  const journal = journalSinceMs(nowMs - journalDays * 86400000);   // newest first
  const lastBy = new Map();
  for (const e of journal) if (e.agent && !lastBy.has(e.agent)) lastBy.set(e.agent, e);
  const presence = new Map(runPresence({}).agents.map(p => [p.agent, p]));
  const claims = activeClaims(loadClaims().claims || []);
  const sensed = senseSnapshots();   // what each head's sensor last raised, from every node
  // a task is started while a claim on task:<id> holds (the work queue's "in progress")
  const startedIds = new Set(claims.filter(c => String(c.area || '').startsWith(taskClaimArea(''))).map(c => String(c.area).slice(taskClaimArea('').length)));

  // `text` only when the title had to cut it: a board of a hundred tasks is otherwise mostly briefs
  const taskView = (t) => ({
    id: t.id, project: t.project, title: taskTitle(t.text),
    ...(taskTitle(t.text) !== String(t.text || '').trim() ? { text: String(t.text).slice(0, 2400) } : {}), importance: t.importance || null,
    deadline: t.deadline || null, overdue: !!(t.deadline && t.deadline < today), assignee: t.assignee || null,
    assigneeKnown: known(t.assignee), assigneeOff: !!(t.assignee && (roles.get(slugify(t.assignee)) || {}).status === 'off'),
    created: t.created || null, tags: t.tags || [],
  });

  /* ── tracks ── */
  const heads = [...roles.values()].filter(r => r.rank === 'head' && r.project);
  let trackNames;
  if (a.project) trackNames = [slugify(a.project)];
  else if (heads.length && !a.all) trackNames = [...new Set(heads.map(h => h.project))];
  else {
    // no heads declared, or every track asked for: each project with open work, busiest first
    const n = new Map();
    for (const t of tasks) if (t.status === 'open' && t.project) n.set(t.project, (n.get(t.project) || 0) + 1);
    trackNames = [...n.keys()].sort((x, y) => n.get(y) - n.get(x) || (x < y ? -1 : 1));
  }

  const roleRow = (r, card) => {
    const p = presence.get(r.role);
    let state;
    if (r.status === 'off') state = { kind: 'off' };
    else if (!p) state = { kind: 'unseen' };
    else if (!p.alive) state = { kind: 'silent', minutes: ageMin(p.last_seen) };
    else if (p.state) {
      state = { kind: p.state, minutes: ageMin(p.state === 'turn' ? (p.turn_started || p.state_since) : p.state_since) };
      for (const [k, v] of [['turn', p.turn], ['empty', p.empty_count], ['silent', p.silent_count], ['reason', p.exit_reason]]) if (v != null) state[k] = v;
    } else state = { kind: 'alive', minutes: ageMin(p.last_seen) };   // no state fields: how fresh is all there is
    const last = lastBy.get(r.role);
    const handoff = card ? sectionBody(card, 'Handoff ' + r.role) : null;
    const row = {
      role: r.role, rank: r.rank, status: r.status, node: (p && p.node) || r.node || null,
      lastSeen: p ? p.last_seen : null, statusText: p ? (p.status || null) : null, state,
      task: p && p.task_id != null ? String(p.task_id) : null,
      lastStep: last ? { ts: last.ts, project: last.project || null, kind: last.kind || null, text: firstLine(last.text, 240) } : null,
      handoff: handoff ? (handoff.length > 800 ? handoff.slice(0, 800) + '…' : handoff) : null,
      tasks: tasks.filter(t => t.status === 'open' && t.assignee === r.role).sort(byUrgency(today3))
        .map(t => ({ id: t.id, title: taskTitle(t.text), ready: readyIds.has(String(t.id)), started: startedIds.has(String(t.id)) })),
      claims: claims.filter(c => c.agent === r.role).map(c => ({ project: c.project, area: c.area, since: c.since })),
    };
    row.offered = row.tasks.filter(t => t.ready && !t.started).length;   // ready and nobody started: idle if the role waits
    return row;
  };

  const tracks = trackNames.map(project => {
    const own = projectSlugSet(project);
    const card = readCard(project);
    const myHeads = heads.filter(h => own.has(h.project));
    const headNames = new Set(myHeads.map(h => h.role));
    const workers = [...roles.values()].filter(r => r.rank !== 'head' && (headNames.has(r.head) || (!r.head && r.project && own.has(r.project))));
    // A worker may file under a project of its own (a sub-repo, an older slug); its work is still
    // this track's, so the track reads every project its rows serve.
    const set = new Set(own);
    for (const w of workers) if (w.project) for (const s of projectSlugSet(w.project)) set.add(s);
    const rows = [...myHeads, ...workers.sort((x, y) => (x.role < y.role ? -1 : 1))].map(r => roleRow(r, card));

    const inWindow = journal.filter(e => set.has(e.project) && parseTs(e.ts).getTime() >= sinceMs);
    const decisions = [];
    for (const e of inWindow) {
      const v = parseVerdict(e.text);
      if (v) decisions.push({ ts: e.ts, agent: e.agent || null, ...v, text: firstLine(e.text, 240) });
    }
    /* Done in the window, each with the line that accepted it. The newest journal entry naming
     * the task, preferring, in order: a decision; an entry by the track's head; any entry that is
     * not a stamp; the stamp itself. A stamp is what the close writes on its own — the "task #N"
     * line, or a done entry that is just "#N <task text>" — and repeats the task instead of saying
     * why it was accepted. */
    const done = tasks.filter(t => t.status === 'done' && set.has(t.project) && t.done && parseTs(t.done).getTime() >= sinceMs)
      .sort((x, y) => (parseTs(y.done) - parseTs(x.done)))
      .map(t => {
        const re = new RegExp('(^|[^\\w-])#?' + escRe(t.id) + '(?![\\w-])');
        const stamp = (e) => e.kind === 'task' || /^[~=+] ?task #/.test(e.text || '') || String(e.text || '').startsWith('#' + t.id + ' ');
        const found = [null, null, null, null];
        for (const e of inWindow) {
          if (!re.test(e.text || '')) continue;
          const rank = e.kind === 'decision' ? 0 : stamp(e) ? 3 : headNames.has(e.agent) ? 1 : 2;
          if (!found[rank]) found[rank] = e;
          if (rank === 0) break;
        }
        const line = found.find(Boolean);
        const { text, ...v } = taskView(t);   // a done task is read by its title and its acceptance
        return { ...v, done: t.done, acceptance: line ? { ts: line.ts, agent: line.agent || null, kind: line.kind || null, text: firstLine(line.text, 240) } : null };
      });
    const next = ready.filter(t => set.has(t.project)).sort(byUrgency(today3)).map(t => ({ ...taskView(t), owner: isOwner(t) }));
    const stuck = blocked.filter(t => set.has(t.project)).sort(byUrgency(today3)).map(t => ({
      ...taskView(t),
      waitingOn: (t.depends_on || []).map(String).filter(d => byId.get(d) && byId.get(d).status === 'open')
        .map(d => ({ id: d, title: taskTitle(byId.get(d).text), assignee: byId.get(d).assignee || null })),
    }));
    const sense = myHeads.map(h => sensed[h.role] ? { head: h.role, ...sensed[h.role] } : null).filter(Boolean);
    return {
      project, heads: myHeads.map(h => h.role), rows, decisions, done, next, blocked: stuck, sense,
      counts: { rows: rows.length, done: done.length, next: next.length, blocked: stuck.length, decisions: decisions.length },
    };
  });

  /* ── waiting for the owner ──
   * Four sources, each named, because "why is this here" is the first thing asked of a list:
   * blocks in an owner queue this node has not consumed; open tasks that are the owner's to press;
   * tasks tagged owner-go; and, when a fleet-level coordinator is declared (a role of rank
   * `fleet`), what was escalated to it in the window and what it answered. */
  const fleet = [...roles.values()].filter(r => r.rank === 'fleet').map(r => r.role);
  const waiting = {
    queue: ownerQueueItems({ root: a.queueRoot, limit: 0, subjectChars: 160 }),
    tasks: tasks.filter(t => t.status === 'open' && isOwner(t)).sort(byUrgency(today3)).map(t => ({ ...taskView(t), ready: readyIds.has(String(t.id)) })),
    ownerGo: tasks.filter(t => t.status === 'open' && Array.isArray(t.tags) && t.tags.includes('owner-go') && !isOwner(t)).map(taskView),
    escalations: fleet.length ? recentBlocks({ root: a.queueRoot, to: fleet, sinceMs, textChars: 600 }).slice(-limitMsgs) : [],
    answers: fleet.length ? recentBlocks({ root: a.queueRoot, from: fleet, sinceMs, textChars: 600 }).filter(b => !fleet.includes(b.role)).slice(-limitMsgs) : [],
  };

  const unknownAssignees = roles.size
    ? [...new Set(tasks.filter(t => t.status === 'open' && t.assignee && !known(t.assignee) && t.owner_kind !== 'human').map(t => t.assignee))].sort()
    : [];
  return {
    days, journalDays, all: !!a.all, registry: { roles: roles.size, heads: heads.length, fleet },
    tracks, allTracks: [...new Set([...heads.map(h => h.project)])].sort(),
    waiting, unknownAssignees, generated: now(),
  };
}
