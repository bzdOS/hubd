// watch.mjs — hub watch: each new journal entry once, to a named cursor, whatever the mesh does to the files
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, T0, ok, cli, done, mktmp } from './_h.mjs';

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

// ── --exec: each entry to a command, marked when it exits 0 ──
const X = mktmp();
const XF = (f) => path.join(X, f);
const lines = (f) => { try { return fs.readFileSync(XF(f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 50)); return f(); };
{
  pass('execer');
  append('journal.fir.jsonl', entry('x1'), entry('x2'), entry('x3'));
  // each command logs its key and the cursor as it stands when the command starts
  const cmd = `cat >> '${XF('in')}'; { echo "$HUBD_WATCH_KEY"; tr -d '\\n' < '${W.watchFile('execer')}'; echo; } >> '${XF('log')}'; test -e '${W.watchFile('execer')}.lock'`;
  let r = await W.watchExec({ name: 'execer', cmd });
  const got = lines('in').map(l => JSON.parse(l));
  ok(!r.failed && r.shown === 3 && got.map(e => e.text).join() === 'x1,x2,x3', 'exec: each entry goes to the command as one JSON line on stdin, oldest first');
  const log = lines('log');
  const keys = log.filter((_, i) => i % 2 === 0);
  ok(keys.length === 3 && keys.every(k => /^[0-9a-f]{12}$/.test(k)) && new Set(keys).size === 3, 'exec: HUBD_WATCH_KEY is the entry\'s key, one per entry');
  ok(log[3].includes(keys[0]) && !log[3].includes(keys[1]) && log[5].includes(keys[1]), 'exec: the cursor is saved after each entry, before the next command starts');
  r = await W.watchExec({ name: 'execer', cmd: 'cat >/dev/null' });
  ok(!r.failed && r.shown === 0, 'exec: an entry the command took is not handed over again');

  fs.rmSync(XF('in'));
  append('journal.fir.jsonl', entry('y1'), entry('y2'), entry('y3'));
  const failing = `e=$(cat); echo "$HUBD_WATCH_KEY $e" >> '${XF('in')}'; case "$e" in *'"y2"'*) exit 3;; esac`;
  r = await W.watchExec({ name: 'execer', cmd: failing });
  ok(r.failed && r.failed.why === 'exited 3' && r.shown === 1 && lines('in').length === 2, 'exec: a command that exits non-zero stops the pass at its entry, with the reason');
  const firstKey = lines('in')[1].split(' ')[0];
  r = await W.watchExec({ name: 'execer', cmd: `e=$(cat); echo "$HUBD_WATCH_KEY $e" >> '${XF('in')}'` });
  const again = lines('in').slice(2);
  ok(!r.failed && again.map(l => JSON.parse(l.slice(13)).text).join() === 'y2,y3', 'exec: the failed entry and the ones after it are handed over on the next pass');
  ok(again[0].split(' ')[0] === firstKey, 'exec: a retried entry carries the same HUBD_WATCH_KEY, so a receiver can drop the repeat');

  append('journal.fir.jsonl', entry('z1'), entry('z2'));
  const t = Date.now();
  r = await W.watchExec({ name: 'execer', cmd: 'sleep 5', timeoutS: 1 });
  ok(r.failed && r.failed.why === 'ran past 1 s and was killed' && Date.now() - t < 4000 && r.shown === 0, 'exec: a command past its time is killed, and its entry stays new');
  let calls = 0;
  r = await W.watchExec({ name: 'execer', cmd: 'cat >/dev/null', stop: () => calls++ > 0 });
  ok(!r.failed && r.shown === 1, 'exec: stop() ends the pass after the entry in flight');
  r = await W.watchExec({ name: 'execer', cmd: `cat >> '${XF('z')}'` });
  ok(r.shown === 1 && JSON.parse(lines('z')[0]).text === 'z2', 'exec: what a stopped pass did not hand over is new on the next one');
}
{
  const env = { HUBD_DIR: T0, HUBD_SUBSCRIBER: undefined };
  let r = cli(['watch', '--as', 'cli-exec', '--exec', 'cat', '--json'], { env });
  ok(r.code === 1 && /--json has nothing to shape/.test(r.stderr), 'cli: --exec with --json is an error');
  r = cli(['watch', '--as', 'cli-exec', '--exec'], { env });
  ok(r.code === 1 && /--exec needs a value/.test(r.stderr), 'cli: --exec without a command is an error');
  cli(['watch', '--as', 'cli-exec'], { env });
  cli(['report', '-p', 'alpha', '--agent', 'dev-exec', '-m', 'to the command'], { env });
  r = cli(['watch', '--as', 'cli-exec', '--exec', 'exit 4'], { env });
  ok(r.code === 1 && /the command exited 4 on the entry of .* \[alpha\/dev-exec\]; it and the entries after it are handed over again on the next run/.test(r.stderr), 'cli: one pass whose command fails exits 1 and names the entry');
  r = cli(['watch', '--as', 'cli-exec', '--exec', 'cat'], { env });
  ok(r.code === 0 && JSON.parse(r.stdout).text === 'to the command', 'cli: the command\'s own output goes to the watch\'s stdout; the entry is handed over again after a failure');
  r = cli(['watch', '--as', 'cli-exec', '--exec', 'cat'], { env });
  ok(r.code === 0 && r.stdout === '', 'cli: once the command exits 0, the entry is not handed over again');
}
{
  // --follow --exec: a failing command is retried each interval, and its recovery is said once
  const env = { ...process.env, HUBD_DIR: T0 };
  delete env.HUBD_SUBSCRIBER;
  const gate = XF('gate');
  const cmd = `test -e '${gate}' || exit 1; cat >> '${XF('followed')}'`;
  const child = spawn(process.execPath, [path.join(REPO, 'hub/cli.mjs'), 'watch', '--as', 'exec-follow', '--follow', '--interval', '0.2', '--exec', cmd], { env });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  await until(() => /a new cursor/.test(err));
  cli(['report', '-p', 'alpha', '--agent', 'dev-gate', '-m', 'behind the gate'], { env: { HUBD_DIR: T0 } });
  ok(await until(() => /the command exited 1 on the entry of .*\[alpha\/dev-gate\].* every 0\.2 s until it exits 0/.test(err)), 'cli: --follow says a failing command once, and that it retries');
  await new Promise(r => setTimeout(r, 700));
  fs.writeFileSync(gate, '');
  ok(await until(() => /the command exits 0 again, after \d+ failed attempt\(s\)/.test(err)), 'cli: --follow says when the command exits 0 again');
  ok((err.match(/the command exited 1/g) || []).length === 1, 'cli: the failure is said once, not on every retry');
  ok(lines('followed').length === 1 && JSON.parse(lines('followed')[0]).text === 'behind the gate', 'cli: the entry reaches the command once it exits 0');

  // a signal while a command runs: it finishes, the entry is marked, the rest waits
  const slow = `cat >/dev/null; touch '${XF('started')}'; sleep 1; echo "$HUBD_WATCH_KEY" >> '${XF('slow')}'`;
  const c2 = spawn(process.execPath, [path.join(REPO, 'hub/cli.mjs'), 'watch', '--as', 'exec-sig', '--follow', '--interval', '0.2', '--exec', slow], { env });
  let err2 = '';
  c2.stderr.on('data', d => { err2 += d; });
  await until(() => /a new cursor/.test(err2));
  cli(['report', '-p', 'alpha', '--agent', 'dev-sig', '-m', 'first of two'], { env: { HUBD_DIR: T0 } });
  cli(['report', '-p', 'alpha', '--agent', 'dev-sig', '-m', 'second of two'], { env: { HUBD_DIR: T0 } });
  await until(() => fs.existsSync(XF('started')));
  const code = await new Promise(r => { c2.on('exit', (c) => r(c)); c2.kill('SIGTERM'); });
  ok(code === 0 && lines('slow').length === 1, 'cli: SIGTERM while a command runs lets it finish, then exits 0 without the next entry');
  const rest = cli(['watch', '--as', 'exec-sig', '--exec', 'cat'], { env: { HUBD_DIR: T0, HUBD_SUBSCRIBER: undefined } });
  ok(rest.code === 0 && rest.stdout.trim().split('\n').map(l => JSON.parse(l).text).join() === 'second of two', 'cli: after the signal only the entry not yet handed over is new');
  child.kill('SIGTERM');
  await new Promise(r => child.on('exit', r));
}
{
  const sh = fs.readFileSync(path.join(REPO, 'contrib/watch-to-matrix.sh'), 'utf8');
  ok(/hub watch --as \S+ --follow .*--exec/.test(sh) && /_matrix\/client\/v3\/rooms\//.test(sh), 'contrib: the Matrix example follows hub watch --exec and posts to the client API');
  ok(sh.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length <= 15, 'contrib: the Matrix example stays a short script');
}
if (spawnSync('jq', ['--version']).status !== 0) console.log('note: no jq here, so the Matrix example was not run');
else {
  // the example run for real, against a curl that keeps what it was given and fails its first post
  const bin = mktmp(), seen = XF('curl');
  fs.writeFileSync(path.join(bin, 'hub'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(REPO, 'hub/cli.mjs')}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\n{ for a in "$@"; do echo "arg $a"; done; echo "data $(cat)"; } >> '${seen}'\ntest -e '${seen}.once' && exit 0\ntouch '${seen}.once'; exit 22\n`, { mode: 0o755 });
  const env = { ...process.env, HUBD_DIR: T0, PATH: `${bin}:${process.env.PATH}`, MATRIX_HS: 'https://matrix.example.org', MATRIX_ROOM: '!room:example.org', MATRIX_TOKEN: 'tok' };
  delete env.HUBD_SUBSCRIBER;
  const child = spawn('/bin/sh', [path.join(REPO, 'contrib/watch-to-matrix.sh'), '-p', 'alpha', '--interval', '0.2'], { env });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  await until(() => /a new cursor/.test(err));
  cli(['report', '-p', 'alpha', '--agent', 'dev-mx', '-m', 'say "hi" & $HOME'], { env: { HUBD_DIR: T0 } });
  await until(() => /exits 0 again/.test(err));
  await new Promise(r => { child.on('exit', r); child.kill('SIGTERM'); });
  const posts = fs.readFileSync(seen, 'utf8').split(/\n(?=arg -fsS)/);
  const url = (p) => (p.match(/^arg (https:\S+)$/m) || [])[1];
  const data = (p) => { try { return JSON.parse((p.match(/^data (.*)$/m) || [])[1]); } catch { return null; } };
  ok(posts.length === 2 && url(posts[0]) && url(posts[0]) === url(posts[1]), 'contrib: a failed post is posted again, with the same transaction id');
  ok(/^https:\/\/matrix\.example\.org\/_matrix\/client\/v3\/rooms\/%21room%3Aexample\.org\/send\/m\.room\.message\/hubd-[0-9a-f]{12}$/.test(url(posts[1]) || ''), 'contrib: the room is escaped into the path, and the transaction id is the entry\'s key');
  const d = data(posts[1]);
  ok(d && d.msgtype === 'm.text' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \[alpha\/dev-mx\] note: say "hi" & \$HOME$/.test(d.body), 'contrib: the message body is the entry as hub log reads it, quotes and dollars intact');
  ok(/^arg Authorization: Bearer tok$/m.test(posts[1]), 'contrib: the token goes in the Authorization header');
}

done();
