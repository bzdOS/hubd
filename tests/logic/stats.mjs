// stats.mjs — sessions taken in from a client's database, bound to tasks, priced and judged:
// VERDICT: lines, the ledger, the binding rule, prices, and the numbers adding up exactly.
import fs from 'node:fs';
import path from 'node:path';
import { ok, mktmp, cli, core, queueLib, done, T0, REPO } from './_h.mjs';

const sessions = await import(path.join(REPO, 'hub/lib/sessions.mjs'));
const stats = await import(path.join(REPO, 'hub/lib/stats.mjs'));
const by = 'dev-test';
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const journalLines = () => fs.readdirSync(T0).filter(f => /^journal.*\.jsonl$/.test(f))
  .reduce((n, f) => n + fs.readFileSync(path.join(T0, f), 'utf8').split('\n').filter(Boolean).length, 0);

const t1 = core.runTaskAdd({ project: 'alpha', text: 'first piece of work', by }).task.id;
const t2 = core.runTaskAdd({ project: 'alpha', text: 'second piece of work', by }).task.id;
const t3 = core.runTaskAdd({ project: 'alpha', text: 'third piece of work', by }).task.id;
ok(t1 === 'cedar-1' && t2 === 'cedar-2' && t3 === 'cedar-3', 'fixture: three tasks, cedar-1..3');

/* ── A bare number in hub_queue_send is stamped as the task's whole id ── */
{
  const r = queueLib.queueSendChecked('worker-a', 'do the second', { from: 'head-a', root: T0, task: '2' });
  ok(r.task === 'cedar-2' && r.taskAsGiven === '2' && r.taskKnown, 'queue send: task "2" is stamped as cedar-2, what was given kept beside it');
  const q = fs.readdirSync(path.join(T0, 'queues')).filter(f => f.startsWith('worker-a')).map(f => fs.readFileSync(path.join(T0, 'queues', f), 'utf8')).join('');
  ok(/· task #cedar-2\b/.test(q), 'queue send: the header carries the whole id');
  const u = queueLib.queueSendChecked('worker-a', 'unknown', { from: 'head-a', root: T0, task: '77' });
  ok(u.task === '77' && u.taskKnown === false && !u.taskAsGiven, 'queue send: a number naming no task is left as given');
}

/* ── VERDICT: ── */
{
  const before = journalLines();
  for (const [text, why] of [
    ['VERDICT: pass #cedar-1 — fine', 'a word other than accept or reject'],
    ['VERDICT: accept #cedar-77 — fine', 'a task the hub does not hold'],
    ['VERDICT: accept #cedar-1 #cedar-2 — both', 'two tasks'],
    ['VERDICT: accept — fine', 'no task'],
    ['FACT: something true\nACCEPT: — nothing named', 'an ACCEPT: line with no task, beside a good line'],
  ]) {
    const e = throws(() => core.runReport({ project: 'alpha', text, by }));
    ok(e && /verdict|no task/i.test(e), `VERDICT: refused, ${why}`);
  }
  ok(throws(() => core.runReport({ project: 'alpha', text: 'VERDICT: accept #cedar-1 — ok', by, private: true })), 'VERDICT: refused in a private report');
  ok(journalLines() === before, 'VERDICT: a refused report writes nothing at all');
}

/* ── The sessions: opencode's rows, built here ── */
const B = Date.UTC(2026, 9, 1, 10, 0);
const min = (n) => B + n * 60000;
const ROWS = [];
let seq = 0;
const nid = (p) => `${p}${String(++seq).padStart(4, '0')}`;
const tok = (input, output = 0, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } });
function session(id, agent, t0, t1, { parent = null, totals = null, cost = 0 } = {}) {
  const t = totals || [0, 0, 0, 0, 0];
  ROWS.push({ table: 'session', row: { id, project_id: 'p1', parent_id: parent, slug: id, directory: '/work', title: 'a session', version: '1',
    time_created: t0, time_updated: t1, agent, model: null, cost, tokens_input: t[0], tokens_output: t[1], tokens_reasoning: t[2],
    tokens_cache_read: t[3], tokens_cache_write: t[4], metadata: null } });
}
function user(sid, at, text, agent) {
  const mid = nid('msg');
  ROWS.push({ table: 'message', row: { id: mid, session_id: sid, time_created: at, time_updated: at,
    data: JSON.stringify({ role: 'user', time: { created: at }, agent, model: { providerID: 'prov', modelID: 'model-x' } }) } });
  ROWS.push({ table: 'part', row: { id: nid('prt'), message_id: mid, session_id: sid, time_created: at, time_updated: at, data: JSON.stringify({ type: 'text', text }) } });
}
function assistant(sid, at, agent, model, parts) {
  const mid = nid('msg');
  const [providerID, modelID] = model.split('/');
  ROWS.push({ table: 'message', row: { id: mid, session_id: sid, time_created: at, time_updated: at,
    data: JSON.stringify({ role: 'assistant', agent, mode: agent, providerID, modelID, time: { created: at }, cost: 0 }) } });
  for (const [pat, data] of parts) ROWS.push({ table: 'part', row: { id: nid('prt'), message_id: mid, session_id: sid, time_created: pat, time_updated: pat, data: JSON.stringify(data) } });
}
const step = (at, t, cost = 0) => [at, { type: 'step-finish', tokens: t, cost }];
const tool = (at, name, input, output, status = 'completed') => [at, { type: 'tool', tool: name, state: { status, input, output: JSON.stringify(output), time: { start: at, end: at } } }];
// a role's session looks itself up first; one with no call at all, no order and two messages is a probe
const ctx = (at) => tool(at, 'hubd_hub_context', { cwd: '/work' }, { project: 'alpha' });
const hdr = (hhmm, id, ...tasks) => `## 2026-10-01 ${hhmm} · from head-a · id ${id}` + tasks.map(t => ` · task #${t}`).join('');

