/* sessions.mjs — `hub sessions ingest`: what an agent client's own database says its sessions did
 * and cost, one ledger line per session, for `hub stats` to bind to tasks. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonProject, HUB, JOURNAL_NODE, nodeKey, shareMode, withLock } from './core.mjs';

/* ── The ledger ──
 *
 * The hub knew who did what, and what it cost only when a caller said so (hub_usage_add). The
 * client knows exactly: opencode keeps every session in a sqlite database, each step with its
 * five token counts and its price, each tool call with its input and output, and each message a
 * role received, the orders from the hub's queues among them. So the hub reads that database and
 * keeps, per session, the facts that do not depend on any other session: when it ran, under which
 * role, the orders it received, the steps it took by model, and the tasks it closed. Which task a
 * step worked on depends on the sessions before it, so that is computed when the ledger is read
 * (stats.mjs), and a change to the rule never needs the database again.
 *
 * Nothing a session said is kept: no prompt, no answer, no tool output. Texts are read for the
 * queue headers in them and hashed to tell a repeated call; the rest of every row is dropped as it
 * is read. A database is opened read-only.
 *
 * ledger.<node>.jsonl, one writer per node and append-only, like the journal, and mesh-synced: the
 * cost of a fleet is a question for the whole fleet. A session that changed since it was taken in
 * is appended again, whole; the reader keeps the version with the newest `v`. */
export const LEDGER_RE = /^ledger\..+\.jsonl$/;
export function ledgerFile() { return path.join(HUB, `ledger.${JOURNAL_NODE}.jsonl`); }
export function ledgerFiles() {
  try { return fs.readdirSync(HUB).filter(f => LEDGER_RE.test(f)).sort().map(f => path.join(HUB, f)); }
  catch { return []; }
}

