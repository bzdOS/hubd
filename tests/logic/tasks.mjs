// tasks.mjs — the task log: the fold, ids across nodes, closing, paging, one next thing
import fs from 'node:fs';
import path from 'node:path';
import { REPO, ok, mktmp, cli, T0, core, done } from './_h.mjs';

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

// Bug: a node that once created a colliding id could no longer address the task that
// id now names. Cascade: fir adds 168; maple's own 168 collides → remapped to 169;
// pine's own 169 collides → remapped to 170. pine then updates the VISIBLE #169
// (maple's task, the id hub_task_list reports) — and its own remap silently sent the
// write to #170 instead. Real incident: ids 168 → 171 → 172 in the shared hub.
fs.writeFileSync(path.join(T0, 'tasks.fir.events.jsonl'),
  JSON.stringify({ ts: '2026-02-01 10:00', node: 'fir', ev: 'add', id: 168, t: { id: 168, text: 'fir-task', status: 'open' } }) + '\n');
fs.writeFileSync(path.join(T0, 'tasks.maple.events.jsonl'),
  JSON.stringify({ ts: '2026-02-01 10:01', node: 'maple', ev: 'add', id: 168, t: { id: 168, text: 'maple-task', status: 'open' } }) + '\n');
fs.writeFileSync(path.join(T0, 'tasks.pine.events.jsonl'),
  JSON.stringify({ ts: '2026-02-01 10:02', node: 'pine', ev: 'add', id: 169, t: { id: 169, text: 'pine-task', status: 'open' } }) + '\n' +
  JSON.stringify({ ts: '2026-02-01 10:03', node: 'pine', ev: 'set', id: 169, patch: { text: 'TRIAGE' } }) + '\n');
const cas = core.foldTasks();
const byId = (id) => cas.tasks.find(t => t.id === id);
ok(cas.tasks.length === 3, `fold/cascade: three tasks after two collisions (got ${cas.tasks.length})`);
ok(byId(169) && byId(169).text === 'TRIAGE',
  `fold/cascade: pine's update lands on the visible #169 it addressed (text=${byId(169) && byId(169).text})`);
ok(byId(170) && byId(170).text === 'pine-task',
  `fold/cascade: pine's own remapped #170 is NOT the one written to (text=${byId(170) && byId(170).text})`);
for (const f of ['tasks.fir.events.jsonl', 'tasks.maple.events.jsonl', 'tasks.pine.events.jsonl']) fs.rmSync(path.join(T0, f));

// Bug: journal rotation must not overwrite an existing same-month archive (data loss).
const big = 'x'.repeat(2 * 1024 * 1024 + 16) + '\n';
fs.writeFileSync(core.JOURNAL, '{"m":"first"}\n' + big);
core.journalAppend({ m: 'after1' });
fs.writeFileSync(core.JOURNAL, '{"m":"second"}\n' + big);
core.journalAppend({ m: 'after2' });
const arch = fs.readdirSync(T0).filter(f => /^journal\.cedar-\d{4}-\d{2}/.test(f));
ok(arch.length === 2, `journal rotation: two distinct archives kept (got ${arch.length}: ${arch.join(',')})`);
const ac = arch.map(f => fs.readFileSync(path.join(T0, f), 'utf8'));
ok(ac.some(c => c.includes('"first"')) && ac.some(c => c.includes('"second"')), 'journal rotation: both archives preserved (no overwrite)');

// Bug (latent): core.mjs must stay synchronous — setHubBase repoints a module-level
// base per HTTP request; one `await` inside a tool would let tenants interleave.
const src = fs.readFileSync(path.join(REPO, 'hub/lib/core.mjs'), 'utf8');
const codeOnly = src.split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
ok(!/\basync\b|\bawait\b/.test(codeOnly), 'core.mjs code (sans comments) has no async/await (keeps the synchronous setHubBase invariant)');
fs.rmSync(T0, { recursive: true, force: true });

// ── regression: cross-node task-id collision must not mis-close the wrong task ──
// Bug: `hub task done N` keyed its `set` event on (writing-node, N) — if the WRITING
// node had itself once collided on local id N (remapped to a different fid), that old
// remap hijacked the lookup and closed the writer's own unrelated task instead of the
// canonical #N. Fix keys `set` on the task's own _origin (node,id it was ADDED under),
// stamped by foldTasks on every fold — so any node closing #N resolves to the same
// canonical task regardless of its own numbering history. HUBD_NODE is fixed to
// 'cedar' for every file here (_h.mjs sets it before the engine loads).
const originRoot = mktmp();
core.setHubBase(originRoot); core.ensureHubDirs();
const originTs1 = '2026-01-01 10:00', originTs2 = '2026-01-01 10:01';
fs.writeFileSync(path.join(originRoot, 'tasks.peer.events.jsonl'),
  JSON.stringify({ ts: originTs1, node: 'peer', ev: 'add', id: 7, t: { id: 7, project: 'x', text: 'peer task', status: 'open' } }) + '\n');
fs.writeFileSync(path.join(originRoot, 'tasks.cedar.events.jsonl'),
  JSON.stringify({ ts: originTs2, node: 'cedar', ev: 'add', id: 7, t: { id: 7, project: 'x', text: 'cedar task', status: 'open' } }) + '\n');