// s1: ordered onto task #1 (a bare number from node cedar's block), closes it, then idles
session('ses-1', 'worker-a', min(0), min(10), { totals: [137, 13, 5, 50, 0], cost: 0.012 });
user('ses-1', min(0), hdr('10:00', 'cedar-5', '1') + '\n\nfix the first thing', 'worker-a');
assistant('ses-1', min(1), 'worker-a', 'prov/model-x', [
  step(min(2), tok(100, 10, 5, 50), 0.01),
  tool(min(3), 'hubd_hub_report', { project: 'alpha', text: 'DONE: #cedar-1 fixed', by: 'worker-a' }, { ok: true, project: 'alpha', done: ['cedar-1'] }),
  step(min(4), tok(30, 3), 0.002),
]);
user('ses-1', min(5), 'queue empty, waiting', 'worker-a');
assistant('ses-1', min(6), 'worker-a', 'prov/model-x', [step(min(7), tok(7))]);
// h1: the head, no order of its own, on a model with no listing
session('ses-2', 'head-a', min(15), min(16));
user('ses-2', min(15), 'look at the board', 'head-a');
assistant('ses-2', min(15), 'head-a', 'local/small-test', [ctx(min(15)), step(min(16), tok(20))]);
// s2: two tasks in one header, and a block naming a task nobody holds
session('ses-3', 'worker-a', min(20), min(22));
user('ses-3', min(20), hdr('10:20', 'cedar-6', 'cedar-2', 'cedar-3') + '\n\nboth of these\n\n' + hdr('10:20', 'cedar-7', '99') + '\n\nand this', 'worker-a');
assistant('ses-3', min(21), 'worker-a', 'prov/model-x', [step(min(22), tok(101, 1))]);
// s3 and its child: no order, the set carries; the child repeats one call three times
session('ses-4', 'worker-a', min(40), min(43));
user('ses-4', min(40), 'continue', 'worker-a');
assistant('ses-4', min(41), 'worker-a', 'prov/model-x', [ctx(min(41)), step(min(41), tok(10))]);
session('ses-5', 'explore', min(42), min(43), { parent: 'ses-4' });
user('ses-5', min(42), 'look around', 'explore');
assistant('ses-5', min(42), 'explore', 'prov/model-x', [
  tool(min(42), 'read', { path: 'a' }, 'same'), tool(min(42), 'read', { path: 'a' }, 'same'), tool(min(42), 'read', { path: 'a' }, 'same'),
  step(min(43), tok(4)),
]);
// the journal closes cedar-3 at 10:45; s4 works on what is left
core.journalAppend({ ts: '2026-10-01 10:45', project: 'alpha', agent: 'head-a', kind: 'done', text: '#cedar-3 third piece of work' });
session('ses-6', 'worker-a', min(50), min(51));
user('ses-6', min(50), 'continue', 'worker-a');
assistant('ses-6', min(51), 'worker-a', 'prov/model-x', [ctx(min(51)), step(min(51), tok(6))]);
// a probe: one question, one answer, no tools
session('ses-7', 'build', min(60), min(61));
user('ses-7', min(60), 'hi', 'build');
assistant('ses-7', min(61), 'build', 'prov/model-x', [step(min(61), tok(3, 1))]);