/** Every session in the ledger, its newest version only, oldest first. */
export function readLedger() {
  const best = new Map();
  for (const f of ledgerFiles()) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r || typeof r.id !== 'string') continue;
      const cur = best.get(r.id);
      if (!cur || r.v > cur.v) best.set(r.id, r);
    }
  }
  return [...best.values()].sort((a, b) => a.t0 - b.t0 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ── Reading a client's rows ──
 * opencode's tables: session (one row, totals included), message and part, each with a JSON
 * `data`. A message's data says its role, agent, model and error; a part is a step's start or
 * finish (tokens and cost), a tool call (tool, input, output), reasoning or text. */
const json = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/* A queue block's header as queueSend writes it, wherever it sits in a message: a role's loop
 * hands the block over with its header, and several blocks can arrive in one message. */
const HEADER_RE = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from ([^\n·]+?)(?: · id ((?:[a-z0-9_-]+-)?\d+))?((?: · task #[^\s·]+)+)?\s*$/gm;
export function ordersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(HEADER_RE)) {
    if (!m[3]) continue;
    for (const r of m[3].matchAll(/task #([^\s·]+)/g)) {
      out.push({ ref: r[1].replace(/[,;.]+$/, ''), from: m[1].trim(), ...(m[2] ? { block: m[2] } : {}) });
    }
  }
  return out;
}

/* A hub tool as the client names it: opencode prefixes an MCP tool with its server's name, so
 * hub_report arrives as "hubd_hub_report", or as whatever the server was called there. */
const hubTool = (name) => { const m = /(?:^|_)hub_([a-z_]+)$/.exec(String(name || '')); return m ? m[1] : null; };

/** One part, down to what the ledger needs. */
export function thinPart(row) {
  const d = json(row.data);
  const p = { id: String(row.id), msg: String(row.message_id), at: num(row.time_created), type: d.type };
  if (d.type === 'step-finish') {
    const t = d.tokens || {};
    p.tok = [num(t.input), num(t.output), num(t.reasoning), num(t.cache && t.cache.read), num(t.cache && t.cache.write)];
    p.cost = num(d.cost);
  } else if (d.type === 'tool') {
    const st = d.state || {};
    p.tool = String(d.tool || '');
    const out = typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? null);
    p.h = hash(p.tool + '\0' + JSON.stringify(st.input ?? null) + '\0' + out);
    const ht = hubTool(p.tool);
    if (ht && st.status === 'completed') {
      const inp = st.input || {}, o = json(out);
      p.hub = ht;
      if (inp.project || o.project) p.project = String(inp.project || o.project);
      // what the hub closed: hub_report says it in `done`; hub_task_update in the task it returns
      if (ht === 'report' && Array.isArray(o.done)) p.closed = o.done.map(String);
      if (ht === 'task_update' && inp.status === 'done' && o.ok) p.closed = [String((o.task && o.task.id) || inp.id)];
      if (st.time && st.time.end) p.at = num(st.time.end);
    }
  } else if (d.type === 'text') {
    const o = ordersIn(d.text);
    if (o.length) p.orders = o;
  }
  return p;
}

/** One message, down to what the ledger needs. */
export function thinMessage(row) {
  const d = json(row.data);
  const model = d.role === 'assistant' ? [d.providerID, d.modelID] : [d.model && d.model.providerID, d.model && d.model.modelID];
  return {
    id: String(row.id), at: num(row.time_created), role: d.role || null, agent: d.agent || d.mode || null,
    model: model[1] ? (model[0] ? model[0] + '/' : '') + model[1] : null, error: !!d.error,
  };
}

const byAt = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A session's ledger line, from its session row and its thinned messages and parts. */
export function summarizeSession(s, msgs, parts, { node, db }) {
  msgs = msgs.slice().sort(byAt);
  const partsOf = new Map();
  for (const p of parts) { if (!partsOf.has(p.msg)) partsOf.set(p.msg, []); partsOf.get(p.msg).push(p); }
  for (const l of partsOf.values()) l.sort(byAt);

  const log = [];
  let seg = null, project = null, run = { h: null, n: 0 }, pending = { ids: [], at: 0 };
  const flush = () => { if (seg && (seg.steps || seg.tools || seg.errors)) log.push({ seg }); seg = null; };
  const segOf = (model, at) => {
    if (!seg || seg.model !== model) {
      flush();
      seg = { model, t0: at, t1: at, steps: 0, tools: 0, invalid: 0, repeats: 0, errors: 0, tok: [0, 0, 0, 0, 0], paid: 0 };
    }
    if (at > seg.t1) seg.t1 = at;
    return seg;
  };
  // A close takes effect after the step that made it: that step worked on the task it closed.
  const closeNow = () => { if (pending.ids.length) { flush(); log.push({ close: [...new Set(pending.ids)], at: pending.at }); pending = { ids: [], at: 0 }; } };
  let toolCalls = 0, orders = 0;
  // the role: the session's own agent, else the agent its first assistant message, or failing
  // that its first message, ran under
  const agent = s.agent || (msgs.find(m => m.role === 'assistant' && m.agent) || msgs.find(m => m.agent) || {}).agent || null;
  for (const m of msgs) {
    const ps = partsOf.get(m.id) || [];
    if (m.role === 'user') {
      closeNow();
      const o = ps.flatMap(p => p.orders || []);
      if (o.length) { flush(); log.push({ order: o, at: m.at }); orders++; }
      continue;
    }
    if (m.role !== 'assistant') continue;
    const model = m.model || 'unknown';
    if (m.error) segOf(model, m.at).errors++;
    for (const p of ps) {
      if (p.type === 'step-finish') {
        const g = segOf(model, p.at);
        g.steps++;
        for (let i = 0; i < 5; i++) g.tok[i] += p.tok[i];
        g.paid += p.cost;
        closeNow();
      } else if (p.type === 'tool') {
        const g = segOf(model, p.at);
        g.tools++; toolCalls++;
        if (p.tool === 'invalid') g.invalid++;
        // a run of the same call with the same result: from the third on, each one is waste,
        // and the second with it
        if (p.h === run.h) { run.n++; if (run.n === 3) g.repeats += 2; else if (run.n > 3) g.repeats++; }
        else run = { h: p.h, n: 1 };
        if (p.project && !project) project = p.project;
        if (p.closed && p.closed.length) { pending.ids.push(...p.closed); pending.at = p.at; }
      }
    }
    closeNow();
  }
  flush();
  for (const e of log) if (e.seg) e.seg.paid = Math.round(e.seg.paid * 1e9) / 1e9;
  const probe = !toolCalls && !orders && msgs.length <= 2;
  return {
    id: String(s.id), v: num(s.time_updated), node, db, agent: agent || null,
    parent: s.parent_id || null, project: project ? canonProject(project) : null,
    t0: num(s.time_created), t1: num(s.time_updated), kind: probe ? 'probe' : 'work', msgs: msgs.length,
    tot: [num(s.tokens_input), num(s.tokens_output), num(s.tokens_reasoning), num(s.tokens_cache_read), num(s.tokens_cache_write)],
    paid: Math.round(num(s.cost) * 1e9) / 1e9,
    log,
  };
}

/* ── Sources ── */

/* node:sqlite came with Node 22.5 behind a flag and without one in 22.13; this package runs on 18.
 * An older Node is refused with the other way in: rows exported by whatever can read the file. */
async function openSqlite(file) {
  if (!fs.existsSync(file)) throw new Error(`--opencode ${file}: no such file`);
  let sqlite;
  const warn = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w && w.message || w)) ? undefined : warn.call(process, w, ...rest));
  try { sqlite = await import('node:sqlite'); }
  catch { throw new Error(`--opencode needs node:sqlite, in Node 22.13 and later; this is Node ${process.versions.node}. Export the rows as JSONL ({"table": "session"|"message"|"part", "row": {...}}) and pass them with --rows.`); }
  finally { process.emitWarning = warn; }
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

