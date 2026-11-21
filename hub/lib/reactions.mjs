/* reactions.mjs — event → action, run by the MCP server itself.
 *
 * `hub watch --as <name> --exec <cmd>` reacts to the journal, but only while a process of its own
 * keeps running, and somebody has to keep it running: a cron line, a unit file, a loop in a
 * terminal. A reaction nobody started reacts to nothing. The MCP server is already a process that
 * lives as long as each agent session does, so the reactions run there, on a tick.
 *
 * <hub>/reactions.json, declared by the owner or a project's head:
 *   { "commands": { "<id>": "<shell command>", ... },
 *     "rules": [ { "id": "<rule>", "by": "<owner or head>", "project": "<slug>",
 *                  "on": { "kind": "decision", "project": "relay", "agent": "...", "match": "^ACCEPT " }
 *                  | "every": "10m",
 *                  "run": "<command id>",
 *                  "queue": "<role>",                      optional: exit 0 + output → that role's queue
 *                  "heartbeat": { "agent": "<name>", "ttl": 15 },   optional: exit 0 → a heartbeat
 *                  "journal": "every" | "change",          default every
 *                  "node": "<node>" } ] }                   optional: only the servers of that node run it
 *
 * The file travels with the hub to every node, and each node has servers of its own: a rule with a
 * side effect outside the node (a branch deleted in a shared remote) names one `node`, or its
 * command has to be safe to run once per node.
 *
 * The boundary: a rule names a command by its id, and only the commands section holds command
 * text. Nothing from the journal is ever put into a command line; the entry reaches the command as
 * one JSON line on stdin, as data. A command that starts with `hub ` runs this hub's own CLI.
 *
 * A journal rule runs its command on each new matching entry, once (a cursor, as `hub watch --as`
 * keeps one). A command that does not exit 0 leaves the entry unmarked: the next tick hands it over
 * again, so a reaction that cannot act yet (the branch is not merged yet) is retried, not lost.
 * Exit 1 is that "not yet", silently; any other exit is a failure, journaled once per distinct cause.
 * Entries of kind `reaction` never trigger a rule, so no rule can feed on its own records.
 *
 * A periodic rule runs when its interval has passed. Exit 0: it fired (output → queue, a heartbeat).
 * Exit 1: nothing to do, silently, as `hub sense` says it. Anything else: a failure.
 *
 * One runner per rule per node: a lease in .reactions/<rule>.<node>.lease with the holder's pid and
 * an expiry, renewed every tick. Another server on the node takes it when the holder's pid is gone
 * or the lease has expired (a holder that hangs). Every firing, and every new failure, is a journal
 * line of kind `reaction` (`journal: "change"` writes only when the outcome changes, for a check
 * that runs every few minutes). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HUB, JOURNAL_NODE, now, readJson, atomicWrite, withLock, journalAppend, ensureLocalIgnores, ensureGitignored,
  roleRegistry, ownerRoles, slugify, runHeartbeat,
} from './core.mjs';
import { queueSend, pidAlive } from './queue.mjs';
import { watchExec, execEntry } from './watch.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
export const reactionsFile = () => path.join(HUB, 'reactions.json');
export const reactionsDir = () => path.join(HUB, '.reactions');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const OUT_MAX = 8000;
export const RUN_TIMEOUT_S = 300;

/** "30s" | "10m" | "24h" | "1d" → ms, or NaN. */
export function everyMs(s) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]] : NaN;
}