const foldedOrigin = core.foldTasks();
ok(foldedOrigin.tasks.find(t => t.id === 7 && t.text === 'peer task'), 'origin fix: peer keeps canonical id 7 (added first)');
ok(foldedOrigin.tasks.find(t => t.id === 8 && t.text === 'cedar task'), 'origin fix: cedar remapped to 8 on collision (got ' + JSON.stringify(foldedOrigin.tasks.map(t => t.id)) + ')');
core.rebuildTaskCache();   // runTaskUpdate reads via loadTasks() -> must see the fresh fold, not a stale cache
core.runTaskUpdate({ id: 7, status: 'done', by: 'test' });   // "cedar" node closing canonical #7 (peer's task)
const afterOrigin = core.runTaskList({ status: 'all' }).tasks;
ok(afterOrigin.find(t => t.id === 7).status === 'done', 'origin fix: closing #7 marks the CANONICAL (peer) task done');
ok(afterOrigin.find(t => t.id === 8).status === 'open', 'origin fix: cedar\'s own remapped task #8 is untouched — the historical mis-close this fix prevents');
fs.rmSync(originRoot, { recursive: true, force: true });

// ── node-scoped ids eliminate cross-node collision AT MINT TIME ──
// (root-cause fix; #191's origin-keying stays as a symptom-patch for legacy
// bare-numeric ids, which are left completely alone here.)
const idRoot1 = mktmp();
core.setHubBase(idRoot1); core.ensureHubDirs();
fs.writeFileSync(path.join(idRoot1, 'tasks.pine.events.jsonl'),
  JSON.stringify({ ts: '2026-01-01 09:00', node: 'pine', ev: 'add', id: 'pine-1', t: { id: 'pine-1', project: 'x', text: 'pine task A', status: 'open' } }) + '\n' +
  JSON.stringify({ ts: '2026-01-01 09:01', node: 'pine', ev: 'add', id: 'pine-2', t: { id: 'pine-2', project: 'x', text: 'pine task B', status: 'open' } }) + '\n');
const addA = core.runTaskAdd({ project: 'x', text: 'cedar task A', by: 'test' });
const addB = core.runTaskAdd({ project: 'x', text: 'cedar task B', by: 'test' });
ok(addA.task.id === 'cedar-1', `id-fix: first local add is node-scoped cedar-1 (got ${addA.task.id})`);
ok(addB.task.id === 'cedar-2', `id-fix: second local add increments to cedar-2 (got ${addB.task.id})`);
const foldedIds = core.foldTasks().tasks.map(t => t.id);
ok(new Set(foldedIds).size === foldedIds.length, `id-fix: no collisions even though both nodes started counting from 1 independently (ids: ${JSON.stringify(foldedIds)})`);
ok(foldedIds.includes('pine-1') && foldedIds.includes('pine-2'), 'id-fix: the offline peer\'s tasks are untouched, no remap needed');

const repDone = core.runReport({ project: 'x', by: 'test', text: `DONE: ${addA.task.id}` });
ok(repDone.done.includes(addA.task.id), `id-fix: report DONE: accepts a node-scoped id, not just parseInt-able numbers (got ${JSON.stringify(repDone.done)})`);
ok(core.runTaskList({ project: 'x', status: 'all' }).tasks.find(t => t.id === addA.task.id).status === 'done', 'id-fix: the node-scoped task is actually closed');

fs.writeFileSync(path.join(idRoot1, 'tasks.legacy.events.jsonl'),
  JSON.stringify({ ts: '2020-01-01 00:00', node: 'legacy', ev: 'add', id: 500, t: { id: 500, project: 'x', text: 'old numeric task', status: 'open' } }) + '\n');
core.runTaskUpdate({ id: 500, status: 'done', by: 'test' });
ok(core.runTaskList({ project: 'x', status: 'all' }).tasks.find(t => t.id === 500).status === 'done', 'id-fix: legacy bare-numeric ids still resolve end-to-end (backward compatible)');

const dependent = core.runTaskAdd({ project: 'x', text: 'blocked on cedar-2', by: 'test', depends_on: [addB.task.id] });
const kanban1 = core.runKanban();
const depRow1 = [...kanban1.queued, ...kanban1.inProgress].find(t => t.id === dependent.task.id);
ok(depRow1 && depRow1.blocked === true, `id-fix: depends_on a node-scoped id correctly flags blocked (got ${JSON.stringify(depRow1)})`);
core.runTaskUpdate({ id: addB.task.id, status: 'done', by: 'test' });
const kanban2 = core.runKanban();
const depRow2 = [...kanban2.queued, ...kanban2.inProgress].find(t => t.id === dependent.task.id);
ok(depRow2 && depRow2.blocked === false, 'id-fix: unblocks once the node-scoped dependency closes');
fs.rmSync(idRoot1, { recursive: true, force: true });

// ── errors must name what the caller got wrong ────────────────────────────────
// Each of these fired against the real hub and told the caller nothing actionable.
const TE = mktmp();
core.setHubBase(TE); core.ensureHubDirs();
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const mSyncNone = threw(() => core.runSync({ agent: 't' }));
ok(/path required/.test(mSyncNone || ''), `sync: omitted path says so, not "does not exist: undefined" (got ${mSyncNone})`);
const mSyncBad = threw(() => core.runSync({ path: path.join(TE, 'nope'), agent: 't' }));
ok(/does not exist/.test(mSyncBad || ''), `sync: a real-but-absent path still reports non-existence (got ${mSyncBad})`);

