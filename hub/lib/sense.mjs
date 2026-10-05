/* sense.mjs — a head's sensor: supervision of its workers without calling a model.
 *
 * A head (a coordinating role over a few workers) used to wake on a timer and read the hub,
 * presence and the repo itself. Most of those wakes found nothing, and each one cost a full model
 * call over a context that only grew — two heads spent a night on roughly 140 empty turns without
 * one acceptance or one order. Everything that can be measured without a model is measured here;
 * the head's model is woken only by an EVENT, and its order is the list of events with the
 * measurements already taken. No events, no call.
 *
 *   hub sense <head>                          events for the next turn (exit 0: wake, 1: none, 2+: failed)
 *   hub sense <head> check <branch>           acceptance checklist for a branch
 *   hub sense <head> verdict <branch> accept|reject <text>
 *                                             the decision: into the journal + an order to the worker
 *   hub sense <head> brief                    first order of a NEW head session
 *   hub sense <head> status                   configuration and sensor state (debugging)
 *
 * What it reads, all from the hub: the role registry (the head, its workers, its repo), presence
 * with the heartbeat's structured fields, the journal, tasks, the head's queue. Branches are read
 * from the head's `repo` (git ls-remote) and checked in its `review` clone. Nothing parses a
 * loop's free-text status: a loop that sends no `state` is simply one the sensor cannot judge.
 *
 * State is node-local — one file per head under HUBD_SENSE_DIR (default <hub>/.sense/, never
 * synced) — because it describes what this node's sensor has already told its head. What the
 * sensor last raised is also published as sense.<node>.json in the hub, one small file per node
 * like presence.<node>.json, so a board on any node can show it.
 *
 * Escalations are appended, one line each (<epoch>\t<head>\t<text>), to the file a monitor reads:
 * HUBD_SENSE_ESCALATIONS when set, else escalations.log in the state directory. The default is
 * deliberately NOT a shared path: a second sensor run beside an old one (a parallel comparison)
 * must not double every escalation the monitor sees. Pointing it at the monitor's file is the
 * switch-over, and it is one variable, set per node — the path differs between operating systems,
 * so it cannot live in the mesh-synced sense.json.
 *
 * Thresholds and the patterns this code must not carry (what counts as private in a public repo,
 * which journal lines are only "still waiting") are data: <hub>/sense.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  HUB, JOURNAL_NODE, now, parseTs, slugify, loadTasks, journalSinceMs, headConf, runPresence,
  runReport, atomicWrite, withLock, parseVerdict, shareMode, readJson,
} from './core.mjs';
import { queueSend, recentBlocks, resolveQueueRoot } from './queue.mjs';
import { splitReflect } from './reflect.mjs';

export const SENSE_DEFAULTS = {
  idleMinEmpty: 3,      // consecutive empty polls (about 5 min each) before a worker reads as idle
  silentRestarts: 3,    // restarts of a model that produced nothing, in a row: stuck
  deadMin: 30,          // presence not refreshed for this long: not running
  longTurnMin: 120,     // one turn longer than this: worth a look
  repeatS: 1800,        // a standing condition is repeated to the head no more often than this
  escalateS: 3600,      // not resolved this long after the first wake: escalate to the fleet
  deadEscalateS: 1800,  // a worker that is not running is the fleet's to restart, after this long
  queueTwinS: 3600,     // a report is matched against the worker's messages to the head within this window only
  twinPrefix: 80,       // this much of a report's first line must appear in such a message to be the same report
  budgetPerH: 4,        // non-critical wakes per hour; critical ones always go
  idleWaitMin: 15,      // waiting this long (sensor clock, across loop restarts): idle
  idleCritMin: 30,      // ...and this long: critical, the budget does not hold it back
  quietJournal: [],     // regexes: a worker's journal line matching one is "still waiting", not a report
  private: [],          // regexes: text that must not appear in a branch bound for a public repo
};
/* Statuses a task is still open in. The hub itself writes open|done, but task events are data and
 * carry what their writers used (todo, in_progress...): a worker's in-progress task is still its
 * open work, and leaving it out made an idle report say "nothing open" about a busy worker. */
