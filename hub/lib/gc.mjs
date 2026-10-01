/* gc.mjs — what a hub accumulates and nobody reads any more, and the one safe way to put it away.
 *
 * In a mesh hub nothing may be removed with rm. Queue files and journals are append-only for the
 * mesh: mesh-sync refuses to commit a deleted log, because committing it would delete that history
 * from every peer — and a hand-deleted empty queue file once kept one node's sync refusing for
 * fifty minutes while supervisors on other nodes read its live workers as dead. So cleaning up is
 * a procedure mesh-sync knows: a file is MOVED under an archive directory with its bytes intact,
 * and mesh-sync accepts a deleted log exactly when the same bytes are there.
 *
 * Classes, each listed before anything moves:
 *   queues    queue files of a name that is not a declared role, or of a role that is switched
 *             off — untouched for `days`, never an owner or broadcast role, never one somebody is
 *             waiting on right now, on any node. Archived to queues/archive/, their cursors to
 *             .qstate/_archive/. Only files this node may move (see shardHold in core): its own
 *             shards, and shards with no writer left; never another live node's, never an empty
 *             one. What is held back is listed as `skipped`, with the reason.
 *   waiters   .waiter markers of processes that are gone (node-local litter). Removed.
 *   presence  presence records of names that are not roles, older than `days`. Node-local;
 *             moved to presence/_archive/.
 *   env       recorded environment observations whose cause is gone (a second waiter that has
 *             stopped waiting). Cleared.
 *   tasks     open tasks assigned to a name that is not a role. LISTED ONLY: reassigning or closing
 *             them is the project head's decision, never a cleanup's.
 *   local     this node's own litter, which never travels: locks older than a minute, the task
 *             cache's backups, orphaned .tmp.<pid> files of a crashed write, reader namespaces idle
 *             for a week (moved to .qstate/_archive/), session records older than a week.
 *
 * Without --apply NOTHING is touched, the local class included. It used to be removed on every run
 * of a command whose other half was a dry run, and printed ahead of the listing, so `hub gc --json`
 * was not JSON.
 *
 * With no roles declared the name-based classes check nothing and say so — without a registry
 * every role would look like a stranger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  HUB, PRESENCE, JOURNAL_NODE, now, parseTs, slugify, loadTasks, roleRegistry, ownerRoles, loadPresence, presenceSnapshots, requireAuthor,
  liveMeshNodes, shardHold, presenceAlive, nodeKey, readJson, staleEnvSessions, newestStampMs, QUEUE_BLOCK_RE,
  envObservations, clearEnvObservation, journalAppend,
} from './core.mjs';
import { resolveQueueRoot, subscriberRoles, pidAlive, subscriberNamespaces, archiveStaleSubscribers, listShards, archiveQueueFile } from './queue.mjs';

const DAY = 86400000;

/** This node's own litter (see the header). Read-only. */
export function localLitter({ root } = {}) {
  const r = root ?? resolveQueueRoot();
  const nowMs = Date.now();
  const out = { locks: [], backups: [], tmp: [], readers: [], sessions: 0 };
  let names = [];
  try { names = fs.readdirSync(HUB); } catch {}
  for (const f of names) {
    let age; try { age = nowMs - fs.statSync(path.join(HUB, f)).mtimeMs; } catch { continue; }
    if (f.endsWith('.lock')) { if (age > 60000) out.locks.push(f); }                 // live ones are stolen after 30s
    else if (f.startsWith('tasks.json.bak')) out.backups.push(f);                     // ONLY the cache's own backups, never a user .bak
    else if (f.includes('.tmp.')) { if (age > 60000) out.tmp.push(f); }             // a crashed atomicWrite
  }
  try { out.readers = subscriberNamespaces({ root: r, days: 7 }).filter(n => n.stale).map(n => (n.tap ? '__watchall__/' : '') + n.name); } catch {}
  out.sessions = staleEnvSessions({ days: 7 });
  return out;
}

