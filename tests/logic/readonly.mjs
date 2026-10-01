// readonly.mjs — a command that only reads leaves the hub exactly as it found it.
//
// Before this, every `hub` run went through ensureProtocol() first, and that wrote: HUBD.md, the
// lines it thought .gitignore lacked (a TRACKED file, so a mesh commit), the hub's subdirectories,
// and an unlink of every .tmp.* older than a minute. `hub gc --json` was the reproduction: the dry
// run deleted the very stale tmp file it was meant to list, and on a mixed rollout two nodes
// appending different lines to the end of .gitignore stopped each other's sync on a conflict.
// So: snapshot the hub, run each read-only command, compare. Not one byte, not one directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { ok, mktmp, cli, done } from './_h.mjs';

// Everything under the hub but git's own bookkeeping (git status refreshes .git/index, which is
// git's business); .git/info/exclude is the hub's, so it is in.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f), rel = path.relative(dir, p);
      if (rel === '.git') { walk(p); continue; }
      if (rel.startsWith('.git' + path.sep) && rel !== path.join('.git', 'info') && rel !== path.join('.git', 'info', 'exclude')) continue;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { out[rel + '/'] = 'dir'; walk(p); }
      else out[rel] = st.size + ':' + st.mtimeMs + ':' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
function diff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => a[k] !== b[k]).map(k => (k in a ? (k in b ? '~' : '-') : '+') + k).sort();
}

const H = mktmp();
const envOf = (d) => ({ HUBD_DIR: d, HUBD_TEAM_DIR: d, HUBD_NODE: 'cedar', HUBD_AGENT: 'dev-readonly' });
const env = envOf(H);
const w = (...argv) => { const r = cli(argv, { env, cwd: H }); if (r.code) console.log('setup: ' + argv.join(' ') + ' -> ' + r.out.slice(0, 300)); return r; };
w('init', H);
w('task', 'add', 'first task', '-p', 'alpha', '--by', 'dev-readonly');
w('task', 'add', 'second task', '-p', 'alpha', '--needs', 'cedar-1', '--by', 'dev-readonly');
w('report', '-p', 'alpha', 'DONE: a step', '--by', 'dev-readonly');
w('card', 'alpha', '-m', 'alpha does a thing', '--by', 'dev-readonly');
w('resource', 'set', 'box', '--type', 'host', '-m', 'a box', '--by', 'dev-readonly');
w('queue', 'send', 'worker', 'hello', '--from', 'dev-readonly');
w('heartbeat', 'dev-readonly', '--status', 'testing');
execSync('git init -q . && git add -A && git -c user.name=t -c user.email=t@t commit -q -m seed', { cwd: H });

/* What a node that upgraded mid-flight looks like: the generated files gone or old, a .gitignore
 * from before some lines existed, a crashed atomicWrite's tmp file, a task cache older than the
 * events. Each one is something the old ensureProtocol() "repaired" on a read. */
fs.rmSync(path.join(H, 'HUBD.md'), { force: true });
fs.rmSync(path.join(H, 'tasks.json'), { force: true });
const gi = path.join(H, '.gitignore');
fs.writeFileSync(gi, fs.readFileSync(gi, 'utf8').split('\n').filter(l => l !== '.sense/' && l !== '.checkins.json').join('\n'));
const tmp = path.join(H, 'tasks.json.tmp.999');
fs.writeFileSync(tmp, '{}');
const old = new Date(Date.now() - 3600e3); fs.utimesSync(tmp, old, old);

const READS = [
  ['version'], ['help'], ['status'], ['brief'], ['inbox'], ['plan'], ['trajectory', 'alpha'], ['whereami', H], ['log'], ['log', '--json'],
  ['task', 'list'], ['task', 'list', '--json'], ['task', 'get', 'cedar-1'], ['claim', 'check', '-p', 'alpha', 'src'],
  ['presence'], ['presence', '--json'], ['graph'], ['now'], ['agenda'], ['board'], ['board', '--json'],
  ['recall', 'thing'], ['usage'], ['rules'], ['operator'], ['audit'], ['lint'], ['sections'], ['harvest'],
  ['gc'], ['gc', '--json'], ['resource', 'list'], ['resource', 'get', 'box'],
  ['cards', 'compact'], ['cards', 'merge-sections'], ['queue', 'status'], ['queue', 'gc'], ['doctor'],
];
// Each command gets its own copy of that hub: the first one to "repair" it would otherwise hide
// what every later one does.
let staleTmpKept = true;
for (const argv of READS) {
  const C = mktmp();
  fs.cpSync(H, C, { recursive: true, preserveTimestamps: true });
  const before = snapshot(C);
  const r = cli(argv, { env: envOf(C), cwd: C });
  const d = diff(before, snapshot(C));
  if (!fs.existsSync(path.join(C, 'tasks.json.tmp.999'))) staleTmpKept = false;
  ok(!d.length, `read-only: hub ${argv.join(' ')} changes nothing in the hub${d.length ? '  — ' + d.slice(0, 6).join(' ') : ''}`);
  if (argv.join(' ') === 'gc --json') {
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    ok(j && j.local && j.local.tmp.includes('tasks.json.tmp.999'),
      'read-only: hub gc --json is valid JSON and lists the stale tmp file it used to delete before looking');
  }
}
ok(staleTmpKept, 'read-only: the stale tmp file is still there after every one of them');

/* A hub that has never been written by this version: no subdirectories at all. Reading it must
 * not create them — the reviewer's repro saw presence/ projects/ resources/ appear on `hub gc`. */
const B = mktmp();
execSync('git init -q .', { cwd: B });
fs.writeFileSync(path.join(B, '.gitignore'), '*.lock\n');
fs.writeFileSync(path.join(B, 'tasks.cedar.events.jsonl'), JSON.stringify({ ev: 'add', id: 'cedar-1', node: 'cedar', ts: '2026-09-01 10:00', task: { id: 'cedar-1', project: 'p', text: 't', status: 'open' } }) + '\n');
const benv = { HUBD_DIR: B, HUBD_TEAM_DIR: B, HUBD_NODE: 'cedar' };
for (const argv of [['status'], ['gc', '--json'], ['task', 'list'], ['brief'], ['board'], ['doctor']]) {
  const C = mktmp();
  fs.cpSync(B, C, { recursive: true, preserveTimestamps: true });
  const before = snapshot(C);
  cli(argv, { env: { ...benv, HUBD_DIR: C, HUBD_TEAM_DIR: C }, cwd: C });
  const d = diff(before, snapshot(C));
  ok(!d.length, `read-only: hub ${argv.join(' ')} on a bare hub creates nothing${d.length ? '  — ' + d.slice(0, 6).join(' ') : ''}`);
}

done();
