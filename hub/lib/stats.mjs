/* stats.mjs — `hub stats`, hub_stats and a task's cost: the session ledger bound to tasks, priced,
 * and judged by verdicts. Reading only, except `hub price pull` and `hub price map`. */
import fs from 'node:fs';
import path from 'node:path';
import {
  canonProject, HUB, JOURNAL_NODE, journalEntries, loadTasks, now, parseTs, requireAuthor, resolveTaskRef, shareMode,
  taskTitle, withLock,
} from './core.mjs';
import { ledgerFiles, readLedger } from './sessions.mjs';

/* ── What is counted, and how ──
 *
 * Every number here is a function of files the hub already holds: the ledger (what each session
 * did, read from the client's own database), the journal (closes and verdicts), the tasks, and the
 * price snapshots. The same files give the same output, byte for byte, so a number quoted next
 * week can be computed again and checked. Four kinds of number, never added together:
 *
 *   READ      tokens of five kinds, model, and what the client says it paid, from the ledger;
 *   MEASURED  attempts, verdicts and the time from order to verdict, from the hub's own logs;
 *   SUPPLIED  what callers reported through hub_usage_add (`hub usage`, not here);
 *   NOTIONAL  tokens times an OpenRouter rate of the step's day: what the work would have cost at
 *             list price, the one way to compare a free tier, a subscription and a paid key.
 *
 * Binding, rule v1. A role's sessions are one timeline (a child session runs under its parent's
 * role). An order is a message the role received carrying a queue header with "task #<ref>"; it
 * replaces the role's set of current tasks with the ones it names. Every other message (the
 * loop's "queue empty", "the step broke off", "the session overflowed") leaves the set as it is,
 * and the set carries into the role's next session. A close (a task the hub reports closed, in
 * the session or in the journal) takes the task out. A step's tokens are split evenly over the
 * set; an empty set is "unbound". A share is "order" when the order that set it came in the same
 * session (or the session it is a child of), "carried" when it came in an earlier one.
 *
 * An attempt is one role on one task: from the order that first gave it the task to the close.
 * A verdict judges the attempt of its `of` role, else the latest attempt on the task that began
 * before it; an attempt's outcome is its last verdict, a task's the last verdict on it. */
export const STATS_RULE = 'v1';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const r6 = (x) => (x === null ? null : Math.round(x * 1e6) / 1e6);
const sum5 = (a, b) => { for (let i = 0; i < 5; i++) a[i] += b[i]; return a; };
const total = (t) => t[0] + t[1] + t[2] + t[3] + t[4];

/* ── Prices ──
 * prices.<node>.jsonl, append-only: a rate row {date, model, in, out, cacheRead, cacheWrite} (USD
 * per token, an OpenRouter model id) when `hub price pull` sees a rate change, and a map row
 * {ts, map, to, by} when `hub price map` says which listing prices one of our models. */
export const PRICES_RE = /^prices\..+\.jsonl$/;
export const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
export function pricesFile() { return path.join(HUB, `prices.${JOURNAL_NODE}.jsonl`); }
function pricesFiles() {
  try { return fs.readdirSync(HUB).filter(f => PRICES_RE.test(f)).sort().map(f => path.join(HUB, f)); }
  catch { return []; }
}
export function readPrices() {
  const rates = new Map(), maps = new Map();
  for (const f of pricesFiles()) {
    let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o && typeof o.map === 'string') {
        const cur = maps.get(o.map);
        if (!cur || String(o.ts) >= String(cur.ts)) maps.set(o.map, { to: o.to || null, ts: o.ts, by: o.by || null });
      } else if (o && typeof o.model === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && Number.isFinite(o.in) && Number.isFinite(o.out)) {
        if (!rates.has(o.model)) rates.set(o.model, []);
        rates.get(o.model).push({ date: o.date, in: o.in, out: o.out, cacheRead: o.cacheRead ?? null, cacheWrite: o.cacheWrite ?? null });
      }
    }
  }
  for (const [k, l] of rates) {
    l.sort((a, b) => cmp(a.date, b.date));
    // one rate a day: of two snapshots of a day, the later file's
    rates.set(k, l.filter((x, i) => i === l.length - 1 || l[i + 1].date !== x.date));
  }
  return { rates, maps };
}

