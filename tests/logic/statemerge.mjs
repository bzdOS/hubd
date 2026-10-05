// statemerge.mjs — a file one node rewrites whole, merged by its time: the driver, and its install
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ok, mktmp, run, REPO, doc, done } from './_h.mjs';

const { mergeState, stampOf, STATE_ATTRS } = await import(path.join(REPO, 'hub/lib/statemerge.mjs'));

const j = (o) => JSON.stringify(o, null, 1) + '\n';
const snap = (ts, state) => j({ v: 1, node: 'fir', ts, sessions: [{ session: 's', role: 'r', state }] });
const BASE = snap('2026-10-05T14:00:00Z', 'IDLE');
const OLD = snap('2026-10-05T14:05:00Z', 'WORKING'), NEW = snap('2026-10-05T14:06:30Z', 'DOWN');
const gitClashes = (o, a, b) => {
  const d = mktmp();
  for (const [n, t] of [['o', o], ['a', a], ['b', b]]) fs.writeFileSync(path.join(d, n), t);
  return spawnSync('git', ['merge-file', '-p', path.join(d, 'a'), path.join(d, 'o'), path.join(d, 'b')]).status;
};

// ── the newer version, whichever side it is on ──
ok(gitClashes(BASE, OLD, NEW) > 0, 'premise: git\'s text merge stops on two rewrites of one snapshot');
ok(mergeState(BASE, OLD, NEW).text === NEW && mergeState(BASE, NEW, OLD).text === NEW,
  'newer: the later ts is taken from either side, so a merge and a rebase keep the same version');
ok(mergeState(BASE, NEW, OLD).took === 'ours' && mergeState(BASE, OLD, NEW).took === 'theirs', 'newer: and says which side it took');
{
  const pres = (written, n) => j({ node: 'fir', written, v: '0.9.50', agents: Array.from({ length: n }, (_, i) => ({ agent: 'a' + i })) });
  ok(mergeState('', pres('2026-10-05 14:09', 3), pres('2026-10-05 14:10', 1)).text === pres('2026-10-05 14:10', 1),
    'newer: presence and sense carry `written`, minutes in UTC; the later one is taken whole, not the bigger one');
  ok(mergeState('', pres('2026-10-05 23:59', 1), pres('2026-10-06 00:00', 1)).took === 'theirs', 'newer: across midnight too');
}
{
  const marks = (a, b) => j({ files: { 'r.fir.queue.md': { mark: '## x', off: 10, at: a } }, subs: { s: { 'r.pine.queue.md': { mark: '## y', off: 5, at: b } } } });
  ok(stampOf(marks('2026-10-05 14:00', '2026-10-05 14:20')) === Date.parse('2026-10-05T14:20Z'),
    'read marks: no time of their own; the latest `at` among the marks, a subscriber\'s included');
  ok(mergeState('', marks('2026-10-05 14:30', '2026-10-05 14:00'), marks('2026-10-05 14:00', '2026-10-05 14:20')).took === 'ours',
    'read marks: the version written last is taken');
}

// ── a version whose time does not read, and a tie ──
ok(mergeState(BASE, '{"v":1,"node":"fi', NEW).text === NEW && mergeState(BASE, NEW, '{"v":1,"node":"fi').text === NEW,
  'unreadable: a half-written file loses to one whose time reads, on either side');
ok(mergeState(BASE, j({ v: 1, node: 'fir' }), OLD).text === OLD, 'unreadable: so does one with no time in it');
{
  const a = snap('2026-10-05T14:06:30Z', 'IDLE');
  const r1 = mergeState(BASE, a, NEW), r2 = mergeState(BASE, NEW, a);
  ok(r1.why === 'tie' && r1.text === r2.text, 'tie: equal times pick the same version from either side, so two nodes cannot disagree');
  ok(mergeState('', 'x', 'y').text === mergeState('', 'y', 'x').text, 'tie: and so does a pair where neither time reads');
}
ok(mergeState(BASE, NEW, NEW).text === NEW && mergeState(BASE, NEW, NEW).why === 'same', 'same: two equal versions merge to themselves');

// ── the driver as git runs it: result into %A ──
{
  const d = mktmp(), f = (n, t) => { const p = path.join(d, n); fs.writeFileSync(p, t); return p; };
  const script = path.join(REPO, 'scripts/state-merge.mjs');
  let o = f('o', BASE), a = f('a', OLD), b = f('b', NEW);
  let r = spawnSync(process.execPath, [script, o, a, b]);
  ok(r.status === 0 && fs.readFileSync(a, 'utf8') === NEW, 'driver: theirs newer, %A now holds theirs');
  a = f('a', NEW); b = f('b', OLD); const before = fs.statSync(a).mtimeMs;
  r = spawnSync(process.execPath, [script, o, a, b]);
  ok(r.status === 0 && fs.readFileSync(a, 'utf8') === NEW && fs.statSync(a).mtimeMs === before, 'driver: ours newer, %A is left as it is');
  r = spawnSync(process.execPath, [script, o, path.join(d, 'missing'), b]);
  ok(r.status !== 0 && /hubd state merge:/.test(String(r.stderr)), 'driver: a file it cannot read exits non-zero, and says so');
}