const mClaim = threw(() => core.runClaim({ project: 'p', agent: 'a' }));
ok(/area/.test(mClaim || '') && !/project/.test((mClaim || '').split('(')[0]),
  `claim: names only the missing field (got ${mClaim})`);

const mUpd = threw(() => core.runTaskUpdate({ status: 'done' }));
ok(/id required/.test(mUpd || ''), `task update: omitted id says so, not "no task #undefined" (got ${mUpd})`);

// A task with no text was filed as "undefined": the engine took whatever it was given.
for (const [what, text] of [['an absent', undefined], ['a blank', '  \n '], ['a non-string', 42]]) {
  const m = threw(() => core.runTaskAdd({ project: 'p', by: 'dev-t', text }));
  ok(/^text required: what the task is/.test(m || ''), `task add: ${what} text is refused (got ${m})`);
}
ok(core.runTaskList({ status: 'all' }).tasks.length === 0, 'task add: and nothing was filed');
const tKeep = core.runTaskAdd({ project: 'p', by: 'dev-t', text: 'keep this text' }).task;
ok(/^text required/.test(threw(() => core.runTaskUpdate({ id: tKeep.id, by: 'dev-t', text: '' })) || '') &&
  core.runTaskGet({ id: tKeep.id }).task.text === 'keep this text', 'task update: blanking the text is refused and the text stays');
fs.rmSync(TE, { recursive: true, force: true });

// ── closing a task releases the claims on it ──────────────────────────────────
// `hub claim --task` marks a task started; closing it left the mark live until its TTL ran out,
// so a finished task still read as somebody's.
{
  const TR = mktmp();
  core.setHubBase(TR); core.ensureHubDirs();
  const env = { HUBD_DIR: TR, HUBD_TEAM_DIR: TR, HUBD_NODE: 'cedar' };
  const live = (id) => core.activeClaims(core.loadClaims().claims).filter(c => c.area === core.taskClaimArea(id)).length;
  const a = core.runTaskAdd({ project: 'p', text: 'close by update', by: 'dev-t' }).task.id;
  const b = core.runTaskAdd({ project: 'p', text: 'close by report', by: 'dev-t' }).task.id;
  const c = core.runTaskAdd({ project: 'p', text: 'still open', by: 'dev-t' }).task.id;
  core.runClaim({ task: a, agent: 'dev-a' }); core.runClaim({ task: a, agent: 'dev-b' });
  core.runClaim({ task: b, agent: 'dev-a' }); core.runClaim({ task: c, agent: 'dev-a' });
  core.runClaim({ project: 'p', area: 'src/**', agent: 'dev-a' });
  const ua = core.runTaskUpdate({ id: a, status: 'done', by: 'dev-a' });
  ok(ua.released === 2 && live(a) === 0, `task done: every claim on the task is released, whoever held it (released ${ua.released}, left ${live(a)})`);
  ok(live(c) === 1 && core.loadClaims().claims.some(x => x.area === 'src/**'), 'task done: claims on other tasks and on files stay');
  const rb = core.runReport({ project: 'p', by: 'dev-a', text: `DONE: ${b}` });
  ok(rb.done.includes(b) && rb.released === 1 && live(b) === 0, `report DONE: the closed task's claim is released and counted (released ${rb.released})`);
  // A claim that outlived the first close (or was taken by a stale writer) goes with a reclose.
  const db = core.loadClaims(); db.claims.push({ id: 'stale', project: 'p', area: core.taskClaimArea(a), agent: 'dev-c', since: core.now(), ttlMin: 60 });
  fs.writeFileSync(path.join(TR, 'claims.json'), JSON.stringify(db));
  const re = core.runTaskUpdate({ id: a, status: 'done', by: 'dev-c' });
  ok(re.noop === 'already-done' && re.released === 1 && live(a) === 0, 'task done: a reclose is still a no-op on the task, and still releases');
  ok(core.runTaskUpdate({ id: c, importance: 'high', by: 'dev-a' }).released === undefined && live(c) === 1, 'task update: an edit that does not close releases nothing');
  // the CLI says so, on both closing paths
  core.runClaim({ task: c, agent: 'dev-b' });
  const out1 = cli(['task', 'done', String(c), '--by', 'dev-a'], { env });
  ok(out1.code === 0 && /closed\n  released 2 claims on it/.test(out1.stdout), `hub task done: prints the release (got ${out1.stdout.trim().replace(/\n/g, ' | ')})`);
  const d = core.runTaskAdd({ project: 'p', text: 'close from a shell report', by: 'dev-t' }).task.id;
  core.runClaim({ task: d, agent: 'dev-a' });
  const out2 = cli(['report', '-p', 'p', '--agent', 'dev-a'], { env, input: `DONE: ${d}\n` });
  ok(out2.code === 0 && new RegExp(`closed #${d}, released 1 task claim$`, 'm').test(out2.stdout), `hub report: names the release beside the close (got ${out2.stdout.trim().replace(/\n/g, ' | ')})`);
  core.setHubBase(T0); core.ensureHubDirs();
}

