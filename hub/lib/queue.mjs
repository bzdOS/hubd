/**
 * queue.mjs — Node.js port of queue/qsend.py and queue/qwait.py.
 * Zero external dependencies (Node stdlib only).
 *
 * On-disk format:
 *   queues/<role>.<node>.queue.md — PER-HOST append-only markdown blocks.
 *     Each machine appends only to its OWN file (like journal.<node>.jsonl and
 *     tasks.<node>.events.jsonl), so several machines syncing one hub never
 *     collide on a queue — no git merge conflict, so mesh-sync never aborts on
 *     queues, so cross-node delivery actually works. (The legacy shared file
 *     queues/<role>.queue.md is still READ for back-compat, never written.)
 *   .qstate/<file>.offset — byte offset of the last-read position, PER source
 *     file. Local to the node (.qstate/ is gitignored).
 *
 * Block format:
 *   \n## YYYY-MM-DD HH:MM · from <sender>\n<text>\n
 *
 * Why per-host: a single shared queues/<role>.queue.md is shared mutable state;
 * two offline nodes appending both edit the same file → git merge conflict →
 * mesh-sync aborts → the waiting node never sees the message. Per-host files are
 * conflict-free by construction (single writer each), and the byte offset stays
 * valid because each file only ever grows by clean append from one writer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HUB, loadPresence, ownerRoles, parseTs, recordEnvObservation, clearEnvObservation, requireAuthor, withLock } from './core.mjs';

// A directory is a hubd TEAM ROOT only if it holds a hub-DATA file that a plain
// code checkout never has. NOT `.git` (that is a code repo, not a hub) and NOT a
// bare `queues/` — a MISROUTED send creates exactly `queues/<role>.<node>.queue.md`
// and nothing else, so `queues/` is precisely the false-positive we must reject.
// (This is the bug that silently wrote a handoff into a source repo's queues/
// instead of the real hub, and the waiting node never saw it.)
const HUB_DATA_FILES = ['sections.json', 'tasks.json', 'claims.json', 'HUBD.md'];
function isHubRoot(d) {
  if (HUB_DATA_FILES.some(f => fs.existsSync(path.join(d, f)))) return true;
  try { return fs.readdirSync(d).some(f => /^journal.*\.jsonl$/.test(f)); }
  catch { return false; }
}

let _warnedFallback = false;

/**
 * Resolve the queue root directory, returning both the path and how it was found.
 *
 * Priority:
 *   1. HUBD_TEAM_DIR (or legacy HUBD_QUEUE_DIR) env var                         -> via "env"
 *   2. Walk UP from process.cwd() (max 8 levels): first dir that is a real hub
 *      (has hub DATA — sections/tasks/claims/HUBD/journal, NOT just .git|queues/) -> via "walk-up"
 *   3. Fall back to HUB (~/.hubd)                                                -> via "fallback"
 *
 * On fallback from inside a git repo (a likely misroute site) warn ONCE to stderr,
 * so a queue silently landing in ~/.hubd instead of the repo is visible.
 *
 * @returns {{ root: string, via: 'env' | 'walk-up' | 'fallback' }}
 */
export function resolveQueueRootInfo() {
  const env = process.env.HUBD_TEAM_DIR || process.env.HUBD_QUEUE_DIR;
  if (env) return { root: env, via: 'env' };

  let d = process.cwd();
  let sawRepo = false;
  for (let i = 0; i < 8; i++) {
    if (isHubRoot(d)) return { root: d, via: 'walk-up' };
    if (fs.existsSync(path.join(d, '.git'))) sawRepo = true;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }

  if (sawRepo && !_warnedFallback) {
    _warnedFallback = true;
    process.stderr.write(
      `hubd: cwd is inside a git repo but no hub found above it — using ${HUB}. ` +
      `Set HUBD_TEAM_DIR to be explicit.\n`);
  }
  return { root: HUB, via: 'fallback' };
}

/**
 * Resolve the queue root directory.
 * @returns {string}
 */
export function resolveQueueRoot() {
  return resolveQueueRootInfo().root;
}

