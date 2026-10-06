// cursors.mjs — queue cursors: one per subscriber, fan-out roles, the session id, a reader across a respawn
import fs from 'node:fs';
import path from 'node:path';
import { REPO, ok, mktmp, run, cli, T0, core, queueLib, done } from './_h.mjs';

// ── a cursor belongs to a subscriber, not to the node ─────────────────────────
// Bug: the offset lived at .qstate/<file>.offset, one per queue file shared by the
// whole node. Several sessions subscribing to one role therefore consumed from one
// cursor — whoever polled first took the message and the rest never saw it. That is
// right for competing workers and wrong for subscribers.
const { sessionId, resetSessionId } = await import(path.join(REPO, 'hub/lib/session.mjs'));
const QR = mktmp();
fs.mkdirSync(path.join(QR, 'queues'), { recursive: true });
// Fan-out is a property of the ROLE, declared once — not something the transport turns
// on because the caller happens to be a long-lived server. Undeclared roles stay
// competing-worker queues, which is what task dispatch relies on.
fs.writeFileSync(path.join(QR, 'subscriber-roles.json'), JSON.stringify(['fanout']));
queueLib.queueSend('fanout', 'one message for everybody', { from: 'test', root: QR });

const subA = await queueLib.queueWait('fanout', { timeout: 0, root: QR, subscriber: 'sess-a' });
const subB = await queueLib.queueWait('fanout', { timeout: 0, root: QR, subscriber: 'sess-b' });
ok(subA.changed && /one message for everybody/.test(subA.text), 'cursor: first subscriber receives the message');
ok(subB.changed && /one message for everybody/.test(subB.text),
  `cursor: SECOND subscriber receives the same message (fan-out, got changed=${subB.changed})`);
const subAagain = await queueLib.queueWait('fanout', { timeout: 0, root: QR, subscriber: 'sess-a' });
ok(!subAagain.changed, 'cursor: a subscriber does not re-read what it already consumed');
ok(fs.existsSync(path.join(QR, '.qstate', 'sess-a')) && fs.existsSync(path.join(QR, '.qstate', 'sess-b')),
  'cursor: each subscriber gets its own .qstate namespace');

// An UNDECLARED role keeps at-most-once delivery even for two identified subscribers:
// otherwise every work queue silently became a broadcast the moment the caller was a
// long-lived MCP server, and two sessions would both do the task and both claim it.
queueLib.queueSend('worker', 'exactly one of you takes this', { from: 'test', root: QR });
const wk1 = await queueLib.queueWait('worker', { timeout: 0, root: QR, subscriber: 'sess-a' });
const wk2 = await queueLib.queueWait('worker', { timeout: 0, root: QR, subscriber: 'sess-b' });
ok(wk1.changed && !wk2.changed,
  `cursor: an undeclared role stays competing-worker even with subscribers (${wk1.changed}/${wk2.changed})`);
const strayWorker = fs.readdirSync(path.join(QR, '.qstate', 'sess-a')).filter(f => f.startsWith('worker.'));
ok(strayWorker.length === 0,
  `cursor: an undeclared role writes no per-subscriber offset (found ${strayWorker.join(',') || 'none'})`);

// No subscriber → the shared per-node cursor, i.e. today's behaviour untouched.
queueLib.queueSend('shared', 'for whoever gets there first', { from: 'test', root: QR });
const sh1 = await queueLib.queueWait('shared', { timeout: 0, root: QR });
const sh2 = await queueLib.queueWait('shared', { timeout: 0, root: QR });
ok(sh1.changed && !sh2.changed, `cursor: without a subscriber the node cursor is still shared (${sh1.changed}/${sh2.changed})`);
const sharedOffsets = fs.readdirSync(path.join(QR, '.qstate')).filter(f => f.startsWith('shared.') && f.endsWith('.offset'));
ok(sharedOffsets.length === 1,
  `cursor: shared offset stays a plain file in .qstate, so existing offsets keep working (found ${sharedOffsets.join(',') || 'none'})`);
