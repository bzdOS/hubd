// test_logic.mjs — regression tests for the logical bugs fixed in the bug-hunt pass.
// Run: node tests/test_logic.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = `node ${REPO}/hub/cli.mjs`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hubd-t-'));
// run the CLI, never throw — capture non-zero exits (doctor exits 1 on warnings)
function run(args, env) {
  try { return { code: 0, out: execSync(`${CLI} ${args}`, { env: { ...process.env, ...env }, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

// ── unit (import core against a temp hub) ─────────────────────────────────────
const T0 = mktmp();
process.env.HUBD_DIR = T0;
process.env.HUBD_NODE = 'cowork';
const core = await import(path.join(REPO, 'hub/lib/core.mjs'));

// Bug: a deleted id must not be reused by another node and then corrupted by the
// original node's later `set` (set-after-del lands on the wrong task).
fs.writeFileSync(path.join(T0, 'tasks.aaa.events.jsonl'),
  JSON.stringify({ ts: '2026-01-01 10:00', node: 'aaa', ev: 'add', id: 5, t: { id: 5, text: 'A-task', status: 'open' } }) + '\n' +
  JSON.stringify({ ts: '2026-01-01 10:01', node: 'aaa', ev: 'del', id: 5 }) + '\n' +
  JSON.stringify({ ts: '2026-01-01 10:03', node: 'aaa', ev: 'set', id: 5, patch: { text: 'A-modified' } }) + '\n');
fs.writeFileSync(path.join(T0, 'tasks.bbb.events.jsonl'),
  JSON.stringify({ ts: '2026-01-01 10:02', node: 'bbb', ev: 'add', id: 5, t: { id: 5, text: 'B-task', status: 'open' } }) + '\n');
const db = core.foldTasks();
ok(db.tasks.length === 1, `fold/reuse: exactly one task survives (got ${db.tasks.length})`);
ok(db.tasks[0] && db.tasks[0].text === 'B-task', `fold/reuse: B's task intact, not corrupted by A's set (text=${db.tasks[0] && db.tasks[0].text})`);
fs.rmSync(path.join(T0, 'tasks.aaa.events.jsonl')); fs.rmSync(path.join(T0, 'tasks.bbb.events.jsonl'));

// Bug: journal rotation must not overwrite an existing same-month archive (data loss).
const big = 'x'.repeat(2 * 1024 * 1024 + 16) + '\n';
fs.writeFileSync(core.JOURNAL, '{"m":"first"}\n' + big);
core.journalAppend({ m: 'after1' });
fs.writeFileSync(core.JOURNAL, '{"m":"second"}\n' + big);
core.journalAppend({ m: 'after2' });
const arch = fs.readdirSync(T0).filter(f => /^journal\.cowork-\d{4}-\d{2}/.test(f));
ok(arch.length === 2, `journal rotation: two distinct archives kept (got ${arch.length}: ${arch.join(',')})`);
const ac = arch.map(f => fs.readFileSync(path.join(T0, f), 'utf8'));
ok(ac.some(c => c.includes('"first"')) && ac.some(c => c.includes('"second"')), 'journal rotation: both archives preserved (no overwrite)');

// Bug (latent): core.mjs must stay synchronous — setHubBase repoints a module-level
// base per HTTP request; one `await` inside a tool would let tenants interleave.
const src = fs.readFileSync(path.join(REPO, 'hub/lib/core.mjs'), 'utf8');
const codeOnly = src.split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
ok(!/\basync\b|\bawait\b/.test(codeOnly), 'core.mjs code (sans comments) has no async/await (keeps the synchronous setHubBase invariant)');
fs.rmSync(T0, { recursive: true, force: true });

// ── CLI: `hub gc` removes only the generated backup, never a user .bak ─────────
const T1 = mktmp();
fs.writeFileSync(path.join(T1, 'tasks.json.bak.20260101T000000Z'), 'old cache');
fs.writeFileSync(path.join(T1, 'mynote.bak.md'), 'a card the user backed up by hand');
run('gc', { HUBD_DIR: T1 });
ok(!fs.existsSync(path.join(T1, 'tasks.json.bak.20260101T000000Z')), 'gc: removes tasks.json.bak.*');
ok(fs.existsSync(path.join(T1, 'mynote.bak.md')), 'gc: keeps a user .bak file (precise matcher, no data loss)');
fs.rmSync(T1, { recursive: true, force: true });

// ── CLI: doctor catches a LARGE destructive rewrite (numstat, no maxBuffer blind spot) ──
const T2 = mktmp();
const ev = path.join(T2, 'tasks.cowork.events.jsonl');
let lines = '';
for (let i = 1; i <= 8000; i++) lines += JSON.stringify({ ts: '2026-01-01 10:00', node: 'cowork', ev: 'add', id: i, t: { id: i, text: 'task ' + 'y'.repeat(220) } }) + '\n';
fs.writeFileSync(ev, lines);   // ~2 MB → a full git-diff would blow execSync's 1 MB buffer
execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: T2 });
fs.writeFileSync(ev, lines.split('\n').slice(5000).join('\n'));   // drop 5000 lines → >1 MB diff
const d = run('doctor', { HUBD_DIR: T2, HUBD_TEAM_DIR: T2 });
ok(/append-only|removed\/changed/i.test(d.out), 'doctor: flags a large non-append-only rewrite (numstat survives big diffs)');
ok(d.code !== 0, 'doctor: exits non-zero on the append-only warning');
fs.rmSync(T2, { recursive: true, force: true });

// ── CLI: rules source = HUB wins over team-root; no hardcoded ~/.hubd shadow ──
const HUBD = mktmp(), TEAM = mktmp();
fs.writeFileSync(path.join(HUBD, 'AGENTS.md'), '# HUB rules');
fs.writeFileSync(path.join(TEAM, 'AGENTS.md'), '# TEAM rules');
const r = run('doctor', { HUBD_DIR: HUBD, HUBD_TEAM_DIR: TEAM });
ok(r.out.includes(path.join(HUBD, 'AGENTS.md')), 'rules source: HUB/AGENTS.md wins over team-root');
ok(!r.out.includes(path.join(TEAM, 'AGENTS.md')), 'rules source: team-root not chosen when HUB has its own');
fs.rmSync(HUBD, { recursive: true, force: true }); fs.rmSync(TEAM, { recursive: true, force: true });

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
