// cli.mjs — the CLI: init, help, the argument parser, JSON through a pipe, a wrapper that cannot load
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, CLI, ok, mktmp, run, cli, done } from './_h.mjs';

// ── init does not scaffold a team into somebody's source checkout ──
// Found by healthchecking 0.9.0: `hub init` with no argument took the cwd, and run from a code
// repo it dropped AGENTS.md / INBOX.md / queues/ / specs/ in there, ready to be committed by
// accident. This repo's own .gitignore carries /queues/ and /INBOX.md — the scar of the same
// misroute, papered over rather than fixed.
const IN = mktmp();
execSync('git init -q .', { cwd: IN });
// cwd matters here and run() inherits the test process's own — which IS a checkout, so using it
// would have re-run the very misroute this test is about, in this repo.
const inCwd = (a) => {
  try { return { code: 0, out: execSync(`${CLI} ${a}`, { cwd: IN, env: { ...process.env, HUBD_DIR: path.join(IN, 'hubbase') }, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
};
const initRepo = inCwd('init');
ok(initRepo.code === 1 && /source checkout/.test(initRepo.out),
  `init: refuses a bare init inside a checkout (code ${initRepo.code})`);
ok(!fs.existsSync(path.join(IN, 'AGENTS.md')) && !fs.existsSync(path.join(IN, 'specs')),
  'init: and writes nothing at all when it refuses');
const initTarget = path.join(IN, 'team');
fs.mkdirSync(initTarget);
inCwd(`init ${initTarget}`);
ok(fs.existsSync(path.join(initTarget, 'AGENTS.md')) && fs.existsSync(path.join(initTarget, 'queues', 'README.md')),
  'init: an explicit folder still scaffolds');
inCwd('init --here');
ok(fs.existsSync(path.join(IN, 'AGENTS.md')),
  'init: --here overrides the guard, so a deliberate scaffold-in-place is one flag away');
fs.rmSync(IN, { recursive: true, force: true });

// ── machine-readable output survives a pipe ──
// A pipe buffers 64KB and Node writes to it asynchronously, so process.exit() right after a
// large console.log used to drop the rest: `hub task list --json` came back cut mid-token,
// valid-looking and short, with nothing saying it had been truncated. execSync reads through
// a pipe, so this test sees exactly what `| jq` would.
const PIPE = mktmp();
fs.writeFileSync(path.join(PIPE, 'tasks.pipe.events.jsonl'),
  Array.from({ length: 140 }, (_, i) => JSON.stringify({
    ts: '2026-06-01 10:00', node: 'pipe', ev: 'add', id: `pipe-${i}`,
    t: { id: `pipe-${i}`, project: 'p', text: 'x'.repeat(700), status: 'open', importance: 'normal', created: '2026-06-01 10:00', by: 'dev-t' },
  })).join('\n') + '\n');
// The reader has to be SLOW to start, or this test is a coin flip: whether the truncation
// shows at all depends on whether the reader drains the pipe before the child exits, and a
// fast reader (execSync's own capture, a prompt `| cat`) usually wins that race. A reader
// that sleeps first guarantees the 64KB buffer fills while the writer is still going —
// which is precisely the case a real consumer hits (`| jq`, an agent parsing the output).
const piped = run('task list --json --status all | { sleep 0.4; cat; }', { HUBD_DIR: PIPE, HUBD_NODE: 'pipe' });
ok(piped.out.length > 65536, `pipe: the payload really is bigger than a pipe buffer (${piped.out.length}B)`);
let pipedJson = null; try { pipedJson = JSON.parse(piped.out); } catch {}
ok(pipedJson && pipedJson.tasks.length === 140,
  `pipe: a >64KB --json payload arrives whole and parses (${pipedJson ? pipedJson.tasks.length + ' tasks' : 'TRUNCATED at ' + piped.out.length + 'B'})`);
fs.rmSync(PIPE, { recursive: true, force: true });

// ── `hub` itself: a CLI that cannot load still exits with a code that means failure ──
const WR = mktmp();
{
  fs.cpSync(path.join(REPO, 'hub'), path.join(WR, 'hub'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(WR, 'package.json'));
  fs.rmSync(path.join(WR, 'hub', 'lib', 'sense.mjs'));
  const wr = (a) => { try { execSync(`node ${WR}/hub/hub.mjs ${a}`, { stdio: 'pipe', env: { ...process.env, HUBD_DIR: WR } }); return { code: 0, err: '' }; } catch (e) { return { code: e.status, err: String(e.stderr || '') }; } };
  const bs = wr('sense h1');
  ok(bs.code === 3 && /sense\.mjs/.test(bs.err), `hub: a module that fails to load exits 3 for hub sense, with the error printed — never 1, "no events" (got ${bs.code})`);
  ok(wr('version').code === 1, 'hub: every other command keeps the exit code a crash always had');
  let good = 0; try { execSync(`node ${REPO}/hub/hub.mjs version`, { stdio: 'pipe' }); } catch (e) { good = e.status; }
  ok(good === 0, 'hub: the wrapper runs the CLI as before');
}

// ── the CLI: a flag no command reads is an error, and the help lists every command ──
const HL = mktmp();
{
  const fl = run('report --message x', { HUBD_DIR: HL, HUBD_AGENT: 'dev-t' });
  ok(fl.code === 1 && /unknown flag: --message/.test(fl.out), 'cli: a flag no command reads is an error, not silently dropped (use -m)');
  // every registered command has a help line; its first name is the one the line starts with
  const cliSrc = fs.readFileSync(path.join(REPO, 'hub/cli.mjs'), 'utf8');
  const registered = [...new Set([...cliSrc.matchAll(/^command\((?:\['([^']+)'|'([^']+)')/gm)].map(m => m[1] || m[2]))].filter(n => !n.startsWith('_'));
  const help = run('--help', { HUBD_DIR: HL });
  const missing = registered.filter(n => !new RegExp('^  ' + n + '\\b', 'm').test(help.out));
  ok(help.code === 0 && registered.length > 40 && !missing.length, `cli: hub --help lists every command (missing: ${missing.join(', ') || 'none'})`);
  const qh = run('queue --help', { HUBD_DIR: HL });
  ok(qh.code === 0 && /queue gc/.test(qh.out) && !/^  status/m.test(qh.out), 'cli: hub <cmd> --help prints that command\'s lines only');
  const sub = run('cards', { HUBD_DIR: HL });
  ok(sub.code === 1 && /no such subcommand/.test(sub.out) && /cards compact/.test(sub.out), 'cli: a command without its subcommand says so and lists them');
}

// ── init scaffolds a team folder, and a second run changes nothing ──
{
  const IN = mktmp(), team = path.join(IN, 'team'); fs.mkdirSync(team);
  const i1 = cli(['init', team]);
  ok(i1.code === 0 && /created/i.test(i1.out), 'init: exit 0, and it says what it created');
  ok(['AGENTS.md', 'INBOX.md', 'queues/README.md', '.gitignore'].every(f => fs.existsSync(path.join(team, f))),
    'init: AGENTS.md, INBOX.md, queues/README.md and .gitignore are there');
  // the template describes the CURRENT queue model: a fresh team root otherwise gets a manual contradicting HUBD.md
  ok(/subscriber-roles\.json/.test(fs.readFileSync(path.join(team, 'queues', 'README.md'), 'utf8')), 'init: queues/README.md documents fan-out (subscriber-roles.json)');
  const kept = ['AGENTS.md', 'INBOX.md', 'queues/README.md'], before = kept.map(f => fs.readFileSync(path.join(team, f), 'utf8'));
  const i2 = cli(['init', team]);
  ok(i2.code === 0 && /exists/i.test(i2.out), 'init again: exit 0, and it says the files exist');
  ok(kept.every((f, k) => fs.readFileSync(path.join(team, f), 'utf8') === before[k]), 'init again: AGENTS.md, INBOX.md and queues/README.md are byte-for-byte what they were');
  ok(cli(['init', path.join(IN, 'nope')]).code !== 0, 'init: a folder that does not exist is an error');
  // The connect line is pasted as printed, so it names an author and the hub this shell is using:
  // without HUBD_AGENT every MCP write is refused or floored, without HUBD_DIR it is ~/.hubd.
  const connect = (env) => (cli(['init', team], { env }).stdout.match(/Connect an agent: +(.+)/) || [])[1] || '';
  const c1 = connect({ HUBD_DIR: team, HUBD_TEAM_DIR: undefined, HUBD_NODE: 'oak', HUBD_AGENT: 'someone-else' });
  ok(c1 === `claude mcp add --scope user hubd --env HUBD_AGENT=dev-<project> --env HUBD_DIR=${team} --env HUBD_NODE=oak -- npx -y @bzdos/hubd`,
    `init: the connect line carries HUBD_AGENT and the hub's own env (got ${c1})`);
  const c2 = connect({ HUBD_DIR: undefined, HUBD_TEAM_DIR: undefined, HUBD_NODE: undefined, PROJECT_HUB_DIR: undefined, HOME: IN });
  ok(c2 === 'claude mcp add --scope user hubd --env HUBD_AGENT=dev-<project> -- npx -y @bzdos/hubd', `init: with the default hub only the author is added (got ${c2})`);
  const spaced = path.join(IN, 'a team'); fs.mkdirSync(spaced);
  const c3 = connect({ HUBD_DIR: spaced, HUBD_TEAM_DIR: undefined, HUBD_NODE: undefined });
  ok(c3.includes(`--env 'HUBD_DIR=${spaced}'`), `init: a value with a space is quoted for the shell (got ${c3})`);
}

// ── an unknown command is an error; no arguments is the help ──
{
  const u = cli(['definitely-not-a-cmd']);
  ok(u.code !== 0 && /unknown command/i.test(u.out), 'cli: an unknown command is an error that says so');
  const h = cli([]);
  ok(h.code === 0 && /\binit\b/.test(h.out) && /\bdoctor\b/.test(h.out), 'cli: no arguments prints the help, exit 0');
}

// ── the argument parser: a flag is never taken for the text, whatever the order ──
{
  const P = mktmp(), env = { HUBD_DIR: P, HUBD_TEAM_DIR: P };
  // `hub task add -p x --by y` used to file a task whose text was "-p", forever, in an append-only log
  const t = cli(['task', 'add', '-p', 'smokeproj', '--by', 'smoke'], { env });
  ok(t.code !== 0 && /Text required/.test(t.out), 'task add: a flag where the text belongs is refused with the usage');
  ok(!fs.readdirSync(P).filter(f => /^tasks\..*\.events\.jsonl$/.test(f)).some(f => /"text":"-p"/.test(fs.readFileSync(path.join(P, f), 'utf8'))),
    'task add: and nothing is written');

  // bodies that were literally "--from", "--text", "--agent": the parser took args[3] blindly
  const qdir = path.join(P, 'queues');
  const blocks = () => (fs.existsSync(qdir) ? fs.readdirSync(qdir) : []).filter(f => /^qs\..*\.queue\.md$/.test(f))
    .map(f => fs.readFileSync(path.join(qdir, f), 'utf8')).join('').split(/^## \d{4}-\d{2}-\d{2} .*$/m).slice(1);
  const last = () => { const b = blocks(); return (b[b.length - 1] || '').replace(/^\n/, ''); };
  const send = (argv, input) => cli(['queue', 'send', 'qs', ...argv], { env, input });
  ok(send(['line one\nline two', '--from', 'smoke']).code === 0 && /^line one\nline two$/m.test(last()), 'queue send: a multiline positional body lands whole');
  ok(send(['--from', 'smoke', 'flag before text']).code === 0 && /^flag before text$/m.test(last()), 'queue send: --from before the text, and the body is the text, not the word --from');
  ok(send(['--from', 'smoke', '--text', '- starts with a dash']).code === 0 && /^- starts with a dash$/m.test(last()), 'queue send: --text carries a body that starts with -');
  ok(send(['--agent', 'smoke', 'agent alias']).code === 0 && /^agent alias$/m.test(last()), 'queue send: --agent names the sender and the body is intact');
  const n = blocks().length;
  const r1 = send(['-oops', '--from', 'smoke']), r2 = send(['text', '--nope', 'x', '--from', 'smoke']), r3 = send(['--from', 'smoke']);
  ok(r1.code !== 0 && /unknown flag -oops/.test(r1.out), 'queue send: a bare body starting with - is refused with an explicit error');
  ok(r2.code !== 0 && /unknown flag --nope/.test(r2.out), 'queue send: an unknown flag is an error, not a swallowed body');
  ok(r3.code !== 0 && blocks().length === n, 'queue send: a missing body is an error, and none of the refused sends wrote anything');
  const big = Array.from({ length: 120 }, (_, i) => `line ${i}: "quotes" $dollars \`ticks\` \\backslash %percent -- \u00fcn\u00efc\u00f8d\u00e9`).join('\n') + '\n';
  ok(Buffer.byteLength(big) > 8000 && send(['-', '--from', 'smoke'], big).code === 0 && last().replace(/\n+$/, '\n') === big,
    'queue send: an 8 KB stdin body with quotes, dollars, ticks and backslashes arrives byte-for-byte');

  const c1 = cli(['claim', '--agent', 'smoke', '-t', '5', 'smokeproj', 'src/**'], { env });
  ok(c1.code === 0 && /^Lock: /m.test(c1.out), 'claim: flags before the positionals still claim');
  ok(cli(['claim', 'check', 'src/a.ts', '-p', 'smokeproj', '--agent', 'other'], { env }).code === 1, "claim: the area claimed was 'src/**', not '--agent' (check finds it)");
  const c3 = cli(['claim', 'smokeproj', 'x', '--bogus', '1', '--agent', 'smoke'], { env });
  ok(c3.code !== 0 && /unknown flag --bogus/.test(c3.out), 'claim: an unknown flag is refused, not swallowed as the area');
  const tid = (/^Task #(\S+) added/m.exec(cli(['task', 'add', 'close me', '-p', 'smokeproj', '--by', 'smoke'], { env }).out) || [])[1];
  const td = cli(['task', 'done', '--by', 'smoke', String(tid)], { env });
  ok(tid && td.code === 0 && /closed/.test(td.out), 'task done: --by before the id closes the id, not the word --by');
}

// ── presence and the log have a machine-readable form ──
// Fleet tooling regex-parsed the one-line renders, and for presence read presence/*.json behind the hub's back.
{
  const J = mktmp(), env = { HUBD_DIR: J, HUBD_TEAM_DIR: J };
  cli(['heartbeat', 'json-probe', '--status', 'a status longer than the eleven columns of the table'], { env });
  let pj = null; try { pj = JSON.parse(cli(['presence', '--json'], { env }).stdout); } catch {}
  const a = pj && pj.agents.find(x => x.agent === 'json-probe');
  ok(a && a.status.includes('eleven columns') && 'alive' in a && Array.isArray(pj.coverage), 'presence --json: the full status, alive and coverage, the object hub_presence returns');
  cli(['report', '-p', 'jsonproj', '--agent', 'smoke', '-k', 'note', '-m', 'json log entry'], { env });
  let lj = null; try { lj = JSON.parse(cli(['log', 'jsonproj', '-n', '5', '--json'], { env }).stdout); } catch {}
  ok(Array.isArray(lj) && lj.some(e => e.agent === 'smoke' && e.project === 'jsonproj' && e.text.includes('json log entry') && e.ts), 'log --json: entries with ts, project, agent and text');
}


// ── the log by window, author and addressee ──
// A sensor read the journal files itself to find the orders sent to its roles, and kept only their
// last megabyte: an older order was not there to find. --since reads all of a window, --to filters
// by addressee, and the text line keeps its format, since scripts match it.
{
  const L = mktmp(), env = { HUBD_DIR: L, HUBD_TEAM_DIR: L };
  cli(['report', '-p', 'logproj', '--agent', 'alice', '-m', 'TO: worker\nhello worker'], { env });
  cli(['report', '-p', 'logproj', '--agent', 'bob', '-m', 'TO: reviewer, worker\nboth of you'], { env });
  cli(['report', '-p', 'logproj', '--agent', 'bob', '-m', 'NOTE: nobody in particular'], { env });
  fs.appendFileSync(path.join(L, 'journal.old.jsonl'),
    JSON.stringify({ ts: '2020-01-01 00:00', project: 'logproj', agent: 'alice', kind: 'note', text: 'long ago', to: 'worker' }) + '\n');
  const texts = (argv) => { try { return JSON.parse(cli(['log', ...argv, '--json'], { env }).stdout).map(e => e.text); } catch { return null; } };
  ok(String(texts(['--to', 'worker'])) === 'long ago,hello worker,both of you', `log --to: the entries addressed to the role, one among several included (${texts(['--to', 'worker'])})`);
  ok(String(texts(['--to', 'worker', '--agent', 'alice'])) === 'long ago,hello worker', 'log --agent: and only the ones that author wrote');
  ok(String(texts(['logproj', '--since', '1h', '--to', 'worker'])) === 'hello worker,both of you', 'log --since: the window, and nothing older');
  ok(texts(['--since', '1h']).length === 3 && texts(['--since', '1h', '-n', '1']).length === 1, 'log --since: all of the window, unless -n caps it too');
  ok(String(texts(['--since', '2019-12-31', '--agent', 'alice'])) === 'long ago,hello worker', 'log --since: a time as well as a duration');
  const line = cli(['log', '--to', 'worker', '--agent', 'alice', '-n', '1'], { env });
  ok(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)? \[logproj\/alice\] note: hello worker\n$/.test(line.stdout), `log: the text line keeps its format, the addressee is in --json only (${JSON.stringify(line.stdout)})`);
  ok(cli(['log', '--since', '3x'], { env }).code === 1 && cli(['log', '--to'], { env }).code === 1 && cli(['log', '-n', '0'], { env }).code === 1,
    'log: a window it cannot read, a flag without its value and a count of 0 are refused');
}


done();
