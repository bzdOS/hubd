/* nodes.mjs — how each node stands, as its own snapshot states it: sessions, disks, relays.
 *
 * Each node's fleet tool (not hubd) writes `snapshot.<node>.json` into the hub directory, and the
 * mesh carries it to every node, as it carries `presence.<node>.json`. Schema v1:
 *   { "v": 1, "node": "fir", "ts": "2026-10-05T14:35:00Z",
 *     "sessions": [{ "session": str, "role": str, "state": "WORKING|IDLE|DOWN|...",
 *                    "hub_age_min": int|null, "motion_min": int|null }],
 *     "disks":    [{ "mount": str, "used_pct": int, "free_gb": int }],
 *     "relays":   [{ "pair": "<sender>→<recipient>", "active": bool, "failed": bool, "last_ok": ISO|null }] }
 * A field this hub does not know is ignored, and a known one of another type reads as missing. The
 * node is the one in the file's name: that node alone writes the file.
 *
 * What is wrong, and the page shows in red:
 *   stale   the snapshot is more than SNAPSHOT_STALE_MIN minutes old, or has no time to read;
 *   full    a disk at DISK_FULL_PCT percent or more;
 *   down    a relay that failed, or is not active.
 * A file that does not parse, is not an object or is not v1 is a row of its own, `unreadable` with
 * the reason: what it meant is not guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HUB, parseTs } from './core.mjs';

export const SNAPSHOT_STALE_MIN = 5;
export const DISK_FULL_PCT = 90;

const FILE_RE = /^snapshot\.(.+)\.json$/;
const str = (x) => (typeof x === 'string' ? x : null);
const num = (x) => (Number.isFinite(x) ? x : null);
const objects = (xs) => (Array.isArray(xs) ? xs.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : []);
const by = (...keys) => (x, y) => {
  for (const k of keys) { const a = String(x[k] ?? ''), b = String(y[k] ?? ''); if (a !== b) return a < b ? -1 : 1; }
  return 0;
};

/** Every node's snapshot, by node: { node, ts, ageMin, stale, unreadable, sessions, disks, relays }.
 *  `unreadable` is null, or why the file was not read; then the rest is empty and `stale` null. */
export function nodeSnapshots({ root = HUB, nowMs = Date.now() } = {}) {
  let files = [];
  try { files = fs.readdirSync(root).filter(f => FILE_RE.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    const node = FILE_RE.exec(f)[1];
    const none = (why) => ({ node, ts: null, ageMin: null, stale: null, unreadable: why, sessions: [], disks: [], relays: [] });
    let o;
    try { o = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); }
    catch (e) { out.push(none(e instanceof SyntaxError ? 'not JSON' : 'cannot be read (' + (e.code || e.message) + ')')); continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { out.push(none('not an object')); continue; }
    if (o.v !== 1) { out.push(none('schema ' + JSON.stringify(o.v ?? null) + ', not 1')); continue; }

    const ts = str(o.ts);
    const age = ts ? nowMs - parseTs(ts).getTime() : NaN;
    out.push({
      node, ts,
      ageMin: Number.isFinite(age) ? Math.max(0, Math.round(age / 60000)) : null,
      stale: !(age <= SNAPSHOT_STALE_MIN * 60000),
      unreadable: null,
      sessions: objects(o.sessions).map(s => ({ session: str(s.session), role: str(s.role), state: str(s.state),
        hubAgeMin: num(s.hub_age_min), motionMin: num(s.motion_min) })).sort(by('session', 'role')),
      disks: objects(o.disks).map(d => ({ mount: str(d.mount), usedPct: num(d.used_pct), freeGb: num(d.free_gb),
        full: num(d.used_pct) != null && d.used_pct >= DISK_FULL_PCT })).sort(by('mount')),
      relays: objects(o.relays).map(r => ({ pair: str(r.pair), active: r.active === true, failed: r.failed === true,
        lastOk: str(r.last_ok), down: r.failed === true || r.active !== true })).sort(by('pair')),
    });
  }
  return out.sort(by('node'));
}