fs.rmSync(QR, { recursive: true, force: true });

// A fanout role's depth is per-reader: subscribers advance their own cursors, nothing
// ever advances the shared one peekQueueDepth reads — so a byte count from it is a
// phantom backlog that only grows, and a fanout OWNER role would show "buttons
// waiting" forever. The brief must report the role as fanout, not a wrong number.
const FB = mktmp();
core.setHubBase(FB); core.ensureHubDirs();
fs.mkdirSync(path.join(FB, 'queues'), { recursive: true });
fs.writeFileSync(path.join(FB, 'subscriber-roles.json'), JSON.stringify(['announce']));
fs.writeFileSync(path.join(FB, 'owner-roles.json'), JSON.stringify(['announce']));
queueLib.queueSend('announce', 'to everybody', { from: 'test', root: FB });
await queueLib.queueWait('announce', { timeout: 0, root: FB, subscriber: 'sess-a' });   // fully consumed by a subscriber
core.runHeartbeat({ agent: 'agent-a', role: 'announce' });
const fbRows = queueLib.queueSummaryForBrief({ root: FB });
const fbRow = fbRows.find(r => r.role === 'announce');
ok(fbRow && fbRow.fanout === true && fbRow.pending === null,
  `brief: a declared fanout role reports fanout:true, pending:null — not the shared cursor's phantom count (got ${JSON.stringify(fbRow)})`);
ok(queueLib.buttonsSummary(fbRows).count === 0,
  'brief: a fanout owner role never counts as buttons waiting — that count could never clear');
fs.rmSync(FB, { recursive: true, force: true });

// Delivery advances the cursor under a lock: two competing waiters seeing the same
// bytes in one poll window would otherwise both deliver them — "exactly one reader"
// held by timing luck. A held lock is a skip for this poll, never a failed wait.
const LK = mktmp();
fs.mkdirSync(path.join(LK, 'queues'), { recursive: true });
queueLib.queueSend('locked', 'contended message', { from: 'test', root: LK });
fs.mkdirSync(path.join(LK, '.qstate'), { recursive: true });
// core.JOURNAL_NODE, not a second copy of the hostname formula: queue filenames follow the
// SAME node identity as the journal and the task log (HUBD_NODE included), and this test
// duplicating the old formula is exactly how the two drifted apart in the first place.
const lkNode = core.JOURNAL_NODE;
const lkLock = path.join(LK, '.qstate', `locked.${lkNode}.queue.md.offset.lock`);
fs.writeFileSync(lkLock, '');   // someone else is mid-drain on this cursor
const lkBlocked = await queueLib.queueWait('locked', { timeout: 0, root: LK });
ok(lkBlocked.changed === false,
  `queue: a held cursor lock skips the poll instead of double-delivering or throwing (got ${JSON.stringify(lkBlocked)})`);
fs.unlinkSync(lkLock);
const lkAfter = await queueLib.queueWait('locked', { timeout: 3, root: LK });
ok(lkAfter.changed === true && /contended message/.test(lkAfter.text),
  'queue: releasing the lock delivers on the next poll — nothing was lost');
fs.rmSync(LK, { recursive: true, force: true });

// peekQueueDepth must count block HEADERS (the full "## <ts> · from" shape queueSend
// writes), not any line that starts with a timestamp heading: a message quoting a log
// line or a dated heading used to inflate the pending count. (A body replicating a
// FULL header verbatim stays indistinguishable — inherent to the flat format.)
const PK = mktmp();
fs.mkdirSync(path.join(PK, 'queues'), { recursive: true });
queueLib.queueSend('quoted', 'see my note from\n## 2026-01-01 00:00\nthat dated heading above', { from: 'test', root: PK });
ok(queueLib.peekQueueDepth('quoted', { root: PK }).pending === 1,
  `peek: a dated heading inside a message body is not a second message (got ${queueLib.peekQueueDepth('quoted', { root: PK }).pending})`);