const rowsFile = path.join(mktmp(), 'rows.jsonl');
fs.writeFileSync(rowsFile, ROWS.map(r => JSON.stringify(r)).join('\n') + '\n');

/* ── Ingest ── */
const env = { HUBD_DIR: T0, HUBD_TEAM_DIR: T0, HUBD_NODE: 'cedar', HUBD_AGENT: by };
{
  const r = cli(['sessions', 'ingest', '--rows', rowsFile, '--db', 'agent', '--dry', '--json'], { env });
  const j = JSON.parse(r.stdout);
  ok(j.dry && j.added === 7 && !sessions.ledgerFiles().length, 'ingest --dry: seven sessions read, nothing written');
}
const first = await sessions.runSessionsIngest({ rows: rowsFile, db: 'agent' });
ok(first.added === 7 && first.probes === 1 && first.written === 7, 'ingest: seven sessions, one a probe');
const again = await sessions.runSessionsIngest({ rows: rowsFile, db: 'agent' });
ok(again.added === 0 && again.updated === 0 && again.unchanged === 7 && again.written === 0, 'ingest again: nothing new, nothing written');
const L = Object.fromEntries(sessions.readLedger().map(r => [r.id, r]));
ok(L['ses-1'].agent === 'worker-a' && L['ses-1'].project === 'alpha' && L['ses-1'].node === 'cedar' && L['ses-1'].db === 'agent', 'ledger: role, project, node and db');
ok(JSON.stringify(L['ses-1'].log.map(e => Object.keys(e)[0])) === '["order","seg","close","seg"]', 'ledger: order, the work, the close after the step that made it, the idle step');
ok(L['ses-1'].log[0].order[0].ref === '1' && L['ses-1'].log[0].order[0].block === 'cedar-5', 'ledger: the order as the header said it, with its block');
ok(L['ses-5'].log[0].seg.repeats === 2 && L['ses-5'].parent === 'ses-4', 'ledger: a call made three times over counts two repeats; the child knows its parent');
ok(L['ses-7'].kind === 'probe' && L['ses-1'].kind === 'work', 'ledger: a probe is told from work');
const raw = fs.readFileSync(sessions.ledgerFile(), 'utf8');
ok(!/fix the first thing|look around|same/.test(raw), 'ledger: no text a session said is kept');

/* ── Binding, rule v1, before any price ── */
const S0 = stats.runStats({ check: true });
const rowOf = (s, id) => s.rows.find(x => x.task === id);
ok(S0.check.ok, '--check: every token is bound, unbound or a probe\'s');
ok(JSON.stringify(S0.check.sessions) === '[281,15,5,50,0]', '--check: the sessions\' own sums');
ok(JSON.stringify(rowOf(S0, 'cedar-1').tok) === '[130,13,5,50,0]', 'bind: both steps before the close go to cedar-1');
ok(JSON.stringify(S0.summary.unbound.tok) === '[27,0,0,0,0]', 'bind: the idle step after the close and the head\'s step are unbound');
ok(S0.summary.probes.tokens === 4, 'bind: a probe is kept apart');
ok(rowOf(S0, 'cedar-2').tokens === 65 && rowOf(S0, 'cedar-2').order === 52 && rowOf(S0, 'cedar-2').carried === 13,
  'bind: two tasks split a step evenly, the odd token to the first; the next sessions and the child carry the set');
ok(rowOf(S0, 'cedar-3').tokens === 57, 'bind: a close in the journal takes the task out of the set');
ok(rowOf(S0, 'cedar-3').steps === 3 && rowOf(S0, 'cedar-2').steps === 4 && S0.summary.bound.steps === 6,
  'bind: a shared step counts whole in each task, once in the sum');
ok(S0.summary.unresolvedRefs.count === 1 && S0.summary.unresolvedRefs.examples[0].ref === '99', 'bind: an order naming no task is counted, not guessed');
ok(S0.summary.empty.repeats === 2, 'summary: repeated calls');
ok(rowOf(S0, 'cedar-1').notional === null && rowOf(S0, 'cedar-1').unpricedTokens === 198, 'price: nothing is priced before a pull');
const byRole = stats.runStats({ group: 'role' });
ok(byRole.rows.map(x => x.role).join(',') === 'worker-a,head-a,build', 'group role: the child works as its parent\'s role');