/** This node's short name (first hostname component), matching mesh-sync's NODE. */
/**
 * Roles whose queue fans out: every subscriber sees every message.
 *
 * The default stays a COMPETING-WORKER queue — one message to exactly one reader —
 * because that is what the queue has always been and what task dispatch relies on.
 * Fan-out cannot be inferred from the transport: giving each session its own cursor
 * whenever the caller happens to be a long-lived server would silently turn every
 * work queue into a broadcast, and two sessions would both do the same task and both
 * claim it. Which of the two a role is, is a property of the ROLE, declared once —
 * same shape and spirit as HUB/owner-roles.json.
 *
 * <queue-root>/subscriber-roles.json: ["architect", "cto"]
 */
export function subscriberRoles(root) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(root, 'subscriber-roles.json'), 'utf8'));
    return Array.isArray(arr) ? arr.filter(r => typeof r === 'string' && r) : [];
  } catch { return []; }
}

function nodeName() {
  try { return (os.hostname() || 'node').split('.')[0] || 'node'; }
  catch { return 'node'; }
}

/**
 * Deliver everything past `f`'s cursor and advance it — atomically w.r.t. other
 * waiters on the SAME cursor. Without the lock, two competing workers polling one
 * shared cursor could both see size > offset in the same instant and both deliver
 * the block: "goes to exactly one of them" held by timing luck, not construction.
 * The lock scope is one offset file for the few ms of a read; a contended or stale
 * lock skips this file for THIS poll (the next poll retries) instead of failing the
 * wait. Subscribers pay the same negligible cost for no benefit (their cursor has no
 * competitor by construction) — one code path beats two. Returns the new text, or
 * null when there is nothing new.
 */
function drainFile(qdir, stateDir, f) {
  const offFile = path.join(stateDir, `${f}.offset`);
  const readOff = () => { try { return parseInt(fs.readFileSync(offFile, 'utf8').trim(), 10) || 0; } catch { return 0; } };
  const sizeOf = () => { try { return fs.statSync(path.join(qdir, f)).size; } catch { return 0; } };
  if (sizeOf() === readOff()) return null;            // nothing new — don't even lock
  try {
    return withLock(offFile, () => {
      const off = readOff(), sz = sizeOf();           // re-read under the lock
      if (sz < off) { fs.writeFileSync(offFile, '0', 'utf8'); return null; }   // truncated/recreated — reset
      if (sz === off) return null;                    // a competitor drained it first
      const fd = fs.openSync(path.join(qdir, f), 'r');
      const buf = Buffer.allocUnsafe(sz - off);
      fs.readSync(fd, buf, 0, sz - off, off);
      fs.closeSync(fd);
      fs.writeFileSync(offFile, String(sz), 'utf8');
      return buf.toString('utf8').trim() || null;
    });
  } catch { return null; }                            // lock busy — skip this poll, retry next
}

/**
 * Append a message block to <root>/queues/<role>.<node>.queue.md (this node's
 * own file). Creates the queues/ directory if it does not exist.
 * Returns the path to the queue file.
 *
 * @param {string} role
 * @param {string} text
 * @param {{ from: string, root?: string, node?: string }} options
 * @returns {string} path to the queue file
 */
/* Which task a message is about. A HOLD reply to a task once sat consumed in a queue while the
 * task itself stayed plain open/high with no trace of the blocker for four days — the reply and
 * the task had no way to reference each other. So a sender may name the task, the reference is
 * stamped into the block header (durable, mesh-synced, and still matching the header pattern
 * every reader already uses), and a consumer gets the ids back with the text so it can report
 * against them instead of guessing what the message was about. */
export const TASK_REF_RE = /·\s*task\s*#([^\s·]+)/gi;
export function parseTaskRefs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TASK_REF_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function queueSend(role, text, { from, root, node, task } = {}) {
  // A queue block is a durable, mesh-synced write that says "from <sender>" forever —
  // so the sender is held to the same rule as every other author. This used to default
  // to 'unknown' (CLI) / 'mcp' (server): exactly the placeholders requireAuthor refuses
  // everywhere else, on the one durable channel that skipped the rule. The MCP floor
  // (HUBD_AGENT) fills an omitted `from` before it reaches here.
  const sender = requireAuthor(from, 'from');
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  fs.mkdirSync(qdir, { recursive: true });
  const nd = node || nodeName();
  const qfile = path.join(qdir, `${role}.${nd}.queue.md`);

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  // The task ref goes AFTER "from <sender>", so the header still matches the `## <ts> · from `
  // prefix every existing reader (peekQueueDepth, doctor, the archive) keys on.
  const ref = (task ?? '') !== '' ? ` · task #${String(task).trim()}` : '';
  const entry = `\n## ${ts} · from ${sender}${ref}\n${String(text).trim()}\n`;

  // append is atomic on POSIX for small writes (same guarantee as Python version)
  fs.appendFileSync(qfile, entry, 'utf8');
  return qfile;
}