fs.rmSync(PK, { recursive: true, force: true });

// DONE with an id that matches nothing used to vanish silently — the task stayed open
// and nothing said so (the protocol's DONE rule warns exactly about batch-copied ids).
const DM = mktmp();
core.setHubBase(DM); core.ensureHubDirs();
const dmT = core.runTaskAdd({ project: 'p', text: 'real work', by: 'test' });
const dmR = core.runReport({ project: 'p', by: 'test', text: `DONE: ${dmT.task.id}, nope-99` });
ok(dmR.done.length === 1 && String(dmR.done[0]) === String(dmT.task.id),
  `report: the real id still closes (got ${JSON.stringify(dmR.done)})`);
ok(JSON.stringify(dmR.doneMissed) === JSON.stringify(['nope-99']),
  `report: an id that matches no task comes back as doneMissed, not swallowed (got ${JSON.stringify(dmR.doneMissed)})`);
ok(core.runTaskList({ status: 'all' }).tasks.find(t => t.id === dmT.task.id).status === 'done',
  'report: the miss does not block the hit');
fs.rmSync(DM, { recursive: true, force: true });

// DONE as roles write it. "#" and a node left out are read when one task ends in the number; a
// line that reads as closing a task but is not the DONE: form ("#471 DONE") used to be a note,
// closing nothing and saying nothing. It refuses the report now, with the form.
const DN = mktmp();
core.setHubBase(DN); core.ensureHubDirs();
const dnEv = (node, n, project) => JSON.stringify({ ts: '2026-10-06 08:00', node, ev: 'add', id: `${node}-${n}`,
  t: { id: `${node}-${n}`, project, text: 'task ' + n, status: 'open' } }) + '\n';
fs.writeFileSync(path.join(DN, 'tasks.fir.events.jsonl'), dnEv('fir', 471, 'p') + dnEv('fir', 500, 'p') + dnEv('fir', 600, 'p'));
fs.writeFileSync(path.join(DN, 'tasks.oak.events.jsonl'), dnEv('oak', 500, 'q') + dnEv('oak', 600, 'p'));
const dnSt = (id) => core.runTaskList({ status: 'all' }).tasks.find(t => t.id === id).status;
const d1 = core.runReport({ project: 'p', by: 'test', text: 'DONE: #471' });
ok(d1.done.join() === 'fir-471' && dnSt('fir-471') === 'done', `report: "DONE: #471" closes fir-471, the one task ending in -471 (${JSON.stringify(d1.done)})`);
const d2 = core.runReport({ project: 'p', by: 'test', text: 'DONE: 500' });
ok(d2.done.join() === 'fir-500' && dnSt('oak-500') === 'open', `report: of two ending in -500, the one in the report's project (${JSON.stringify(d2.done)})`);
const d3 = core.runReport({ project: 'p', by: 'test', text: 'DONE: 600' });
ok(!d3.done.length && d3.doneMissed.join() === '600' && d3.doneAmbiguous[0].tasks.sort().join() === 'fir-600,oak-600' &&
  /Write "DONE: <id>\[, <id>\]"/.test(d3.doneForm) && dnSt('fir-600') === 'open' && dnSt('oak-600') === 'open',
  `report: two in the project ending in -600 close neither, and the reply names both and the form (${JSON.stringify(d3.doneAmbiguous)})`);
const dnRefused = (text) => { try { core.runReport({ project: 'p', by: 'test', text }); return null; } catch (e) { return e.message; } };
const dnLen = core.journalTail('p', 1000).length;
for (const line of ['#600 DONE', 'fir-600 done', 'fir-600: DONE', 'DONE #600', 'DONE fir-600', 'DONE 600', 'DONE - 600, 601']) {
  const m = dnRefused(`checked the build\n${line}`);
  ok(m && /reads as closing a task, but it is not the DONE: form and would close nothing\. Write "DONE: <id>/.test(m),
    `report: "${line}" is refused with the form (${m && m.slice(0, 60)})`);
}
ok(core.journalTail('p', 1000).length === dnLen && dnSt('fir-600') === 'open', 'report: and a refused report writes nothing');
for (const line of ['3 done, 2 left', 'phase-2 done', 'DONE 3 of 5 steps', 'Done with the build'])
  ok(dnRefused(line) === null, `report: "${line}" is prose, filed as a note`);