/* ── Verdicts ── */
ok(throws(() => core.runReport({ project: 'alpha', text: 'VERDICT: accept #1 of=worker-a ref=abc1234 — works', by: 'head-a' })) === null, 'VERDICT: accept, a bare number resolved');
ok(throws(() => core.runReport({ project: 'alpha', text: 'REJECT: #cedar-2 of=worker-a — tests fail', by: 'head-a' })) === null, 'REJECT: as an alias');
core.journalAppend({ ts: '2026-10-01 11:30', project: 'alpha', agent: 'head-a', kind: 'decision', text: 'ACCEPT #cedar-3 reads well' });
core.journalAppend({ ts: '2026-10-01 11:31', project: 'alpha', agent: 'head-a', kind: 'decision', text: 'ACCEPT a1b2c3d some-branch' });
const vj = [...core.journalEntries()].filter(e => e.kind === 'verdict');
ok(vj.length === 2 && vj[0].task === 'cedar-1' && vj[0].verdict === 'accept' && vj[0].of === 'worker-a' && vj[0].ref === 'abc1234', 'VERDICT: a journal entry of its own kind');
ok(vj[0].text.startsWith('ACCEPT #cedar-1 ') && vj[1].text.startsWith('REJECT #cedar-2 '), 'VERDICT: the text opens with the word in capitals, as the Summary reads a verdict');
ok(core.loadTasks().tasks.find(t => t.id === 'cedar-2').status !== 'done', 'VERDICT: no task status changes');
const S1 = stats.runStats({ task: 'cedar-2', check: true });
ok(rowOf(S1, 'cedar-1').outcome === 'accept' && rowOf(S1, 'cedar-2').outcome === 'reject' && rowOf(S1, 'cedar-3').outcome === 'accept',
  'verdicts: accept, reject, and a decision read by the strict rule');
ok(S1.summary.verdicts.journal === 2 && S1.summary.verdicts.parsed === 1 && S1.summary.verdicts.unreadable === 1, 'verdicts: counted by where they came from');
ok(S1.summary.waste.attempts === 1 && S1.summary.waste.tokens === 65, 'waste: the rejected attempt\'s tokens');
ok(S1.task.attemptList.length === 1 && S1.task.attemptList[0].role === 'worker-a' && S1.task.attemptList[0].from === 'head-a', 'task: its attempts, by role, from the sender');
ok(S1.summary.attempts.total === 3 && S1.summary.attempts.accepted === 2 && S1.summary.attempts.rejected === 1, 'attempts: three, two accepted');