/**
 * Block until new content appears in ANY of this role's queue files
 * (<role>.<node>.queue.md for every node, plus the legacy <role>.queue.md).
 *
 *   - Per-file byte offset in <root>/.qstate/<file>.offset.
 *   - Each poll: for every source file, deliver bytes past its offset; if a file
 *     shrank (truncated/recreated) reset that file's offset to 0.
 *   - New content from several files in one poll is concatenated.
 *   - Poll every 2000 ms until `timeout` seconds elapse.
 *
 * Single-consumer guard: advisory warning if another live waiter is detected
 *   (marker <root>/.qstate/<role>.waiter, refreshed each poll, removed on exit).
 *
 * @param {string} role
 * @param {{ timeout?: number, root?: string }} options
 * @returns {Promise<{ changed: true, text: string } | { changed: false }>}
 */
export async function queueWait(role, { timeout = 540, root, subscriber } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  // A subscriber gets its OWN cursor namespace, the same trick queueWaitAll already
  // uses for __watchall__: several sessions can then subscribe to one role without
  // consuming each other's messages. Two conditions, both required: the caller has an
  // identity to be a subscriber WITH, and the role is declared a fan-out role. Absent
  // either, the cursor stays where it has always been — shared per node — so competing
  // workers keep at-most-once delivery and existing offsets keep working.
  const declared = subscriberRoles(r).includes(role);
  const fanout = !!subscriber && declared;
  const stateDir = fanout ? path.join(r, '.qstate', subscriber) : path.join(r, '.qstate');
  // Declaring the role is the fix for the conflict recorded below; once declared, stop
  // reporting it. Cheap: clearEnvObservation only writes when it actually holds one.
  if (declared) clearEnvObservation('cursor-conflict', role);

  fs.mkdirSync(qdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Ensure this node's own file exists (so a fresh waiter has a file to track).
  const ownFile = path.join(qdir, `${role}.${nodeName()}.queue.md`);
  if (!fs.existsSync(ownFile)) fs.writeFileSync(ownFile, '', 'utf8');

  // Match <role>.queue.md (legacy) and <role>.<node>.queue.md (per-host). Node
  // names have no dots, so a single optional [^.]+ segment is exact per role.
  const esc = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fileRe = new RegExp(`^${esc}(\\.[^.]+)?\\.queue\\.md$`);
  const waiterFile = path.join(stateDir, `${role}.waiter`);

  const sourceFiles = () => {
    try { return fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return []; }
  };

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }
  function writeWaiter() {
    fs.writeFileSync(waiterFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), 'utf8');
  }

  // Single-consumer guard: warn if a fresh, live competing waiter exists.
  try {
    const w = JSON.parse(fs.readFileSync(waiterFile, 'utf8'));
    if (w.pid !== process.pid && (Date.now() - new Date(w.since).getTime()) < 10000 && pidAlive(w.pid)) {
      // Sharing a cursor is the conflict, not sharing a role: distinct subscribers
      // have their own cursor namespace and never reach this warning.
      process.stderr.write(`warning: another waiter (pid ${w.pid}) shares this cursor — one live consumer per cursor\n`);
      // stderr is invisible to an MCP client, so this used to be a warning nobody read.
      // Record it: an env check turns it into "declare the role, or run one waiter".
      if (!declared) recordEnvObservation('cursor-conflict', role);
    }
  } catch { /* no marker or unreadable — fine */ }

  writeWaiter();
  try {
    const deadline = Date.now() + timeout * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parts = [];
      for (const f of sourceFiles()) {
        const t = drainFile(qdir, stateDir, f);
        if (t) parts.push(t);
      }
      if (parts.length) {
        const text = parts.join('\n').trim();
        const tasks = parseTaskRefs(text);
        return { changed: true, text, ...(tasks.length ? { tasks } : {}) };
      }
      if (Date.now() >= deadline) return { changed: false };

      writeWaiter();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    try { fs.unlinkSync(waiterFile); } catch {}
  }
}