export const OPEN_STATUSES = new Set(['open', 'doing', 'in_progress', 'active']);
const BUILD_RE = /(^|\/)(build|out|obj|target|node_modules)\/|\.(o|a|so|dylib|dSYM|pyc)$/;

export function senseConfig() {
  const o = readJson(path.join(HUB, 'sense.json'), {});
  const c = { ...SENSE_DEFAULTS };
  for (const k of Object.keys(SENSE_DEFAULTS)) if (o[k] != null) c[k] = o[k];
  c.quietRe = regexList(c.quietJournal);
  c.privateRe = regexList(c.private);
  return c;
}
const regexList = (list) => (Array.isArray(list) ? list : list ? [list] : []).map(s => { try { return new RegExp(s, 'i'); } catch { return null; } }).filter(Boolean);

/** The private patterns for one head: the hub-wide list in sense.json plus the head's own
 *  (`private` attribute on its role card — a project's names are that project's data). */
export function privatePatterns(conf, cfg = senseConfig()) {
  return [...(cfg.privateRe || []), ...regexList(conf && conf.private)];
}

export function senseDir() {
  const d = process.env.HUBD_SENSE_DIR || path.join(HUB, '.sense');
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    // on a shared hub the head's loop and an operator run as different users: keep the group in
    try { if (fs.statSync(path.dirname(d)).mode & 0o020) fs.chmodSync(d, 0o2775); } catch {}
  }
  return d;
}
const statePath = (head) => path.join(senseDir(), `head.${slugify(head)}.json`);
export function loadSenseState(head) { return readJson(statePath(head), {}); }
function saveSenseState(head, st) { atomicWrite(statePath(head), st); }
export function escalationsPath() { return process.env.HUBD_SENSE_ESCALATIONS || path.join(senseDir(), 'escalations.log'); }
/* An escalation that cannot be written is said so on stderr and in the pass's text, not dropped:
 * HUBD_SENSE_ESCALATIONS naming a directory that did not exist lost every one without a word,
 * while the turn text told the head they were "already escalated". The directory is created. */
