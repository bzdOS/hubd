/**
 * queue.mjs — Node.js port of queue/qsend.py and queue/qwait.py.
 * Zero external dependencies (Node stdlib only).
 *
 * On-disk format (identical to the Python originals):
 *   queues/<role>.queue.md  — append-only markdown blocks
 *   .qstate/<role>.offset   — byte offset of the last-read position
 *
 * Block format:
 *   \n## YYYY-MM-DD HH:MM · from <sender>\n<text>\n
 */

import fs from 'node:fs';
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
 * Walking from cwd rather than from the binary path is correct because `hub`
 * is installed globally — its realpath would point into node_modules, not the
 * team repo.
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
 * Delegates to resolveQueueRootInfo() so queue.mjs stays the single owner of that logic.
 *
 * @returns {string}
 */
export function resolveQueueRoot() {
  return resolveQueueRootInfo().root;
}

/**
 * Append a message block to <root>/queues/<role>.queue.md.
 * Creates the queues/ directory if it does not exist.
 * Returns the path to the queue file.
 *
 * @param {string} role
 * @param {string} text
 * @param {{ from?: string, root?: string }} options
 * @returns {string} path to the queue file
 */
export function queueSend(role, text, { from = 'unknown', root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  fs.mkdirSync(qdir, { recursive: true });
  const qfile = path.join(qdir, `${role}.queue.md`);

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = `\n## ${ts} · from ${from}\n${String(text).trim()}\n`;

  // append is atomic on POSIX for small writes (same guarantee as Python version)
  fs.appendFileSync(qfile, entry, 'utf8');
  return qfile;
}

/**
 * Block until new content appears in <root>/queues/<role>.queue.md.
 *
 * Faithful port of queue/qwait.py:
 *   - State file: <root>/.qstate/<role>.offset (byte offset, plain integer).
 *   - If file size > offset: read new bytes, update offset, return changed result.
 *   - If file size < offset (truncated/recreated): reset offset to 0, keep waiting.
 *   - Poll every 2000 ms until `timeout` seconds elapse.
 *   - Creates the queue file (empty) if it does not exist yet.
 *
 * Single-consumer guard: advisory warning if another live waiter is detected.
 *   Marker file: <root>/.qstate/<role>.waiter, JSON {"pid": <N>, "since": "<ISO>"}.
 *   Written on entry, refreshed on every poll, removed before returning (try/finally).
 *   Dead-pid or stale (>10s) markers are silently overwritten.
 *
 * @param {string} role
 * @param {{ timeout?: number, root?: string }} options
 * @returns {Promise<{ changed: true, text: string } | { changed: false }>}
 */
export async function queueWait(role, { timeout = 540, root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qfile = path.join(r, 'queues', `${role}.queue.md`);
  const stateDir = path.join(r, '.qstate');

  fs.mkdirSync(path.dirname(qfile), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Create queue file if missing (same as Python: open(qfile, 'a').close())
  if (!fs.existsSync(qfile)) {
    fs.writeFileSync(qfile, '', 'utf8');
  }

  const stateFile = path.join(stateDir, `${role}.offset`);
  const waiterFile = path.join(stateDir, `${role}.waiter`);

  function readOffset() {
    try { return parseInt(fs.readFileSync(stateFile, 'utf8').trim(), 10) || 0; } catch { return 0; }
  }

  function writeOffset(n) {
    fs.writeFileSync(stateFile, String(n), 'utf8');
  }

  function fileSize() {
    try { return fs.statSync(qfile).size; } catch { return 0; }
  }

  // pid liveness check: returns true if the process is alive
  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  function writeWaiter() {
    fs.writeFileSync(waiterFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), 'utf8');
  }

  // Single-consumer guard: check for a live competing waiter
  try {
    const raw = fs.readFileSync(waiterFile, 'utf8');
    const w = JSON.parse(raw);
    const otherPid = w.pid;
    if (otherPid !== process.pid) {
      const ageMsRaw = Date.now() - new Date(w.since).getTime();
      const fresh = ageMsRaw < 10000;
      if (fresh && pidAlive(otherPid)) {
        process.stderr.write(`warning: another waiter (pid ${otherPid}) is active — one live consumer per role\n`);
      }
    }
  } catch { /* no marker or unreadable — fine */ }

  // Register own marker; always clean up on exit
  writeWaiter();
  try {
    const deadline = Date.now() + timeout * 1000;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const off = readOffset();
      const sz = fileSize();

      if (sz > off) {
        // New content available — read from offset to end
        const fd = fs.openSync(qfile, 'r');
        const len = sz - off;
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, off);
        fs.closeSync(fd);
        writeOffset(sz);
        return { changed: true, text: buf.toString('utf8').trim() };
      }

      if (sz < off) {
        // File was truncated or recreated — reset offset and keep waiting
        writeOffset(0);
        continue;
      }

      if (Date.now() >= deadline) {
        return { changed: false };
      }

      // Refresh waiter marker on each poll iteration
      writeWaiter();

      // Poll every 2000 ms using a real async sleep (no busy-wait, no Atomics)
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    // Always remove own marker (both changed and timeout paths)
    try { fs.unlinkSync(waiterFile); } catch {}
  }
}
