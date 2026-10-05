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
import {
  HUB, atomicWrite, ensureGitignored, ensureLocalIgnores, journalFileEndMs, journalFiles, journalNodeOf,
  parseTs, projectSlugSet, readJson, sinceToMs, withLock,
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

/** One pass of a watch: every entry new to the cursor `name`, oldest first, handed to `emit`.
 *  An entry is marked only after `emit` returns, so when it throws (the reader went away) the
 *  cursor keeps what was shown and the rest is new on the next pass. A new cursor shows nothing
 *  on its first pass unless `since` places it earlier; an existing one refuses `since`. `memo`
 *  (one object across passes) lets a long-running watch skip lines it already found too old. */
export function watchPass({ name, project = null, since = null, includePrivate = false, emit, nowMs = Date.now(), memo = null } = {}) {
  const key = cleanName(name);
  if (!key) throw new Error('watch: a cursor name is required (letters, digits, - and _)');
  if (typeof emit !== 'function') throw new Error('watch: emit must be a function');
  const only = project ? projectSlugSet(project) : null;
  const file = watchFile(key);
  return withLock(file, () => {
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

    const mark = (x) => {
      const b = bucketOf(x.ms);
      if (!buckets.has(b)) buckets.set(b, new Set());
      buckets.get(b).add(x.h);
      dirty = true;
    };
    let shown = 0, failure = null;
    const show = !created || since != null;
    for (const x of fresh) {
      if (show && (includePrivate || !x.priv) && (!only || only.has(x.e.project))) {
        try { emit(x.e); } catch (err) { failure = err; break; }
        shown++;
      }
      mark(x);
    }
    if (dirty) {
      if (created && !ensureLocalIgnores()) ensureGitignored('.watch/');
      const seenOut = {};
      for (const b of [...buckets.keys()].sort()) if (buckets.get(b).size) seenOut[b] = [...buckets.get(b)].join(' ');
      atomicWrite(file, JSON.stringify({ name: key, from: new Date(fromMs).toISOString(), windowDays: WINDOW_DAYS,
        at: new Date(nowMs).toISOString(), shown: ((cur && cur.shown) || 0) + shown, seen: seenOut }) + '\n');
    }
    if (failure) throw failure;
    return { name: key, created, shown, from: new Date(fromMs).toISOString(), file };
  });
}

/** The journal files' sizes and times: a long-running watch passes again only when this changes. */
export function journalStamp() {
  return journalFiles().map(f => { try { const s = fs.statSync(f); return `${path.basename(f)}:${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return ''; } }).join('|');
}