function escalate(head, text, nowS) {
  const f = escalationsPath();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${Math.floor(nowS)}\t${head}\t${String(text).replace(/\s+/g, ' ')}\n`); shareMode(f);
    return true;
  } catch (e) {
    process.stderr.write(`sense: escalation NOT written to ${f} (${e.code || e.message}): ${text}\n`);
    return false;
  }
}

const git = (args, cwd, timeout = 120000) => {
  try { return { rc: 0, out: execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) }; }
  catch (e) { return { rc: e.status ?? 99, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') }; }
};
const epoch = (ts) => { const ms = parseTs(ts).getTime(); return Number.isFinite(ms) ? ms / 1000 : 0; };
const minuteTs = (ts) => { const d = parseTs(ts); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : String(ts || ''); };

const norm = (t) => String(t || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
/** A short fingerprint of a journal entry: the journal is minute-grained, and two reports of one
 *  minute are two reports. */
export const entryHash = (e) => crypto.createHash('sha1').update(String(e.text || '')).digest('hex').slice(0, 10);

/** A journal report that is a copy of a message the worker already put in the head's queue.
 *  Matched by TEXT: matched by time alone, a loop's "empty turn" line in the queue swallowed a real
 *  report written in the same quarter hour. The first line of the report, without the task refs a
 *  report line starts with, must appear in the body of one of the worker's queue messages. */
export function isTwin(e, qmsgs, cfg = SENSE_DEFAULTS) {
  const txt = String(e.text || '').replace(/^(#\S+\s*·\s*)+/, '');
  const head = norm(txt.split(' · ')[0]).slice(0, cfg.twinPrefix);
  if (head.length < 20) return false;
  const t = epoch(e.ts);
  return (qmsgs || []).some(([qt, body]) => Math.abs(t - qt) <= cfg.queueTwinS && body.includes(head));
}

// The reflection block is split off where its fields are read (reflect.mjs); the excerpt below keeps it.
export { splitReflect };

/** A worker's report as the head's order quotes it: `max` characters, the reflection kept whole
 *  (up to 500) and the body cut to make room for it. */
export function reportExcerpt(text, max = 700) {
  const { body, reflect } = splitReflect(text);
  if (!reflect) return body.slice(0, max);
  const rf = reflect.slice(0, 500);
  if (!body) return rf;
  const room = Math.max(0, max - rf.length - 4);
  return (body.length > room ? body.slice(0, Math.max(0, room - 1)) + '…' : body) + ' · ' + rf;
}

/** The configuration of one head, from the registry. null when the head is not declared. */
export function senseConf(head) {
  const h = headConf(head);
  if (!h) return null;
  const at = h.attrs || {};
  return {
    head: h.role, project: at.hubproject || h.project || '', repo: at.repo || '', base: at.base || 'main',
    review: at.review || '', plan: at.plan || '', private: at.private || '',
    workers: h.workers.filter(w => w.status !== 'off').map(w => w.role),
    idleMin: Object.fromEntries(h.workers.filter(w => w.idleMin != null).map(w => [w.role, w.idleMin])),
    cwd: Object.fromEntries(h.workers.filter(w => w.attrs && w.attrs.cwd).map(w => [w.role, w.attrs.cwd])),
  };
}

/** What a worker is doing, from its heartbeat fields → [kind, detail]:
 *  dead | stuck | idle | long | exit | busy | unknown. Pure; the tests drive it. */
export function workerState(p, nowS, cfg = SENSE_DEFAULTS) {
  if (!p) return ['unknown', 'no presence record'];
  const age = (nowS - epoch(p.last_seen)) / 60;
  const st = p.status || '';
  if (age > cfg.deadMin) return ['dead', `presence not refreshed for ${Math.floor(age)} min (last: "${st || p.state || '-'}")`];
  if ((p.silent_count ?? 0) >= cfg.silentRestarts) return ['stuck', `the model stopped producing output ${p.silent_count} times in a row`];
  if (p.state === 'exit') return ['exit', p.exit_reason || st || 'the loop exited'];
  if (p.state === 'waiting') {
    const n = p.empty_count ?? 0;
    return n >= cfg.idleMinEmpty ? ['idle', `queue empty for ${n} polls (~${n * 5} min)`] : ['busy', st || 'waiting'];
  }
  if (p.state === 'turn') {
    const m = p.turn_started ? (nowS - epoch(p.turn_started)) / 60 : 0;
    if (m >= cfg.longTurnMin) return ['long', `turn #${p.turn ?? '?'} running for ${Math.floor(m)} min`];
  }
  return ['busy', st || p.state || 'alive'];
}

/**
 * The events for one sensor pass. Pure over its inputs; mutates `st`.
 * @returns {{ev: Array<[string, boolean, string]>, esc: string[]}}  events (key, critical, text), escalations
 */
