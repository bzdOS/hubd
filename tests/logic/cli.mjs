// cli.mjs — the CLI: init outside a checkout, JSON through a pipe, a wrapper that cannot load, flags and help
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, CLI, ok, mktmp, run, done } from './_h.mjs';

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

done();