// The queue long-poll default must stay under a typical MCP client's own tool-call
// timeout: every recorded call above ~60s was aborted by the client, and the old
// default of 170 was never usable. Guard the schema and the implementation together
// so the advertised number and the applied number cannot drift apart.
const idxSrc = fs.readFileSync(path.join(REPO, 'hub/index.mjs'), 'utf8');
ok(!/a\.timeout \|\| 170/.test(idxSrc), 'queue wait: implementation no longer defaults to the unusable 170s');
ok((idxSrc.match(/a\.timeout \|\| 45/g) || []).length === 2, 'queue wait: both wait tools default to 45s');
ok(!/default 170/.test(idxSrc), 'queue wait: schema no longer advertises 170s');

// importance was settable at add and then frozen: hub_task_update declared no such
// property and runTaskUpdate applied only status/text/deadline/cat/assignee, so the
// call returned ok and changed nothing.
const TI = mktmp();
core.setHubBase(TI); core.ensureHubDirs();
const tImp = core.runTaskAdd({ project: 'p', text: 'reprioritise me', importance: 'normal', by: 't' });
ok(tImp.task.importance === 'normal', 'task add: importance recorded');
const upImp = core.runTaskUpdate({ id: tImp.task.id, importance: 'high', by: 't' });
ok(upImp.task.importance === 'high', `task update: importance is editable (got ${upImp.task.importance})`);
ok(core.runTaskList({ project: 'p', status: 'all' }).tasks[0].importance === 'high',
  'task update: the new importance survives the fold, not just the return value');
fs.rmSync(TI, { recursive: true, force: true });

// ── closing a closed task is a no-op, not a second close ──
const ID = mktmp();
core.setHubBase(ID); core.ensureHubDirs();
const idT = core.runTaskAdd({ project: 'p', text: 'close me twice', by: 'dev-t' }).task;
const close1 = core.runTaskUpdate({ id: idT.id, status: 'done', by: 'dev-t' });
const close2 = core.runTaskUpdate({ id: idT.id, status: 'done', by: 'other-t' });
ok(!close1.noop && close2.noop === 'already-done', 'idempotent done: the second close reports itself as a no-op');
const idEvents = fs.readFileSync(path.join(ID, `tasks.${core.JOURNAL_NODE}.events.jsonl`), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l)).filter(e => e.patch && e.patch.status === 'done');
ok(idEvents.length === 1, `idempotent done: exactly one done event on disk (got ${idEvents.length})`);
ok(core.journalTail('p', 20).some(e => /already closed/.test(e.text)), 'idempotent done: the attempt is still journalled');
const close3 = core.runTaskUpdate({ id: idT.id, status: 'done', assignee: 'zed', by: 'dev-t' });
ok(close3.task.assignee === 'zed' && close3.task.done === close1.task.done,
  'idempotent done: a re-close carrying a real edit applies the edit and keeps the original close time');

// ── a reopen ends the closure: the close time does not outlive it ──
const reopen = core.runTaskUpdate({ id: idT.id, status: 'open', by: 'dev-t' });
ok(reopen.task.status === 'open' && !('done' in reopen.task), `reopen: the answer carries no close time (got ${reopen.task.done})`);
const reopened = core.runTaskList({ project: 'p', status: 'all' }).tasks.find(t => t.id === idT.id);
ok(reopened && reopened.status === 'open' && !('done' in reopened),
  `reopen: the fold drops the close time, so the task does not read as closed (got ${reopened && reopened.done})`);
const reclosed = core.runTaskUpdate({ id: idT.id, status: 'done', by: 'dev-t' });
ok(!reclosed.noop && !!reclosed.task.done, 'reopen: closing it again is a new close, with its own time');

// ── cat is a closed vocabulary; anything else survives as a tag ──
ok(core.normalizeCat('technical').cat === 'technical', 'cat: a canonical value passes through');
ok(core.normalizeCat('Chore ').cat === 'chore', 'cat: trimmed and lower-cased');
const offEnum = core.normalizeCat('jail', ['ci']);
ok(offEnum.cat === null && offEnum.tags.join(',') === 'ci,jail', `cat: an off-enum value becomes a tag (got ${JSON.stringify(offEnum)})`);
const catTask = core.runTaskAdd({ project: 'p', text: 'built in a jail', cat: 'jail', by: 'dev-t' }).task;
ok(catTask.cat === null && catTask.tags.includes('jail'), 'cat: task add routes an off-enum cat into tags');
// the migration is append-only: it writes set events, it does not rewrite the legacy log
fs.writeFileSync(path.join(ID, 'tasks.legacy.events.jsonl'),
  JSON.stringify({ ts: '2026-06-01 10:00', node: 'legacy', ev: 'add', id: 'legacy-1', t: { id: 'legacy-1', project: 'p', text: 'old', cat: 'semmarkup', status: 'open' } }) + '\n');
const legacyBefore = fs.readFileSync(path.join(ID, 'tasks.legacy.events.jsonl'), 'utf8');
ok(core.runTaskRetag({}).count === 1, 'retag: dry run finds the off-enum task and changes nothing');
ok(core.runTaskRetag({ apply: true, by: 'dev-t' }).moved === 1, 'retag: apply moves it');
ok(fs.readFileSync(path.join(ID, 'tasks.legacy.events.jsonl'), 'utf8') === legacyBefore,
  'retag: the legacy event log is untouched (append-only contract)');
const retagged = core.runTaskList({ status: 'all' }).tasks.find(t => String(t.id) === 'legacy-1');
ok(retagged.cat === null && retagged.tags.includes('semmarkup'), 'retag: the old category survives as a tag');