export function collectEvents(conf, st, nowS, pres, tasks, ents, branches, checker, queued = {}, cfg = SENSE_DEFAULTS, decided = new Set()) {
  const ev = [], esc = [];
  const pend = st.pending || (st.pending = {});
  const live = new Set();
  const raise = (key, crit, text) => {
    live.add(key);
    const p = pend[key];
    if (!p) { pend[key] = { first: nowS, last: nowS, esc: 0 }; ev.push([key, crit, text]); return; }
    if (nowS - p.first >= cfg.escalateS && !p.esc) {
      p.esc = 1;
      esc.push(`${text} — head woken ${Math.floor((nowS - p.first) / 60)} min ago, not resolved`);
    }
    if (nowS - p.last >= cfg.repeatS) {
      p.last = nowS;
      ev.push([key, crit, `${text} (reminder: standing for ${Math.floor((nowS - p.first) / 60)} min)`]);
    }
  };
  const openOf = (w) => tasks.filter(t => t.assignee === w && OPEN_STATUSES.has(t.status)).map(t => String(t.id)).sort();

  /* Idle time is counted on the sensor's clock, not on the loop's counter: the loop's empty count
   * restarts with every restart of the loop, and a worker once sat idle 55 minutes through three
   * restarts while the count never reached the threshold. The hub keeps state_since across loop
   * restarts; the sensor keeps its own mark as well, cleared only by a turn or a report. */
  const waiting = st.waiting || (st.waiting = {});
  const jmark = st.journal || (st.journal = {});
  for (const w of conf.workers) {
    const p = pres[w];
    let [kind, why] = workerState(p, nowS, cfg);
    if ((p && p.state === 'turn') || kind === 'dead' || kind === 'exit' || kind === 'unknown') delete waiting[w];
    else if (p && p.state === 'waiting' && waiting[w] == null) waiting[w] = nowS;
    const wmin = waiting[w] != null ? (nowS - waiting[w]) / 60 : 0;
    const own = conf.idleMin[w] != null;
    const lim = own ? conf.idleMin[w] : cfg.idleWaitMin;
    // A role with its own threshold steps on its own clock, so its empty-poll count grows without
    // meaning anything: for it, idle is only the time since its last report or turn.
    if (kind === 'idle' && p && p.state === 'waiting' && own && wmin < lim) kind = 'busy';
    if (kind === 'busy' && wmin >= lim) { kind = 'idle'; why = `waiting for an order for ${Math.floor(wmin)} min (across loop restarts)`; }
    const ids = openOf(w);
    if (kind === 'idle') {
      raise(`idle:${w}`, wmin >= Math.max(cfg.idleCritMin, 2 * lim),
        `WORKER IDLE: ${w} — ${why}; open on it: ${ids.join(', ') || 'nothing'}. ` +
        (ids.length ? 'Give it an order for one of them (or close / reassign the stale ones).' : 'Cut and give it the next task toward the project goal.'));
    } else if (kind === 'stuck') {
      raise(`stuck:${w}`, true, `WORKER STUCK: ${w} — ${why}. Cut the order into a smaller step or give it another way.`);
    } else if (kind === 'long') {
      raise(`long:${w}`, false, `LONG TURN: ${w} — ${why}. Check on its branch whether it is moving.`);
    } else if (kind === 'dead' || kind === 'exit' || kind === 'unknown') {
      // bringing a role back up is the fleet's job, not the head's: escalation only
      const k = `dead:${w}`;
      live.add(k);
      const pd = pend[k] || (pend[k] = { first: nowS, last: nowS, esc: 0 });
      if (nowS - pd.first >= cfg.deadEscalateS && !pd.esc) {
        pd.esc = 1;
        esc.push(`worker ${w} not running for ${Math.floor((nowS - pd.first) / 60)} min: ${why}`);
      }
    }

    /* The journal is minute-grained: "newer than the mark" lost the second report of the mark's own
     * minute. So entries AT the mark count too, minus the ones of that minute already seen, told
     * apart by fingerprint. */
    const seen = jmark[w] || '';
    const hmark = st.journal_h || (st.journal_h = {});
    const seenH = new Set(hmark[w] || []);
    const legacy = !(w in hmark);        // a state from before fingerprints: the mark's minute was seen whole
    const mine = ents.filter(e => e.agent === w && e.ts >= seen && !(e.ts === seen && (legacy || seenH.has(entryHash(e)))));
    let news = mine.filter(e => !cfg.quietRe.some(re => re.test(e.text || '')));
    if (mine.length) {
      const top = mine.reduce((m, e) => (e.ts > m ? e.ts : m), seen);
      hmark[w] = [...new Set([...mine.filter(e => e.ts === top).map(entryHash), ...(top === seen ? seenH : [])])].sort();
      jmark[w] = top;
      if (news.length) delete waiting[w];
      // a report the worker also sent to the head's queue does not wake the head twice
      news = news.filter(e => !isTwin(e, queued[w], cfg));
      if (seen) {        // the first pass only sets the mark, it does not wake
        for (const e of news.slice(-3)) ev.push([`rep:${w}:${e.ts}:${entryHash(e)}`, false, `WORKER REPORT ${w} ${e.ts} UTC: ${reportExcerpt(e.text)}`]);
        // the ones beyond three used to be dropped without a word
        if (news.length > 3) ev.push([`rep:${w}:more:${news[news.length - 4].ts}`, false, `${news.length - 3} MORE REPORTS from ${w} before these (since ${news[0].ts}) — hub log`]);
      }
    }
  }

  const verd = st.verdicts || (st.verdicts = {});
  if (branches) {
    for (const br of Object.keys(branches).sort()) {
      const sha = branches[br];
      // decided at this sha: by this sensor, or by anyone whose verdict is in the journal — so a
      // fresh sensor state (a new node, a parallel run) does not re-raise what was already judged
      if ((verd[br] && verd[br].sha === sha) || decided.has(`${br}@${sha}`) || decided.has(`@${sha}`)) continue;
      const [okv, txt] = checker(br);
      if (okv === null) { verd[br] = { sha, v: 'merged', ts: Math.floor(nowS) }; continue; }   // already in the base
      if (okv === false && /PRIVATE/.test(txt) && !pend[`br:${br}:${sha}`]) esc.push(`public repo ${conf.repo}: branch ${br} (${sha.slice(0, 10)}) carries private content`);
      raise(`br:${br}:${sha}`, okv === false, `BRANCH FOR ACCEPTANCE: ${br}\n${txt}`);
    }
  }
  for (const k of Object.keys(pend)) if (!live.has(k)) delete pend[k];
  return { ev, esc };
}

