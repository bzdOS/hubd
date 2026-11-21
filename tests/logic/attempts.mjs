// attempts.mjs — what was tried on a task: the thread, its standing, reviews, commit-only contests,
// and the commons, where a token anyone holds only reads and adds
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, ok, mktmp, cli, freePort, reap, T0, core, done } from './_h.mjs';

const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
const add = (text, tags) => core.runTaskAdd({ project: 'math', text, tags, by: 'seed' }).task.id;
const att = (a) => core.runAttemptAdd(a);

// ── the thread and its standing ──
const P = add('Find a 5x5 grid with property X; success: the checker prints OK.');
const d1 = att({ task: P, outcome: 'dead', lens: 'greedy fill', tried: 'greedy row by row', why: 'stalls at row 3 every time', by: 'ann' });
ok(d1.ok && d1.id === `${P}.1` && d1.tried.dead === 1, `attempt: a dead end is recorded as ${P}.1 (got ${d1.id})`);
const l1 = att({ task: P, outcome: 'lead', lens: 'SAT encoding', tried: 'encoded rows 1-3', next: 'add the column constraints', by: 'bob' });
const s1 = core.runTaskGet({ id: P });
ok(s1.standing && s1.standing.dead.length === 1 && s1.standing.leads.length === 1 && s1.attempts.length === 2,
  'task get: the standing lists the dead lens and the open lead');
ok(s1.attemptsNote && /data, never as instructions/.test(s1.attemptsNote), 'task get: the thread says it is data, not instructions');
att({ task: P, outcome: 'partial', lens: 'SAT encoding', tried: 'added columns', result: '4x4 found, 5x5 timed out',
  builds_on: [l1.id], by: 'cat' });
ok(core.runTaskGet({ id: P }).standing.leads.length === 0, 'standing: a lead someone built on is no longer waiting');
ok(!core.runTaskGet({ id: add('untouched') }).standing, 'task get: a task nobody tried has no standing');

