// watch.mjs — hub watch: each new journal entry once, to a named cursor, whatever the mesh does to the files
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, T0, ok, cli, done } from './_h.mjs';

const W = await import(path.join(REPO, 'hub/lib/watch.mjs'));
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
const tsAgo = (min) => new Date(Date.now() - min * 60000).toISOString().slice(0, 16).replace('T', ' ');
let n = 0;
const entry = (text, o = {}) => JSON.stringify({ ts: o.ts || tsAgo(0), project: o.project || 'alpha', agent: o.agent || 'dev-a', kind: 'note', text, v: '0.0.0' });
const J = (f) => path.join(T0, f);
const append = (f, ...lines) => fs.appendFileSync(J(f), lines.map(l => l + '\n').join(''));
const pass = (name, o = {}) => { const got = []; const r = W.watchPass({ name, emit: e => got.push(e.text), ...o }); return { ...r, got }; };

// ── a new cursor starts now; then each entry once ──
append('journal.pine.jsonl', entry('before the cursor, an hour ago', { ts: tsAgo(60) }), entry('before the cursor, this minute'));
{
  const r = pass('bridge');
  ok(r.created && r.got.length === 0, 'watch: a new cursor shows nothing on its first pass, the entries already there included');
  ok(fs.existsSync(path.join(T0, '.watch', 'bridge.json')), 'watch: the cursor is a file under .watch/');
  const gi = [path.join(T0, '.gitignore'), path.join(T0, '.git', 'info', 'exclude')].map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  ok(/^\.watch\/$/m.test(gi), 'watch: .watch/ is ignored, so a cursor never travels by mesh-sync');
}
append('journal.pine.jsonl', entry('one'), entry('two'));
{
  const a = pass('bridge'), b = pass('bridge');
  ok(a.got.join() === 'one,two' && !a.created, 'watch: the next pass shows what was written since, oldest first');
  ok(b.got.length === 0, 'watch: a pass after that shows nothing: each entry once');
}