export function budgetOk(st, nowS, crit, cfg = SENSE_DEFAULTS) {
  st.wakes = (st.wakes || []).filter(t => nowS - t < 3600);
  if (crit || st.wakes.length < cfg.budgetPerH) { st.wakes.push(nowS); return true; }
  return false;
}

export function remoteBranches(repo) {
  const r = git(['ls-remote', repo, 'refs/heads/task/*'], undefined, 60000);
  if (r.rc !== 0) return null;
  const out = {};
  for (const l of r.out.split('\n')) {
    const [sha, ref] = l.split('\t');
    if (sha && ref && ref.startsWith('refs/heads/')) out[ref.slice('refs/heads/'.length)] = sha;
  }
  return out;
}

/** Acceptance checklist → [ok: true | false | null (already in the base), text]. */
export function checkBranch(conf, branch, { fetch = true, cfg = senseConfig() } = {}) {
  const rv = conf.review, base = conf.base;
  if (!rv || !fs.existsSync(rv)) return [false, `no clone to check in (${rv || 'the head has no review attribute'})`];
  if (fetch) git(['fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], rv, 300000);
  const b = `origin/${branch}`, bb = `origin/${base}`;
  const sr = git(['rev-parse', '--verify', '-q', b], rv);
  if (sr.rc !== 0) return [false, `branch ${branch} is not in the remote`];
  const sha = sr.out.trim();
  if (git(['merge-base', '--is-ancestor', b, bb], rv).rc === 0) return [null, `branch ${branch} @ ${sha.slice(0, 10)} is already entirely in ${base}`];
  const lines = [`branch ${branch} @ ${sha.slice(0, 10)}, base ${base}`], bad = [];
  if (git(['merge-base', '--is-ancestor', bb, b], rv).rc === 0) lines.push(`OK sits on the current ${base} (merges fast-forward)`);
  else bad.push(`does not sit on the current ${base}: rebase onto origin/${base}`);
  const n = parseInt(git(['rev-list', '--count', `${bb}..${b}`], rv).out.trim() || '0', 10) || 0;
  if (!n) bad.push('no commits beyond the base');
  lines.push(`commits: ${n}`);
  for (const l of git(['log', '--format=%h %s', `${bb}..${b}`], rv).out.split('\n').filter(Boolean).slice(0, 12)) lines.push('  ' + l);
  lines.push('changes: ' + (git(['diff', '--shortstat', `${bb}...${b}`], rv).out.trim() || 'none'));
  const files = git(['diff', '--numstat', `${bb}...${b}`], rv, 300000).out.split('\n').map(l => l.split('\t')).filter(f => f.length >= 3);
  const binf = files.filter(f => f[0] === '-').map(f => f[2]);
  const buildf = files.filter(f => BUILD_RE.test(f[2])).map(f => f[2]);
  if (binf.length) lines.push(`binary files: ${binf.length} (${binf.slice(0, 5).join(', ')})`);
  if (buildf.length) bad.push(`build products in the diff: ${buildf.slice(0, 5).join(', ')}`);
  /* No patterns is a failure, not a pass. "Nothing private" was printed for a check that had
   * nothing to check with, and a branch bound for a public repo went through on it. */
  const priv = privatePatterns(conf, cfg);
  if (priv.length) {
    const msgs = git(['log', '--format=%B', `${bb}..${b}`], rv).out;
    const added = git(['diff', `${bb}...${b}`], rv, 300000).out.split('\n').filter(l => l.startsWith('+')).join('\n');
    const hits = (msgs + '\n' + added).split('\n').filter(l => priv.some(re => re.test(l)));
    if (hits.length) bad.push(`PRIVATE content in commits/diff (${hits.length} lines): ` + hits.slice(0, 3).map(h => h.slice(0, 100)).join(' | '));
    else lines.push('OK nothing private (messages and added lines)');
  } else bad.push('no private patterns declared, so nothing can be told apart from public text: declare them (hub sense.json -> private, or the head\'s `private` attribute) before accepting into a public repo');
  for (const x of bad) lines.push('FAIL ' + x);
  lines.push('RESULT: ' + (bad.length ? 'NOT acceptable — return it to the worker: verdict reject with the remarks'
    : 'formally acceptable — decide on the content: verdict accept|reject'));
  return [!bad.length, lines.join('\n')];
}

/** Who gets the order for a branch: whoever handed it in, never the first worker alphabetically
 *  (three workers in worktrees of one repo, and the merge order went to the wrong one twice).
 *  The only worker → the worker whose tree has this branch checked out → the last worker in the
 *  journal to name the branch or its sha. Undetermined → nobody: the head decides, no guessing. */
export function branchOwner(conf, branch, sha, ents) {
  const ws = conf.workers;
  if (ws.length === 1) return [ws[0], 'the only worker'];
  for (const w of ws) {
    const cwd = conf.cwd[w];
    if (cwd && fs.existsSync(cwd)) {
      const r = git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], undefined, 20000);
      if (r.rc === 0 && r.out.trim() === branch) return [w, `the branch is HEAD of ${cwd}`];
    }
  }
  const short = sha.slice(0, 7);
  for (const e of [...ents].reverse()) if (ws.includes(e.agent) && (String(e.text).includes(branch) || String(e.text).includes(short))) return [e.agent, `handed it in last in the journal (${e.ts})`];
  return ['', 'undetermined'];
}

