// reactions.mjs — the event -> action rules of <hub>/reactions.json, run by the MCP server itself.
// On a `hub demo` with a real git repo: an ACCEPT deletes the branch once it is merged, with no
// process of its own; two servers on one node run the rule once; the lease passes when its holder
// dies; a rule that names a command line, or that a worker declared, never runs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, ok, mktmp, reap, done } from './_h.mjs';

const W = mktmp();
const D = path.join(W, 'hub');
const HUBJS = path.join(REPO, 'hub/hub.mjs');
const base = { ...process.env, HUBD_AGENT: '', HUBD_NODE: 'elm', HUBD_SENSE_DIR: path.join(W, 'sense'), HUBD_SENSE_ESCALATIONS: path.join(W, 'esc.log'),
  GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const env = { ...base, HUBD_DIR: D, HUBD_TEAM_DIR: D, HUBD_REACTIONS_TICK_S: '1' };
const hub = (...argv) => { const r = spawnSync(process.execPath, [HUBJS, ...argv], { env, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...a], { cwd, env, encoding: 'utf8' }); if (r.status) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(f, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await sleep(150); } return f(); }

// the demo, a bare origin, a worker's clone and the head's review clone
{
  const r = spawnSync(process.execPath, [HUBJS, 'demo', D], { env: { ...base, HUBD_DIR: path.join(W, 'none') }, encoding: 'utf8' });
  ok(r.status === 0, `hub demo builds (${r.status}) ${r.status ? r.stderr : ''}`);
}
const R = path.join(W, 'relay');
fs.mkdirSync(R);
git(R, 'init', '-q', '--bare', 'origin.git');
git(R, 'clone', '-q', 'origin.git', 'work');
git(path.join(R, 'work'), 'commit', '-q', '--allow-empty', '-m', 'init');
git(path.join(R, 'work'), 'push', '-q', 'origin', 'main');
git(R, 'clone', '-q', 'origin.git', 'review');
hub('resource', 'set', 'relay-head', '--attr', `repo=${R}/origin.git`, '--attr', `review=${R}/review`, '--attr', 'private=\\.internal\\b', '--by', 'owner');

const HANDLER = path.join(REPO, 'examples/team/delete-merged-branch.sh');
const MARK = path.join(W, 'pwned');
fs.writeFileSync(path.join(D, 'reactions.json'), JSON.stringify({
  commands: { 'delete-merged': `REPO='${R}/review' sh '${HANDLER}'`, touch: `touch '${MARK}'` },
  rules: [
    { id: 'janitor', by: 'relay-head', project: 'relay', on: { kind: 'decision', match: '^ACCEPT ' }, run: 'delete-merged' },
    { id: 'by-a-worker', by: 'relay-dev', every: '1s', run: 'touch' },
    { id: 'a-command-line', by: 'owner', every: '1s', run: `touch '${MARK}'` },
    { id: 'other-project', by: 'relay-head', project: 'atlas', every: '1s', run: 'touch' },
  ],
}, null, 2));

{
  const r = hub('reactions');
  ok(r.code === 1, `hub reactions exits 1 while a declared rule is refused (${r.code})`);
  ok(/by-a-worker[\s\S]*REFUSED: by "relay-dev"/.test(r.out), 'a rule a worker declared is refused');
  ok(/a-command-line[\s\S]*REFUSED: run .* is not a command declared in commands/.test(r.out), 'a rule that names a command line, not a declared command, is refused');
  ok(/other-project[\s\S]*REFUSED/.test(r.out), 'a head declares rules for its own project only');
  ok(/janitor\s+on kind=decision[\s\S]*lease: nobody yet/.test(r.out), 'the janitor rule is valid and nobody holds it yet');
}

// two MCP servers over stdio on one node, stdin held open as an agent session holds it
const server = () => reap(spawn(process.execPath, [path.join(REPO, 'hub/index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] }));
const s1 = server(), s2 = server();
const out = { [s1.pid]: '', [s2.pid]: '' };
for (const s of [s1, s2]) { s.stdout.on('data', d => { out[s.pid] += d; }); s.stderr.resume(); }
const leaseOf = () => { try { return JSON.parse(fs.readFileSync(path.join(D, '.reactions', 'janitor.elm.lease'), 'utf8')); } catch { return null; } };
const first = await until(() => leaseOf());
ok(first && [s1.pid, s2.pid].includes(first.pid), `one of the two servers holds the janitor's lease (${first && first.pid})`);
const cursor = await until(() => fs.existsSync(path.join(D, '.watch', 'reaction-janitor-elm.json')));
ok(cursor, 'the rule keeps a cursor of its own, from the moment it first ran');

// a worker's branch, accepted by the head
git(path.join(R, 'work'), 'checkout', '-q', '-b', 'task/backoff');
fs.writeFileSync(path.join(R, 'work', 'backoff.txt'), 'retry with backoff\n');
git(path.join(R, 'work'), 'add', 'backoff.txt');
git(path.join(R, 'work'), 'commit', '-q', '-m', 'retry: back off');
git(path.join(R, 'work'), 'push', '-q', 'origin', 'task/backoff');
const SHA = git(path.join(R, 'work'), 'rev-parse', 'HEAD');
{
  const r = hub('sense', 'relay-head', 'verdict', 'task/backoff', 'accept', 'backoff is capped');
  ok(r.code === 0, `the head accepts the branch (${r.code}) ${r.code ? r.out : ''}`);
}
const branchThere = () => /task\/backoff/.test(git(path.join(R, 'origin.git'), 'branch', '--list'));
const reactionLines = () => JSON.parse(hub('log', '-n', '200', '--json').out || '[]').filter(e => e.kind === 'reaction');
await sleep(3000);
ok(branchThere(), 'accepted but not merged: the branch stays, the handler said "not yet" (exit 1)');
ok(reactionLines().length === 0, 'a "not yet" is not journaled');
{
  const st = JSON.parse(hub('reactions', '--json').out);
  const j = st.rules.find(r => r.id === 'janitor');
  ok(j && j.lease && j.lease.alive, 'hub reactions shows the live lease');
}

// the worker merges; within a tick or two the branch is gone, deleted once
git(path.join(R, 'work'), 'push', '-q', 'origin', `${SHA}:refs/heads/main`);
const gone = await until(() => !branchThere());
ok(gone, 'merged: the branch is deleted by the MCP server, with no watcher process of its own');
await sleep(2500);
{
  const fired = reactionLines().filter(e => /^janitor: fired on decision/.test(e.text));
  ok(fired.length === 1, `two servers on one node: the rule fired once (${fired.length})`);
  ok(fired[0] && fired[0].agent === 'reactions@elm' && /deleted task\/backoff/.test(fired[0].text), `the firing is journaled with what the command said: ${fired[0] && fired[0].text}`);
}
ok(!fs.existsSync(MARK), 'no refused rule ever ran');

// the holder dies without letting go; the other server takes the lease
const holder = leaseOf().pid === s1.pid ? s1 : s2, other = holder === s1 ? s2 : s1;
holder.kill('SIGKILL');
const moved = await until(() => { const l = leaseOf(); return l && l.pid === other.pid; }, 8000);
ok(moved, 'the holder is killed: its lease passes to the other server at once (its pid is gone)');
ok(!out[s1.pid] && !out[s2.pid], 'the commands\' output never reached a server\'s stdout, where it speaks JSON-RPC');

// the server that lives on ends cleanly and lets go of its lease
other.stdin.end();
await until(() => other.exitCode !== null || other.signalCode !== null, 8000);
ok(other.exitCode === 0, `a server whose session ends exits 0 (${other.exitCode})`);
ok(!leaseOf(), 'and releases the lease it held');

// a periodic rule, through `hub reactions run`: output to a queue, exit 1 is "nothing to do"
fs.writeFileSync(path.join(D, 'reactions.json'), JSON.stringify({
  commands: { stale: `printf 'relay-api: the deploy is 3 days old\\n'`, quiet: 'exit 1', broken: 'exit 7', 'hub-log': 'hub log relay -n 1' },
  rules: [
    { id: 'stale-deploy', by: 'relay-head', project: 'relay', every: '10m', run: 'stale', queue: 'relay-dev' },
    { id: 'quiet', by: 'owner', every: '10m', run: 'quiet' },
    { id: 'broken', by: 'coord', every: '10m', run: 'broken' },
    { id: 'on-another-node', by: 'owner', every: '1s', run: 'broken', node: 'fir' },
    { id: 'own-cli', by: 'owner', every: '10m', run: 'hub-log', heartbeat: { agent: 'relay-api-check', ttl: 30 }, journal: 'change' },
  ],
}));
{
  const r = hub('reactions', 'run');
  ok(/stale-deploy: fired/.test(r.out), `a periodic rule that exits 0 fired: ${r.out.split('\n')[0]}`);
  ok(/quiet: nothing/.test(r.out), 'exit 1 is nothing to do');
  ok(/broken: failed - exited 7/.test(r.out), 'exit 7 is a failure (a fleet role may declare a rule)');
  ok(reactionLines().some(e => /^broken: FAILED \(exited 7\)/.test(e.text)), 'the failure is journaled');
  hub('reactions', 'run');
  ok(/on-another-node: elsewhere - runs on fir/.test(r.out), 'a rule that names another node does not run here');
  ok(/own-cli: fired/.test(r.out), 'a command that starts with `hub ` runs this hub\'s own CLI');
  const q = hub('queue', 'list', 'relay-dev', '-n', '1');
  ok(/the deploy is 3 days old/.test(q.out), 'its output went to the role\'s queue');
  const p = hub('presence');
  ok(/relay-api-check/.test(p.out), 'a heartbeat rule leaves the agent present');
  const again = hub('reactions', 'run');
  ok(/stale-deploy: waiting/.test(again.out), 'run again at once: the interval has not passed');
  const lines = reactionLines().filter(e => /^(stale-deploy|own-cli|quiet):/.test(e.text));
  ok(lines.filter(e => e.text.startsWith('own-cli')).length === 1 && !lines.some(e => e.text.startsWith('quiet')), 'journaled: each firing once, "nothing to do" never');
}
done();