const dnC = cli(['report', '-p', 'p', '--agent', 'test', '-m', 'DONE: 600, nope-1'], { env: { HUBD_DIR: DN }, cwd: DN });
ok(/NOT closed: #600 \(several end in it: (fir-600, oak-600|oak-600, fir-600)\), #nope-1 \(no such task\).*Write "DONE: <id>/.test(dnC.stderr),
  `CLI: the misses, which kind each is, and the form (${dnC.stderr.trim().slice(0, 120)})`);
fs.rmSync(DN, { recursive: true, force: true });

// A card made by hub_card_set has `- set:`, not `- synced:` — it used to show '?' in
// status and could never go stale in the brief, however long abandoned.
const SC = mktmp();
core.setHubBase(SC); core.ensureHubDirs();
core.runCardSet({ project: 'harvested', digest: 'captured from a dialog', by: 'test' });
const scRow = core.runStatus().projects.find(p => p.project === 'harvested');
ok(scRow && /^\d{4}-/.test(scRow.synced), `status: a card-set card shows its set time, not '?' (got ${scRow && scRow.synced})`);
fs.writeFileSync(path.join(SC, 'projects', 'oldset.md'),
  '# oldset\n\n- slug: oldset\n- set: 2020-01-01 00:00 by test\n\n## Digest\n\nlong abandoned\n');
ok(core.runBrief({}).staleCards.some(c => c.project === 'oldset'),
  'brief: a card-set card goes stale by its set time');
fs.rmSync(SC, { recursive: true, force: true });

// sessionId must never depend on the model: explicit env wins, else the parent process
// (stable across a server respawn), else null so the caller keeps the node cursor.
const prevSess = process.env.HUBD_SESSION;
process.env.HUBD_SESSION = 'My Session/42';
resetSessionId();
ok(sessionId() === 's-my-session-42', `sessionId: HUBD_SESSION wins and is slugified (got ${sessionId()})`);
delete process.env.HUBD_SESSION;
resetSessionId();
const derived = sessionId();
ok(new RegExp(`^p-${process.ppid}(-.+)?$`).test(derived),
  `sessionId: falls back to the parent process (got ${derived})`);
// pids are recycled, so the pid alone is not an identity: a new client landing on a
// dead session's pid would inherit its cursor and resume at its offset, skipping every
// message in between. The parent's start time distinguishes them. Absent on a platform
// that exposes neither procfs nor ps — then the bare pid is the documented fallback.
ok(derived !== 'p-' + process.ppid,
  `sessionId: the parent's start time is part of the id, so a recycled pid gets a fresh cursor (got ${derived})`);
if (prevSess === undefined) delete process.env.HUBD_SESSION; else process.env.HUBD_SESSION = prevSess;
resetSessionId();

// whatsnew's checkpoint must key on the session, not on the agent label: the label
// names the function being performed and several functions share one trajectory, so
// keying on it made a relabelled caller lose its checkpoint and re-read everything.
const WN = mktmp();
core.setHubBase(WN); core.ensureHubDirs();
core.journalAppend({ ts: core.now(), project: 'p', agent: 'dev', kind: 'note', text: 'first entry' });
const wn1 = core.runWhatsNew({ agent: 'dev', session: 'sess-x' });
ok(wn1.firstCheckin === true, 'whatsnew: first call for a session has no checkpoint');
const wn2 = core.runWhatsNew({ agent: 'reviewer', session: 'sess-x' });
ok(wn2.firstCheckin === false,
  `whatsnew: the SAME session under a new agent label keeps its checkpoint (got firstCheckin=${wn2.firstCheckin})`);