/** Which listing prices one of our models ("provider/model" as the client names it): the map
 *  first; else a listing of the same id, with or without the provider; else the one listing whose
 *  name after its vendor is the model's. Free tiers and renamed models need the map. */
export function priceSource(ours, P) {
  const m = P.maps.get(ours);
  if (m) return { to: m.to, via: 'map' };
  const bare = ours.includes('/') ? ours.slice(ours.indexOf('/') + 1) : ours;
  if (P.rates.has(ours)) return { to: ours, via: 'same' };
  if (P.rates.has(bare)) return { to: bare, via: 'same' };
  const hits = [...P.rates.keys()].filter(k => k.slice(k.indexOf('/') + 1) === bare).sort();
  if (hits.length === 1) return { to: hits[0], via: 'auto' };
  return { to: null, via: hits.length ? 'ambiguous' : 'none', ...(hits.length ? { candidates: hits } : {}) };
}

/* The rate of a listing on a day: the last snapshot on or before it; a day before the first
 * snapshot takes the first one and is marked approximate. A cache rate a listing does not give is
 * its input rate. Reasoning is billed as output. */
function makePricer(P) {
  const memo = new Map();
  return (model, day) => {
    const k = model + '\0' + day;
    if (memo.has(k)) return memo.get(k);
    const src = priceSource(model, P);
    let v = null;
    const list = src.to ? P.rates.get(src.to) : null;
    if (list && list.length) {
      let r = null;
      for (const x of list) { if (x.date <= day) r = x; else break; }
      v = { approx: !r, r: r || list[0] };
    }
    memo.set(k, v);
    return v;
  };
}
const priceOf = (tok, r) => tok[0] * r.in + (tok[1] + tok[2]) * r.out + tok[3] * (r.cacheRead ?? r.in) + tok[4] * (r.cacheWrite ?? r.in);

/** hub price pull: OpenRouter's public model list (or a saved copy of it), and a rate row for
 *  every listing whose rate is new or changed since the last snapshot any node took. */