// ── the install, beside the card driver ──
const H = mktmp();
execFileSync('git', ['init', '-q', '-b', 'main', H]);
const env = { HUBD_DIR: H, HUBD_TEAM_DIR: H };
const attrs = () => fs.readFileSync(path.join(H, '.git', 'info', 'attributes'), 'utf8');
const drv = () => { try { return execFileSync('git', ['-C', H, 'config', '--get', 'merge.hubd-state.driver'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const attrOf = (p) => execFileSync('git', ['-C', H, 'check-attr', 'merge', '--', p], { encoding: 'utf8' }).trim().split(': ').pop();
let r = run('card merge-driver', env);
ok(r.code === 0 && STATE_ATTRS.every(a => attrs().includes(a)), `install: hub card merge-driver puts the state attributes in .git/info/attributes too (code ${r.code})`);
ok(drv().includes('scripts/state-merge.mjs') && / %O %A %B \|\| true$/.test(drv()),
  'install: the driver names this hubd\'s script and keeps ours when it cannot run');
ok(['snapshot.fir.json', 'presence.fir.json', 'sense.fir.json', 'queues/read/r.fir.json'].every(p => attrOf(p) === 'hubd-state'),
  'install: snapshot, presence, sense and read-mark files take the driver');
ok(['sense.json', 'limits.json', 'sub/snapshot.fir.json', 'queues/r.fir.queue.md'].every(p => attrOf(p) === 'unspecified'),
  'install: the hub\'s own config files, other folders and the queues do not');
r = run('card merge-driver', env);
ok(r.code === 0 && STATE_ATTRS.every(a => attrs().split(a).length === 2), 'install: a second run adds no line twice');
r = run('card merge-driver --remove', env);
ok(r.code === 0 && !drv() && !STATE_ATTRS.some(a => attrs().includes(a)), 'install: --remove takes it out with the card driver');

// ── the node a command names: the link on PATH, not the versioned binary behind it ──
const { stableNode } = await import(path.join(REPO, 'hub/lib/cardmerge.mjs'));
{
  const real = fs.realpathSync(process.execPath), other = mktmp(), link = mktmp();
  fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(real, path.join(link, 'node'));
  ok(stableNode(real, [other, link].join(path.delimiter)) === path.join(link, 'node'),
    'node: the first `node` on PATH that is this same binary, past one that is not');
  ok(stableNode(real, other) === real && stableNode(real, '') === real, 'node: and the binary itself when PATH has no such link');
  r = run('card merge-driver', { ...env, PATH: link + path.delimiter + process.env.PATH });
  ok(r.code === 0 && drv().startsWith(`'${path.join(link, 'node')}' `), `install: the command names that link (${drv().split(' ')[0]})`);
}

// ── doctor: a driver that will not run, on a node that syncs ──
{
  const issues = () => doc.mergeDriverIssues(H);
  ok(issues().length === 0, 'doctor: both drivers installed and their files there - nothing to say');
  fs.writeFileSync(path.join(H, '.git', 'info', 'attributes'), attrs().replace('/presence.*.json merge=hubd-state\n', ''));
  ok(issues().length === 1 && issues()[0].name === 'hubd-state' && /attributes for \/presence\.\*\.json$/.test(issues()[0].what),
    'doctor: an attribute line gone - that pattern merges as text');
  const old = path.join(mktmp(), 'scripts');
  fs.mkdirSync(old);
  fs.copyFileSync(path.join(REPO, 'scripts/state-merge.mjs'), path.join(old, 'state-merge.mjs'));
  const { installStateDriver } = await import(path.join(REPO, 'hub/lib/statemerge.mjs'));
  installStateDriver(H, { script: path.join(old, 'state-merge.mjs') });
  fs.rmSync(old, { recursive: true });
  ok(issues().length === 1 && issues()[0].what === 'names a file that is gone: ' + path.join(old, 'state-merge.mjs') && /ours/.test(issues()[0].instead),
    'doctor: hubd moved - the command names a file that is gone, and ours is kept');
  execFileSync('git', ['-C', H, 'config', 'merge.hubd-state.driver', 'my-merge %O %A %B']);
  ok(issues().length === 0, 'doctor: a command set by hand is left to whoever set it');
  run('card merge-driver --remove', env);
  ok(issues().length === 2 && issues().every(i => i.what === 'not installed'), 'doctor: neither installed - both named');

  const O = mktmp(), C = mktmp();
  execFileSync('git', ['init', '-q', '-b', 'main', O]);
  execFileSync('git', ['-C', O, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  execFileSync('git', ['clone', '-q', O, C]);
  const cenv = { HUBD_DIR: C, HUBD_TEAM_DIR: C };
  let d = run('doctor', cenv);
  ok(/drivers: +2 merge driver\(s\) will not run on this node {2}WARNING/.test(d.out) && /hubd-state: not installed - a snapshot/.test(d.out)
    && /on this node: hub card merge-driver/.test(d.out), 'doctor: a mesh node without the drivers is warned, with what merges instead and the fix');
  run('card merge-driver', cenv);
  d = run('doctor', cenv);
  ok(/drivers: +hubd-card, hubd-state: in place/.test(d.out), 'doctor: and says so once they are in place');
  ok(!/drivers:/.test(run('doctor', env).out), 'doctor: a hub with no origin syncs with nobody and is not asked for them');
}

done();