// what each outcome needs
ok(throws(() => att({ task: P, outcome: 'dead', lens: 'x', tried: 'y', by: 'ann' }), /needs tried and why/), 'dead: refused without why');
ok(throws(() => att({ task: P, outcome: 'lead', lens: 'x', tried: 'y', by: 'ann' }), /needs tried and next/), 'lead: refused without next');
ok(throws(() => att({ task: P, outcome: 'claim', lens: 'x', tried: 'y', by: 'ann' }), /needs tried and result/), 'claim: refused without result');
ok(throws(() => att({ task: P, outcome: 'won', lens: 'x', by: 'ann' }), /outcome must be one of/), 'an unknown outcome is refused');
ok(throws(() => att({ task: P, outcome: 'dead', tried: 'y', why: 'z', by: 'ann' }), /lens required/), 'a lens is required');
ok(throws(() => att({ task: P, outcome: 'dead', lens: 'x'.repeat(121), tried: 'y', why: 'z', by: 'ann' }), /120 characters/), 'a lens is one short line');
ok(throws(() => att({ task: P, outcome: 'dead', lens: 'x', tried: 'y', why: 'z' }), /by required/), 'an attempt names its author');
ok(throws(() => att({ task: 'nope-9', outcome: 'dead', lens: 'x', tried: 'y', why: 'z', by: 'ann' }), /no task #nope-9/), 'an unknown task is refused');
ok(throws(() => att({ task: P, outcome: 'dead', lens: 'x', tried: 'y'.repeat(4001), why: 'z', by: 'ann' }), /4000 at most/), 'a text over 4000 characters is refused');
ok(throws(() => att({ task: P, outcome: 'lead', lens: 'x', tried: 'y', next: 'z', builds_on: [`${P}.99`], by: 'ann' }), /builds_on: no attempt/),
  'builds_on names attempts that exist');
ok(throws(() => att({ task: P, outcome: 'claim', lens: 'x', tried: 'y', result: 'z', artifacts: ['file:///etc/passwd'], by: 'ann' }), /public URL/),
  'an artifact is a public URL');
ok(throws(() => att({ task: P, outcome: 'claim', lens: 'x', tried: 'y', result: 'z', artifacts: Array.from({ length: 11 }, (_, i) => `https://e.org/${i}`), by: 'ann' }), /10 at most/),
  'ten artifacts at most');
ok(throws(() => att({ task: P, outcome: 'claim', lens: 'x', tried: 'y', result: 'z', commitment: 'abc', by: 'ann' }), /64 hex/), 'a commitment is 64 hex digits');

// ── reviews: someone else's, one each, three different people ──
const c1 = att({ task: P, outcome: 'claim', lens: 'SAT + symmetry', tried: 'broke symmetry', result: 'checker prints OK',
  artifacts: ['https://example.org/grid.txt sha256:00ff'], by: 'cat' });
ok(c1.claim && c1.claim.status === 'pending' && c1.claim.missing.length === 3, 'claim: pending, needing all three checks');
const rv = (by, check, verdict = 'pass') => att({ task: P, outcome: 'review', of: c1.id, check, verdict, result: 'reran it', by });
ok(throws(() => rv('cat', 'reproduce'), /your own claim/), 'review: the author cannot review their own claim');
ok(throws(() => att({ task: P, outcome: 'review', of: d1.id, check: 'reproduce', verdict: 'pass', result: 'r', by: 'dan' }), /of required/),
  'review: only a claim or partial can be reviewed');
ok(throws(() => rv('dan', 'taste'), /check must be one of/), 'review: the check is reproduce, novelty or criterion');
rv('dan', 'reproduce');
ok(throws(() => rv('dan', 'novelty'), /already reviewed/), 'review: one review per reviewer per claim');
rv('erin', 'novelty');
let st = core.runTaskGet({ id: P }).standing.claims.find(c => c.id === c1.id);
ok(st.status === 'pending' && st.missing.join() === 'criterion', `review: two passes leave it pending on criterion (got ${st.status} ${st.missing})`);
const last = rv('fay', 'criterion');
ok(last.claim.status === 'verified', `review: three passes by three people verify it (got ${last.claim.status})`);
ok(core.loadTasks().tasks.find(t => t.id === P).tried.solved === true, 'tried: a verified claim marks the task solved');
ok(core.runTaskGet({ id: P }).task.status === 'open', 'a verified claim does not close the task: the operator does');
const c2 = att({ task: P, outcome: 'partial', lens: 'local search', tried: 't', result: 'r', by: 'gus' });
att({ task: P, outcome: 'review', of: c2.id, check: 'reproduce', verdict: 'fail', result: 'got a different grid', by: 'dan' });
st = core.runTaskGet({ id: P }).standing.claims.find(c => c.id === c2.id);
ok(st.status === 'disputed' && st.failed[0].by === 'dan', 'review: one fail disputes it, with who and why');

// ── commit-only: a live contest takes an outcome and, for a claim, a commitment ──
const L = add('A live contest problem.', ['commit-only']);
ok(throws(() => att({ task: L, outcome: 'dead', tried: 'all of it', by: 'ann' }), /commit-only.*tried would spoil/),
  'commit-only: a text is refused as a spoiler');
ok(throws(() => att({ task: L, outcome: 'dead', lens: 'Vigenere, key length 7', by: 'ann' }), /commit-only.*lens would spoil/),
  'commit-only: even a lens is refused, a one-line method can shortcut the contest');
ok(throws(() => att({ task: L, outcome: 'claim', by: 'ann' }), /a claim is a commitment/), 'commit-only: a claim needs a commitment');
ok(throws(() => att({ task: L, outcome: 'partial', by: 'ann' }), /commit-only/), 'commit-only: no partials');
const sealed = att({ task: L, outcome: 'claim', commitment: 'ab'.repeat(32), by: 'ann' });
ok(sealed.ok && sealed.claim.status === 'pending', 'commit-only: a claim with a commitment is recorded');
ok(throws(() => att({ task: L, outcome: 'review', of: sealed.id, check: 'reproduce', verdict: 'pass', result: 'r', by: 'bob' }), /checked privately/),
  'commit-only: claims are not reviewed in public');
ok(att({ task: L, outcome: 'dead', by: 'bob' }).ok, 'commit-only: a dead outcome alone is recorded');

// ── leaks: refused only where the server says the hub is public ──
for (const [what, text] of [['a home path', 'ran it in /Users/someone/work'], ['an email', 'mail me at a.b@example.com'],
  ['a key', 'used sk-' + 'A'.repeat(24)], ['a GitHub token', 'ghp_' + 'a'.repeat(30)]])
  ok(throws(() => att({ task: P, outcome: 'dead', lens: 'x', tried: text, why: 'z', by: 'ann', public: true }), /this hub is public/),
    `leak: ${what} in a public attempt is refused`);
ok(throws(() => att({ task: P, outcome: 'dead', lens: 'on /home/me/x', tried: 'y', why: 'z', by: 'ann', public: true }), /public/), 'leak: the lens is checked too');
ok(att({ task: P, outcome: 'dead', lens: 'paths', tried: 'ran it in /Users/someone/work', why: 'z', by: 'ann' }).ok,
  'leak: in a team hub a path is just a path');
ok(core.leakIn('the 3x+1 map, n <= 10^12') === null, 'leak: plain math is not a leak');

// ── the fold: two nodes that number an attempt alike both keep theirs ──
{
  const F = mktmp();
  core.setHubBase(F); core.ensureHubDirs();
  const ev = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(F, 'tasks.aaa.events.jsonl'),
    ev({ ts: '2026-03-01 10:00', node: 'aaa', ev: 'add', id: 'aaa-1', t: { id: 'aaa-1', text: 'T', status: 'open', project: 'p' } }) +
    ev({ ts: '2026-03-01 10:01', node: 'aaa', ev: 'attempt', id: 'aaa-1', keyed: 'origin', aid: 'aaa-1.1', a: { outcome: 'dead', lens: 'a', by: 'ann' } }) +
    ev({ ts: '2026-03-01 10:00', node: 'aaa', ev: 'add', id: 'aaa-2', t: { id: 'aaa-2', text: 'gone', status: 'open', project: 'p' } }) +
    ev({ ts: '2026-03-01 10:03', node: 'aaa', ev: 'attempt', id: 'aaa-2', keyed: 'origin', aid: 'aaa-2.1', a: { outcome: 'dead', lens: 'a', by: 'ann' } }) +
    ev({ ts: '2026-03-01 10:04', node: 'aaa', ev: 'del', id: 'aaa-2' }));
  fs.writeFileSync(path.join(F, 'tasks.bbb.events.jsonl'),
    ev({ ts: '2026-03-01 10:02', node: 'aaa', ev: 'attempt', id: 'aaa-1', keyed: 'origin', aid: 'aaa-1.1', a: { outcome: 'lead', lens: 'b', by: 'bob' } }) +
    ev({ ts: '2026-03-01 10:05', node: 'aaa', ev: 'future-kind', id: 'aaa-1' }));
  const db = core.foldTasks();
  const ids = (db.attempts['aaa-1'] || []).map(x => x.id + ':' + x.lens).join(' ');
  ok(ids === 'aaa-1.1:a aaa-1.2:b', `fold: a colliding attempt number takes the next free one (got ${ids})`);
  ok(!db.attempts['aaa-2'] && db.tasks.length === 1, 'fold: the attempts of a deleted task go with it');
  ok(db.tasks[0].tried && db.tasks[0].tried.n === 2 && db.tasks[0].tried.authors === 2, 'fold: the task carries its counts');
  core.setHubBase(T0); core.ensureHubDirs();
}

// ── the CLI ──
{
  const C = mktmp();
  const env = { HUBD_DIR: C, HUBD_TEAM_DIR: C, HUBD_AGENT: undefined };
  const id = JSON.parse(cli(['task', 'add', '-p', 'math', 'Prove the thing', '--by', 'seed', '--json'], { env }).stdout || '{}')?.task?.id
    || (cli(['task', 'add', '-p', 'math', 'Prove the thing', '--by', 'seed'], { env }).out.match(/#(\S+?)[: ]/) || [])[1];
  const a = cli(['attempt', id, '-o', 'dead', '--lens', 'induction', '--tried', 'induction on n', '--why', 'the step fails at n=4', '--by', 'ann'], { env });
  ok(a.code === 0 && a.out.includes(`Attempt #${id}.1 on #${id}: dead`), `cli: hub attempt records a dead end (got ${a.out.trim()})`);
  const bad = cli(['attempt', id, '-o', 'lead', '--lens', 'x', '--tried', 'y', '--by', 'ann'], { env });
  ok(bad.code !== 0 && /needs tried and next/.test(bad.out), 'cli: a refusal says what is missing');
  const g = cli(['task', 'get', id], { env });
  ok(/thread: 1 attempt, 1 person/.test(g.out) && /dead .*\[induction\] the step fails at n=4/.test(g.out), 'cli: task get prints the thread');
  const live = (cli(['task', 'add', '-p', 'math', 'A live contest', '--tag', 'commit-only', '--by', 'seed'], { env }).out.match(/#(\S+?)[: ]/) || [])[1];
  const sa = cli(['attempt', live, '-o', 'dead', '--by', 'ann'], { env });
  const sg = cli(['task', 'get', live], { env });
  ok(sa.code === 0 && sg.code === 0 && /dead \S+ \S/.test(sg.out) && !/undefined|\[\]/.test(sa.out + sg.out),
    `cli: a commit-only attempt, which has no lens, prints without a stray "undefined" (got ${sg.out.trim().split('\n').slice(-3).join(' | ')})`);
}

// ── the commons over MCP: a key anyone holds, and a regular tenant beside it ──
const H = mktmp();
const KEY = 'commons-public-key-0001', OTHER = 'a-private-team-token-0042';
const mcpPort = await freePort(), boardPort = await freePort();
const srvEnv = { ...process.env, HUBD_DIR: H, HUBD_TEAM_DIR: H, HUBD_MULTITENANT: '1', HUBD_COMMONS: KEY };
delete srvEnv.HUBD_AGENT; delete srvEnv.HUBD_TOOLS;
const srv = reap(spawn(process.execPath, [path.join(REPO, 'hub/index.mjs'), '--http', String(mcpPort)], { env: srvEnv, stdio: ['ignore', 'ignore', 'pipe'] }));
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('http server did not start')), 8000);
  srv.stderr.on('data', (d) => { if (String(d).includes('serving MCP over HTTP')) { clearTimeout(to); resolve(); } });
});
const rpc = async (tok, method, params) => (await (await fetch(`http://127.0.0.1:${mcpPort}/`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})).json()).result;
const call = async (tok, name, args) => {
  const r = await rpc(tok, 'tools/call', { name, arguments: args });
  return { err: r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
};

const tools = (await rpc(KEY, 'tools/list', {})).tools.map(t => t.name);
ok(tools.includes('hub_attempt') && tools.includes('hub_task_add') && !tools.includes('hub_task_update') && !tools.includes('hub_report')
  && !tools.includes('hub_card_set') && !tools.includes('hub_queue_send'), `commons: tools/list offers reads and adds only (got ${tools.length} tools)`);
const init = await rpc(KEY, 'initialize', {});
ok(/public board of unsolved problems/.test(init.instructions) && !/hub_brief|hub_context/.test(init.instructions), 'commons: its own instructions');
const onb = await call(KEY, 'hub_onboarding', {});
ok(onb.json && onb.json.mode === 'commons' && /# The commons: how a run works/.test(onb.json.protocol), 'commons: onboarding is the run protocol');
const pid = (await call(KEY, 'hub_task_add', { project: 'number-theory', text: 'An open problem.', by: 'seed' })).json.id;
const upd = await call(KEY, 'hub_task_update', { id: pid, status: 'done', why: 'test: closed on what the test checked', by: 'mallory' });
ok(upd.err && /not offered in a commons/.test(upd.text), 'commons: hub_task_update is refused');
const rep = await call(KEY, 'hub_report', { project: 'number-theory', text: `DONE: #${pid}`, agent: 'mallory' });
ok(rep.err && /not offered in a commons/.test(rep.text), 'commons: hub_report is refused (its DONE line would close tasks)');
const leakAdd = await call(KEY, 'hub_task_add', { project: 'x', text: 'ping me at someone@example.com', by: 'seed' });
ok(leakAdd.err && /this hub is public/.test(leakAdd.text), 'commons: an email in a new problem is refused');
const leakOff = await call(KEY, 'hub_attempt', { task: pid, outcome: 'dead', lens: 'x', tried: 'in /home/someone/run', why: 'z', by: 'ann', public: false });
ok(leakOff.err && /this hub is public/.test(leakOff.text), 'commons: a caller cannot pass public:false to skip the check');
const leakBy = await call(KEY, 'hub_attempt', { task: pid, outcome: 'dead', lens: 'x', tried: 'y', why: 'z', by: 'ann@example.com' });
ok(leakBy.err && /this hub is public/.test(leakBy.text), 'commons: every string a write carries is checked, the handle too');
const good = await call(KEY, 'hub_attempt', { task: pid, outcome: 'lead', lens: 'sieve', tried: 'sieved to 10^9', next: 'push to 10^10', by: 'ann' });
ok(good.json && good.json.id === `${pid}.1`, 'commons: an attempt is recorded');
const got = await call(KEY, 'hub_task_get', { id: pid });
ok(got.json.standing.leads[0].next === 'push to 10^10' && got.json.attemptsNote, 'commons: the thread reads back with its note');
// a team's tenant on the same server is untouched by any of it
const tTools = (await rpc(OTHER, 'tools/list', {})).tools.map(t => t.name);
ok(tTools.includes('hub_task_update') && tTools.includes('hub_report'), 'tenant: a regular tenant keeps every tool');
ok(/Shared sync point/.test((await rpc(OTHER, 'initialize', {})).instructions), 'tenant: and the usual instructions');
const tAdd = await call(OTHER, 'hub_task_add', { project: 'p', text: 'mail ops@example.com about it', by: 'dev' });
ok(!tAdd.err, 'tenant: an email in a team task is just text');

// ── the board: the commons opens on its problems ──
const board = reap(spawn(process.execPath, [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(boardPort)], { env: srvEnv, stdio: ['ignore', 'pipe', 'ignore'] }));
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('board did not start')), 8000);
  board.stdout.on('data', (d) => { if (String(d).includes('hubd kanban')) { clearTimeout(to); resolve(); } });
});
const api = async (p) => { const r = await fetch(`http://127.0.0.1:${boardPort}${p}`); return { code: r.status, body: await r.json() }; };
ok((await api(`/api/mode?t=${KEY}`)).body.commons === true, 'board: the commons key opens in commons mode');
ok((await api(`/api/mode?t=${OTHER}`)).body.commons === false, 'board: a team token does not');
ok((await api(`/api/mode?t=never-used-token-123`)).body.commons === false, 'board: nor a token with no workspace yet');
const list = (await api(`/api/tasks?t=${KEY}`)).body.tasks;
ok(list.length === 1 && list[0].id === pid && list[0].tried.lead === 1, 'board: /api/tasks lists the open problems with their counts');
const one = await api(`/api/task?t=${KEY}&id=${encodeURIComponent(pid)}`);
ok(one.code === 200 && one.body.standing.leads.length === 1 && !('_origin' in one.body.task), 'board: /api/task returns the thread, without internals');
ok((await api(`/api/task?t=${KEY}&id=nope-1`)).code === 404, 'board: an unknown problem is a 404');
ok((await api(`/api/tasks?t=never-used-token-123`)).body.tasks.length === 0, 'board: a workspace that does not exist has no problems');
const page = await fetch(`http://127.0.0.1:${boardPort}/?t=never-used-token-123`);
ok(page.status === 200 && /text\/html/.test(page.headers.get('content-type')), 'board: and its page opens, empty, instead of a 404');

