/* summary.mjs — where every track stands, as a script states it: one state of the hub, one answer.
 *
 * Asked "where is each track", a coordinator reads the board and retells it, and two retellings of
 * one state differ in what they cut, what they leave out and which line they take for the verdict.
 * The owner asked for the answer to be assembled by a script instead. So everything here is a
 * function of the hub's files and of the moment asked, and the moment shows only as ages:
 *   - every list is ordered by its own fields (created, closed, id), never by urgency, which moves
 *     with the date;
 *   - text is whole: a verdict or a blocked entry is the entry as the journal holds it;
 *   - with `now` fixed, two calls on one hub return the same bytes.
 *
 * Per track (a head's project, as on the board — see trackLayout):
 *   goal     the card's Goal section; for a card without one, the first line of its Digest;
 *   working  open tasks with an assignee and no open dependency;
 *   blocked  open tasks that wait on an open dependency;
 *   closed   tasks closed in the last 24 hours, the window of the Live column "Done today";
 *   stalled  each role's newest `blocked` journal entry, unless the role handed the work in after it.
 * A task's age counts from its creation, a closed task's from its close. Each task carries its
 * head's newest verdict on it.
 *
 * A VERDICT is a journal entry by one of the track's heads that names the task and holds a verdict
 * word: ACCEPT, ACCEPTED, REJECT, REJECTED, and the words a hub adds for the language its heads
 * write in, in <hub>/verdicts.json: {"accept": [...], "reject": [...]}. A word matches whole and in
 * its case: a verdict is written in capitals, and "accept" in a sentence is not one. What the entry
 * says about the task is the verdict word nearest its name on the side the entry writes verdicts:
 * an entry whose first verdict word comes before its first task name puts each verdict before what
 * it judges ("ACCEPT <sha> <branch>: closes #12", "ACCEPT #12, REJECT #13"), so the task takes the
 * nearest word before its name; one that names a task first ("#12 ACCEPT, #13 REJECT") takes the
 * nearest after it. With no word on that side, the nearest on the other. At one position the longer
 * word wins, so a negated form a hub lists under reject is not read as the word inside it.
 *
 * A task is NAMED by "#<id>", and an id with a letter in it also bare ("fir-12"): a bare number in
 * prose is a count far more often than a task. A blocked entry's task is the first task it names.
 * The entry stands until a later `done` entry by the same role names that task, or the task is
 * closed after it; an entry that names no task stands until the role's next `done` entry.
 *
 * Beside the tracks, the ESCALATIONS to the fleet (escalations.mjs): every one not yet answered,
 * however old, and those answered in the last 24 hours with their answers, both oldest first and
 * whole. An escalation is answered when an entry of the fleet card's Owner decisions quotes its
 * "<date> · from <role> · id N"; nothing else is taken for an answer.
 */
import path from 'node:path';
import {
  HUB, parseTs, escRe, readJson, loadTasks, readCard, digestOf, sectionBody, liveHeading, hasHeading, isPlaceholder,
  journalSinceMs, roleRegistry, eligibleOpen, taskTitle,
} from './core.mjs';
import { trackLayout } from './board.mjs';
import { escalationState, ANSWERED_HOURS } from './escalations.mjs';

const JOURNAL_DAYS = 30;   // how far back verdicts and blocked entries are read, as on the board
const CLOSED_HOURS = 24;
const DEFAULT_WORDS = { accept: ['ACCEPT', 'ACCEPTED'], reject: ['REJECT', 'REJECTED'] };

/** Every verdict word and what it says, 'accept' or 'reject': the defaults, then <hub>/verdicts.json. */
export function verdictWords() {
  const o = readJson(path.join(HUB, 'verdicts.json'), {}) || {};
  const words = new Map();
  for (const v of ['accept', 'reject']) {
    for (const w of [...DEFAULT_WORDS[v], ...(Array.isArray(o[v]) ? o[v] : [])]) {
      const k = typeof w === 'string' ? w.trim() : '';
      if (k && !words.has(k)) words.set(k, v);
    }
  }
  return words;
}