/**
 * Block until new content appears in ANY queue file, across every role — a
 * supervisory subscription for an orchestrator that reacts to whichever agent
 * reports first, instead of polling role-by-role or ssh-ing into each host to
 * check.
 *
 * NOT the same consumer as a role's own `queueWait(role)` — this uses a
 * SEPARATE offset namespace (.qstate/__watchall__/<file>.offset), so watching
 * everything never steals a message from a role's own consumer (a competing-worker
 * role keeps its at-most-once delivery; this is a tap, not a competing reader).
 *
 * A tap is a subscriber by definition, so a `subscriber` here always gets its own
 * cursor and needs no role declaration: several orchestrators may watch the fleet at
 * once, and none of them consumes from anyone.
 *
 * @param {{ timeout?: number, root?: string }} options
 * @returns {Promise<{ changed: true, events: Array<{ role: string, node: string|null, text: string }> } | { changed: false }>}
 */
export async function queueWaitAll({ timeout = 540, root, subscriber } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  // Same reasoning as queueWait: __watchall__ already keeps taps off a role's own
  // consumer, but two orchestrators tapping at once still shared one cursor.
  const stateDir = subscriber
    ? path.join(r, '.qstate', '__watchall__', subscriber)
    : path.join(r, '.qstate', '__watchall__');

  fs.mkdirSync(qdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Any <role>.queue.md or <role>.<node>.queue.md — no role filter.
  const fileRe = /^[^.]+(\.[^.]+)?\.queue\.md$/;
  const waiterFile = path.join(stateDir, 'waiter');

  const sourceFiles = () => {
    try { return fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return []; }
  };

  function parseFile(f) {
    const m = f.match(/^(.+?)(?:\.([^.]+))?\.queue\.md$/);
    return m ? { role: m[1], node: m[2] || null } : { role: f, node: null };
  }

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }
  function writeWaiter() {
    fs.writeFileSync(waiterFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), 'utf8');
  }

  try {
    const w = JSON.parse(fs.readFileSync(waiterFile, 'utf8'));
    if (w.pid !== process.pid && (Date.now() - new Date(w.since).getTime()) < 10000 && pidAlive(w.pid)) {
      process.stderr.write(`warning: another all-queues waiter (pid ${w.pid}) is active\n`);
    }
  } catch { /* no marker or unreadable — fine */ }

  writeWaiter();
  try {
    const deadline = Date.now() + timeout * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const events = [];
      for (const f of sourceFiles()) {
        const t = drainFile(qdir, stateDir, f);
        if (t) {
          const { role, node } = parseFile(f);
          const tasks = parseTaskRefs(t);
          events.push({ role, node, text: t, ...(tasks.length ? { tasks } : {}) });
        }
      }
      if (events.length) return { changed: true, events };
      if (Date.now() >= deadline) return { changed: false };

      writeWaiter();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    try { fs.unlinkSync(waiterFile); } catch {}
  }
}

/**
 * Non-consuming peek at how many messages are waiting in a role's queue — for
 * hub_brief/hub_presence to show "N queued for role X" without stealing from
 * the role's own hub_queue_wait consumer. Reads the SAME per-file byte offsets
 * queueWait uses (.qstate/<file>.offset) but never writes them back, so calling
 * this never advances anyone's read position.
 *
 * @param {string} role
 * @param {{ root?: string }} options
 * @returns {{ pending: number, oldestWaiting: string|null }}
 */