function journalWindow(hours = 72) {
  return journalSinceMs(Date.now() - hours * 3600000).map(e => ({ ...e, ts: minuteTs(e.ts) })).reverse();   // oldest first
}
/** {sender: [[epoch, normalised body]]} — the head's queue, every node's file, for twin matching. */
function queuedFrom(head) {
  const out = {};
  for (const b of recentBlocks({ root: resolveQueueRoot(), to: [head], sinceMs: Date.now() - 2 * 86400000, textChars: 1e6 }))
    (out[b.from] || (out[b.from] = [])).push([epoch(b.ts), norm(b.text)]);
  return out;
}

/** Publish what this node's sensor last raised, for boards on every node. Rewritten only when the
 *  content changed, so an idle sensor does not turn into a commit per mesh tick. */
/*  One file per node holds every head of that node, and each head's sensor runs as its own
 *  process: read, change one key, write back — two heads finishing together lost one of the two
 *  updates. Held under a lock; a lock that cannot be had costs one board refresh, never the pass. */
function publish(head, ev, st, esc) {
  const f = path.join(HUB, `sense.${JOURNAL_NODE}.json`);
  try {
    withLock(f, () => {
      const o = readJson(f, {});
      const heads = o.heads || {};
      const prevHead = heads[head] || {};
      const cur = {
        pending: Object.keys(st.pending || {}).sort(),
        last: ev.length ? { ts: now(), events: ev.map(([key, crit, text]) => ({ key, crit, text: text.slice(0, 300) })) } : (prevHead.last || null),
        escalations: [...(prevHead.escalations || []), ...esc.map(t => ({ ts: now(), text: t.slice(0, 300) }))].slice(-10),
      };
      if (JSON.stringify(prevHead) === JSON.stringify(cur)) return;
      heads[head] = cur;
      atomicWrite(f, { node: JOURNAL_NODE, written: now(), heads });
    });
  } catch {}
}

