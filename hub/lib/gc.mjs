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
 *             waiting on right now. Archived to queues/archive/, their cursors to .qstate/_archive/.
 *   waiters   .waiter markers of processes that are gone (node-local litter). Removed.
 *   presence  presence records of names that are not roles, older than `days`. Node-local;
 *             moved to presence/_archive/.
 *   env       recorded environment observations whose cause is gone (a second waiter that has
 *             stopped waiting). Cleared.
 *   tasks     open tasks assigned to a name that is not a role. LISTED ONLY: reassigning or closing
 *             them is the project head's decision, never a cleanup's.
 *
 * With no roles declared the name-based classes check nothing and say so — without a registry
 * every role would look like a stranger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  HUB, PRESENCE, now, parseTs, slugify, loadTasks, roleRegistry, ownerRoles, loadPresence, requireAuthor,
  envObservations, clearEnvObservation, journalAppend,
} from './core.mjs';
import { resolveQueueRoot, subscriberRoles, pidAlive } from './queue.mjs';

const DAY = 86400000;

function newestBlockMs(file, size) {
  if (!size) return null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const n = Math.min(size, 65536), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      let best = null;
      for (const m of buf.toString('utf8').matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · from /gm)) {
        const ms = parseTs(m[1]).getTime();
        if (Number.isFinite(ms) && (best == null || ms > best)) best = ms;
      }
      return best;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
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
  const presence = new Map(loadPresence().map(p => [p.agent, p]));
  const aliveOf = (name) => { const p = presence.get(name); return !!p && nowMs < parseTs(p.last_seen).getTime() + (p.ttlMin ?? 15) * 60000; };
  const waiterAlive = (role) => { try { return pidAlive(JSON.parse(fs.readFileSync(path.join(st, `${role}.waiter`), 'utf8')).pid); } catch { return false; } };

  const queues = [];
  if (roles.size) {
    let files = [];
    try { files = fs.readdirSync(qdir).filter(f => f.endsWith('.queue.md')); } catch {}
    for (const f of files) {
      const m = f.match(/^(.+?)(?:\.([^.]+))?\.queue\.md$/);
      const role = m ? m[1] : f;
      if (owners.has(role) || fanout.has(role) || known(role) || aliveOf(role) || waiterAlive(role)) continue;
      let stt; try { stt = fs.statSync(path.join(qdir, f)); } catch { continue; }
      // The newest block header, not the file's mtime: a git checkout or pull stamps every file it
      // writes with the time of the pull, which would make a year-old queue look written today.
      const last = newestBlockMs(path.join(qdir, f), stt.size);
      const idleDays = Math.floor((nowMs - (last ?? stt.mtimeMs)) / DAY);
      if (idleDays < days) continue;
      const reg = roles.get(slugify(role));
      queues.push({ file: f, role, node: m && m[2] ? m[2] : null, bytes: stt.size, idleDays, reason: reg ? 'role is off' : 'not a declared role' });
    }
  }

  const waiters = [];
  const scanWaiters = (dir, prefix) => {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.waiter')) {
        let pid = null; try { pid = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')).pid; } catch {}
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
  return { root: r, days, queues, waiters, presence: stalePresence, env, tasks, notes, generated: now() };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Apply the plan: move, never unlink a log; then one commit, when the hub is a git repo. */
export function runHubGc({ root, days = 14, apply = false, by } = {}) {
  const plan = hubGcPlan({ root, days });
  if (!apply) return { apply: false, ...plan };
  const author = requireAuthor(by, 'by');
  const r = plan.root;
  const moved = [], failed = [];
  const adir = path.join(r, 'queues', 'archive'), cdir = path.join(r, '.qstate', '_archive');
  for (const q of plan.queues) {
    try {
      fs.mkdirSync(adir, { recursive: true });
      let dest = path.join(adir, q.file);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(adir, q.file.replace(/\.queue\.md$/, `.${n}.queue.md`));
      fs.renameSync(path.join(r, 'queues', q.file), dest);
      moved.push({ from: path.join('queues', q.file), to: path.relative(r, dest) });
      const cur = path.join(r, '.qstate', `${q.file}.offset`);
      if (fs.existsSync(cur)) { fs.mkdirSync(cdir, { recursive: true }); fs.renameSync(cur, path.join(cdir, path.basename(dest) + '.offset')); }
    } catch (e) { failed.push({ file: q.file, error: e.message }); }
  }
  let waitersRemoved = 0;
  for (const w of plan.waiters) { try { fs.unlinkSync(path.join(r, '.qstate', w.file)); waitersRemoved++; } catch {} }
  let presenceMoved = 0;
  const pdir = path.join(PRESENCE, '_archive');
  for (const p of plan.presence) {
    try { fs.mkdirSync(pdir, { recursive: true }); fs.renameSync(path.join(PRESENCE, slugify(p.agent) + '.json'), path.join(pdir, slugify(p.agent) + '.json')); presenceMoved++; } catch {}
  }
  for (const e of plan.env) clearEnvObservation(e.kind, e.value);

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
  return { apply: true, ...plan, moved, failed, waitersRemoved, presenceMoved, envCleared: plan.env.length, commit, commitError };
}
