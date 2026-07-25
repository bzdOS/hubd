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
import { HUB, loadPresence, ownerRoles, parseTs } from './core.mjs';

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
function nodeName() {
  try { return (os.hostname() || 'node').split('.')[0] || 'node'; }
  catch { return 'node'; }
}

/**
 * Append a message block to <root>/queues/<role>.<node>.queue.md (this node's
 * own file). Creates the queues/ directory if it does not exist.
 * Returns the path to the queue file.
 *
 * @param {string} role
 * @param {string} text
 * @param {{ from?: string, root?: string, node?: string }} options
 * @returns {string} path to the queue file
 */
export function queueSend(role, text, { from = 'unknown', root, node } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  fs.mkdirSync(qdir, { recursive: true });
  const nd = node || nodeName();
  const qfile = path.join(qdir, `${role}.${nd}.queue.md`);

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = `\n## ${ts} · from ${from}\n${String(text).trim()}\n`;

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
  // consuming each other's messages. Without a subscriber the cursor stays where it
  // has always been — shared per node — which is what competing workers and the CLI
  // want, and keeps existing offsets valid.
  const stateDir = subscriber ? path.join(r, '.qstate', subscriber) : path.join(r, '.qstate');

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
  const offPath = (f) => path.join(stateDir, `${f}.offset`);
  const readOff = (f) => { try { return parseInt(fs.readFileSync(offPath(f), 'utf8').trim(), 10) || 0; } catch { return 0; } };
  const writeOff = (f, n) => fs.writeFileSync(offPath(f), String(n), 'utf8');
  const sizeOf = (f) => { try { return fs.statSync(path.join(qdir, f)).size; } catch { return 0; } };

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
    }
  } catch { /* no marker or unreadable — fine */ }

  writeWaiter();
  try {
    const deadline = Date.now() + timeout * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parts = [];
      for (const f of sourceFiles()) {
        const off = readOff(f);
        const sz = sizeOf(f);
        if (sz > off) {
          const fd = fs.openSync(path.join(qdir, f), 'r');
          const buf = Buffer.allocUnsafe(sz - off);
          fs.readSync(fd, buf, 0, sz - off, off);
          fs.closeSync(fd);
          writeOff(f, sz);
          const t = buf.toString('utf8').trim();
          if (t) parts.push(t);
        } else if (sz < off) {
          writeOff(f, 0); // truncated/recreated — reset this file
        }
      }
      if (parts.length) return { changed: true, text: parts.join('\n').trim() };
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
 * everything never steals a message from the one live consumer a role's queue
 * is meant to have (the single-consumer contract queueWait enforces per role
 * stays intact; this is a tap, not a competing reader).
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
  const offPath = (f) => path.join(stateDir, `${f}.offset`);
  const readOff = (f) => { try { return parseInt(fs.readFileSync(offPath(f), 'utf8').trim(), 10) || 0; } catch { return 0; } };
  const writeOff = (f, n) => fs.writeFileSync(offPath(f), String(n), 'utf8');
  const sizeOf = (f) => { try { return fs.statSync(path.join(qdir, f)).size; } catch { return 0; } };

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
        const off = readOff(f);
        const sz = sizeOf(f);
        if (sz > off) {
          const fd = fs.openSync(path.join(qdir, f), 'r');
          const buf = Buffer.allocUnsafe(sz - off);
          fs.readSync(fd, buf, 0, sz - off, off);
          fs.closeSync(fd);
          writeOff(f, sz);
          const t = buf.toString('utf8').trim();
          if (t) { const { role, node } = parseFile(f); events.push({ role, node, text: t }); }
        } else if (sz < off) {
          writeOff(f, 0);
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
    const heads = buf.toString('utf8').match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/gm) || [];
    pending += heads.length;
    for (const h of heads) {
      const ts = h.slice(3);
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

  return [...roles].sort().map(role => {
    const { pending, oldestWaiting } = peekQueueDepth(role, { root: r });
    const forRole = presence.filter(p => p.role === role).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
    const ageDays = oldestWaiting ? Math.floor((Date.now() - parseTs(oldestWaiting).getTime()) / 86400000) : null;
    return { role, pending, oldestWaiting, lastSeen: forRole[0] ? forRole[0].last_seen : null, isButton: owners.has(role), ageDays };
  }).filter(s => s.pending > 0 || s.lastSeen);
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
  const items = (rows || []).filter(r => r.isButton && r.pending > 0);
  const count = items.reduce((n, r) => n + r.pending, 0);
  const oldestDays = items.length ? Math.max(...items.map(r => r.ageDays ?? 0)) : null;
  return { count, oldestDays, items };
}