/** Every node's published sensor state, merged by head (the board reads this). */
export function senseSnapshots() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(HUB).filter(f => /^sense\..+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(HUB, f), 'utf8')) || {};
      for (const [h, v] of Object.entries(o.heads || {})) out[h] = { ...v, node: o.node || f.slice(6, -5), written: o.written || null };
    } catch {}
  }
  return out;
}

/** One sensor pass → { code: 0 wake | 1 nothing, text, events, escalations }. */
export function runSenseEvents(head, { nowS = Date.now() / 1000 } = {}) {
  const conf = senseConf(head);
  if (!conf) throw new Error(`no head "${head}" in the role registry — declare it: hub resource set ${slugify(head)} --type role --attr rank=head --attr project=<slug> --by <you>`);
  const cfg = senseConfig();
  const st = loadSenseState(conf.head);
  const presence = new Map(runPresence({}).agents.map(p => [p.agent, p]));
  const pres = Object.fromEntries(conf.workers.map(w => [w, presence.get(w) || null]));
  const branches = conf.repo ? remoteBranches(conf.repo) : null;
  let fetched = false;
  const checker = (br) => { const r = checkBranch(conf, br, { fetch: !fetched, cfg }); fetched = true; return r; };
  // what the pass may move and a held-back wake has to put back: the journal marks AND the
  // fingerprints of the mark's minute — restoring only the marks replayed that minute's reports
  const jmark = { ...(st.journal || {}) };
  const jhmark = st.journal_h ? JSON.parse(JSON.stringify(st.journal_h)) : null;
  const ents = journalWindow(24 * 30);
  const decided = new Set();
  for (const e of ents) {
    const v = e.kind === 'decision' ? parseVerdict(e.text) : null;
    if (v && v.sha.length === 40) { decided.add(`@${v.sha}`); if (v.branch) decided.add(`${v.branch}@${v.sha}`); }
  }
  let { ev, esc } = collectEvents(conf, st, nowS, pres, loadTasks().tasks, ents.filter(e => epoch(e.ts) >= nowS - 72 * 3600), branches, checker, queuedFrom(conf.head), cfg, decided);
  const unwritten = esc.filter(e => !escalate(conf.head, e, nowS));
  const crit = ev.some(([, c]) => c);
  if (ev.length && !budgetOk(st, nowS, crit, cfg)) {
    // held back: take the new marks off so it comes on the next pass; reminders come next pass too
    for (const [k] of ev) {
      const p = st.pending[k];
      if (p && p.first === nowS) delete st.pending[k];
      else if (p) p.last -= cfg.repeatS;
    }
    st.journal = jmark;
    if (jhmark) st.journal_h = jhmark; else delete st.journal_h;
    ev = [];
  }
  saveSenseState(conf.head, st);
  publish(conf.head, ev, st, esc);
  if (!ev.length) return { code: 1, text: '', events: [], escalations: esc, unwritten };
  const lines = [`SUPERVISION EVENTS (${new Date(nowS * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC) — the sensor has already taken the measurements, do not re-measure. Handle EACH one and end the turn.`];
  ev.forEach(([, c, t], i) => lines.push('', `${i + 1}. ${c ? '[CRITICAL] ' : ''}${t}`));
  const sent = esc.filter(e => !unwritten.includes(e));
  if (sent.length) lines.push('', 'Already escalated to the fleet: ' + sent.join('; '));
  if (unwritten.length) lines.push('', `NOT escalated — ${escalationsPath()} could not be written; tell the fleet yourself: ` + unwritten.join('; '));
  lines.push('', 'Tools (the sensor does the acceptance checks, you decide):',
    `  hub sense ${conf.head} check task/<slug>`,
    `  hub sense ${conf.head} verdict task/<slug> accept "<what is accepted>"   — into the hub + an order to the worker to merge into ${conf.base}`,
    `  hub sense ${conf.head} verdict task/<slug> reject "<what to fix>"       — remarks to the worker`,
    'An order to a worker: hub_queue_send (one task, 30-90 min, the acceptance command, branch task/<slug>).',
    'End of the turn: the project card (hub_card_set: waiting on / next step / dead ends, do not repeat / accepted) — your memory between sessions.');
  return { code: 0, text: lines.join('\n'), events: ev.map(([key, crit, text]) => ({ key, crit, text })), escalations: esc, unwritten };
}