// ── paging beats a silent cap ──
for (let i = 0; i < 5; i++) core.runTaskAdd({ project: 'many', text: 'task ' + i, by: 'dev-t' });
const page = core.runTaskList({ project: 'many', limit: 2, offset: 1 });
ok(page.count === 2 && page.total === 5 && page.offset === 1,
  `task list: a page reports its own size AND the full total (got ${JSON.stringify({ c: page.count, t: page.total })})`);

// ── output budgets ──
const bigPayload = { journal: Array.from({ length: 200 }, (_, i) => ({ ts: '2026-07-01 10:00', text: 'x'.repeat(200) + i })),
              tasks: Array.from({ length: 80 }, (_, i) => ({ id: i, text: 'y'.repeat(100) })) };
const plan = [['journal', 30], ['tasks', 40]];
const capped = core.capOutput(bigPayload, plan, { maxChars: 20000 });
ok(capped.journal.length <= 30 && capped.tasks.length <= 40, 'budget: per-key top-N applies');
ok(JSON.stringify(capped, null, 1).length <= 20000,
  `budget: the payload really fits, measured the way the transport serialises it (got ${JSON.stringify(capped, null, 1).length})`);
ok(capped.truncated.journal.hidden === 200 - capped.journal.length && /hidden/.test(capped.hint),
  'budget: what was hidden is stated, never silently dropped');
// Order matters only once the governor actually has to cut: squeeze hard enough that the
// per-key top-N alone cannot fit the payload, then the journal must give way before the tasks.
const squeezed = core.capOutput(bigPayload, plan, { maxChars: 8000 });
ok(squeezed.journal.length < 30 && squeezed.tasks.length === 40,
  `budget: under pressure the journal gives way first and the tasks stay whole (journal ${squeezed.journal.length}, tasks ${squeezed.tasks.length})`);
ok(core.capOutput(bigPayload, plan, { maxChars: 20000, full: true }).journal.length === 200,
  'budget: full:true returns everything');
const tiny = core.capOutput(bigPayload, plan, { maxChars: 2000 });
ok(JSON.stringify(tiny, null, 1).length <= 2000 && tiny.tasks.length >= 1,
  `budget: an impossible budget empties the first list before gutting the last (tasks left ${tiny.tasks.length})`);
ok(core.capOutput({ tasks: [1, 2] }, plan).truncated === undefined, 'budget: a small payload is passed through untouched');

// ── compact views: a journal keeps its newest end, texts are cut, bookkeeping is left out ──
{
  const journal = Array.from({ length: 15 }, (_, i) => ({ ts: `2026-07-01 10:${String(i).padStart(2, '0')}`, text: 'j'.repeat(i === 14 ? 50 : 600) + i }));
  const tasks = Array.from({ length: 70 }, (_, i) => ({ id: i, text: 't'.repeat(400), deadline: null, depends_on: [], note: '', _origin: { node: 'pine', id: i } }));
  const v = core.capOutput({ journal, tasks }, [['journal', 5, { keep: 'tail', textMax: 240 }], ['tasks', 50, { textMax: 160, drop: ['_origin'], dropEmpty: true }]]);
  ok(v.journal.length === 5 && v.journal[0].ts === journal[10].ts && v.journal[4].ts === journal[14].ts,
    `compact: keep:'tail' keeps the NEWEST entries of an oldest-first journal (got ${v.journal.map(e => e.ts.slice(-2)).join(',')})`);
  ok(v.journal.slice(0, 4).every(e => e.text.length === 240 && e.text.endsWith('…')) && v.journal[4].text === journal[14].text,
    'compact: textMax cuts a long text to its limit with an ellipsis and leaves a short one alone');
  ok(v.truncated.journal.hidden === 10 && v.truncated.journal.textCut === 4 && /journal: 5 shown, 10 hidden, 4 text\(s\) cut to 240 chars/.test(v.hint),
    `compact: the cut texts are counted and named in the hint (got ${v.hint})`);
  ok(v.tasks.length === 50 && v.tasks.every(t => !('_origin' in t) && !('deadline' in t) && !('depends_on' in t) && !('note' in t) && t.text.length === 160),
    'compact: drop leaves bookkeeping out, dropEmpty leaves null / [] / "" out, texts cut to 160');
  ok(tasks[0]._origin && tasks[0].text.length === 400 && journal[0].text.length === 601, 'compact: the caller\'s objects are not mutated');
  const f = core.capOutput({ journal, tasks }, [['journal', 5, { keep: 'tail', textMax: 240 }]], { full: true });
  ok(f.journal.length === 15 && f.journal[0].text.length === 601 && f.truncated === undefined, 'compact: full:true returns every entry whole');
  // Over budget the shrink passes cut the same end the plan does: the oldest of a tail list goes first.
  const sq = core.capOutput({ journal }, [['journal', 15, { keep: 'tail' }]], { maxChars: 3000 });
  ok(sq.journal.length < 15 && sq.journal.at(-1).ts === journal[14].ts,
    `compact: under budget pressure a tail list still loses its oldest entries, not its newest (kept ${sq.journal.length}, last ${sq.journal.at(-1).ts.slice(-2)})`);
  const only = core.capOutput({ tasks: [{ id: 1, text: 'x'.repeat(300) }] }, [['tasks', 50, { textMax: 160 }]]);
  ok(only.truncated?.tasks?.hidden === 0 && only.truncated.tasks.textCut === 1, 'compact: a text cut alone is reported, even when no item was hidden');
}

