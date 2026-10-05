/* watch.mjs — the journal's new entries, each shown once, to a named reader.
 *
 * A notifier that follows the journal (a chat bridge, a pager) used to read the raw files by byte
 * offset, the way `tail -f` does. On a synced hub that shows an entry more than once, or not at all:
 *   - a union merge keeps a line both sides hold twice (readLogEntries in core.mjs), and an offset
 *     reads the second copy as new;
 *   - a merge can put lines this node has not seen BEFORE lines it has, so the offset is already
 *     past them;
 *   - a reset that shortens a file and a pull that grows it again replays the file from the reset
 *     point;
 *   - journalAppend renames the live file into a month archive at 2 MB, and the lines written after
 *     the last read and before the rename are in a file the offset no longer follows.
 *
 * So the cursor holds no offset. It holds which entries were passed: a short hash of the node log
 * family and the line, the same key readLogEntries drops repeats by, so the reader and the watch
 * agree on what one entry is. Neither a reorder, a doubled line, a replayed file nor a rotation
 * changes that key. The hashes are kept for WINDOW_DAYS, bucketed by the hour of the entry; an
 * entry older than that when it first reaches this node is not shown (`hub log` still has it).
 *
 * Every entry the watch passes is marked, shown or not: a cursor is a position in the journal, and
 * a filter (a project, the private braid) is what this run shows from it. Changing the filter later
 * does not replay what was passed. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  HUB, acquireLock, atomicWrite, ensureGitignored, ensureLocalIgnores, journalFileEndMs, journalFiles, journalNodeOf,
  parseTs, projectSlugSet, readJson, releaseLock, sinceToMs, withLock,
} from './core.mjs';

export const WINDOW_DAYS = 7;
/* A new cursor starts this far back: journal times are whole minutes, so an entry written in the
 * minute the cursor was placed reads as older than it, and a node's clock can run a little behind. */
const START_MARGIN_MS = 10 * 60000;
const HOUR = 3600000;

const cleanName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export const watchDir = () => path.join(HUB, '.watch');
export const watchFile = (name) => path.join(watchDir(), cleanName(name) + '.json');
const hashOf = (family, line) => crypto.createHash('sha1').update(family + '\n' + line).digest('hex').slice(0, 12);
const bucketOf = (ms) => new Date(ms).toISOString().slice(0, 13);

/* What a pass starts from, read under the cursor's lock: the cursor's marks inside the window and
 * the entries new to it, oldest first. */
function open({ key, file, project, since, includePrivate, nowMs, memo }) {
  const cur = readJson(file, null);
  if (cur && since != null) {
    throw new Error(`watch: the cursor "${key}" exists (placed ${cur.from}); --since only places a new one. ` +
      `Delete ${path.relative(HUB, file)} to start it again, or read the past with hub log.`);
  }
  const created = !cur;
  const fromMs = cur ? parseTs(cur.from).getTime() : since != null ? sinceToMs(since, nowMs) : nowMs - START_MARGIN_MS;
  const floor = Math.max(fromMs, nowMs - WINDOW_DAYS * 86400000);
  const buckets = new Map();
  let dirty = created;
  for (const [b, hs] of Object.entries((cur && cur.seen) || {})) {
    if (parseTs(b + ':00').getTime() + HOUR <= floor) { dirty = true; continue; }   // out of the window
    buckets.set(b, new Set(String(hs).split(' ').filter(Boolean)));
  }
  const seen = new Set();
  for (const hs of buckets.values()) for (const h of hs) seen.add(h);
  const old = memo ? (memo.old ||= new Set()) : new Set();

  const fresh = [];
  let order = 0;
  // A month archive that ended before the window holds nothing the window needs (journalFileEndMs).
  for (const f of journalFiles().filter(x => journalFileEndMs(path.basename(x)) > floor)) {
    const family = journalNodeOf(path.basename(f));
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      const line = l.trim();
      if (!line) continue;
      const h = hashOf(family, line);
      if (seen.has(h) || old.has(h)) continue;
      let e;
      try { e = JSON.parse(line); } catch { old.add(h); continue; }
      const ms = parseTs(e && e.ts).getTime();
      if (!Number.isFinite(ms) || ms < floor) { old.add(h); continue; }
      seen.add(h);                          // a second copy later in this pass is the same entry
      fresh.push({ e, ms, h, order: order++, priv: family === 'life' || (e && e.private === true) });
    }
  }
  fresh.sort((a, b) => a.ms - b.ms || a.order - b.order);
  const only = project ? projectSlugSet(project) : null;
  return { key, file, cur, created, fromMs, nowMs, buckets, fresh, dirty, shown: 0,
    show: (x) => (!created || since != null) && (includePrivate || !x.priv) && (!only || only.has(x.e.project)) };
}
const mark = (st, x) => {
  const b = bucketOf(x.ms);
  if (!st.buckets.has(b)) st.buckets.set(b, new Set());
  st.buckets.get(b).add(x.h);
  st.dirty = true;
};
function save(st) {
  if (!st.dirty) return;
  if (st.created && !ensureLocalIgnores()) ensureGitignored('.watch/');
  const seenOut = {};
  for (const b of [...st.buckets.keys()].sort()) if (st.buckets.get(b).size) seenOut[b] = [...st.buckets.get(b)].join(' ');
  atomicWrite(st.file, JSON.stringify({ name: st.key, from: new Date(st.fromMs).toISOString(), windowDays: WINDOW_DAYS,
    at: new Date(st.nowMs).toISOString(), shown: ((st.cur && st.cur.shown) || 0) + st.shown, seen: seenOut }) + '\n');
  st.dirty = false;
}
const result = (st) => ({ name: st.key, created: st.created, shown: st.shown, from: new Date(st.fromMs).toISOString(), file: st.file });
const keyOf = (name) => {
  const key = cleanName(name);
  if (!key) throw new Error('watch: a cursor name is required (letters, digits, - and _)');
  return key;
};