// ── seeding a commons from the V3R1T4S bank: as data, through the same gate, once ──
{
  const B = mktmp();
  const target = (id, extra) => ({ id, name: 'Name ' + id, category: 'number-hunts', kind: 'harvest', tractability: 3, compute_profile: 'laptop-hours',
    statement: 'Find it.', success_criterion: 'The checker prints OK.', partial_wins: [{ id: 'p1', statement: 'Half of it.' }],
    verification_method: 'Run the checker.', primary_sources: ['https://example.org/src'], status_source: 'https://example.org/src',
    status_checked: '2026-10-01', disclosure: 'open', pitfalls: ['Mail the setter at setter@example.org only with permission.'], angles: ['Try a sieve.'], ...extra });
  fs.writeFileSync(path.join(B, 'targets.json'), JSON.stringify({ schema: 'v3r1t4s.bank/1', targets: [target('t-one'), target('t-live', { disclosure: 'commit-only' })] }));
  const run = (args) => { const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/import-bank.mjs'), path.join(B, 'targets.json'), '--commit', 'abc1234', '--url', `http://127.0.0.1:${mcpPort}/`, '--key', KEY, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  const first = run([]);
  ok(first.code === 0 && /added 2, refused 0/.test(first.out), `import: both targets added (got ${first.out.trim().split('\n').pop()})`);
  const again = run([]);
  ok(again.code === 0 && /2 already in the commons, 0 to add/.test(again.out), 'import: a second run adds nothing');
  const seeded = (await api(`/api/tasks?t=${KEY}`)).body.tasks.filter(t => (t.tags || []).includes('v3r1t4s'));
  const live = seeded.find(t => /Name t-live/.test(t.text));
  ok(seeded.length === 2 && live && live.tags.includes('commit-only') && seeded.every(t => t.project === 'number-hunts'), 'import: the bank\'s category, kind and commit-only tag carry over');
  const full = (await call(KEY, 'hub_task_get', { id: seeded[0].id })).json.task.text;
  ok(/setter \(at\) example\.org/.test(full) && /V3R1T4S target bank, id t-\w+, commit abc1234 .*CC BY 4\.0; changed here/.test(full),
    'import: an address in the bank is written out, and the credit line names the bank id, commit and licence');
}

srv.kill(); board.kill();
done();