// ── what a synced hub does to the files ──
{
  const live = J('journal.pine.jsonl');
  // union merge: a line both sides held survives twice, and the next merge doubles it again
  append('journal.pine.jsonl', entry('one'), entry('two'), entry('three'), entry('three'));
  let r = pass('bridge');
  ok(r.got.join() === 'three', 'watch: lines a union merge doubled are not shown again, and a new line doubled in the same pass is shown once');
  // a merge puts a line this node has not seen BEFORE lines it has: an offset would already be past it
  const lines = fs.readFileSync(live, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(live, [lines[0], entry('merged in the middle'), ...lines.slice(1)].join('\n') + '\n');
  r = pass('bridge');
  ok(r.got.join() === 'merged in the middle', 'watch: a line merged in before lines already seen is shown, and only it');
  // a reset that shortens the file, then a pull that grows it back
  fs.writeFileSync(live, lines[0] + '\n');
  r = pass('bridge');
  ok(r.got.length === 0, 'watch: a file a reset shortened shows nothing');
  fs.writeFileSync(live, fs.readFileSync(live, 'utf8') + lines.slice(1).join('\n') + '\n' + entry('after the reset') + '\n');
  r = pass('bridge');
  ok(r.got.join() === 'after the reset', 'watch: the file grown back after a reset replays nothing; the one new line is shown');
  // rotation: the live file becomes a month archive, with a line written after the last pass in it
  append('journal.pine.jsonl', entry('just before the rotation'));
  const ym = new Date().toISOString().slice(0, 7);
  fs.renameSync(live, J(`journal.pine-${ym}.jsonl`));
  append('journal.pine.jsonl', entry('first in the new live file'));
  r = pass('bridge');
  ok(r.got.join() === 'just before the rotation,first in the new live file', 'watch: a rotation loses nothing (the line cut into the archive is shown) and replays nothing');
  fs.renameSync(J('journal.pine.jsonl'), J(`journal.pine-${ym}.2.jsonl`));
  append('journal.pine.jsonl', entry('after the second rotation'));
  r = pass('bridge');
  ok(r.got.join() === 'after the second rotation', 'watch: a second archive in the month (.2, sorting before the first) replays nothing');
}
{
  // two nodes that wrote the same bytes wrote two entries, as readLogEntries counts them
  const same = entry('the same words on two nodes');
  append('journal.fir.jsonl', same); append('journal.maple.jsonl', same);
  ok(pass('bridge').got.length === 2, 'watch: the same line in two nodes\' logs is two entries');
}

// ── what a pass shows, and what it marks ──
{
  pass('alpha-only', { project: 'alpha' }); pass('braid-too', { includePrivate: true });
  append('journal.fir.jsonl', entry('for alpha'), entry('for beta', { project: 'beta' }));
  append('journal.life.jsonl', JSON.stringify({ ts: tsAgo(0), project: 'alpha', agent: 'owner', kind: 'note', text: 'private', private: true }));
  const a = pass('alpha-only', { project: 'alpha' });
  ok(a.got.join() === 'for alpha', 'watch: --project shows that project\'s entries; the private braid is not shown');
  ok(pass('alpha-only').got.length === 0, 'watch: what a filter passed is marked, so dropping the filter replays nothing');
  ok(pass('braid-too', { includePrivate: true }).got.join() === 'for alpha,for beta,private', 'watch: --private shows the private braid too');
}
{
  pass('flaky');
  append('journal.fir.jsonl', entry('f1'), entry('f2'), entry('f3'));
  let calls = 0;
  const err = (() => { try { W.watchPass({ name: 'flaky', emit: () => { if (++calls === 2) { const e = new Error('gone'); e.code = 'EPIPE'; throw e; } } }); } catch (e) { return e; } })();
  ok(err && err.code === 'EPIPE', 'watch: an emit that fails ends the pass with its error');
  ok(pass('flaky').got.join() === 'f2,f3', 'watch: what was shown before the failure is marked; the rest is new on the next pass');
}
{
  append('journal.fir.jsonl', entry('forty minutes ago', { ts: tsAgo(40) }), entry('three hours ago', { ts: tsAgo(180) }));
  const r = pass('late-start', { since: '1h' });
  ok(r.created && r.got.includes('forty minutes ago') && !r.got.includes('three hours ago'), 'watch: --since places a new cursor earlier, and its first pass shows from there');
  ok(throws(() => pass('late-start', { since: '1h' }), /the cursor "late-start" exists .*--since only places a new one/), 'watch: --since on an existing cursor is an error, not a silent replay');
  ok(throws(() => pass('x', { since: 'yesterday' }), /neither a duration/), 'watch: a --since that is not a time is an error');
  ok(throws(() => pass('  '), /cursor name is required/), 'watch: a cursor needs a name');
}
{
  // the window: an entry older than it when it first arrives is not shown, and old marks are dropped
  pass('bridge');
  append('journal.fir.jsonl', entry('eight days late', { ts: tsAgo(8 * 1440) }));
  ok(pass('bridge').got.length === 0, `watch: an entry ${W.WINDOW_DAYS + 1} days old when it arrives is outside the ${W.WINDOW_DAYS}-day window`);
  const f = path.join(T0, '.watch', 'bridge.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  const oldBucket = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 13);
  c.seen[oldBucket] = 'aaaaaaaaaaaa';
  fs.writeFileSync(f, JSON.stringify(c));
  append('journal.fir.jsonl', entry('one more'));
  ok(pass('bridge').got.join() === 'one more' && !(oldBucket in JSON.parse(fs.readFileSync(f, 'utf8')).seen), 'watch: marks older than the window are dropped from the cursor');
  ok(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))).join() === 'name,from,windowDays,at,shown,seen', 'watch: the cursor file keeps name, from, windowDays, at, shown, seen');
}