/** One pass of a watch: every entry new to the cursor `name`, oldest first, handed to `emit`.
 *  An entry is marked only after `emit` returns, so when it throws (the reader went away) the
 *  cursor keeps what was shown and the rest is new on the next pass. A new cursor shows nothing
 *  on its first pass unless `since` places it earlier; an existing one refuses `since`. `memo`
 *  (one object across passes) lets a long-running watch skip lines it already found too old. */
export function watchPass({ name, project = null, since = null, includePrivate = false, emit, nowMs = Date.now(), memo = null } = {}) {
  const key = keyOf(name);
  if (typeof emit !== 'function') throw new Error('watch: emit must be a function');
  const file = watchFile(key);
  return withLock(file, () => {
    const st = open({ key, file, project, since, includePrivate, nowMs, memo });
    let failure = null;
    for (const x of st.fresh) {
      if (st.show(x)) {
        try { emit(x.e, x.h); } catch (err) { failure = err; break; }
        st.shown++;
      }
      mark(st, x);
    }
    save(st);
    if (failure) throw failure;
    return result(st);
  });
}

/* --exec: each entry goes to a command, and is marked only when the command exits 0. That is the
 * at-least-once a bridge needs: a post that failed is the command's non-zero exit, and the entry is
 * handed over again on the next pass. Three things differ from a pass to stdout:
 *   - the cursor is saved after every entry the command took, so a watch killed in the middle of a
 *     backlog hands over again only the entry it was holding;
 *   - the pass awaits each command, so a signal is seen between entries: the command in flight
 *     finishes, the cursor is saved, and the pass ends, instead of running the backlog first;
 *   - a command gets EXEC_TIMEOUT_S, and the lock is touched before each one. A lock is taken from
 *     a holder after 30 s without a touch (acquireLock), and a second watch on the cursor would
 *     then hand over the same entries.
 * HUBD_WATCH_KEY is the entry's hash, the same on every attempt: a receiver that drops a repeat by
 * it (a Matrix transaction id) shows a retried entry once. */
export const EXEC_TIMEOUT_S = 20;

/** Runs `cmd` with sh on one entry, the entry as one JSON line on stdin. Resolves to null when it
 *  exited 0, else to why not. */
export function execEntry(cmd, e, key, { timeoutS = EXEC_TIMEOUT_S } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, HUBD_WATCH_KEY: key },
        timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
    } catch (err) { resolve(`could not start: ${err.message}`); return; }
    const t0 = Date.now();
    child.on('error', (err) => resolve(`could not start: ${err.message}`));
    child.on('close', (code, signal) => resolve(code === 0 ? null
      : signal === 'SIGKILL' && Date.now() - t0 >= timeoutS * 1000 - 50 ? `ran past ${timeoutS} s and was killed`
      : signal ? `was killed by ${signal}` : `exited ${code}`));
    child.stdin.on('error', () => {});      // a command that does not read stdin closes it early
    child.stdin.end(JSON.stringify(e) + '\n');
  });
}

/** A pass that hands each entry to `cmd` (execEntry). Resolves to the pass's result, with `failed`
 *  {why, ts, project, agent} when a command did not exit 0: that entry and the ones after it are
 *  new on the next pass. `stop()` true ends the pass after the entry in flight. */
export async function watchExec({ name, cmd, project = null, since = null, includePrivate = false, nowMs = Date.now(), memo = null,
  timeoutS = EXEC_TIMEOUT_S, stop = () => false } = {}) {
  const key = keyOf(name);
  if (!cmd || typeof cmd !== 'string') throw new Error('watch: --exec needs a command');
  const file = watchFile(key);
  const lock = acquireLock(file);
  try {
    const st = open({ key, file, project, since, includePrivate, nowMs, memo });
    let failed = null;
    for (const x of st.fresh) {
      if (stop()) break;
      if (st.show(x)) {
        touch(lock);
        const why = await execEntry(cmd, x.e, x.h, { timeoutS });
        if (why) { failed = { why, ts: x.e.ts, project: x.e.project, agent: x.e.agent }; break; }
        st.shown++;
        mark(st, x);
        save(st);
        continue;
      }
      mark(st, x);
    }
    save(st);
    return { ...result(st), ...(failed ? { failed } : {}) };
  } finally { releaseLock(lock); }
}
const touch = (lock) => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} };

/** The journal files' sizes and times: a long-running watch passes again only when this changes. */
export function journalStamp() {
  return journalFiles().map(f => { try { const s = fs.statSync(f); return `${path.basename(f)}:${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return ''; } }).join('|');
}