export function peekQueueDepth(role, { root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');
  const esc = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fileRe = new RegExp(`^${esc}(\\.[^.]+)?\\.queue\\.md$`);
  let files;
  try { files = fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return { pending: 0, oldestWaiting: null }; }

  let pending = 0, oldest = null;
  for (const f of files) {
    let off = 0; try { off = parseInt(fs.readFileSync(path.join(stateDir, `${f}.offset`), 'utf8').trim(), 10) || 0; } catch {}
    let size = 0; try { size = fs.statSync(path.join(qdir, f)).size; } catch {}
    if (size <= off) continue;
    const fd = fs.openSync(path.join(qdir, f), 'r');
    const buf = Buffer.allocUnsafe(size - off);
    fs.readSync(fd, buf, 0, size - off, off);
    fs.closeSync(fd);
    // Match the FULL block header (incl. "· from") that queueSend writes — a bare
    // timestamp pattern also matched such a line quoted inside a message body and
    // inflated the count.
    const heads = buf.toString('utf8').match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm) || [];
    pending += heads.length;
    for (const h of heads) {
      const ts = h.slice(3, 19);
      if (!oldest || ts < oldest) oldest = ts;
    }
  }
  return { pending, oldestWaiting: oldest };
}

/**
 * Every role's queue depth in one call, cross-referenced with presence
 * (core.mjs's fleet registry) so a brief can show "N queued for role X, agent
 * last-seen T" — visibility into delivery without screen-scraping to check who
 * is even listening. Roles are discovered from queue FILENAMES: a role only
 * shows up once something has been sent to it at least once. Rows with nothing
 * pending and no known presence are dropped — this augments hub_brief's recent-
 * attention view, not a permanent roster (that's hub_presence).
 *
 * @param {{ root?: string }} options
 * @returns {Array<{ role: string, pending: number, oldestWaiting: string|null, lastSeen: string|null }>}
 */
export function queueSummaryForBrief({ root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  let files;
  try { files = fs.readdirSync(qdir).filter(f => /\.queue\.md$/.test(f)); } catch { return []; }

  const roles = new Set();
  for (const f of files) {
    const m = f.match(/^(.+?)(?:\.[^.]+)?\.queue\.md$/);
    if (m) roles.add(m[1]);
  }

  let presence = [];
  try { presence = loadPresence(); } catch {}
  const owners = new Set(ownerRoles());
  const fanoutRoles = new Set(subscriberRoles(r));

  // Which roles were ever consumed at all — the difference between "N waiting for someone who
  // is away" and "N waiting for someone who has never existed". Both used to print identically.
  const everRead = new Set();
  for (const f of files) {
    const m = f.match(/^(.+?)(?:\.[^.]+)?\.queue\.md$/);
    if (m && queueCursorSeen(r, f)) everRead.add(m[1]);
  }

  return [...roles].sort().map(role => {
    // A declared broadcast role is consumed through PER-READER cursors
    // (.qstate/<subscriber>/) — nothing ever advances the shared cursor peekQueueDepth
    // reads, so a byte count from it is a phantom backlog that only grows. Per-reader
    // depth is not one number; report the role as fanout instead of a wrong count.
    const fanout = fanoutRoles.has(role);
    const { pending, oldestWaiting } = fanout ? { pending: null, oldestWaiting: null } : peekQueueDepth(role, { root: r });
    const forRole = presence.filter(p => p.role === role).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
    const ageDays = oldestWaiting ? Math.floor((Date.now() - parseTs(oldestWaiting).getTime()) / 86400000) : null;
    return { role, fanout, pending, oldestWaiting, lastSeen: forRole[0] ? forRole[0].last_seen : null,
      isButton: owners.has(role), ageDays, neverRead: !everRead.has(role) && !owners.has(role) };
  }).filter(s => s.pending > 0 || s.lastSeen);
}

/* ── Queue lifecycle ──
 * A queue file is born on the first send to a role and never dies. In this hub that left 43
 * files against ONE live cursor: 42 roles nobody had ever listened on — mostly one-off
 * experiments (revtest, difftest, teamtest, zaika8fix) — still counted as pending work by
 * hub_brief and read as fleet load by anyone glancing at it. Backlog addressed to a consumer
 * that never existed is not backlog, and a number that only ever grows teaches its reader to
 * ignore the number.
 *
 * "Never read" is the discriminator, not age. A cursor under .qstate means somebody really did
 * consume this file through hub_queue_wait. Two things deliberately do NOT count as reading:
 * a tap (.qstate/__watchall__/) — an orchestrator watching the fleet was never that role's
 * consumer — and a HUMAN owner role, whose queue is read as a file by a person, so a missing
 * cursor there is normal rather than evidence of a ghost.
 *
 * Nothing is deleted. A ghost is MOVED to queues/archive/, so every message stays readable and
 * the move is one reviewable rename in the mesh's git history instead of a silent loss. */
export function queueCursorSeen(root, file) {
  const st = path.join(root, '.qstate');
  if (fs.existsSync(path.join(st, `${file}.offset`))) return true;
  try {
    for (const d of fs.readdirSync(st, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === '__watchall__') continue;   // a tap is not a consumer
      if (fs.existsSync(path.join(st, d.name, `${file}.offset`))) return true;
    }
  } catch {}
  return false;
}

/**
 * Every queue file with what decides its fate: was it ever consumed, is anyone present for
 * its role, how old is its newest message. Pure read — never moves or writes anything.
 *
 * @param {{ root?: string, days?: number }} options
 * @returns {Array<{file, role, node, bytes, messages, newest, ageDays, read, lastSeen, isOwner, ghost}>}
 */
export function queueInventory({ root, days = 30 } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  let files;
  try { files = fs.readdirSync(qdir).filter(f => /\.queue\.md$/.test(f)); } catch { return []; }
  let presence = [];
  try { presence = loadPresence(); } catch {}
  const owners = new Set(ownerRoles());
  const nowMs = Date.now();

  return files.map(f => {
    const m = f.match(/^(.+?)(?:\.([^.]+))?\.queue\.md$/);
    const role = m ? m[1] : f.replace(/\.queue\.md$/, '');
    const node = m ? (m[2] || null) : null;
    const full = path.join(qdir, f);
    let text = '', bytes = 0, mtimeMs = nowMs;
    try { text = fs.readFileSync(full, 'utf8'); } catch {}
    try { const st = fs.statSync(full); bytes = st.size; mtimeMs = st.mtimeMs; } catch {}
    const heads = text.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm) || [];
    const stamps = heads.map(h => h.slice(3, 19));
    const newest = stamps.length ? stamps.reduce((x, y) => (x > y ? x : y)) : null;
    // An empty file (queueWait creates one for its own node before anything is sent) has no
    // message to date, so fall back to the file's own age — otherwise it is ageless and never
    // collectable, which is the wrong answer for the emptiest kind of ghost.
    const ageDays = Math.floor((nowMs - (newest ? parseTs(newest).getTime() : mtimeMs)) / 86400000);
    const lastSeen = presence.filter(p => p.role === role).map(p => p.last_seen).sort().pop() || null;
    const read = queueCursorSeen(r, f);
    const isOwner = owners.has(role);
    return { file: f, role, node, bytes, messages: heads.length, newest, ageDays, read, lastSeen, isOwner,
      ghost: !read && !lastSeen && !isOwner && ageDays >= days };
  });
}