function applyLocalLitter(l, r) {
  let removed = 0;
  for (const f of [...l.locks, ...l.backups, ...l.tmp]) { try { fs.unlinkSync(path.join(HUB, f)); removed++; } catch {} }
  let readers = 0;
  if (l.readers.length) { try { readers = archiveStaleSubscribers({ root: r, days: 7 }).moved.length; } catch {} }
  const sessions = l.sessions ? staleEnvSessions({ days: 7, apply: true }) : 0;
  return { removed, readers, sessions };
}

export function hubGcPlan({ root, days = 14 } = {}) {
  const r = root ?? resolveQueueRoot();
  const nowMs = Date.now();
  const roles = roleRegistry();
  const owners = new Set(ownerRoles());
  const fanout = new Set(subscriberRoles(r));
  const known = (name) => roles.has(slugify(name)) && roles.get(slugify(name)).status !== 'off';
  const notes = [];
  if (!roles.size) notes.push('no roles are declared (resource cards of type "role"): queues, presence and tasks were not judged by name');

  const qdir = path.join(r, 'queues'), st = path.join(r, '.qstate');
  // alive anywhere in the mesh: this node's registry and every other node's published snapshot
  const everyone = [...loadPresence(), ...presenceSnapshots().flatMap(sn => sn.agents)];
  const aliveOf = (name) => everyone.some(p => p && (p.agent === name || p.role === name) && presenceAlive(p, nowMs));
  const live = liveMeshNodes({ root: r, days: Math.max(days, 30) });
  const waiterAlive = (role) => { const w = readJson(path.join(st, `${role}.waiter`)); return !!(w && pidAlive(w.pid)); };

  const queues = [], skipped = [];
  if (roles.size) {
    for (const { file: f, role, node } of listShards(qdir)) {
      if (owners.has(role) || fanout.has(role) || known(role) || aliveOf(role) || waiterAlive(role)) continue;
      let stt; try { stt = fs.statSync(path.join(qdir, f)); } catch { continue; }
      // The newest block header, not the file's mtime: a git checkout or pull stamps every file it
      // writes with the time of the pull, which would make a year-old queue look written today.
      const last = newestStampMs(path.join(qdir, f), QUEUE_BLOCK_RE, stt.size);
      const idleDays = Math.floor((nowMs - (last ?? stt.mtimeMs)) / DAY);
      if (idleDays < days) continue;
      const reg = roles.get(slugify(role));
      const row = { file: f, role, node, bytes: stt.size, idleDays, reason: reg ? 'role is off' : 'not a declared role' };
      const hold = shardHold(node, last == null ? 0 : 1, live);
      if (hold) { skipped.push({ ...row, why: hold }); continue; }
      row.whose = !node ? 'no node in its name' : nodeKey(node) === JOURNAL_NODE ? 'this node' : live ? `node ${node} writes no more` : 'no mesh';
      queues.push(row);
    }
  }

  const waiters = [];
  const scanWaiters = (dir, prefix) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.waiter')) {
        const pid = (readJson(path.join(dir, e.name)) || {}).pid || null;
        if (!pid || !pidAlive(pid)) waiters.push({ file: prefix + e.name, pid });
      } else if (e.isDirectory() && !e.name.startsWith('_') && !prefix) scanWaiters(path.join(dir, e.name), e.name + '/');
    }
  };
  scanWaiters(st, '');

  const stalePresence = [];
  if (roles.size) {
    for (const p of loadPresence()) {
      if (!p || !p.agent || roles.has(slugify(p.agent)) || owners.has(p.agent)) continue;
      const ms = parseTs(p.last_seen).getTime();
      const age = Number.isFinite(ms) ? Math.floor((nowMs - ms) / DAY) : null;
      if (age != null && age >= days) stalePresence.push({ agent: p.agent, lastSeen: p.last_seen, idleDays: age });
    }
  }

  const env = [];
  const obs = envObservations();
  for (const kind of ['cursor-conflict', 'subscriber-shared']) {
    for (const v of ((obs[kind] || {}).values || [])) {
      const role = String(v).split(' as ')[0];
      if (!waiterAlive(role)) env.push({ kind, value: v });
    }
  }

  const tasks = [];
  if (roles.size) {
    const byWho = new Map();
    for (const t of loadTasks().tasks.filter(t => t.status === 'open' && t.assignee)) {
      if (known(t.assignee) || owners.has(t.assignee) || t.owner_kind === 'human') continue;
      const k = t.assignee;
      (byWho.get(k) || byWho.set(k, []).get(k)).push({ id: t.id, project: t.project });
    }
    for (const [assignee, list] of [...byWho].sort((a, b) => b[1].length - a[1].length)) {
      const reg = roles.get(slugify(assignee));
      tasks.push({ assignee, reason: reg ? 'role is off' : 'not a declared role', count: list.length,
        projects: [...new Set(list.map(x => x.project))].sort(), ids: list.map(x => x.id) });
    }
  }
  return { root: r, days, node: JOURNAL_NODE, queues, skipped, waiters, presence: stalePresence, env, tasks, local: localLitter({ root: r }), notes, generated: now() };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Apply the plan: move, never unlink a log; then one commit, when the hub is a git repo. */