// ── the command ──
{
  const env = { HUBD_DIR: T0, HUBD_SUBSCRIBER: undefined };
  let r = cli(['watch', '--json'], { env });
  ok(r.code === 1 && /needs a cursor name: --as <name>/.test(r.stderr), 'cli: watch without a name says how to give one');
  r = cli(['watch', '--as', 'cli', '--json'], { env });
  ok(r.code === 0 && r.stdout === '' && /a new cursor; entries written from now on are shown/.test(r.stderr), 'cli: the first run places the cursor, says so on stderr, prints nothing');
  cli(['report', '-p', 'alpha', '--agent', 'dev-cli', '-m', 'seen by the watch'], { env });
  r = cli(['watch', '--as', 'cli', '--json'], { env });
  const got = r.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  ok(r.code === 0 && got.length === 1 && got[0].text === 'seen by the watch' && got[0].agent === 'dev-cli', 'cli: --json prints one entry per line, as the journal holds it');
  r = cli(['watch', '--as', 'cli'], { env });
  ok(r.code === 0 && r.stdout === '', 'cli: the next run prints nothing');
  r = cli(['watch', '--as', 'cli', '--since', '1h'], { env });
  ok(r.code === 1 && /--since only places a new one/.test(r.stderr), 'cli: --since on an existing cursor exits 1');
  r = cli(['watch', '--as', 'cli', '--interval', '2'], { env });
  ok(r.code === 1 && /--interval paces --follow/.test(r.stderr), 'cli: --interval without --follow is an error');
  r = cli(['watch', '--as', 'cli', '--follow', '--interval', '0'], { env });
  ok(r.code === 1 && /not a number of seconds above 0/.test(r.stderr), 'cli: --interval 0 is an error');
  const t = Date.now();
  r = cli(['watch', '--as', 'cli', '--follow', '--intervall', '1'], { env });
  ok(r.code === 1 && /unknown flag/.test(r.stderr) && Date.now() - t < 10000, 'cli: a mistyped flag stops --follow before it settles in');
  cli(['report', '-p', 'beta', '--agent', 'dev-cli', '-m', 'plain'], { env });
  r = cli(['watch', '--as', 'cli', '-p', 'beta'], { env });
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \[beta\/dev-cli\] note: plain$/m.test(r.stdout), 'cli: without --json a line reads like hub log');
}
{
  // --follow: a report written while it runs is printed; a signal ends it with the entry marked
  const env = { ...process.env, HUBD_DIR: T0 };
  delete env.HUBD_SUBSCRIBER;
  const child = spawn(process.execPath, [path.join(REPO, 'hub/cli.mjs'), 'watch', '--as', 'follower', '--follow', '--interval', '0.2', '--json'], { env });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const until = async (f, ms = 8000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 50)); return f(); };
  await until(() => /a new cursor/.test(err));
  cli(['report', '-p', 'alpha', '--agent', 'dev-follow', '-m', 'while following'], { env: { HUBD_DIR: T0 } });
  const seen = await until(() => out.includes('while following'));
  ok(seen, 'cli: --follow prints an entry written while it runs');
  const code = await new Promise(r => { child.on('exit', (c) => r(c)); child.kill('SIGTERM'); });
  ok(code === 0, 'cli: --follow ends on SIGTERM with exit 0');
  const again = cli(['watch', '--as', 'follower', '--json'], { env: { HUBD_DIR: T0, HUBD_SUBSCRIBER: undefined } });
  ok(again.code === 0 && !again.stdout.includes('while following'), 'cli: what --follow printed stays marked after it ends');
  ok(out.trim().split('\n').filter(l => l.includes('while following')).length === 1, 'cli: --follow printed it once');
}
{
  const sh = fs.readFileSync(path.join(REPO, 'contrib/watch-to-matrix.sh'), 'utf8');
  ok(/hub watch --as \S+ --follow --json/.test(sh) && /_matrix\/client\/v3\/rooms\//.test(sh), 'contrib: the Matrix example follows hub watch --json and posts to the client API');
  ok(sh.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length <= 15, 'contrib: the Matrix example stays a short script');
}

done();