const hasLetter = (id) => /\D/.test(String(id));
/** The pattern that finds task `id` named in a text (see the header). */
export function namesTask(id) {
  return new RegExp('(?<![\\p{L}\\p{N}_#-])' + (hasLetter(id) ? '#?' : '#') + escRe(String(id)) + '(?![\\p{L}\\p{N}_-])', 'u');
}
const CANDIDATE = /(?<![\p{L}\p{N}_#-])(#?)([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;
/** The first task a text names, and where: { id, index } or null. */
function firstTaskNamed(text, byId) {
  for (const m of String(text || '').matchAll(CANDIDATE)) if (byId.has(m[2]) && (m[1] || hasLetter(m[2]))) return { id: m[2], index: m.index };
  return null;
}

const head = (nowMs) => ({ v: 1, asOf: new Date(nowMs).toISOString().slice(0, 16).replace('T', ' '),
  journalDays: JOURNAL_DAYS, closedHours: CLOSED_HOURS, answeredHours: ANSWERED_HOURS });
/** The answer for a hub with nothing in it (a tenant that has not written yet). */
export function emptySummary(nowMs = Date.now()) { return { ...head(nowMs), tracks: [], escalations: { fleet: [], waiting: [], answered: [] } }; }

export function runSummary(a = {}) {
  const nowMs = Number.isFinite(a.now) ? a.now : Date.now();
  const ageMin = (ts) => { const ms = ts ? parseTs(ts).getTime() : NaN; return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / 60000)) : null; };
  const ms = (ts) => parseTs(ts).getTime();

  const words = verdictWords();
  const wordList = [...words.keys()].sort((x, y) => y.length - x.length || (x < y ? -1 : 1));
  const wordSrc = '(?<![\\p{L}\\p{N}_])(?:' + wordList.map(escRe).join('|') + ')(?![\\p{L}\\p{N}_])';
  const anyWord = new RegExp(wordSrc, 'u');
  const wordRe = new RegExp(wordSrc, 'gu');
  // what an entry says about the task named at [at, end) (see the header)
  const verdictAt = (text, at, end) => {
    const ws = [...text.matchAll(wordRe)].map(m => ({ index: m.index, end: m.index + m[0].length, word: m[0] }));
    const before = ws.filter(w => w.end <= at).pop(), after = ws.find(w => w.index >= end);
    const first = firstTaskNamed(text, byId);
    const verdictFirst = ws.length && first && ws[0].index < first.index;
    const w = verdictFirst ? before || after : after || before;
    return w ? words.get(w.word) : null;
  };

  const roles = roleRegistry();
  const tasks = loadTasks().tasks;
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  const { list: ready, blocked } = eligibleOpen(tasks);
  const journal = journalSinceMs(nowMs - JOURNAL_DAYS * 86400000);   // newest first
  const closedSince = nowMs - CLOSED_HOURS * 3600000;
  const oldestFirst = (x, y) => (String(x.created || '') < String(y.created || '') ? -1 : String(x.created || '') > String(y.created || '') ? 1 : String(x.id) < String(y.id) ? -1 : 1);

  // sorted here, not in registry order: that is a directory listing, and its order is the filesystem's
  const layout = trackLayout({ roles, tasks, project: a.project }).sort((x, y) => (x.project < y.project ? -1 : 1));
  const tracks = layout.map(({ project, heads: hs, workers, set }) => {
    const heads = [...hs].sort((x, y) => (x.role < y.role ? -1 : 1));
    const card = readCard(project);
    const headNames = new Set(heads.map(h => h.role));
    const said = journal.filter(e => headNames.has(e.agent) && anyWord.test(String(e.text || '')));
    const verdictOn = (id) => {
      const re = namesTask(id);
      for (const e of said) {
        const text = String(e.text);
        const m = re.exec(text);
        if (m) return { ts: e.ts, agent: e.agent, verdict: verdictAt(text, m.index, m.index + m[0].length), text };
      }
      return null;
    };
    const open = (t) => ({ id: t.id, title: taskTitle(t.text), assignee: t.assignee || null, created: t.created || null,
      ageMin: ageMin(t.created), verdict: verdictOn(t.id) });

    const working = ready.filter(t => set.has(t.project) && t.assignee).sort(oldestFirst).map(open);
    const stuck = blocked.filter(t => set.has(t.project)).sort(oldestFirst).map(t => ({
      ...open(t),
      waitingOn: (t.depends_on || []).map(String).filter(d => byId.get(d) && byId.get(d).status === 'open'),
    }));
    const closed = tasks.filter(t => t.status === 'done' && set.has(t.project) && t.done && ms(t.done) >= closedSince)
      .sort((x, y) => (x.done > y.done ? -1 : x.done < y.done ? 1 : String(x.id) < String(y.id) ? -1 : 1))
      .map(t => ({ id: t.id, title: taskTitle(t.text), assignee: t.assignee || null, closed: t.done, ageMin: ageMin(t.done), verdict: verdictOn(t.id) }));

    const stalled = [];
    for (const r of [...heads, ...workers]) {
      const i = journal.findIndex(e => e.agent === r.role && e.kind === 'blocked');
      if (i < 0) continue;
      const b = journal[i];
      const task = (firstTaskNamed(b.text, byId) || {}).id || null;
      const re = task ? namesTask(task) : null;
      const handedIn = journal.slice(0, i).some(e => e.agent === r.role && e.kind === 'done' && (!re || re.test(String(e.text || ''))));
      const t = task ? byId.get(task) : null;
      const closedAfter = !!(t && t.status === 'done' && t.done && ms(t.done) > ms(b.ts));
      if (!handedIn && !closedAfter) stalled.push({ role: r.role, ts: b.ts, ageMin: ageMin(b.ts), task, text: String(b.text || '') });
    }

    let goal = null;
    if (card) {
      const h = liveHeading(card, 'goal');
      const body = hasHeading(card, h) ? sectionBody(card, h) : null;
      const first = String(digestOf(card) || '').split('\n').map(x => x.trim()).find(Boolean);
      if (!isPlaceholder(body)) goal = { text: body, from: 'goal' };
      else if (first && !isPlaceholder(first)) goal = { text: first, from: 'digest' };
    }
    return {
      project, heads: heads.map(h => h.role), roles: workers.map(w => w.role), goal,
      working, blocked: stuck, closed, stalled,
    };
  });
  return { ...head(nowMs), tracks, escalations: escalationState({ roles, root: a.queueRoot, nowMs }) };
}