/**
 * One host-agnostic ledger of a role's traffic: how much has been DELIVERED and how much is
 * still pending, aggregated across every per-host file.
 *
 * Why this exists: per-host files each look authoritative on their own. A reply that had
 * already been consumed elsewhere sat in `worker.<host>.queue.md`, and read with
 * plain `cat` from another host it looked like it had never been delivered — there was no view
 * that answered "delivered or pending?" without opening N files and knowing which cursor
 * belonged to which. Byte offsets are split on a Buffer, never on a JS string: a cursor counts
 * bytes, and slicing UTF-16 code units instead would miscount every non-ASCII message.
 *
 * @param {{ root?: string, role?: string }} options
 */
export function queueLedger({ root, role } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');
  let files;
  try { files = fs.readdirSync(qdir).filter(f => /\.queue\.md$/.test(f)); } catch { return { roles: [] }; }
  const fanoutRoles = new Set(subscriberRoles(r));
  const owners = new Set(ownerRoles());
  const HEAD = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm;
  const countHeads = (s) => (s.match(HEAD) || []).length;

  const byRole = new Map();
  for (const f of files) {
    const m = f.match(/^(.+?)(?:\.([^.]+))?\.queue\.md$/);
    const rl = m ? m[1] : f.replace(/\.queue\.md$/, '');
    if (role && rl !== role) continue;
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(path.join(qdir, f)); } catch {}
    let cursor = null;
    try { cursor = parseInt(fs.readFileSync(path.join(stateDir, `${f}.offset`), 'utf8').trim(), 10); } catch {}
    const off = Math.min(Math.max(0, cursor || 0), buf.length);
    const total = countHeads(buf.toString('utf8'));
    const delivered = countHeads(buf.subarray(0, off).toString('utf8'));
    // Per-subscriber cursors (broadcast roles): each reader has its own position, so there is
    // no single "delivered" for the role — report the readers instead of averaging them into a
    // number that is true for nobody.
    const readers = [];
    try {
      for (const d of fs.readdirSync(stateDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '__watchall__') continue;
        try {
          const c = parseInt(fs.readFileSync(path.join(stateDir, d.name, `${f}.offset`), 'utf8').trim(), 10) || 0;
          readers.push({ subscriber: d.name, delivered: countHeads(buf.subarray(0, Math.min(c, buf.length)).toString('utf8')) });
        } catch {}
      }
    } catch {}
    if (!byRole.has(rl)) byRole.set(rl, { role: rl, fanout: fanoutRoles.has(rl), isButton: owners.has(rl), total: 0, delivered: 0, pending: 0, files: [], readers: [] });
    const agg = byRole.get(rl);
    agg.total += total; agg.delivered += delivered; agg.pending += total - delivered;
    agg.files.push({ file: f, node: m && m[2] ? m[2] : null, total, delivered, pending: total - delivered, cursor: cursor == null ? null : off, bytes: buf.length });
    for (const rd of readers) {
      const found = agg.readers.find(x => x.subscriber === rd.subscriber);
      if (found) found.delivered += rd.delivered; else agg.readers.push({ ...rd });
    }
  }
  return { roles: [...byRole.values()].sort((a, b) => (a.role < b.role ? -1 : 1)) };
}