function* fromSqlite(db, wanted) {
  const sessions = db.prepare('SELECT * FROM session').all();
  const msgQ = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ?');
  const partQ = db.prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ?');
  for (const s of sessions) {
    if (!wanted(s)) { yield { s, skip: true }; continue; }
    yield { s, msgs: msgQ.all(s.id).map(thinMessage), parts: partQ.all(s.id).map(thinPart) };
  }
}

function* fromRows(text, wanted) {
  const sessions = new Map(), msgs = new Map(), parts = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  let n = 0;
  for (const l of text.split('\n')) {
    n++;
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { throw new Error(`--rows: line ${n} is not JSON`); }
    const r = o && o.row;
    if (!r) continue;
    if (o.table === 'session') sessions.set(String(r.id), r);
    else if (o.table === 'message') push(msgs, String(r.session_id), thinMessage(r));
    else if (o.table === 'part') push(parts, String(r.session_id), thinPart(r));
  }
  for (const s of sessions.values()) {
    if (!wanted(s)) { yield { s, skip: true }; continue; }
    yield { s, msgs: msgs.get(String(s.id)) || [], parts: parts.get(String(s.id)) || [] };
  }
}

/** hub sessions ingest: read a client's sessions, append the new and the changed to the ledger. */
export async function runSessionsIngest(a = {}) {
  if (!a.opencode === !a.rows) throw new Error('say where the sessions are: --opencode <opencode.db> or --rows <file|->');
  const node = nodeKey(a.node || JOURNAL_NODE);
  const db = String(a.db || os.userInfo().username || 'default');
  const have = new Map();
  for (const r of readLedger()) have.set(r.id, r.v);
  const wanted = (s) => !(have.has(String(s.id)) && have.get(String(s.id)) >= num(s.time_updated));
  let src, handle = null;
  if (a.opencode) { handle = await openSqlite(a.opencode); src = fromSqlite(handle, wanted); }
  else src = fromRows(a.rows === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a.rows, 'utf8'), wanted);
  const out = [], counts = { sessions: 0, unchanged: 0, added: 0, updated: 0, probes: 0 };
  try {
    for (const { s, skip, msgs, parts } of src) {
      counts.sessions++;
      if (skip) { counts.unchanged++; continue; }
      const row = summarizeSession(s, msgs, parts, { node, db });
      out.push(row);
      have.has(row.id) ? counts.updated++ : counts.added++;
      if (row.kind === 'probe') counts.probes++;
    }
  } finally { if (handle) try { handle.close(); } catch {} }
  out.sort((x, y) => x.t0 - y.t0 || (x.id < y.id ? -1 : 1));
  if (out.length && !a.dry) {
    const f = ledgerFile();
    withLock(f, () => { fs.appendFileSync(f, out.map(r => JSON.stringify(r)).join('\n') + '\n'); });
    shareMode(f);
  }
  return { ok: true, node, db, ...counts, written: a.dry ? 0 : out.length, dry: !!a.dry, file: a.dry ? null : ledgerFile() };
}