export function runSenseVerdict(head, branch, v, text) {
  const conf = senseConf(head);
  if (!conf) throw new Error(`no head "${head}" in the role registry`);
  if (v !== 'accept' && v !== 'reject') throw new Error('verdict: accept or reject');
  const [okv, txt] = checkBranch(conf, branch);
  const sr = git(['rev-parse', '--verify', '-q', `origin/${branch}`], conf.review || '.');
  const sha = sr.out.trim();
  if (!sha) return { code: 1, text: txt };
  if (okv === null) return { code: 0, text: txt + ' — nothing to decide' };
  if (v === 'accept' && okv === false) return { code: 1, text: txt + '\n\naccept REFUSED: the branch fails the checklist. Return it to the worker (reject).' };
  const [worker, whyW] = branchOwner(conf, branch, sha, journalWindow(24 * 14));
  let rep, order;
  if (v === 'accept') {
    // The first line is exactly what a base-protecting hook reads: "decision: ACCEPT <full sha>".
    rep = `ACCEPT ${sha} ${branch} → ${conf.base}: ${text}`;
    order = `Branch ${branch} ACCEPTED by the head (${sha.slice(0, 10)}). Merge it into ${conf.base} fast-forward:\n` +
      `  git fetch origin && git push origin ${sha}:refs/heads/${conf.base}\n` +
      `A hook lets the base move only up to the accepted sha; "no acceptance found" means the hub has not reached your node yet — retry in 10 minutes. ` +
      `A non-fast-forward refusal means ${conf.base} moved on: rebase the branch onto it, push the branch, tell the head. Finish with hub_report.`;
  } else {
    rep = `REJECT ${sha} ${branch}: ${text}`;
    order = `Branch ${branch} (${sha.slice(0, 10)}) NOT accepted. Fix it in the same branch and push:\n${text}\n\nThe sensor's checklist:\n${txt}`;
  }
  runReport({ project: conf.project || 'general', agent: conf.head, kind: 'decision', text: rep });
  if (worker) queueSend(worker, order, { from: conf.head, root: resolveQueueRoot() });
  const st = loadSenseState(conf.head);
  (st.verdicts || (st.verdicts = {}))[branch] = { sha, v, ts: Math.floor(Date.now() / 1000), text: String(text).slice(0, 300) };
  for (const k of Object.keys(st.pending || {})) if (k.startsWith(`br:${branch}:`)) delete st.pending[k];
  saveSenseState(conf.head, st);
  return { code: 0, worker, text: `${v === 'accept' ? 'accepted' : 'returned'}: ${branch} @ ${sha.slice(0, 10)}; into the hub: "${rep.slice(0, 80)}…"; order -> ${worker || 'NOBODY'} (${whyW})` +
    (worker ? '' : '\n  the branch owner is undetermined — send the merge order yourself to whoever handed the branch in (hub_queue_send)') };
}

/** The first order of a NEW head session. The hub's data is not rebuilt here: returning after a
 *  lost context is what hub_context and hub_whatsnew are for, and the head's memory is its card. */
export function runSenseBrief(head, cwd = process.cwd()) {
  const conf = senseConf(head);
  if (!conf) throw new Error(`no head "${head}" in the role registry`);
  return `NEW SESSION — the previous conversation is gone. Before handling the order: hub_context({cwd: "${cwd}"}), ` +
    `then hub_whatsnew({agent: "${conf.head}"}) — the card of project ${conf.project} (your memory), open tasks, the journal.` +
    (conf.plan ? ` The plan toward the goal is ${conf.plan} in ${conf.base}: \`git -C ${conf.review} show origin/${conf.base}:${conf.plan}\`.` : '');
}