/** The declared rules, each with `problem` set when it cannot run (and why). Never throws. */
export function loadReactions() {
  const file = reactionsFile();
  if (!fs.existsSync(file)) return { file, exists: false, rules: [], commands: {}, problems: [] };
  let o;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { file, exists: true, rules: [], commands: {}, problems: [`reactions.json does not parse: ${e.message}`] };
  }
  const commands = (o && typeof o.commands === 'object' && o.commands) || {};
  const owners = new Set(ownerRoles().map(slugify));
  const reg = roleRegistry();
  const seen = new Set();
  const rules = (Array.isArray(o && o.rules) ? o.rules : []).map((r, i) => {
    const x = { ...(r || {}) };
    const bad = (why) => ({ ...x, id: x.id || `#${i + 1}`, problem: why });
    if (!ID_RE.test(String(x.id || ''))) return bad('id: letters, digits, - and _, up to 60');
    if (seen.has(x.id)) return bad('a second rule with this id');
    seen.add(x.id);
    if (typeof x.run !== 'string' || typeof commands[x.run] !== 'string' || !commands[x.run].trim())
      return bad(`run "${x.run}" is not a command declared in commands — a rule names a declared command, never a command line`);
    const by = slugify(x.by || '');
    const role = reg.get(by);
    const project = x.project ? slugify(x.project) : null;
    const may = owners.has(by) || (role && role.status !== 'off' && (role.rank === 'fleet' || (role.rank === 'head' && (!project || role.project === project))));
    if (!may) return bad(`by "${x.by || ''}": a rule is declared by an owner role, a fleet role, or the live head of its project`);
    const hasOn = x.on && typeof x.on === 'object', hasEvery = x.every != null;
    if (hasOn === hasEvery) return bad('a rule has either on (a journal entry) or every (an interval), not both and not neither');
    if (hasEvery && !(everyMs(x.every) >= 1000)) return bad(`every "${x.every}": a duration like 30s, 10m, 24h, 1d`);
    if (hasOn && x.on.match != null) { try { new RegExp(x.on.match); } catch { return bad(`on.match is not a regular expression: ${x.on.match}`); } }
    if (x.queue != null && !ID_RE.test(slugify(x.queue))) return bad(`queue "${x.queue}" is not a role name`);
    if (x.heartbeat != null && !(x.heartbeat && x.heartbeat.agent)) return bad('heartbeat needs an agent');
    if (x.journal != null && !['every', 'change'].includes(x.journal)) return bad('journal: every or change');
    if (x.node != null && !ID_RE.test(slugify(x.node))) return bad(`node "${x.node}" is not a node name`);
    return { ...x, project, command: commands[x.run], kindOf: hasOn ? 'journal' : 'every' };
  });
  return { file, exists: true, rules, commands, problems: [] };
}

/** Does a journal entry trigger a rule's `on`? Pure. */
export function matchesOn(on, e) {
  if (!e || e.kind === 'reaction') return false;
  if (on.kind && e.kind !== on.kind) return false;
  if (on.project && slugify(e.project || '') !== slugify(on.project)) return false;
  if (on.agent && e.agent !== on.agent) return false;
  if (on.match != null && !new RegExp(on.match).test(String(e.text || ''))) return false;
  return true;
}

/* ── the lease ── */
const leaseFile = (id, node = JOURNAL_NODE) => path.join(reactionsDir(), `${id}.${slugify(node)}.lease`);
const stateFile = (id, node = JOURNAL_NODE) => path.join(reactionsDir(), `${id}.${slugify(node)}.json`);
function ensureDir() {
  const d = reactionsDir();
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    if (!ensureLocalIgnores()) ensureGitignored('.reactions/');
  }
}

/** Take or renew the lease on one rule for this node. true when this process holds it.
 *  `ttlMs` is how long the lease stands without a renewal. */
export function takeLease(id, { pid = process.pid, ttlMs = 90000, nowMs = Date.now(), holder = '' } = {}) {
  ensureDir();
  const f = leaseFile(id);
  return withLock(f, () => {
    const cur = readJson(f, null);
    const mine = cur && cur.pid === pid;
    const free = !cur || mine || !(Date.parse(cur.until) > nowMs) || !pidAlive(cur.pid);
    if (!free) return false;
    atomicWrite(f, JSON.stringify({ rule: id, node: JOURNAL_NODE, pid, holder, since: mine ? cur.since : new Date(nowMs).toISOString(),
      until: new Date(nowMs + ttlMs).toISOString() }) + '\n');
    return true;
  });
}
export function readLease(id) { return readJson(leaseFile(id), null); }
export function releaseLeases(pid = process.pid) {
  let files = [];
  try { files = fs.readdirSync(reactionsDir()).filter(f => f.endsWith('.lease')); } catch { return; }
  for (const f of files) {
    const p = path.join(reactionsDir(), f);
    try { const cur = readJson(p, null); if (cur && cur.pid === pid) fs.unlinkSync(p); } catch {}
  }
}

