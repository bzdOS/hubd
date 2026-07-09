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
import { HUB } from './core.mjs';

/**
 * Resolve the queue root directory, returning both the path and how it was found.
 *
 * Priority:
 *   1. HUBD_TEAM_DIR (or legacy HUBD_QUEUE_DIR) env var   -> via "env"
 *   2. Walk UP from process.cwd() (max 8 levels): first dir with queues/ or .git -> via "walk-up"
 *   3. Fall back to HUB (~/.hubd)                                                 -> via "fallback"
 *
 * @returns {{ root: string, via: 'env' | 'walk-up' | 'fallback' }}
 */
export function resolveQueueRootInfo() {
  const env = process.env.HUBD_TEAM_DIR || process.env.HUBD_QUEUE_DIR;
  if (env) return { root: env, via: 'env' };

  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(d, 'queues')) ||
      fs.existsSync(path.join(d, '.git'))
    ) {
      return { root: d, via: 'walk-up' };
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
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
export async function queueWait(role, { timeout = 540, root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');

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
      process.stderr.write(`warning: another waiter (pid ${w.pid}) is active — one live consumer per role\n`);
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
export async function queueWaitAll({ timeout = 540, root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate', '__watchall__');

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
