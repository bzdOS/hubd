/* statemerge.mjs — the git merge driver for the files one node rewrites whole, and its install.
 *
 * A node publishes its state to the mesh as JSON files that bear its name and that it alone writes:
 * `snapshot.<node>.json`, `presence.<node>.json`, `sense.<node>.json`, and its read marks,
 * `queues/read/<role>.<node>.json`. Each write replaces the whole file. One writer means one line
 * of history, and nothing to merge, until there are two: history repaired or rebased so that the
 * same node's writes sit on both sides, or one node name in two clones. Then each side has rewritten
 * the file since the merge base, every line with a time in it differs, and git's text merge stops
 * on it. On a live mesh one node's snapshot stopped another node's sync that way, and it stood
 * until its history was realigned by hand.
 *
 * Neither side is right as a side. In a merge, ours is this node; in a rebase, ours is upstream and
 * theirs is the commit being replayed, so "keep ours" keeps opposite things in the two. What does
 * mean the same in both is the time the file carries: the newer version is the one its writer wrote
 * last, from everything it knew then. So the newer one is taken whole and the base is not read.
 * The time is `ts` (a snapshot), else `written` (presence, sense), else the latest `at` among the
 * marks (read marks have no time of their own). A version whose time cannot be read loses to one
 * whose time can. Equal times, or neither readable: the greater text, so that every node and both
 * directions pick the same one and two nodes merging the pair apart do not disagree afterwards.
 *
 * Installed per node beside the card driver, for the reason cardmerge.mjs gives: the driver command
 * lives in .git/config, which does not travel. The command ends in `|| true`: if node or hubd moves
 * and the path goes stale, the file git left in %A stays, ours. No union of two JSON documents is
 * a JSON document; ours is one, and its writer replaces it within minutes.
 *
 * Nothing here imports the hub (cardmerge.mjs says why). */
import fs from 'node:fs';
import { installDriver, removeDriver, shq } from './cardmerge.mjs';

export const STATE_DRIVER = 'hubd-state';
export const STATE_ATTRS = ['/snapshot.*.json', '/presence.*.json', '/sense.*.json', '/queues/read/*.json']
  .map(p => `${p} merge=${STATE_DRIVER}`);

/* A stored time in ms: ISO with a zone, or 'YYYY-MM-DD HH:MM' as hubd writes it, which is UTC. */
const ms = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const t = s.replace(' ', 'T');
  const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z');
  return Number.isFinite(v) ? v : null;
};
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** The time one version of a state file carries, in ms; null when it has none that reads. */
export function stampOf(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!isObj(j)) return null;
  const top = ms(j.ts) ?? ms(j.written);
  if (top != null) return top;
  let best = null;
  for (const slot of [j.files, ...(isObj(j.subs) ? Object.values(j.subs) : [])])
    if (isObj(slot)) for (const e of Object.values(slot)) {
      const v = ms(isObj(e) ? e.at : null);
      if (v != null && (best == null || v > best)) best = v;
    }
  return best;
}

/** Merge two versions of a state file: { text, took: 'ours'|'theirs', why: 'same'|'newer'|'readable'|'tie' }. */
export function mergeState(base, ours, theirs) {
  const a = String(ours ?? ''), b = String(theirs ?? '');
  const pick = (side, why) => ({ text: side === 'ours' ? a : b, took: side, why });
  if (a === b) return pick('ours', 'same');
  const sa = stampOf(a), sb = stampOf(b);
  if (sa != null && sb != null && sa !== sb) return pick(sa > sb ? 'ours' : 'theirs', 'newer');
  if ((sa == null) !== (sb == null)) return pick(sa != null ? 'ours' : 'theirs', 'readable');
  return pick(a > b ? 'ours' : 'theirs', 'tie');
}

/** The driver itself: git hands it %O %A %B and reads the result back from %A. */
export function runStateDriver([base, ours, theirs]) {
  const read = (f) => fs.readFileSync(f, 'utf8');
  const r = mergeState(read(base), read(ours), read(theirs));
  if (r.took === 'theirs') fs.writeFileSync(ours, r.text);
}

/** Install (or refresh) the driver in the hub's own repository. `script` is scripts/state-merge.mjs. */
export function installStateDriver(hub, { node = process.execPath, script }) {
  return installDriver(hub, { name: STATE_DRIVER, label: 'hubd: files one node rewrites whole, the newer version taken',
    command: `${shq(node)} ${shq(script)} %O %A %B || true`, attrs: STATE_ATTRS });
}

/** Take it out again: git's text merge decides on this node. */
export function removeStateDriver(hub) { return removeDriver(hub, { name: STATE_DRIVER, attrs: STATE_ATTRS }); }