// ── one task by id, and a miss that points somewhere ──
const GT = mktmp();
core.setHubBase(GT); core.ensureHubDirs();
const gtA = core.runTaskAdd({ project: 'p', text: 'the dependency', by: 'dev-t' }).task;
const gtB = core.runTaskAdd({ project: 'p', text: 'the dependent', depends_on: [gtA.id], by: 'dev-t' }).task;
const got = core.runTaskGet({ id: gtB.id });
ok(got.task.id === gtB.id && got.blockedBy.length === 1 && got.blockedBy[0].id === gtA.id,
  'task get: returns the task and what blocks it');
ok(core.runTaskGet({ id: gtA.id }).blocks[0].id === gtB.id, 'task get: and what it blocks, the other way round');
let gtErr = ''; try { core.runTaskGet({ id: 'no-such-9' }); } catch (e) { gtErr = e.message; }
ok(/hub_search/.test(gtErr), 'task get: a miss points at hub_search instead of dead-ending');
core.runResourceSet({ slug: 'api-core', type: 'service', status: 'planned', by: 'dev-t' });
let getErr = ''; try { core.runGet({ project: 'api-core' }); } catch (e) { getErr = e.message; }
ok(/IS a resource/.test(getErr) && /hub_resource_get/.test(getErr),
  'hub_get: a name that exists in the RESOURCE namespace is named as such, with the tool that reads it');
fs.writeFileSync(path.join(GT, 'projects', 'acme-io.md'), '# acme-io\n\n- slug: acme-io\n\n## Digest\n\nx\n');
let nearErr = ''; try { core.runGet({ project: 'acme' }); } catch (e) { nearErr = e.message; }
ok(/did you mean: acme-io/.test(nearErr), 'hub_get: a near-miss slug is suggested');

// ── closing a task does not silently leave its resources reading "planned" ──
const rhTask = core.runTaskAdd({ project: 'p', text: 'ship it', resources: ['api-core'], by: 'dev-t' }).task;
const rhDone = core.runTaskUpdate({ id: rhTask.id, status: 'done', by: 'dev-t' });
ok(/api-core \(planned\)/.test(rhDone.resourceHint || ''), 'close: a linked resource still marked planned is reported');
core.runResourceSet({ slug: 'api-core', status: 'live', by: 'dev-t' });
const rhTask2 = core.runTaskAdd({ project: 'p', text: 'ship again', resources: ['api-core'], by: 'dev-t' }).task;
ok(!core.runTaskUpdate({ id: rhTask2.id, status: 'done', by: 'dev-t' }).resourceHint,
  'close: a live resource produces no noise');

// ── a renamed project stops holding two separate backlogs ──
const AL = mktmp();
core.setHubBase(AL); core.ensureHubDirs();
core.runTaskAdd({ project: 'acme', text: 'written under the old slug', by: 'dev-t' });
fs.writeFileSync(path.join(AL, 'project-aliases.json'), '{"acme": "acme-io"}');
const alNew = core.runTaskAdd({ project: 'acme', text: 'written after the alias', by: 'dev-t' }).task;
ok(core.canonProject('acme') === 'acme-io', 'alias: the canonical slug resolves');
ok(alNew.project === 'acme-io', 'alias: new work lands on the canonical slug, not the alias');
ok(core.runTaskList({ project: 'acme' }).count === 2 && core.runTaskList({ project: 'acme-io' }).count === 2,
  'alias: asking by EITHER name returns the whole project');
core.runCardSet({ project: 'acme-io', digest: 'canonical card', by: 'dev-t' });
ok(/acme-io/.test(core.runGet({ project: 'acme' }).card),
  'alias: hub_get by the old name finds the canonical card');
ok(new Set(core.runGet({ project: 'acme' }).journal.map(e => e.project)).size === 2,
  'alias: the journal trail spans both slugs');
fs.writeFileSync(path.join(AL, 'project-aliases.json'), '{"a": "b", "b": "a"}');
ok(core.canonProject('a') === 'b' || core.canonProject('a') === 'a', 'alias: a cycle terminates instead of hanging');

// ── one next thing, and the day split by who can act ──
const NX = mktmp();
core.setHubBase(NX); core.ensureHubDirs();
fs.writeFileSync(path.join(NX, 'owner-roles.json'), '["alice"]');
const nxDep = core.runTaskAdd({ project: 'p', text: 'the prep', by: 'dev-t' }).task;
const nxBlocked = core.runTaskAdd({ project: 'p', text: 'loud but blocked', importance: 'high', depends_on: [nxDep.id], by: 'dev-t' }).task;
const nxOwner = core.runTaskAdd({ project: 'p', text: 'owner decides', assignee: 'alice', by: 'dev-t' }).task;
const nx = core.runNext({});
ok(String(nx.task.id) === String(nxDep.id),
  `next: a blocked high-importance task never wins over a ready one (${nx.task && nx.task.id})`);
ok(nx.blockedCount === 1 && nx.eligible === 2, `next: reports what was eligible and what was blocked (${nx.eligible}/${nx.blockedCount})`);
core.runTaskUpdate({ id: nxDep.id, status: 'done', by: 'dev-t' });
const nx2 = core.runNext({});
ok(String(nx2.task.id) === String(nxBlocked.id) && /importance high/.test(nx2.why),
  'next: closing the dependency unblocks it, and the reason is stated');