/* ── one tick ── */
const cmdLine = (c) => (/^hub(\s|$)/.test(c.trim()) ? `"${process.execPath}" "${CLI}"${c.trim().slice(3)}` : c);
const firstLine = (s) => String(s || '').trim().split('\n')[0].slice(0, 160);

function record(r, text) {
  try { journalAppend({ ts: now(), project: r.project || 'general', agent: `reactions@${JOURNAL_NODE}`, kind: 'reaction', text: `${r.id}: ${text}` }); } catch {}
}
function afterSuccess(r, out) {
  const did = [];
  const body = String(out || '').trim();
  if (r.queue && body) {
    try { queueSend(slugify(r.queue), body.slice(0, OUT_MAX), { from: `reaction-${r.id}` }); did.push(`output → queue ${slugify(r.queue)}`); }
    catch (e) { did.push(`queue ${r.queue} refused: ${e.message}`); }
  }
  if (r.heartbeat) {
    try {
      runHeartbeat({ agent: r.heartbeat.agent, role: r.heartbeat.role || r.heartbeat.agent, status: firstLine(body) || 'check passed',
        ttlMin: Number(r.heartbeat.ttl) || 15 });
      did.push(`heartbeat ${r.heartbeat.agent}`);
    } catch (e) { did.push(`heartbeat refused: ${e.message}`); }
  }
  return did;
}

/** One pass over every rule this process can lease. Resolves to one row per rule:
 *  {id, outcome: 'fired'|'nothing'|'failed'|'held'|'invalid'|'waiting'|'elsewhere', detail}. */
export async function reactionsTick({ nowMs = Date.now(), leaseTtlMs = 90000, holder = '', timeoutS = RUN_TIMEOUT_S, stop = () => false } = {}) {
  const { rules, problems } = loadReactions();
  const rows = problems.map(p => ({ id: '-', outcome: 'invalid', detail: p }));
  if (!rules.length) return rows;
  ensureDir();
  const env = { HUBD_DIR: HUB };
  for (const r of rules) {
    if (stop()) break;
    if (r.problem) { rows.push({ id: r.id, outcome: 'invalid', detail: r.problem }); continue; }
    if (r.node && slugify(r.node) !== slugify(JOURNAL_NODE)) { rows.push({ id: r.id, outcome: 'elsewhere', detail: `runs on ${r.node}` }); continue; }
    if (!takeLease(r.id, { ttlMs: leaseTtlMs, nowMs, holder })) {
      const l = readLease(r.id);
      rows.push({ id: r.id, outcome: 'held', detail: l ? `by pid ${l.pid} until ${l.until}` : 'by another process' });
      continue;
    }
    const sf = stateFile(r.id);
    const st = readJson(sf, {});
    const ruleEnv = { ...env, HUBD_AGENT: `reaction-${r.id}`, HUBD_REACTION: r.id };
    if (r.kindOf === 'journal') {
      const fired = [];
      let res;
      try {
        res = await watchExec({ name: `reaction-${r.id}-${slugify(JOURNAL_NODE)}`, cmd: cmdLine(r.command), match: (e) => matchesOn(r.on, e),
          capture: true, env: ruleEnv, cwd: HUB, timeoutS, includePrivate: false, stop,
          onDone: (e, key, out) => {
            const did = afterSuccess(r, out);
            fired.push(e);
            record(r, `fired on ${e.kind || 'entry'} ${e.ts} by ${e.agent || '?'} ("${firstLine(e.text).slice(0, 80)}")` +
              (firstLine(out) ? ` → ${firstLine(out)}` : '') + (did.length ? `; ${did.join('; ')}` : ''));
          } });
      } catch (e) { res = { failed: { why: e.message, key: 'error' } }; }
      if (res.failed && res.failed.why === 'exited 1') {
        // exit 1: cannot act on it yet (the branch is not merged yet) — waiting, not a failure
        rows.push({ id: r.id, outcome: 'waiting', detail: firstLine(res.failed.out) || `the entry of ${res.failed.ts || '?'} is handed over again next tick`, fired: fired.length });
      } else if (res.failed) {
        const sig = `${res.failed.key}|${res.failed.why}`;
        if (st.lastFail !== sig) {
          st.lastFail = sig;
          record(r, `FAILED on the entry of ${res.failed.ts || '?'} (${res.failed.why})` + (firstLine(res.failed.out) ? `: ${firstLine(res.failed.out)}` : '') +
            '; it is handed over again on the next tick');
        }
        rows.push({ id: r.id, outcome: 'failed', detail: res.failed.why, fired: fired.length });
      } else {
        if (fired.length) delete st.lastFail;
        rows.push({ id: r.id, outcome: fired.length ? 'fired' : 'nothing', detail: fired.length ? `${fired.length} entr${fired.length === 1 ? 'y' : 'ies'}` : '' });
      }
      st.at = new Date(nowMs).toISOString();
      atomicWrite(sf, JSON.stringify(st) + '\n');
      continue;
    }
    // periodic
    const due = !st.last || nowMs - Date.parse(st.last) >= everyMs(r.every);
    if (!due) { rows.push({ id: r.id, outcome: 'waiting', detail: `next after ${new Date(Date.parse(st.last) + everyMs(r.every)).toISOString()}` }); continue; }
    st.last = new Date(nowMs).toISOString();
    atomicWrite(sf, JSON.stringify(st) + '\n');   // claimed before it runs: a crash mid-run does not rerun it at once
    const cap = {};
    const why = await execEntry(cmdLine(r.command), { rule: r.id, ts: now() }, `${r.id}:${st.last}`, { timeoutS, capture: cap, env: ruleEnv, cwd: HUB });
    let outcome, detail;
    if (!why) {
      const did = afterSuccess(r, cap.out);
      outcome = 'fired'; detail = [firstLine(cap.out), ...did].filter(Boolean).join('; ');
    } else if (why === 'exited 1') { outcome = 'nothing'; detail = ''; }
    else { outcome = 'failed'; detail = why + (firstLine(cap.out) ? `: ${firstLine(cap.out)}` : ''); }
    const changed = st.outcome !== outcome;
    if (outcome === 'fired' && (r.journal !== 'change' || changed)) record(r, `fired${detail ? ' → ' + detail : ''}`);
    if (outcome === 'failed' && st.lastFail !== detail) record(r, `FAILED (${detail})`);
    if (outcome === 'nothing' && r.journal === 'change' && changed && st.outcome) record(r, 'nothing to do (was ' + st.outcome + ')');
    if (outcome === 'failed') st.lastFail = detail; else delete st.lastFail;
    st.outcome = outcome;
    atomicWrite(sf, JSON.stringify(st) + '\n');
    rows.push({ id: r.id, outcome, detail });
  }
  return rows;
}