export async function runPricePull(a = {}) {
  let body;
  if (a.from) {
    try { body = JSON.parse(fs.readFileSync(a.from, 'utf8')); } catch (e) { throw new Error(`--from ${a.from}: ${e.code === 'ENOENT' ? 'no such file' : 'not JSON'}`); }
  } else {
    const res = await fetch(a.url || OPENROUTER_MODELS, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${a.url || OPENROUTER_MODELS}: HTTP ${res.status}`);
    body = await res.json();
  }
  const list = Array.isArray(body) ? body : body && body.data;
  if (!Array.isArray(list)) throw new Error('not a model list: expected {"data": [{"id": ..., "pricing": {...}}]}');
  const P = readPrices();
  const date = a.date || now().slice(0, 10);
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const rows = [];
  for (const m of list.filter(x => x && typeof x.id === 'string').sort((x, y) => cmp(x.id, y.id))) {
    const pr = m.pricing || {};
    const r = { in: n(pr.prompt), out: n(pr.completion), cacheRead: n(pr.input_cache_read), cacheWrite: n(pr.input_cache_write) };
    // a router's "-1" is a price decided per request, not a rate
    if (!Number.isFinite(r.in) || !Number.isFinite(r.out) || r.in < 0 || r.out < 0) continue;
    for (const k of ['cacheRead', 'cacheWrite']) if (!Number.isFinite(r[k]) || r[k] < 0) r[k] = null;
    const last = (P.rates.get(m.id) || []).at(-1);
    if (last && last.in === r.in && last.out === r.out && last.cacheRead === r.cacheRead && last.cacheWrite === r.cacheWrite) continue;
    rows.push({ date, model: m.id, ...r });
  }
  if (rows.length && !a.dry) {
    const f = pricesFile();
    withLock(f, () => { fs.appendFileSync(f, rows.map(x => JSON.stringify(x)).join('\n') + '\n'); });
    shareMode(f);
  }
  return { ok: true, date, listings: list.length, changed: rows.length, dry: !!a.dry, ...(rows.length && !a.dry ? { file: pricesFile() } : {}) };
}

/** hub price map: price one of our models by a listing ("-" for none: it is not priced). */
export function runPriceMap(a = {}) {
  const by = requireAuthor(a.by, 'by');
  const ours = String(a.ours || '').trim(), to = String(a.to || '').trim();
  if (!ours || !to) throw new Error('usage: hub price map <our model, provider/model as the client names it> <OpenRouter id, or - for none> --by <you>');
  const P = readPrices();
  if (to !== '-' && !P.rates.has(to)) throw new Error(`no listing "${to}" in the price snapshots; hub price pull first, or check the id on openrouter.ai/models`);
  const row = { ts: now(), map: ours, to: to === '-' ? null : to, by };
  const f = pricesFile();
  withLock(f, () => { fs.appendFileSync(f, JSON.stringify(row) + '\n'); });
  shareMode(f);
  return { ok: true, ...row };
}

/** hub price list: every model the ledger saw, the listing that prices it, and its rate today. */
export function runPriceList() {
  const P = readPrices();
  const seen = new Map();
  for (const r of readLedger()) for (const e of r.log) if (e.seg) {
    const k = e.seg.model; const c = seen.get(k) || { steps: 0, tokens: 0 };
    c.steps += e.seg.steps; c.tokens += total(e.seg.tok); seen.set(k, c);
  }
  const today = now().slice(0, 10);
  const models = [...seen.keys()].sort().map(m => {
    const src = priceSource(m, P);
    const list = src.to ? P.rates.get(src.to) : null;
    const rate = list && list.length ? list.filter(x => x.date <= today).at(-1) || list[0] : null;
    return { model: m, ...seen.get(m), listing: src.to, via: src.via, ...(src.candidates ? { candidates: src.candidates } : {}), rate };
  });
  return { listings: P.rates.size, maps: P.maps.size, models, unpriced: models.filter(x => !x.rate).map(x => x.model) };
}

/* ── Verdicts and closes, from the journal ── */

/* The decisions heads wrote before VERDICT: existed, read by a strict rule and never rewritten:
 * the first word ACCEPT or REJECT, and exactly one task the hub holds named in the text. */
const LEGACY_RE = /^\s*(?:decision:\s*)?(ACCEPT|REJECT)\b/;
function legacyTask(text, project, tasks, ids) {
  const found = new Set();
  for (const x of String(text).matchAll(/(?:^|[^\w-])#?([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*-\d+)(?![\w-])/gi)) if (ids.has(x[1])) found.add(x[1]);
  for (const x of String(text).matchAll(/(?:^|[^\w-])#(\d+)(?![\w-])/g)) {
    const r = resolveTaskRef(x[1], tasks, { project });
    if (r.known) found.add(r.id);
  }
  return found.size === 1 ? [...found][0] : null;
}

function readJournalFacts(sinceMs, tasks) {
  const ids = new Set(tasks.map(t => String(t.id)));
  const verdicts = [], closes = [];
  let legacyUnbound = 0;
  const all = [...journalEntries(sinceMs)].filter(e => e && e.ts);
  all.sort((a, b) => cmp(a.ts, b.ts));   // stable: one minute keeps the files' order
  for (const e of all) {
    const ms = parseTs(e.ts).getTime();
    if (e.kind === 'verdict' && e.task && (e.verdict === 'accept' || e.verdict === 'reject')) {
      verdicts.push({ ms, task: String(e.task), verdict: e.verdict, of: e.of || null, by: e.agent || null, parsed: false });
    } else if (e.kind === 'decision') {
      const m = LEGACY_RE.exec(e.text || '');
      if (!m) continue;
      const task = legacyTask(e.text, e.project, tasks, ids);
      if (task) verdicts.push({ ms, task, verdict: m[1].toLowerCase(), of: null, by: e.agent || null, parsed: true });
      else legacyUnbound++;
    } else if (e.kind === 'done') {
      const m = /^#(\S+)\s/.exec(String(e.text || '') + ' ');
      // the journal's minute: the close is put at its end, after every step of that minute
      if (m && ids.has(m[1])) closes.push({ ms: ms + 59999, task: m[1], by: e.agent || null });
    }
  }
  return { verdicts, closes, legacyUnbound };
}

/* ── The timeline ── */

function bindAll() {
  const rows = readLedger();
  const tasks = loadTasks().tasks;
  const taskById = new Map(tasks.map(t => [String(t.id), t]));
  const P = readPrices();
  const pricer = makePricer(P);
  const minT0 = rows.length ? rows[0].t0 : Date.now();
  const J = readJournalFacts(minT0 - 7 * 86400000, tasks);

  const byId = new Map(rows.map(r => [r.id, r]));
  const rootOf = (r) => { let x = r; for (let i = 0; i < 64 && x.parent && byId.has(x.parent); i++) x = byId.get(x.parent); return x; };
  const shares = [];
  const priced = (model, at, tok) => {
    const p = pricer(model, dayOf(at));
    return p ? { notional: priceOf(tok, p.r), approx: p.approx } : { notional: null, approx: false };
  };
  const share = (o) => { const p = priced(o.model, o.at, o.tok); shares.push({ ...o, day: dayOf(o.at), ...p }); };

  // the sessions' own sums, and probes, which no timeline sees
  const sessions = { work: 0, probe: 0, tok: [0, 0, 0, 0, 0], paid: 0, steps: 0, totalsDiffer: 0 };
  const empty = { repeats: 0, invalid: 0, errors: 0, sessionsWithoutSteps: 0 };
  const events = [];
  for (const r of rows) {
    const root = rootOf(r);
    const role = root.agent || r.agent || '(none)';
    const project = r.project || root.project || null;
    const segTok = [0, 0, 0, 0, 0];
    let steps = 0, last = r.t0;
    r.log.forEach((e, i) => {
      // a session's own order holds, whatever its clocks say
      const at = Math.max(last, e.seg ? e.seg.t0 : e.at);
      last = at;
      if (e.seg) {
        sum5(segTok, e.seg.tok); steps += e.seg.steps;
        sessions.paid += e.seg.paid; sessions.steps += e.seg.steps;
        empty.repeats += e.seg.repeats; empty.invalid += e.seg.invalid; empty.errors += e.seg.errors;
      }
      if (r.kind === 'probe') {
        if (e.seg) share({ kind: 'probe', at, role, project, model: e.seg.model, task: null, tok: e.seg.tok.slice(), paid: e.seg.paid, steps: e.seg.steps, sid: r.id });
        return;
      }
      events.push({ at, k: 1, role, sid: r.id, root: root.id, i, project, ...(e.order ? { order: e.order } : e.seg ? { seg: e.seg } : { close: e.close }) });
    });
    sum5(sessions.tok, segTok);
    r.kind === 'probe' ? sessions.probe++ : sessions.work++;
    if (!steps) empty.sessionsWithoutSteps++;
    if (r.tot && total(r.tot) && r.tot.some((x, i) => x !== segTok[i])) sessions.totalsDiffer++;
  }
  for (const c of J.closes) events.push({ at: c.ms, k: 2, role: '', sid: '', i: 0, close: [c.task], global: true });
  events.sort((a, b) => a.at - b.at || a.k - b.k || cmp(a.role, b.role) || cmp(a.sid, b.sid) || a.i - b.i);

  const state = new Map();     // role -> { set, origin }
  const attempts = [], open = new Map();
  const unresolved = new Map();
  const key = (task, role) => task + '\0' + role;
  const begin = (task, role, at, from) => {
    const a = { task, role, start: at, end: null, from: from || null, last: at, tok: [0, 0, 0, 0, 0], steps: 0, paid: 0, models: new Set(), verdicts: [] };
    attempts.push(a); open.set(key(task, role), a);
    return a;
  };
  const end = (task, role, at) => { const a = open.get(key(task, role)); if (a) { a.end = at; open.delete(key(task, role)); } };
  for (const ev of events) {
    if (ev.order) {
      const set = [];
      for (const o of ev.order) {
        // a bare number is the sending node's first: the block's id says which node sent it
        const node = o.block && o.block.includes('-') ? o.block.replace(/-\d+$/, '') : undefined;
        const r = resolveTaskRef(o.ref, tasks, { project: ev.project, node });
        if (!r.known) { unresolved.set(o.ref, (unresolved.get(o.ref) || 0) + 1); continue; }
        if (!set.includes(r.id)) set.push(r.id);
        if (!open.has(key(r.id, ev.role))) begin(r.id, ev.role, ev.at, o.from);
      }
      set.sort();
      state.set(ev.role, { set, origin: ev.root });
    } else if (ev.seg) {
      const st = state.get(ev.role) || { set: [], origin: null };
      const g = ev.seg;
      if (!st.set.length) {
        share({ kind: 'unbound', at: ev.at, role: ev.role, project: ev.project, model: g.model, task: null, tok: g.tok.slice(), paid: g.paid, steps: g.steps, sid: ev.sid });
        continue;
      }
      const n = st.set.length;
      // tokens split in whole tokens, the odd ones to the first ids; a step is not split: it
      // counts whole in every task it worked on, and once in every sum over tasks
      st.set.forEach((task, idx) => {
        const tok = g.tok.map(x => Math.floor(x / n) + (idx < x % n ? 1 : 0));
        const a = open.get(key(task, ev.role)) || begin(task, ev.role, ev.at, null);
        sum5(a.tok, tok); a.steps += g.steps; a.paid += g.paid / n; a.models.add(g.model); a.last = Math.max(a.last, g.t1 || ev.at);
        const t = taskById.get(task);
        share({ kind: 'task', at: ev.at, role: ev.role, project: (t && t.project) || ev.project, model: g.model, task, attempt: a,
          strength: st.origin === ev.root ? 'order' : 'carried', tok, paid: g.paid / n, steps: idx ? 0 : g.steps, stepsIn: g.steps, sid: ev.sid });
      });
    } else if (ev.close) {
      const roles = ev.global ? [...state.keys()] : [ev.role];
      for (const role of roles) {
        const st = state.get(role);
        if (st) st.set = st.set.filter(x => !ev.close.includes(x));
      }
      for (const task of ev.close) {
        if (ev.global) { for (const a of [...open.values()]) if (a.task === task) end(task, a.role, ev.at); }
        else end(task, ev.role, ev.at);
      }
    }
  }

  // verdicts onto attempts
  let noAttempt = 0;
  const vByTask = new Map();
  for (const v of J.verdicts) {
    if (!vByTask.has(v.task)) vByTask.set(v.task, []);
    vByTask.get(v.task).push(v);
    let pick = null;
    for (const a of attempts) {
      if (a.task !== v.task || a.start > v.ms || (v.of && a.role !== v.of)) continue;
      if (!pick || a.start > pick.start || (a.start === pick.start && a.role > pick.role)) pick = a;
    }
    if (pick) pick.verdicts.push(v); else noAttempt++;
  }
  let asOf = rows.reduce((m, r) => Math.max(m, r.t1 || 0), 0);
  for (const v of J.verdicts) asOf = Math.max(asOf, v.ms);
  for (const a of attempts) {
    a.outcome = a.verdicts.length ? a.verdicts[a.verdicts.length - 1].verdict : null;
    a.abandoned = a.end === null && !a.verdicts.length && a.last < asOf - 86400000;
  }
  return {
    rows, tasks, taskById, shares, attempts, sessions, empty, vByTask, asOf,
    unresolved, verdicts: { journal: J.verdicts.filter(v => !v.parsed).length, parsed: J.verdicts.filter(v => v.parsed).length, unreadable: J.legacyUnbound, noAttempt },
  };
}

/* ── Aggregation ── */

const blank = () => ({ steps: 0, tok: [0, 0, 0, 0, 0], notional: 0, priced: false, unpricedTokens: 0, approx: false, paid: 0 });
function addShare(acc, s) {
  acc.steps += s.steps; sum5(acc.tok, s.tok); acc.paid += s.paid;
  if (s.notional === null) acc.unpricedTokens += total(s.tok);
  else { acc.notional += s.notional; acc.priced = true; if (s.approx) acc.approx = true; }
}
// notional: what the priced tokens would cost; null when none were priced and some were not
const money = (acc) => ({ steps: acc.steps, tok: acc.tok, tokens: total(acc.tok),
  notional: !acc.priced && acc.unpricedTokens ? null : r6(acc.notional), unpricedTokens: acc.unpricedTokens,
  ...(acc.approx ? { approx: true } : {}), paid: r6(acc.paid) });

function parseSince(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = /^(\d+)\s*([dh])$/.exec(String(v).trim());
  if (m) return { ms: Date.now() - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000) };
  const t = parseTs(String(v).length === 10 ? v + ' 00:00' : String(v)).getTime();
  if (!Number.isFinite(t)) throw new Error(`--since ${v}: a number of days or hours ("7d", "12h") or a date ("2026-10-01")`);
  return { ms: t };
}

const NO_SESSIONS = 'no sessions in the ledger yet: hub sessions ingest --opencode <opencode.db> (or --rows <file>) takes a client\'s sessions in';

/** hub stats / hub_stats. */
export function runStats(a = {}) { return statsOf(a, true); }

function statsOf(a, withRows) {
  // `group`, not `by`: `by` is an author everywhere in the hub, and the MCP server fills it in
  const by = a.group || 'task';
  if (!['task', 'model', 'role', 'day'].includes(by)) throw new Error(`group ${by}: task, model, role or day`);
  const B = ledgerFiles().length ? bindAll() : null;
  if (!B || !B.rows.length) return { rule: STATS_RULE, empty: true, note: NO_SESSIONS };
  const since = parseSince(a.since);
  const proj = a.project ? canonProject(a.project) : null;
  const inWin = (ms) => !since || ms >= since.ms;
  const okProj = (p) => !proj || p === proj;
  const shares = B.shares.filter(s => inWin(s.at) && okProj(s.project));
  const attemptsIn = B.attempts.filter(x => {
    const t = B.taskById.get(x.task);
    if (!okProj((t && t.project) || null)) return false;
    return !since || x.start >= since.ms || x.last >= since.ms || x.verdicts.some(v => v.ms >= since.ms);
  });

  const out = { rule: STATS_RULE, asOf: isoOf(B.asOf), ...(since ? { since: isoOf(since.ms) } : {}), ...(proj ? { project: proj } : {}), group: by };

  // per task
  const taskAcc = new Map();
  for (const s of shares) if (s.kind === 'task') {
    if (!taskAcc.has(s.task)) taskAcc.set(s.task, { ...blank(), order: 0, carried: 0 });
    const acc = taskAcc.get(s.task); addShare(acc, s); acc.steps += s.stepsIn - s.steps; acc[s.strength] += total(s.tok);
  }
  const taskRow = (id) => {
    const t = B.taskById.get(id) || {};
    const att = attemptsIn.filter(x => x.task === id);
    const vs = B.vByTask.get(id) || [];
    const first = att.length ? Math.min(...att.map(x => x.start)) : null;
    const lastV = vs.length ? vs[vs.length - 1] : null;
    const acc = taskAcc.get(id) || { ...blank(), order: 0, carried: 0 };
    return {
      task: id, project: t.project || null, title: taskTitle(t.text || '', 60), status: t.status || null,
      attempts: att.length, roles: [...new Set(att.map(x => x.role))].sort(),
      models: [...new Set(att.flatMap(x => [...x.models]))].sort(),
      ...money(acc), order: acc.order, carried: acc.carried,
      ...(first !== null ? { firstOrder: isoOf(first) } : {}),
      ...(lastV ? { verdictAt: isoOf(lastV.ms) } : {}),
      hours: first !== null && lastV && lastV.ms >= first ? Math.round((lastV.ms - first) / 360000) / 10 : null,
      outcome: lastV ? lastV.verdict : null,
    };
  };

  // the summary every view carries
  const unbound = blank(), probes = blank(), waste = blank();
  let wasteAttempts = 0;
  for (const s of shares) {
    if (s.kind === 'unbound') addShare(unbound, s);
    else if (s.kind === 'probe') addShare(probes, s);
    else if (s.attempt && s.attempt.outcome === 'reject') addShare(waste, s);
  }
  for (const x of attemptsIn) if (x.outcome === 'reject') wasteAttempts++;
  const sids = { work: new Set(), probe: new Set() };
  for (const s of shares) sids[s.kind === 'probe' ? 'probe' : 'work'].add(s.sid);
  out.summary = {
    // the sessions with a step in the window (and the project)
    sessions: { work: sids.work.size, probe: sids.probe.size },
    bound: money(shares.filter(s => s.kind === 'task').reduce((acc, s) => (addShare(acc, s), acc), blank())),
    unbound: money(unbound),
    probes: money(probes),
    waste: { attempts: wasteAttempts, ...money(waste) },
    empty: B.empty,
    unresolvedRefs: { count: [...B.unresolved.values()].reduce((x, y) => x + y, 0),
      examples: [...B.unresolved.entries()].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])).slice(0, 5).map(([ref, n]) => ({ ref, n })) },
    verdicts: B.verdicts,
    attempts: { total: attemptsIn.length, accepted: attemptsIn.filter(x => x.outcome === 'accept').length,
      rejected: attemptsIn.filter(x => x.outcome === 'reject').length, open: attemptsIn.filter(x => x.end === null && !x.outcome).length,
      abandoned: attemptsIn.filter(x => x.abandoned).length },
  };

  if (a.task) {
    const r = resolveTaskRef(a.task, B.tasks, {});
    if (!r.known) throw new Error(`no task #${a.task}${r.ambiguous ? ' (it is ' + r.ambiguous.join(', ') + ')' : ''}`);
    out.task = taskRow(r.id);
    out.task.attemptList = attemptsIn.filter(x => x.task === r.id).map(x => ({
      role: x.role, from: x.from, start: isoOf(x.start), end: x.end === null ? null : isoOf(x.end),
      models: [...x.models].sort(), steps: x.steps, tok: x.tok, tokens: total(x.tok), paid: r6(x.paid),
      outcome: x.outcome, verdicts: x.verdicts.map(v => ({ at: isoOf(v.ms), verdict: v.verdict, by: v.by, ...(v.parsed ? { parsed: true } : {}) })),
      ...(x.abandoned ? { abandoned: true } : {}),
    }));
  }

  if (!withRows) { /* a task's cost alone */ }
  else if (by === 'task') {
    const ids = new Set([...taskAcc.keys(), ...attemptsIn.map(x => x.task)]);
    out.rows = [...ids].map(taskRow).sort((x, y) => y.tokens - x.tokens || cmp(x.task, y.task));
  } else {
    const keyOf = by === 'model' ? (s) => s.model : by === 'role' ? (s) => s.role : (s) => s.day;
    const acc = new Map();
    const get = (k) => { if (!acc.has(k)) acc.set(k, { ...blank(), attempts: new Set(), unbound: 0, probe: 0 }); return acc.get(k); };
    for (const s of shares) {
      const g = get(keyOf(s)); addShare(g, s);
      if (s.kind !== 'task') g[s.kind] += total(s.tok);
      else if (by === 'model') g.attempts.add(s.attempt);
    }
    // an attempt counts under every model it used, and under its role and the day it began
    if (by !== 'model') for (const x of attemptsIn) get(by === 'role' ? x.role : dayOf(x.start)).attempts.add(x);
    out.rows = [...acc.entries()].map(([k, g]) => {
      const att = [...g.attempts];
      const accepted = att.filter(x => x.outcome === 'accept').length, rejected = att.filter(x => x.outcome === 'reject').length;
      const m = money(g);
      return {
        [by]: k, ...m, unboundTokens: g.unbound, probeTokens: g.probe,
        attempts: att.length, accepted, rejected, abandoned: att.filter(x => x.abandoned).length,
        acceptRate: accepted + rejected ? Math.round(accepted / (accepted + rejected) * 1000) / 1000 : null,
        ...(by === 'model' ? {
          notionalPerAccepted: accepted && m.notional !== null ? r6(m.notional / accepted) : null,
          attemptsPerAccepted: accepted ? Math.round(att.length / accepted * 100) / 100 : null,
        } : {}),
      };
    }).sort(by === 'day' ? (x, y) => cmp(x.day, y.day) : (x, y) => y.tokens - x.tokens || cmp(x[by], y[by]));
  }

  if (a.check) out.check = checkOf(B);
  return out;
}

/* The invariant: every token the sessions read is bound to a task, unbound, or a probe's, exactly,
 * since a step is split in whole tokens. Over everything, whatever the filters. */
function checkOf(B) {
  const parts = { task: [0, 0, 0, 0, 0], unbound: [0, 0, 0, 0, 0], probe: [0, 0, 0, 0, 0] };
  for (const s of B.shares) sum5(parts[s.kind], s.tok);
  const sum = sum5(sum5(parts.task.slice(), parts.unbound), parts.probe);
  const ok = sum.every((x, i) => x === B.sessions.tok[i]);
  return { ok, sessions: B.sessions.tok, bound: parts.task, unbound: parts.unbound, probes: parts.probe,
    sessionTotalsDiffer: B.sessions.totalsDiffer };
}

/** What one task cost, for hub task get; null when the hub holds no sessions or none touched it. */
export function taskCost(id) {
  if (!ledgerFiles().length) return null;
  const s = statsOf({ task: id }, false).task;
  if (!s || (!s.attempts && !s.tokens && !s.outcome)) return null;
  const { attemptList, title, status, ...rest } = s;
  return { ...rest, attemptList };
}