const wn3 = core.runWhatsNew({ agent: 'dev', session: 'sess-y' });
ok(wn3.firstCheckin === true, 'whatsnew: a different session gets its own checkpoint');
const wn4 = core.runWhatsNew({ agent: 'solo' });
ok(wn4.firstCheckin === true, 'whatsnew: with no session the agent label is still the key (CLI path unchanged)');
fs.rmSync(WN, { recursive: true, force: true });

// gc must reach BOTH places a subscriber cursor lives. A fleet tap's cursor sits under
// .qstate/__watchall__/<subscriber>/, so skipping that dir exempted the busiest kind
// from the sweep entirely — while a live-but-idle cursor must survive, or the session
// silently resumes at the tail.
const GC = mktmp();
const monthOld = new Date(Date.now() - 30 * 86400000);
for (const p of [['role-sub'], ['__watchall__', 'tap-sub'], ['fresh-sub']]) {
  const d = path.join(GC, '.qstate', ...p);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'x.queue.md.offset');
  fs.writeFileSync(f, '0');
  if (p[p.length - 1] !== 'fresh-sub') fs.utimesSync(f, monthOld, monthOld);
}
fs.writeFileSync(path.join(GC, '.qstate', 'shared.queue.md.offset'), '0');   // a shared cursor, must survive
const gcOut = run('gc --apply --by dev-t', { HUBD_DIR: GC, HUBD_TEAM_DIR: GC });
ok(!fs.existsSync(path.join(GC, '.qstate', 'role-sub')), 'gc: sweeps a stale role-subscriber cursor');
ok(!fs.existsSync(path.join(GC, '.qstate', '__watchall__', 'tap-sub')),
  `gc: sweeps a stale fleet-tap cursor under __watchall__ too (out=${gcOut.out.trim().split('\n').pop()})`);
ok(fs.existsSync(path.join(GC, '.qstate', 'fresh-sub')), 'gc: leaves a recently-used cursor alone');
ok(fs.existsSync(path.join(GC, '.qstate', 'shared.queue.md.offset')), 'gc: never touches a shared cursor file');
fs.rmSync(GC, { recursive: true, force: true });