/* ── Prices ── */
const listing = path.join(mktmp(), 'models.json');
fs.writeFileSync(listing, JSON.stringify({ data: [
  { id: 'prov/model-x', pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001' } },
  { id: 'other/router', pricing: { prompt: '-1', completion: '-1' } },
  { id: 'other/model-z', pricing: { prompt: '0.000003', completion: '0.000015' } },
] }));
const p1 = await stats.runPricePull({ from: listing, date: '2026-09-30' });
ok(p1.listings === 3 && p1.changed === 2, 'price pull: a rate decided per request is no rate');
const p2 = await stats.runPricePull({ from: listing, date: '2026-10-02' });
ok(p2.changed === 0, 'price pull: an unchanged rate is not written again');
const S2 = stats.runStats({});
ok(rowOf(S2, 'cedar-1').notional === 0.000171 && !rowOf(S2, 'cedar-1').approx, 'notional: input, output with reasoning, cache read at its own rate');
ok(S2.summary.unbound.unpricedTokens === 20 && S2.summary.unbound.notional === 0.000007, 'notional: a model with no listing is unpriced, never zero');
ok(throws(() => stats.runPriceMap({ ours: 'local/small-test', to: 'nobody/none', by })), 'price map: a listing not in the snapshots is refused');
stats.runPriceMap({ ours: 'local/small-test', to: 'other/model-z', by });
ok(stats.runStats({}).summary.unbound.unpricedTokens === 0, 'price map: a local model priced as a listing');
const pl = stats.runPriceList();
ok(pl.models.find(m => m.model === 'local/small-test').via === 'map' && pl.models.find(m => m.model === 'prov/model-x').via === 'same', 'price list: how each model is priced');
stats.runPriceMap({ ours: 'local/small-test', to: '-', by });
ok(stats.runStats({}).summary.unbound.unpricedTokens === 20, 'price map: "-" takes the price away again');

/* ── Determinism: the same files, the same bytes ── */
const a1 = cli(['stats', '--json', '--check'], { env }), a2 = cli(['stats', '--json', '--check'], { env });
ok(a1.code === 0 && a1.stdout === a2.stdout && a1.stdout.length > 100, 'stats --json: byte for byte the same, twice');
ok(cli(['stats', '--group', 'model', '--json'], { env }).stdout === cli(['stats', '--group', 'model', '--json'], { env }).stdout, 'stats --group model: the same, twice');
const txt = cli(['stats', '--check'], { env });
ok(txt.code === 0 && /check: ok/.test(txt.out) && /READ/.test(txt.out) && /MEASURED/.test(txt.out), 'hub stats: the text view, check ok');
ok(/cost: .*accepted/.test(cli(['task', 'get', 'cedar-1'], { env }).out), 'hub task get: a cost line');
ok(/cost: /.test(cli(['task', 'get', 'cedar-1'], { env }).out) && stats.taskCost('cedar-1').attempts === 1, 'taskCost: one attempt');
ok(stats.taskCost('cedar-1').tokens === 198, 'taskCost: its tokens');
ok(/group week/.test(cli(['stats', '--group', 'week'], { env }).out), 'stats: an unknown group is refused');

/* ── A changed session is taken in again, whole ── */
{
  const extra = ROWS.map(r => ({ ...r }));   // the rows above stay as they were, for the sqlite part
  const s6 = extra.find(r => r.table === 'session' && r.row.id === 'ses-6');
  s6.row = { ...s6.row, time_updated: min(55) };
  const mid = 'msg-late';
  extra.push({ table: 'message', row: { id: mid, session_id: 'ses-6', time_created: min(54), time_updated: min(54),
    data: JSON.stringify({ role: 'assistant', agent: 'worker-a', providerID: 'prov', modelID: 'model-x' }) } });
  extra.push({ table: 'part', row: { id: 'prt-late', message_id: mid, session_id: 'ses-6', time_created: min(55), time_updated: min(55), data: JSON.stringify({ type: 'step-finish', tokens: tok(8), cost: 0 }) } });
  const f = path.join(mktmp(), 'rows2.jsonl');
  fs.writeFileSync(f, extra.map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = await sessions.runSessionsIngest({ rows: f, db: 'agent' });
  ok(r.updated === 1 && r.unchanged === 6, 'ingest: a session that changed is appended again');
  const S3 = stats.runStats({ check: true });
  ok(S3.check.ok && rowOf(S3, 'cedar-2').tokens === 73, 'ingest: the newest version counts, once');
}

/* ── The same sessions from a sqlite database ── */
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
if (sqlite) {
  const dir = mktmp(), dbf = path.join(dir, 'opencode.db');
  const db = new sqlite.DatabaseSync(dbf);
  const cols = { session: Object.keys(ROWS[0].row), message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
    part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'] };
  for (const [t, c] of Object.entries(cols)) db.exec(`CREATE TABLE ${t} (${c.join(', ')})`);
  for (const { table, row } of ROWS) {
    const c = cols[table];
    db.prepare(`INSERT INTO ${table} (${c.join(', ')}) VALUES (${c.map(() => '?').join(', ')})`).run(...c.map(k => row[k] ?? null));
  }
  db.close();
  const H1 = mktmp(), H2 = mktmp();
  const e = (h) => ({ HUBD_DIR: h, HUBD_TEAM_DIR: h, HUBD_NODE: 'cedar', HUBD_AGENT: by });
  const r1 = cli(['sessions', 'ingest', '--opencode', dbf, '--db', 'agent'], { env: e(H1) });
  const r2 = cli(['sessions', 'ingest', '--rows', rowsFile, '--db', 'agent'], { env: e(H2) });
  const read = (h) => fs.readFileSync(path.join(h, 'ledger.cedar.jsonl'), 'utf8');
  ok(r1.code === 0 && /7 new/.test(r1.out), 'ingest --opencode: a sqlite database, read-only');
  ok(r2.code === 0 && read(H1) === read(H2), 'ingest --opencode and --rows: the same ledger, byte for byte');
} else {
  ok(true, 'ingest --opencode: skipped, no node:sqlite in this Node');
}

done();