/**
 * Archive the ghost queues. Dry by default — prints what it WOULD move, so the first run is
 * always safe to type. `apply` moves them into queues/archive/, never unlinks.
 *
 * @param {{ root?: string, days?: number, apply?: boolean }} options
 */
export function runQueueGc({ root, days = 30, apply = false } = {}) {
  const r = root ?? resolveQueueRoot();
  const inv = queueInventory({ root: r, days });
  const ghosts = inv.filter(x => x.ghost);
  // Report what the age threshold is holding back, never just what it caught: in this hub 42
  // of 43 files had never been consumed but only 5 were older than the default 30 days, and a
  // bare "5 ghosts" would read as "the other 38 are fine".
  const neverRead = inv.filter(x => !x.read && !x.lastSeen && !x.isOwner).length;
  if (!apply) return { apply: false, days, count: ghosts.length, ghosts, live: inv.length - ghosts.length, neverRead, total: inv.length };
  const dir = path.join(r, 'queues', 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const moved = [], failed = [];
  for (const g of ghosts) {
    try {
      let dest = path.join(dir, g.file);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, g.file.replace(/\.queue\.md$/, `.${n}.queue.md`));
      fs.renameSync(path.join(r, 'queues', g.file), dest);
      moved.push(g.file);
    } catch { failed.push(g.file); }
  }
  return { apply: true, days, count: ghosts.length, moved, failed, archive: dir, ghosts };
}

/**
 * Roll up the owner-role rows from queueSummaryForBrief into the single line
 * task #159 asks for: "N buttons waiting (oldest X days)". A "button" is a
 * pending message in a HUMAN-owner's queue (HUB/owner-roles.json) — a decision
 * only OWNER can make, packaged by an agent down to a <=30s call (see AGENTS.md's
 * "prep vs button" split). Pure function over already-computed rows — no I/O.
 *
 * @param {Array<{ role: string, pending: number, oldestWaiting: string|null, isButton: boolean, ageDays: number|null }>} rows
 * @returns {{ count: number, oldestDays: number|null, items: Array }}
 */
export function buttonsSummary(rows) {
  // A fanout role carries pending:null (per-reader cursors, see queueSummaryForBrief),
  // so `pending > 0` also keeps a broadcast owner role out of the rollup — the count
  // would otherwise never clear.
  const items = (rows || []).filter(r => r.isButton && r.pending > 0);
  const count = items.reduce((n, r) => n + r.pending, 0);
  const oldestDays = items.length ? Math.max(...items.map(r => r.ageDays ?? 0)) : null;
  return { count, oldestDays, items };
}