/** What `hub reactions` shows: each rule, whether it can run, who holds it, how it last went. */
export function reactionsStatus() {
  const { file, exists, rules, problems } = loadReactions();
  return {
    file, exists, problems,
    rules: rules.map(r => {
      const l = r.problem ? null : readLease(r.id);
      const s = r.problem ? {} : readJson(stateFile(r.id), {});
      return { id: r.id, by: r.by || null, trigger: r.on ? { on: r.on } : { every: r.every }, run: r.run, problem: r.problem || null,
        lease: l ? { pid: l.pid, until: l.until, alive: Date.parse(l.until) > Date.now() && pidAlive(l.pid) } : null,
        last: s.last || s.at || null, outcome: s.outcome || null, failing: s.lastFail || null };
    }),
  };
}

/** The tick, on a timer, for a long-running process (the MCP server). Off when HUBD_REACTIONS=0.
 *  Returns a stop function. The timer never keeps the process alive on its own. */
export function startReactions({ tickS = Number(process.env.HUBD_REACTIONS_TICK_S) || 30, log = () => {}, holder = 'mcp' } = {}) {
  if (process.env.HUBD_REACTIONS === '0') return () => {};
  let busy = false, stopped = false;
  const tickMs = Math.max(1, tickS) * 1000;
  const tick = async () => {
    if (busy || stopped || !fs.existsSync(reactionsFile())) return;
    busy = true;
    try { await reactionsTick({ leaseTtlMs: Math.max(3 * tickMs, 15000), holder, stop: () => stopped }); }
    catch (e) { log(`reactions: ${e.message}`); }
    finally { busy = false; }
  };
  const t = setInterval(tick, tickMs);
  t.unref();
  setTimeout(tick, 200).unref();
  const end = () => { stopped = true; clearInterval(t); try { releaseLeases(); } catch {} };
  process.once('exit', end);
  return end;
}