// ── a broadcast reader keeps its place across a respawn ──
const SUBQ = mktmp();
core.setHubBase(SUBQ); core.ensureHubDirs();
{
  const qlib = await import(path.join(REPO, 'hub/lib/queue.mjs'));
  const sess = await import(path.join(REPO, 'hub/lib/session.mjs'));
  const saved = { a: process.env.HUBD_AGENT, s: process.env.HUBD_SESSION, u: process.env.HUBD_SUBSCRIBER };
  delete process.env.HUBD_SESSION; delete process.env.HUBD_SUBSCRIBER;
  process.env.HUBD_AGENT = 'kestrel-linux';
  sess.resetSessionId();
  const sid = sess.subscriberId();
  ok(sid === 'a-kestrel-linux', `subscriber: falls back to HUBD_AGENT, which a respawned role comes back with (got ${sid})`);
  ok(sess.sessionId() !== sid, 'subscriber: the process session id (author floor, checkpoints) is NOT the shared agent name');
  process.env.HUBD_SUBSCRIBER = 'linux-reader'; sess.resetSessionId();
  ok(sess.subscriberId() === 'u-linux-reader', 'subscriber: HUBD_SUBSCRIBER wins when the harness names the reader');
  delete process.env.HUBD_SUBSCRIBER; sess.resetSessionId();

  fs.writeFileSync(path.join(SUBQ, 'subscriber-roles.json'), JSON.stringify(['chat']));
  qlib.queueSend('chat', 'one', { from: 'dev-t', root: SUBQ });
  const w1 = await qlib.queueWait('chat', { root: SUBQ, timeout: 0, subscriber: sess.subscriberId() });
  qlib.queueSend('chat', 'two', { from: 'dev-t', root: SUBQ });
  sess.resetSessionId();                                   // "respawn": same env, new process identity
  const w2 = await qlib.queueWait('chat', { root: SUBQ, timeout: 0, subscriber: sess.subscriberId() });
  ok(/one/.test(w1.text) && /two/.test(w2.text) && !/one/.test(w2.text), 'subscriber: after a respawn the reader resumes at its own position — not from zero, not from the end');

  // Two live sessions on one stable id split a broadcast — seen and reported, not silent.
  const nsDir = path.join(SUBQ, '.qstate', sid);
  fs.writeFileSync(path.join(nsDir, 'chat.waiter'), JSON.stringify({ pid: process.ppid, since: new Date().toISOString() }));
  const origErr = process.stderr.write; process.stderr.write = () => true;
  await qlib.queueWait('chat', { root: SUBQ, timeout: 0, subscriber: sid });
  process.stderr.write = origErr;
  const sharedObs = () => ((JSON.parse(fs.readFileSync(path.join(SUBQ, '.env-state.json'), 'utf8')).observations || {})['subscriber-shared'] || {}).values || [];
  ok(sharedObs().includes(`chat as ${sid}`) && core.envChecks({}).total >= 1,
    'subscriber: two live waiters on one id are recorded for the environment check');
  fs.rmSync(path.join(nsDir, 'chat.waiter'), { force: true });
  await qlib.queueWait('chat', { root: SUBQ, timeout: 0, subscriber: sid });
  ok(sharedObs().length === 0, 'subscriber: and the notice clears once only one waits');

  // Dead namespaces: listed, archived (moved, not deleted), and no longer counted as readers.
  const old = (Date.now() - 10 * 86400000) / 1000;
  for (const d of [path.join(SUBQ, '.qstate', 'p-111-dead'), path.join(SUBQ, '.qstate', '__watchall__', 'p-222-dead')]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'chat.cedar.queue.md.offset'), '0');
    fs.utimesSync(path.join(d, 'chat.cedar.queue.md.offset'), old, old);
  }
  const g0 = qlib.runQueueGc({ root: SUBQ });
  ok(g0.staleSubscribers.map(s => s.name).sort().join(',') === 'p-111-dead,p-222-dead' && fs.existsSync(path.join(SUBQ, '.qstate', 'p-111-dead')),
    `gc: dry run lists the idle reader namespaces, including taps, and moves nothing (${g0.staleSubscribers.map(s => s.name)})`);
  ok(qlib.queueLedger({ root: SUBQ, role: 'chat' }).roles[0].readers.some(r => r.subscriber === 'p-111-dead'), 'gc: before archiving, the dead reader shows in the ledger');
  const g1 = qlib.runQueueGc({ root: SUBQ, apply: true });
  ok(g1.subscribersArchived.length === 2 && fs.existsSync(path.join(SUBQ, '.qstate', '_archive', 'p-111-dead', 'chat.cedar.queue.md.offset'))
    && fs.existsSync(path.join(SUBQ, '.qstate', '_archive', '__watchall__', 'p-222-dead')) && fs.existsSync(nsDir),
    'gc: --apply moves idle namespaces to .qstate/_archive/ and leaves the live one');
  ok(!qlib.queueLedger({ root: SUBQ, role: 'chat' }).roles[0].readers.some(r => /dead|archive/.test(r.subscriber)), 'gc: an archived namespace is no longer a reader');
  const gcCli = run('gc', { HUBD_DIR: SUBQ, HUBD_TEAM_DIR: SUBQ });
  ok(gcCli.code === 0 && fs.existsSync(path.join(SUBQ, '.qstate', '_archive')), 'gc: hub gc leaves the archive alone');

  if (saved.a === undefined) delete process.env.HUBD_AGENT; else process.env.HUBD_AGENT = saved.a;
  if (saved.s !== undefined) process.env.HUBD_SESSION = saved.s;
  if (saved.u !== undefined) process.env.HUBD_SUBSCRIBER = saved.u;
  sess.resetSessionId();
}
core.setHubBase(T0); core.ensureHubDirs();

done();