export function runHubGc({ root, days = 14, apply = false, by } = {}) {
  const plan = hubGcPlan({ root, days });
  if (!apply) return { apply: false, ...plan };
  const author = requireAuthor(by, 'by');
  const r = plan.root;
  const moved = [], failed = [];
  for (const q of plan.queues) {
    try { moved.push({ from: path.join('queues', q.file), to: path.relative(r, archiveQueueFile(r, q.file)) }); }
    catch (e) { failed.push({ file: q.file, error: e.message }); }
  }
  let waitersRemoved = 0;
  for (const w of plan.waiters) { try { fs.unlinkSync(path.join(r, '.qstate', w.file)); waitersRemoved++; } catch {} }
  let presenceMoved = 0;
  const pdir = path.join(PRESENCE, '_archive');
  for (const p of plan.presence) {
    try { fs.mkdirSync(pdir, { recursive: true }); fs.renameSync(path.join(PRESENCE, slugify(p.agent) + '.json'), path.join(pdir, slugify(p.agent) + '.json')); presenceMoved++; } catch {}
  }
  for (const e of plan.env) clearEnvObservation(e.kind, e.value);
  const local = applyLocalLitter(plan.local, r);

  /* One commit for the whole move, so every peer receives it as one change it can read. When
   * that is not possible (not a repo, a sync holding the index right now) the files stay moved and
   * uncommitted — and mesh-sync accepts them anyway, because the bytes are in the archive. */
  let commit = null, commitError = null;
  if (moved.length && fs.existsSync(path.join(r, '.git'))) {
    try {
      const paths = moved.flatMap(m => [m.from, m.to]);
      git(['add', '-A', '--', ...paths], r);
      git(['-c', 'user.name=hub-gc', '-c', `user.email=hub-gc@${slugify(author)}`, 'commit', '-q', '-m',
        `hub gc: archived ${moved.length} queue file(s) by ${author}`, '--', ...paths], r);
      commit = git(['rev-parse', '--short', 'HEAD'], r).trim();
    } catch (e) { commitError = String(e.stderr || e.message).trim().split('\n')[0]; }
  }
  if (moved.length || waitersRemoved || presenceMoved || plan.env.length) {
    journalAppend({ ts: now(), project: 'hub', agent: author, kind: 'note',
      text: `hub gc: archived ${moved.length} queue file(s), removed ${waitersRemoved} dead waiter marker(s), archived ${presenceMoved} presence record(s), cleared ${plan.env.length} stale observation(s)` });
  }
  return { apply: true, ...plan, moved, failed, waitersRemoved, presenceMoved, envCleared: plan.env.length, localRemoved: local, commit, commitError };
}