const ag = core.runAgenda({});
ok(ag.ownerButtons.length === 1 && String(ag.ownerButtons[0].id) === String(nxOwner.id),
  'agenda: a task assigned to a DECLARED owner role is a button, not agent work');
ok(!ag.agentReady.some(t => String(t.id) === String(nxOwner.id)),
  'agenda: and it is kept out of "agent work, ready now" — a list whose point is that you can start everything in it');
const nxAll = core.runTaskList({ status: 'open' }).count;
ok(ag.counts.agentReady + ag.counts.ownerButtons + ag.counts.blocked === nxAll,
  `agenda: every open task lands in exactly one column (${ag.counts.agentReady}+${ag.counts.ownerButtons}+${ag.counts.blocked} vs ${nxAll})`);

// ── a replayed add for a key that was ALREADY remapped must not mint a new task ──
// The guard compared the remap against the RAW id, so once a key had been remapped (its id was
// taken by someone else), every later add for that same key mismatched again and minted another
// task. One duplicated line in an event log multiplied without limit and broke the origin
// invariant set/del rely on: in the live base 1034 of 1507 tasks were copies born this way, and
// closing one of eleven siblings left the other ten unreachable forever.
const RP = mktmp();
core.setHubBase(RP); core.ensureHubDirs();
const dupAdd = JSON.stringify({ ts: '2026-07-07 09:20', node: 'pine', ev: 'add', id: 7,
  t: { id: 7, project: 'p', text: 'replayed', status: 'open' } });
fs.writeFileSync(path.join(RP, 'tasks.aaa.events.jsonl'),   // takes id 7 first, from another node
  JSON.stringify({ ts: '2026-07-07 09:00', node: 'aaa', ev: 'add', id: 7, t: { id: 7, project: 'p', text: 'the incumbent', status: 'open' } }) + '\n');
fs.writeFileSync(path.join(RP, 'tasks.pine.events.jsonl'), (dupAdd + '\n').repeat(6));
const rp = core.foldTasks();
const replayed = rp.tasks.filter(t => t.text === 'replayed');
ok(replayed.length === 1, `fold: six replays of one add produce ONE task, not six (got ${replayed.length})`);
ok(rp.tasks.length === 2, `fold: and the incumbent it collided with is untouched (got ${rp.tasks.length} tasks)`);
ok(replayed[0].id !== 7 && replayed[0]._origin.node === 'pine' && replayed[0]._origin.id === 7,
  'fold: the remapped task still records the origin it was added under');
const originKeys = rp.tasks.map(t => `${t._origin.node}::${t._origin.id}`);
ok(new Set(originKeys).size === originKeys.length,
  'fold: no two tasks share an origin — the invariant set/del key on');
/* Two conventions live in these logs, and the same bytes mean different tasks under each — which
 * is why new writes mark themselves. An origin-keyed set (what runTaskUpdate emits now) names the
 * (node,id) the task was ADDED under; an unmarked legacy set carries a FINAL id, where a live task
 * with that id is the target. pine updating its own remapped task and "update the visible #7"
 * would otherwise be indistinguishable. */
fs.appendFileSync(path.join(RP, 'tasks.pine.events.jsonl'),
  JSON.stringify({ ts: '2026-07-08 10:00', node: 'pine', ev: 'set', id: 7, keyed: 'origin', patch: { status: 'done' } }) + '\n');
const replayFold = core.foldTasks().tasks;
ok(replayFold.filter(t => t.text === 'replayed' && t.status === 'done').length === 1,
  'fold: an origin-keyed set closes the task it was addressed to, with no sibling left open');
ok(replayFold.find(t => t.text === 'the incumbent').status === 'open',
  'fold: and it does NOT touch the other node\'s task that happens to hold that number');
fs.appendFileSync(path.join(RP, 'tasks.pine.events.jsonl'),
  JSON.stringify({ ts: '2026-07-08 11:00', node: 'pine', ev: 'set', id: 7, patch: { text: 'legacy-write' } }) + '\n');
ok(core.foldTasks().tasks.find(t => t.id === 7).text === 'legacy-write',
  'fold: an UNMARKED same-node set still means the visible id, so old events keep the meaning they were written with');
/* An unmarked event whose node is NOT the file it lives in was written by a node deliberately
 * addressing another node's origin — only the origin-keyed writer does that. The writer has been
 * recording sets that way since 0.4.8 without a marker, and reading them as final-id events
 * misroutes every one (85 in the hub this was found in — including closes that landed on other
 * people's tasks and silently marked them done). */
fs.writeFileSync(path.join(RP, 'tasks.other.events.jsonl'),
  JSON.stringify({ ts: '2026-07-09 10:00', node: 'pine', ev: 'set', id: 7, patch: { text: 'cross-node origin write' } }) + '\n');
const crossFold = core.foldTasks().tasks;
ok(crossFold.find(t => t._origin.node === 'pine').text === 'cross-node origin write',
  'fold: an unmarked CROSS-node set is origin-keyed — only that writer addresses a foreign origin');
ok(crossFold.find(t => t.id === 7).text === 'legacy-write',
  'fold: and it leaves the task merely holding that number alone');
fs.rmSync(RP, { recursive: true, force: true });
core.setHubBase(T0); core.ensureHubDirs();

// ── the journal says WHAT changed on a task, not merely that something did ──
// "~ task #N → edited" made the most useful event in a coordination log (somebody took this
// task) indistinguishable from a typo fix in its text. Found while filming the kanban: the live
// activity line for an assignment read "edited".
const JW = mktmp();
core.setHubBase(JW); core.ensureHubDirs();
const jwT = core.runTaskAdd({ project: 'p', text: 'the work', by: 'dev-t' }).task;
core.runTaskUpdate({ id: jwT.id, assignee: 'dev-atlas', by: 'lead-t' });
core.runTaskUpdate({ id: jwT.id, importance: 'high', deadline: '2026-12-01', by: 'lead-t' });
core.runTaskUpdate({ id: jwT.id, status: 'done', by: 'dev-atlas' });
const jwAll = core.journalTail('p', 20);
const jwLines = jwAll.filter(e => e.kind === 'task').map(e => e.text);
ok(jwLines.some(l => /@dev-atlas/.test(l)), `journal: an assignment names the new owner (got ${JSON.stringify(jwLines)})`);
/* ATTRIBUTE MAINTENANCE NO LONGER REACHES THE JOURNAL.
 * Measured on a live hub: 2642 entries, 1211 of them task echo, 725 from this one line. A reader
 * scanning the month does not need to know which field was touched — that is in
 * tasks.<node>.events.jsonl at full fidelity. Who holds a task and what state it is in, they do,
 * so assignment and status stay. */
ok(!jwLines.some(l => /importance high|due 2026-12-01|text|cat\/tags|deps/.test(l)),
  `journal: a field edit writes nothing here — it is already in the event log (got ${JSON.stringify(jwLines)})`);
/* But a CLOSURE is narrative and gets PROMOTED, not dropped. The spec asked for kind:task to go
 * entirely; on the live hub 83 of 467 "-> done" echoes were the only journal trace that a task was
 * ever closed, because closing through the CLI never wrote a `done` entry. Cutting them would have
 * erased 83 closures from the readable record in order to remove noise. */
const jwDone = jwAll.filter(e => e.kind === 'done').map(e => e.text);
ok(jwDone.some(l => l.includes('#' + jwT.id)) && jwDone.some(l => /the work/.test(l)),
  `journal: a close reads as a done entry carrying the task text, not as field echo (got ${JSON.stringify(jwDone)})`);
ok(!jwLines.some(l => /→ done/.test(l)),
  'journal: and the close is recorded once, not as both a done entry and an echo line');
ok(!jwLines.some(l => /→ edited$/.test(l)), 'journal: nothing falls back to the useless word');
fs.rmSync(JW, { recursive: true, force: true });
core.setHubBase(T0); core.ensureHubDirs();

// ── a cache folded by a buggy fold must not outlive the fix ───────────────────
/* tasks.json is rebuilt when it is older than the newest event file, which can only ever notice
 * NEW EVENTS. The case that misses is the one that matters most: a fix to the fold itself leaves
 * every event byte-identical and every mtime untouched, so the wrong cache survives the upgrade
 * and keeps being served as fact. On the hub 0.9.2 was found on, `hub doctor` still reported
 * "977 open" after the phantom-task fix shipped — the corrected fold said 154. */
const FV = mktmp();
core.setHubBase(FV); core.ensureHubDirs();
const fvEvents = path.join(FV, 'tasks.pine.events.jsonl');
fs.writeFileSync(fvEvents, JSON.stringify({ ts: '2026-08-03 09:00', node: 'pine', ev: 'add', id: 'pine-1',
  t: { id: 'pine-1', project: 'p', text: 'real task', status: 'open' } }) + '\n');
const past = new Date(Date.now() - 3600_000);
fs.utimesSync(fvEvents, past, past);                    // events are OLD; the stale cache is fresh
const phantoms = { seq: 9, tasks: [{ id: 1, project: 'p', text: 'phantom', status: 'open' },
                                   { id: 2, project: 'p', text: 'phantom too', status: 'open' }] };
fs.writeFileSync(path.join(FV, 'tasks.json'), JSON.stringify(phantoms));
const fvTasks = core.loadTasks().tasks;
ok(fvTasks.length === 1 && fvTasks[0].text === 'real task',
  `loadTasks: a cache with no fold stamp is refolded, not trusted (got ${fvTasks.length}: ${fvTasks.map(t => t.text).join(', ')})`);
ok(JSON.parse(fs.readFileSync(path.join(FV, 'tasks.json'), 'utf8')).foldVersion === core.VERSION,
  'loadTasks: the rebuilt cache records the version that folded it');
fs.writeFileSync(path.join(FV, 'tasks.json'), JSON.stringify({ ...phantoms, foldVersion: '0.0.1' }));
fs.utimesSync(fvEvents, past, past);
ok(core.loadTasks().tasks[0].text === 'real task',
  'loadTasks: and a cache folded by a DIFFERENT version is refolded too');
fs.utimesSync(fvEvents, past, past);
ok(core.loadTasks().tasks.length === 1 && JSON.parse(fs.readFileSync(path.join(FV, 'tasks.json'), 'utf8')).foldVersion === core.VERSION,
  'loadTasks: a cache stamped with the running version is served as-is');

done();
