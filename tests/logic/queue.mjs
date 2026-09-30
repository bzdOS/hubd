// queue.mjs — queues: depth, buttons, ghosts, task refs, the ledger, spellings, a role's work, two readers, acks, the CLI
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, ok, mktmp, run, cli, T0, core, queueLib, done } from './_h.mjs';

// ── queue-depth peek: non-consuming, mesh-safe ──
const qRoot1 = mktmp();
const qdir1 = path.join(qRoot1, 'queues'), stateDir1 = path.join(qRoot1, '.qstate');
fs.mkdirSync(qdir1, { recursive: true }); fs.mkdirSync(stateDir1, { recursive: true });
const qfile1 = path.join(qdir1, 'hubd.testnode.queue.md');
const msg1 = '\n## 2026-01-01 10:00 · from orchestrator\nfirst message\n';
fs.writeFileSync(qfile1, msg1);
fs.writeFileSync(path.join(stateDir1, 'hubd.testnode.queue.md.offset'), String(Buffer.byteLength(msg1)));   // first message already consumed
const msg2 = '\n## 2026-01-01 11:00 · from orchestrator\nsecond message\n';
fs.appendFileSync(qfile1, msg2);
const depth1 = queueLib.peekQueueDepth('hubd', { root: qRoot1 });
ok(depth1.pending === 1, `peekQueueDepth: counts only the unread message (got ${depth1.pending})`);
ok(depth1.oldestWaiting === '2026-01-01 11:00', `peekQueueDepth: oldestWaiting is the unread one's timestamp (got ${depth1.oldestWaiting})`);
const offsetBefore = fs.readFileSync(path.join(stateDir1, 'hubd.testnode.queue.md.offset'), 'utf8');
queueLib.peekQueueDepth('hubd', { root: qRoot1 });   // call again
ok(fs.readFileSync(path.join(stateDir1, 'hubd.testnode.queue.md.offset'), 'utf8') === offsetBefore, 'peekQueueDepth: never advances the offset (non-consuming, does not steal from the real consumer)');
fs.rmSync(qRoot1, { recursive: true, force: true });

// ── queueSummaryForBrief: cross-references presence, drops idle/unknown roles ──
const qRoot2 = mktmp();
core.setHubBase(qRoot2);
fs.mkdirSync(path.join(qRoot2, 'queues'), { recursive: true });
fs.writeFileSync(path.join(qRoot2, 'queues', 'busyrole.node1.queue.md'), '\n## 2026-02-02 09:00 · from orchestrator\nsomething\n');
fs.writeFileSync(path.join(qRoot2, 'queues', 'idlerole.node1.queue.md'), '');   // exists, nothing pending, no presence -> dropped
core.runHeartbeat({ agent: 'agent-busy', role: 'busyrole' });
const summary = queueLib.queueSummaryForBrief({ root: qRoot2 });
ok(summary.length === 1 && summary[0].role === 'busyrole', `queueSummaryForBrief: only the role with pending or presence shows up (got ${JSON.stringify(summary)})`);
ok(summary[0].pending === 1 && summary[0].lastSeen === core.readPresenceRecord('agent-busy').last_seen, 'queueSummaryForBrief: pending count + presence last-seen cross-referenced by role');
fs.rmSync(qRoot2, { recursive: true, force: true });

// ── buttons: owner-roles.json + queue-depth isButton/ageDays + buttonsSummary ──
const btnRoot1 = mktmp();
core.setHubBase(btnRoot1);
ok(core.ownerRoles().length === 0, 'ownerRoles: empty by default (no owner-roles.json)');
fs.writeFileSync(path.join(btnRoot1, 'owner-roles.json'), JSON.stringify(['alice', 42, '', 'boss']));
ok(JSON.stringify(core.ownerRoles()) === JSON.stringify(['alice', 'boss']), `ownerRoles: reads the file, drops non-string/empty entries (got ${JSON.stringify(core.ownerRoles())})`);

fs.mkdirSync(path.join(btnRoot1, 'queues'), { recursive: true });
const oldTs = '2020-01-01 00:00';
fs.writeFileSync(path.join(btnRoot1, 'queues', 'alice.node1.queue.md'), `\n## ${oldTs} · from agent\nsign this contract\n`);
fs.writeFileSync(path.join(btnRoot1, 'queues', 'dev.node1.queue.md'), '\n## 2026-01-01 00:00 · from orchestrator\nfix the bug\n');
const rows1 = queueLib.queueSummaryForBrief({ root: btnRoot1 });
const aliceRow = rows1.find(r => r.role === 'alice');
const devRow = rows1.find(r => r.role === 'dev');
ok(aliceRow && aliceRow.isButton === true, 'queueSummaryForBrief: owner role flagged isButton');
ok(devRow && devRow.isButton === false, 'queueSummaryForBrief: non-owner role is not a button');
ok(aliceRow.ageDays >= 2000, `queueSummaryForBrief: ageDays computed from a 2020 timestamp (got ${aliceRow.ageDays})`);

const btnSum1 = queueLib.buttonsSummary(rows1);
ok(btnSum1.count === 1 && btnSum1.items.length === 1 && btnSum1.items[0].role === 'alice', `buttonsSummary: counts only button rows with pending>0 (got ${JSON.stringify(btnSum1)})`);
ok(btnSum1.oldestDays === aliceRow.ageDays, 'buttonsSummary: oldestDays matches the button row age');

// a button role with nothing pending contributes nothing
fs.writeFileSync(path.join(btnRoot1, 'queues', 'boss.node1.queue.md'), '');
const rows2 = queueLib.queueSummaryForBrief({ root: btnRoot1 });
const btnSum2 = queueLib.buttonsSummary(rows2);
ok(btnSum2.count === 1, `buttonsSummary: an empty owner queue does not inflate the count (got ${btnSum2.count})`);

/* ── OQI: what is waiting, not how many bytes ──
 * The count was right and useless — finding out WHAT was waiting meant opening the file and
 * scrolling past two months of blocks, which is the friction that let the items rot. */
const oqi1 = queueLib.ownerQueueItems({ root: btnRoot1 });
ok(oqi1.length === 1 && oqi1[0].role === 'alice' && oqi1[0].from === 'agent',
  `ownerQueueItems: one row per pending block in an owner queue (got ${JSON.stringify(oqi1)})`);
ok(oqi1[0].subject === 'sign this contract',
  `ownerQueueItems: the subject is the block's first line — the convention senders already use (got ${JSON.stringify(oqi1[0].subject)})`);
ok(oqi1[0].ageDays >= 2000 && oqi1[0].ts === oldTs, 'ownerQueueItems: age comes from the block header, not the file mtime');
ok(!oqi1.some(r => r.role === 'dev'), 'ownerQueueItems: a non-owner role is not an owner item');

// A task ref in the header is carried through, and the header shape is the one peekQueueDepth
// counts — so the list and the count can never disagree about what is pending.
fs.appendFileSync(path.join(btnRoot1, 'queues', 'alice.node1.queue.md'),
  '\n## 2026-03-04 05:06 · from planner · task #77\nBUTTON: ship it?\nmore body\n');
const oqi2 = queueLib.ownerQueueItems({ root: btnRoot1 });
ok(oqi2.length === 2 && oqi2[1].task === '77' && oqi2[1].subject === 'BUTTON: ship it?',
  `ownerQueueItems: task ref parsed, body's first line is the subject (got ${JSON.stringify(oqi2[1])})`);
ok(oqi2[0].ts < oqi2[1].ts, 'ownerQueueItems: oldest first — that is what a queue is');
ok(queueLib.peekQueueDepth('alice', { root: btnRoot1 }).pending === oqi2.length,
  'ownerQueueItems: agrees with peekQueueDepth about how many are pending');
// What queueSend writes today: a block id between the sender and the task ref.
queueLib.queueSend('alice', 'BUTTON: renew the domain?', { from: 'planner', root: btnRoot1, node: 'node1', task: '78' });
const oqi3 = queueLib.ownerQueueItems({ root: btnRoot1 });
ok(oqi3.length === 3 && oqi3[2].task === '78' && oqi3[2].from === 'planner' && oqi3[2].subject === 'BUTTON: renew the domain?',
  `ownerQueueItems: a block with an id in its header is listed, sender and task intact (got ${JSON.stringify(oqi3[2])})`);

/* Reading a queue to LOOK at it must not consume it — this project has already had that bug. */
const oqiOffBefore = fs.existsSync(path.join(btnRoot1, '.qstate', 'alice.node1.queue.md.offset'));
queueLib.ownerQueueItems({ root: btnRoot1 });
ok(!oqiOffBefore && !fs.existsSync(path.join(btnRoot1, '.qstate', 'alice.node1.queue.md.offset')),
  'ownerQueueItems: moves no cursor and creates no offset — looking is not consuming');

// Already-delivered blocks are past the cursor and are not waiting on anybody.
fs.mkdirSync(path.join(btnRoot1, '.qstate'), { recursive: true });
fs.writeFileSync(path.join(btnRoot1, '.qstate', 'alice.node1.queue.md.offset'),
  String(fs.statSync(path.join(btnRoot1, 'queues', 'alice.node1.queue.md')).size));
ok(queueLib.ownerQueueItems({ root: btnRoot1 }).length === 0,
  'ownerQueueItems: a queue read to the byte has nothing waiting');
fs.rmSync(btnRoot1, { recursive: true, force: true });

/* ── OW: the buttons that were actually rotting ──
 * The spec was aimed at the owner queue. Measured, that queue was empty; 31 of 143 open tasks
 * belonged to the owner, oldest 80 days, four past deadline. Different surface, same rot. */
const owRoot = mktmp();
core.setHubBase(owRoot);
fs.writeFileSync(path.join(owRoot, 'owner-roles.json'), JSON.stringify(['boss']));
const owToday = '2026-06-10';
const owTasks = [
  { id: 1, status: 'open', assignee: 'boss', project: 'p', created: '2026-04-01 09:00', deadline: '2026-05-01', text: 'decide the thing' },
  { id: 2, status: 'open', owner_kind: 'human', project: 'p', created: '2026-06-01 09:00', text: 'sign' },
  { id: 3, status: 'open', assignee: 'dev', project: 'p', created: '2026-01-01 09:00', text: 'agent work' },
  { id: 4, status: 'done', assignee: 'boss', project: 'p', created: '2026-01-01 09:00', text: 'already decided' },
  { id: 5, status: 'open', assignee: 'boss', project: 'p', text: 'no created stamp' },
];
const ow1 = core.ownerWaiting(owTasks, { today: owToday });
ok(ow1.count === 3, `ownerWaiting: owner_kind OR an assignee in owner-roles, open only (got ${ow1.count})`);
ok(ow1.overdue === 1 && ow1.items.find(r => r.id === 1).overdueDays === 40,
  `ownerWaiting: counts how far past the deadline, not just that it passed (got ${JSON.stringify(ow1.items.find(r => r.id === 1))})`);
ok(ow1.unknownAge === 1 && ow1.items[ow1.items.length - 1].ageDays === null,
  'ownerWaiting: a task with no created stamp is counted but its age is unknown, never guessed as 0');
ok(ow1.oldestDays === ow1.items[0].ageDays && ow1.items[0].id === 1,
  'ownerWaiting: oldest first, and oldestDays ignores the unstamped rows rather than reading them as new');
ok(core.ownerWaiting(owTasks, { today: owToday, limit: 1 }).items.length === 1 &&
   core.ownerWaiting(owTasks, { today: owToday, limit: 1 }).count === 3,
  'ownerWaiting: the limit cuts the list, never the count');
fs.rmSync(owRoot, { recursive: true, force: true });

/* ── LR: the two card checks, and the review that carries them ── */
const lrRoot = mktmp();
core.setHubBase(lrRoot);
fs.writeFileSync(path.join(lrRoot, 'projects', 'titleonly.md'), '# titleonly v1\n');
fs.writeFileSync(path.join(lrRoot, 'projects', 'nodigest.md'),
  '# nodigest\n\n## Next step\nsomething real\n\n## Gates\nby 2026-01-01\n');
fs.writeFileSync(path.join(lrRoot, 'projects', 'fine.md'),
  '# fine\n\n- synced: 2026-06-01 10:00\n\n## Next step\nall good\n');
const lr1 = core.runLint({});
const lrIds = lr1.findings.map(f => f.id + ':' + f.project);
ok(lrIds.includes('card-empty:titleonly'),
  `runLint: a card that is a title and nothing else is a finding (got ${JSON.stringify(lrIds)})`);
ok(lrIds.includes('card-without-digest:nodigest'),
  'runLint: a real card with no digest line is unchecked by every freshness check, and says so');
ok(!lrIds.includes('card-without-digest:titleonly'),
  'runLint: an empty card is not also told it lacks a digest — one remedy per card');
ok(!lrIds.some(x => x.endsWith(':fine')), 'runLint: a card with a digest and sections is clean');
ok(lr1.findings.find(f => f.id === 'card-empty').law && lr1.findings.find(f => f.id === 'card-empty').lawDeclared === false,
  'runLint: a new finding still quotes a rule, and admits the rule is the engine\'s own');

// One per KIND: a plain top-N filled itself with three copies of one rule and pushed the other
// kinds off the list, which teaches its reader less than three different rules would.
fs.writeFileSync(path.join(lrRoot, 'projects', 'titleonly2.md'), '# titleonly2\n');
fs.writeFileSync(path.join(lrRoot, 'projects', 'nodigest2.md'),
  '# nodigest2\n\n## Next step\nalso real\n');
const lrRev = core.runReview({ limit: 2 });
ok(lrRev.total === 4 && lrRev.kinds === 2, `runReview: totals count instances, kinds count rules (got ${JSON.stringify({ t: lrRev.total, k: lrRev.kinds })})`);
ok(lrRev.findings.length === 2 && new Set(lrRev.findings.map(f => f.id)).size === 2,
  'runReview: one finding per kind, so a repeated rule cannot crowd out the others');
ok(lrRev.findings.every(f => f.alsoLikeThis === 1),
  `runReview: says how many more of the same kind it did not print (got ${JSON.stringify(lrRev.findings.map(f => f.alsoLikeThis))})`);
ok(core.runReview({ limit: 1 }).hint === '3 more finding(s) in 1 further kind(s) — hub lint / hub audit for all of them',
  `runReview: a short list says so, in both instances and kinds (got ${JSON.stringify(core.runReview({ limit: 1 }).hint)})`);
ok(core.runReview({ limit: 0 }).findings.length === 0 && core.runReview({ limit: 0 }).total === 4,
  'runReview: limit 0 turns the block off without blinding the count');

/* It files NOTHING. The spec wanted a finding older than 7 days applied automatically under
 * "auditor-ambient" — an agent writing a verdict nobody reached. hub audit --apply still files,
 * with a caller's name on it; the passenger only reports. */
const lrTasksBefore = core.loadTasks().tasks.length;
core.runReview({ limit: 3 });
core.runBrief({});
ok(core.loadTasks().tasks.length === lrTasksBefore,
  'runReview: rides on brief and files nothing — an unanswered finding is not thereby decided');
const lrBrief = core.runBrief({});
ok(lrBrief.review && lrBrief.review.total === 4, 'runBrief: carries the review block on a call somebody was going to make anyway');
fs.rmSync(lrRoot, { recursive: true, force: true });

// ── ghost queues: never consumed, never deleted ──
const QG = mktmp();
fs.mkdirSync(path.join(QG, 'queues'), { recursive: true });
fs.mkdirSync(path.join(QG, '.qstate'), { recursive: true });
fs.writeFileSync(path.join(QG, 'owner-roles.json'), '["boss"]');
const oldMsg = '\n## 2026-01-02 10:00 · from alice\nancient\n';
fs.writeFileSync(path.join(QG, 'queues', 'ghost.n1.queue.md'), oldMsg);
fs.writeFileSync(path.join(QG, 'queues', 'live.n1.queue.md'), oldMsg);
fs.writeFileSync(path.join(QG, '.qstate', 'live.n1.queue.md.offset'), '0');   // a registered consumer that has not drained yet
fs.writeFileSync(path.join(QG, 'queues', 'boss.n1.queue.md'), oldMsg);
fs.mkdirSync(path.join(QG, '.qstate', '__watchall__'), { recursive: true });
fs.writeFileSync(path.join(QG, '.qstate', '__watchall__', 'tapped.n1.queue.md.offset'), '5');
fs.writeFileSync(path.join(QG, 'queues', 'tapped.n1.queue.md'), oldMsg);
core.setHubBase(QG);   // ownerRoles() reads HUB
const inv = queueLib.queueInventory({ root: QG, days: 30 });
const byFile = Object.fromEntries(inv.map(x => [x.file, x]));
ok(byFile['ghost.n1.queue.md'].ghost === true, 'queue gc: a never-consumed old queue is a ghost');
ok(byFile['live.n1.queue.md'].ghost === false, 'queue gc: a queue with a cursor is spared');
ok(byFile['boss.n1.queue.md'].ghost === false, 'queue gc: a human owner queue is spared (a person reads it as a file)');
ok(byFile['tapped.n1.queue.md'].ghost === true, 'queue gc: a __watchall__ tap does not count as having consumed it');
/* ── work dispatched to nobody ──
 * `ghost` needs 30 days, which is right for "archive this" and useless for "did anything
 * happen". A task sent to a role with no consumer running reports success, and the hub looks
 * busy while nothing is happening: two roles on one hub were sent work twice in an afternoon
 * and it just sat, noticed hours later only because a third agent wrote "REPEATED ESCALATION"
 * in prose. So the same predicate without the age gate, reported separately. */
const strandNow = '\n## ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' · from alice\nfresh work\n';
fs.writeFileSync(path.join(QG, 'queues', 'nobodyhome.n1.queue.md'), strandNow);
fs.writeFileSync(path.join(QG, 'queues', 'empty.n1.queue.md'), '');
const stranded = queueLib.strandedQueues({ root: QG, days: 30 });
const strandedRoles = stranded.map(x => x.role);
ok(strandedRoles.includes('nobodyhome'),
  `strandedQueues: fresh messages with no consumer and no presence are reported at once (got ${strandedRoles.join(', ')})`);
ok(!strandedRoles.includes('live'),
  'strandedQueues: a queue with a cursor is not stranded — something is reading it');
ok(!strandedRoles.includes('boss'),
  'strandedQueues: an owner button is not stranded — a person is meant to be the slow part');
ok(!strandedRoles.includes('empty'),
  'strandedQueues: an empty file holds no message, so there is nothing to strand');
ok(!strandedRoles.includes('ghost'),
  'strandedQueues: an old one belongs to queue gc, not here — the two lists never double-count');
/* One number covered two unrelated situations. 2811 messages "nothing here has taken" reads as
 * 2811 dropped pieces of work; 2718 of them were in queues written to within the day, which a dead
 * role does not do — and cursors are node-local, so a queue fed here and drained on another node
 * looks from here exactly like one addressed to nobody. Split on the one local piece of evidence:
 * is anything still ARRIVING. */
fs.writeFileSync(path.join(QG, 'queues', 'wentquiet.n1.queue.md'),
  '\n## ' + new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 16).replace('T', ' ') + ' · from alice\nold work\n');
const strandDoc = run('doctor', { HUBD_DIR: QG, HUBD_TEAM_DIR: QG });
ok(/1 message\(s\) in 1 queue\(s\) nobody took, and nothing new has arrived in 7d {2}WARNING/.test(strandDoc.out),
  'doctor: a queue that has gone quiet with work still in it is the one that warns');
ok(/1 message\(s\) in 1 queue\(s\) with no cursor HERE, still being written to/.test(strandDoc.out) &&
   /NOT a backlog/.test(strandDoc.out),
  'doctor: a queue still being fed is reported as unverifiable from here, not as dropped work');
/* The claim has to be bounded. Cursors live in .qstate/ and presence in presence/, neither of
 * which is mesh-synced, so this node cannot see a consumer running on another one — and the
 * numbers really do diverge: 473 messages looked untaken from a laptop, 53 from the node whose
 * consumers actually hold the cursors. Printing the caveat is what keeps the line honest. */
ok(/cursors and presence are node-local/.test(strandDoc.out),
  'doctor: and says out loud that a consumer on another node is invisible from here');
ok(!/and \d+ more/.test(strandDoc.out.split('nobody took')[1].split('still being written to')[0]),
  'doctor: the quiet list is printed whole — it was the decidable tail that used to be truncated');
fs.rmSync(path.join(QG, 'queues', 'nobodyhome.n1.queue.md'));
fs.rmSync(path.join(QG, 'queues', 'wentquiet.n1.queue.md'));
fs.rmSync(path.join(QG, 'queues', 'empty.n1.queue.md'));

/* ── a purged queue must not re-deliver what survived it ──
 * Cursors are byte offsets, and a shrunken file used to reset them to 0 — right for a file that
 * was RECREATED, wrong for one that was PURGED. Purging is routine: two commits on one mesh
 * removed 15531 and 13422 lines of consumed messages, because the files had grown past fifteen
 * thousand lines and hubd has no compaction. Every surviving block was then delivered again,
 * silently, to workers whose contract is at-most-once. See docs/queue-invariant.md. */
const WM = mktmp();
fs.mkdirSync(path.join(WM, 'queues'), { recursive: true });
fs.mkdirSync(path.join(WM, '.qstate'), { recursive: true });
const wmQ = path.join(WM, 'queues', 'w.n1.queue.md');
const wmOff = path.join(WM, '.qstate', 'w.n1.queue.md.offset');
const blk = (ts, txt) => `\n## ${ts} · from alice\n${txt}\n`;
fs.writeFileSync(wmQ, blk('2026-09-01 10:00', 'one') + blk('2026-09-01 10:01', 'two'));
const wmFirst = await queueLib.queueWait('w', { timeout: 0, root: WM });
ok(wmFirst.changed && /one/.test(wmFirst.text) && /two/.test(wmFirst.text),
  'watermark: a first drain delivers everything');
const wmCur = fs.readFileSync(wmOff, 'utf8');
ok(/^\d+\n## 2026-09-01 10:01 · from alice\n?$/.test(wmCur),
  `cursor file: offset on line 1, the last delivered header on line 2 (got ${JSON.stringify(wmCur)})`);
/* Format-compatible on purpose: every existing reader does parseInt(trim(contents)), parseInt
 * stops at the first non-digit, so an older hubd on the same node still reads the offset. */
ok(parseInt(wmCur.trim(), 10) === fs.statSync(wmQ).size,
  'cursor file: an old reader parseInt()s it to exactly the byte offset, ignoring the watermark');

// PURGE: drop the first block, keep the second — the watermark is still in the file.
fs.writeFileSync(wmQ, blk('2026-09-01 10:01', 'two'));
ok(!(await queueLib.queueWait('w', { timeout: 0, root: WM })).changed,
  'watermark: after a purge that kept the last delivered block, nothing is re-delivered');
ok(parseInt(fs.readFileSync(wmOff, 'utf8').trim(), 10) === fs.statSync(wmQ).size,
  'watermark: and the cursor resumes at the end of that block, not at 0');
fs.appendFileSync(wmQ, blk('2026-09-01 10:02', 'three'));
const wmNext = await queueLib.queueWait('w', { timeout: 0, root: WM });
ok(wmNext.changed && /three/.test(wmNext.text) && !/two/.test(wmNext.text),
  'watermark: the next append is delivered, and only it');

// PURGE PAST the watermark: it went too, so every remaining block postdates it.
fs.writeFileSync(wmQ, blk('2026-09-01 11:00', 'later'));
const wmAfter = await queueLib.queueWait('w', { timeout: 0, root: WM });
ok(wmAfter.changed && /later/.test(wmAfter.text),
  'watermark: when the watermark itself was purged, what remains is newer and IS delivered');

/* A repeated header is possible — timestamps are minute-resolution, so one sender can write two
 * identical ones. Take the LAST, erring toward delivering less rather than twice. */
fs.writeFileSync(wmQ, blk('2026-09-02 09:00', 'dup') + blk('2026-09-02 09:00', 'dup'));
fs.writeFileSync(wmOff, `${fs.statSync(wmQ).size}\n## 2026-09-02 09:00 · from alice\n`);
fs.writeFileSync(wmQ, blk('2026-09-02 09:00', 'dup') + blk('2026-09-02 09:00', 'dup') + blk('2026-09-02 09:05', 'new'));
fs.writeFileSync(wmOff, `999999\n## 2026-09-02 09:00 · from alice\n`);
const wmDup = await queueLib.queueWait('w', { timeout: 0, root: WM });
ok(!wmDup.changed || !/dup/.test(wmDup.text),
  'watermark: a repeated header resolves to its LAST occurrence, so nothing already seen repeats');

/* A cursor written before 0.9.9 has no watermark. Behaviour is unchanged — reset to 0 — but it is
 * now disclosed instead of silent, because there is genuinely no information to do better with. */
fs.writeFileSync(wmQ, blk('2026-09-03 08:00', 'legacy-a') + blk('2026-09-03 08:01', 'legacy-b'));
fs.writeFileSync(wmOff, '999999');
const trims = queueLib.outOfBandTrims({ root: WM });
ok(trims.length === 1 && trims[0].file === 'w.n1.queue.md' && trims[0].hasMark === false,
  `outOfBandTrims: a cursor past the end of its file is found, and its missing watermark noted (got ${JSON.stringify(trims)})`);
const wmLegacy = await queueLib.queueWait('w', { timeout: 0, root: WM });
ok(wmLegacy.changed && /legacy-a/.test(wmLegacy.text),
  'watermark: with no watermark there is nothing to do better than restart from 0');
ok(queueLib.outOfBandTrims({ root: WM }).length === 0,
  'outOfBandTrims: a healthy cursor is not reported');
const wmDoc = run('doctor', { HUBD_DIR: WM, HUBD_TEAM_DIR: WM });
fs.writeFileSync(wmOff, '999999');
ok(/trimmed outside hubd {2}WARNING/.test(run('doctor', { HUBD_DIR: WM, HUBD_TEAM_DIR: WM }).out),
  'doctor: names queue files trimmed outside hubd');
ok(/NO watermark — will restart from 0/.test(run('doctor', { HUBD_DIR: WM, HUBD_TEAM_DIR: WM }).out),
  'doctor: and says which of them will re-deliver, rather than letting it happen quietly');
fs.rmSync(WM, { recursive: true, force: true });

// this node's own shard (the tests run as node "cedar"), and an empty one of its own
fs.writeFileSync(path.join(QG, 'queues', 'ghost.cedar.queue.md'), oldMsg);
fs.writeFileSync(path.join(QG, 'queues', 'hollow.cedar.queue.md'), '');
const qgOld = new Date(Date.now() - 60 * 86400000);
fs.utimesSync(path.join(QG, 'queues', 'hollow.cedar.queue.md'), qgOld, qgOld);
const gcDry = queueLib.runQueueGc({ root: QG, days: 30 });
ok(gcDry.apply === false && fs.existsSync(path.join(QG, 'queues', 'ghost.cedar.queue.md')),
  'queue gc: the dry run moves nothing');
ok(gcDry.held.map(h => h.file).join() === 'hollow.cedar.queue.md' && /no message/.test(gcDry.held[0].why),
  `queue gc: an empty file is held back, with its reason; with no git mesh every other ghost is this node's to move (${gcDry.held.map(h => h.file)})`);
// who may move what, in a mesh: own shards and writerless ones, never a live node's, never an empty file
const liveSet = new Set(['cedar', 'n1']);
ok(/still writes to the mesh/.test(core.shardHold('n1', 2, liveSet)) && core.shardHold('Cedar', 2, liveSet) === null &&
  core.shardHold('gone', 2, liveSet) === null && core.shardHold(null, 2, liveSet) === null && /no message/.test(core.shardHold('cedar', 0, liveSet)) &&
  core.shardHold('n1', 2, null) === null,
  'shardHold: a live node\'s shard is held; this node\'s (any case), a gone node\'s, a node-less one move; an empty one never');
const gcRun = queueLib.runQueueGc({ root: QG, days: 30, apply: true });
ok(gcRun.moved.sort().join() === 'ghost.cedar.queue.md,ghost.n1.queue.md,tapped.n1.queue.md' && !fs.existsSync(path.join(QG, 'queues', 'ghost.cedar.queue.md')) &&
  fs.existsSync(path.join(QG, 'queues', 'hollow.cedar.queue.md')),
  `queue gc: apply archives the ghosts that hold a message and leaves the empty one (moved ${gcRun.moved})`);
ok(fs.readFileSync(path.join(QG, 'queues', 'archive', 'ghost.cedar.queue.md'), 'utf8') === oldMsg,
  'queue gc: archived content is byte-identical — moved, never deleted');
ok(fs.existsSync(path.join(QG, 'queues', 'live.n1.queue.md')) && fs.existsSync(path.join(QG, 'queues', 'boss.n1.queue.md')),
  'queue gc: live and owner queues stay put');
ok(queueLib.queueSummaryForBrief({ root: QG }).find(r => r.role === 'live').neverRead === false,
  'brief: a consumed role is not flagged never-read');

// ── a queue message can say which task it is about ──
const QT = mktmp();
fs.mkdirSync(path.join(QT, 'queues'), { recursive: true });
core.setHubBase(QT);
queueLib.queueSend('worker', 'HOLD: waiting on the owner', { from: 'dev-t', root: QT, task: 'pine-3', node: 'n1' });
queueLib.queueSend('worker', 'unrelated', { from: 'dev-t', root: QT, node: 'n1' });
const qtText = fs.readFileSync(path.join(QT, 'queues', 'worker.n1.queue.md'), 'utf8');
ok(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from dev-t(?: · id \d+)? · task #pine-3$/m.test(qtText),
  'queue task ref: stamped after the sender, so the header pattern every reader uses still matches');
ok(queueLib.peekQueueDepth('worker', { root: QT }).pending === 2,
  'queue task ref: the existing depth reader is unaffected by the extra field');
ok(queueLib.parseTaskRefs(qtText).join(',') === 'pine-3', 'queue task ref: parsed back out of delivered text');
const qtWait = await queueLib.queueWait('worker', { timeout: 0, root: QT });
ok(qtWait.changed && qtWait.tasks && qtWait.tasks[0] === 'pine-3',
  'queue task ref: the consumer is told which task the message is about');

/* ── a cursor that cannot be written must be LOUD, never "nothing new" ──
 * Field measurement 2026-09-14: four live roles, 12-43 KB of orders each,
 * undelivered for a day. Every wait answered NO_CHANGES, every send answered delivered, every role
 * logged "queue empty". Cause: a root-run command left a root-owned cursor and the role — another
 * user — could not advance it, which drainFile caught exactly like a busy lock. */
if (process.getuid && process.getuid() !== 0) {
  const QS = mktmp();
  fs.mkdirSync(path.join(QS, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(QS, '.qstate'), { recursive: true });
  core.setHubBase(QS);
  queueLib.queueSend('stuck', 'order one', { from: 'orch', root: QS, node: 'n1' });
  ok((await queueLib.queueWait('stuck', { timeout: 0, root: QS })).changed, 'stall: setup — the first order is delivered normally');
  queueLib.queueSend('stuck', 'order two, sent while the cursor is read-only', { from: 'orch', root: QS, node: 'n1' });
  const offFile = path.join(QS, '.qstate', 'stuck.n1.queue.md.offset');
  fs.chmodSync(offFile, 0o444);
  let stallErr = null;
  try { await queueLib.queueWait('stuck', { timeout: 0, root: QS }); } catch (e) { stallErr = e; }
  ok(stallErr && stallErr.name === 'QueueStalled',
    `stall: a wait on an unwritable cursor throws instead of reporting NO_CHANGES (got ${stallErr ? stallErr.name : 'no error'})`);
  ok(stallErr && /silently held forever/.test(stallErr.message) && /chmod/.test(stallErr.message),
    'stall: the error says what it costs and how to fix it');
  ok(queueLib.queueInventory({ root: QS }).find(x => x.file === 'stuck.n1.queue.md').stalled === 'EACCES',
    'stall: the inventory doctor reads carries it too, so it is visible without waiting');
  // A second role in the same hub stays deliverable: one broken cursor must not hide the rest.
  queueLib.queueSend('fine', 'unrelated order', { from: 'orch', root: QS, node: 'n1' });
  const okRole = await queueLib.queueWait('fine', { timeout: 0, root: QS });
  ok(okRole.changed && /unrelated order/.test(okRole.text), 'stall: another role in the same hub still delivers');
  fs.chmodSync(offFile, 0o644);
  const recovered = await queueLib.queueWait('stuck', { timeout: 0, root: QS });
  ok(recovered.changed && /order two/.test(recovered.text), 'stall: once writable, the held order is delivered — nothing was lost');
  // A marker left by a process that is gone is litter, and it used to stay forever.
  const waiter = path.join(QS, '.qstate', 'stuck.waiter');
  fs.writeFileSync(waiter, JSON.stringify({ pid: 999999, since: new Date().toISOString() }));
  await queueLib.queueWait('stuck', { timeout: 0, root: QS });
  ok(!fs.existsSync(waiter), 'stall: a waiter marker whose process is dead is cleared, not reported as a competitor');
  fs.rmSync(QS, { recursive: true, force: true });
}

// ── delivered vs pending, across hosts, in one answer ──
const QL = mktmp();
fs.mkdirSync(path.join(QL, 'queues'), { recursive: true });
fs.mkdirSync(path.join(QL, '.qstate'), { recursive: true });
core.setHubBase(QL);
queueLib.queueSend('w', 'one', { from: 'dev-t', root: QL, node: 'hostA' });
// multi-byte on purpose (— is 3 bytes, · is 2): a cursor counts BYTES, so slicing the file as
// a JS string instead of a Buffer would miscount delivered/pending on any non-ASCII message.
queueLib.queueSend('w', 'two — a multi-byte dash · and a bullet', { from: 'dev-t', root: QL, node: 'hostA' });
queueLib.queueSend('w', 'three', { from: 'dev-t', root: QL, node: 'hostB' });
const drained = await queueLib.queueWait('w', { timeout: 0, root: QL });   // consumes hostA + hostB
ok(drained.changed, 'ledger: setup consumed the queue');
queueLib.queueSend('w', 'four, arrived after the read', { from: 'dev-t', root: QL, node: 'hostA' });
const led = queueLib.queueLedger({ root: QL }).roles.find(x => x.role === 'w');
ok(led.total === 4 && led.delivered === 3 && led.pending === 1,
  `ledger: totals are aggregated across hosts (${JSON.stringify({ t: led.total, d: led.delivered, p: led.pending })})`);
ok(led.files.length >= 2 && led.files.every(f => f.total === f.delivered + f.pending),
  'ledger: every per-host file reconciles on its own too');

// ── never create a SECOND spelling of a queue file that already exists ───────
/* Two spellings of one host ("Pine" from a raw hostname, "pine" through JOURNAL_NODE) became
 * two tracked paths, and on a case-insensitive filesystem two paths differing only by case are one
 * file for two index entries. git can satisfy one; `git add -A` stages nothing for the other; every
 * merge that must write it refuses. One node sat 228 commits outside its own mesh while its sync
 * retried every 60 seconds. Readers were always fine — that was the part checked at the time. */
const QCOL = mktmp();
fs.mkdirSync(path.join(QCOL, 'queues'), { recursive: true });
const qcolDir = path.join(QCOL, 'queues');
fs.writeFileSync(path.join(qcolDir, 'hv.Pine.queue.md'), '\n## 2026-09-01 10:00 · from orchestrator\nlegacy\n');
/* The assertion is on the INVARIANT, not on the spelling that comes back. Where the filesystem is
 * case-insensitive the OS already collapses the two names, so `exact` matches and the requested
 * spelling is returned — and it is the same file. Where it is case-sensitive the scan finds the
 * existing name. Both answers satisfy "one file per role and node"; only that is worth asserting,
 * and only case-sensitive nodes can create the pair in the first place. */
/* The decision itself, as a pure function over a list of names — the only way this branch can be
 * tested here at all. On a case-insensitive filesystem the OS collapses the two names, so every
 * filesystem-level assertion below passes with the guard removed entirely; the nodes that actually
 * take this branch are the case-sensitive ones, and they are not the ones running these tests. */
ok(queueLib.pickExistingVariant(['hv.Pine.queue.md', 'other.x.queue.md'], 'hv.pine.queue.md') === 'hv.Pine.queue.md',
  'pickExistingVariant: finds the spelling already on disk');
ok(queueLib.pickExistingVariant(['hv.pine.queue.md'], 'hv.pine.queue.md') === null,
  'pickExistingVariant: the exact name is not a variant of itself');
ok(queueLib.pickExistingVariant(['hv.fir.queue.md', 'hvx.pine.queue.md'], 'hv.pine.queue.md') === null,
  'pickExistingVariant: a different node or role is never treated as a case-variant');
ok(queueLib.pickExistingVariant([], 'hv.pine.queue.md') === null,
  'pickExistingVariant: an empty queues dir yields the canonical name');

const qcolProbe = path.join(qcolDir, 'CaseProbe'); fs.writeFileSync(qcolProbe, '');
const qcolInsensitive = fs.existsSync(path.join(qcolDir, 'caseprobe'));
fs.rmSync(qcolProbe);
ok(path.basename(queueLib.resolveQueueFile(qcolDir, 'hv', 'pine')) ===
   (qcolInsensitive ? 'hv.pine.queue.md' : 'hv.Pine.queue.md'),
  'resolveQueueFile: resolves to the file that already exists, whatever this filesystem calls it');
ok(path.basename(queueLib.resolveQueueFile(qcolDir, 'hv', 'fir')) === 'hv.fir.queue.md',
  'resolveQueueFile: a genuinely different node still gets its own file');
ok(path.basename(queueLib.resolveQueueFile(qcolDir, 'other', 'pine')) === 'other.pine.queue.md',
  'resolveQueueFile: a different role is not confused with one that exists');
queueLib.queueSend('hv', 'sent after the rename', { from: 'dev-t', root: QCOL, node: 'pine' });
const qcFiles = fs.readdirSync(qcolDir).filter(f => /^hv\./i.test(f)).sort();
ok(qcFiles.length === 1 && qcFiles[0] === 'hv.Pine.queue.md',
  `queueSend: appends to the existing file instead of creating a colliding pair (got ${qcFiles.join(', ')})`);
ok(fs.readFileSync(path.join(qcolDir, 'hv.Pine.queue.md'), 'utf8').includes('sent after the rename'),
  'queueSend: and the message really landed there');
/* The other creation site, and the easier one to miss because waiting looks read-only: queueWait
 * touches its own node's file so a fresh waiter has something to track. Named for THIS node's
 * identity with the case flipped, which is exactly the shape the incident had. */
const qcolOwn = core.JOURNAL_NODE;
const qcolFlipped = qcolOwn.charAt(0).toUpperCase() + qcolOwn.slice(1);
fs.writeFileSync(path.join(qcolDir, `hv3.${qcolFlipped}.queue.md`), '');
await queueLib.queueWait('hv3', { root: QCOL, timeout: 0, subscriber: 'x' });
const qcW = fs.readdirSync(qcolDir).filter(f => /^hv3\./i.test(f));
ok(qcW.length === 1,
  `queueWait: waiting does not create a second spelling either (got ${qcW.join(', ')})`);

// ── a role's queue as a view on its tasks ──
const WK = mktmp();
core.setHubBase(WK);
{
  fs.mkdirSync(path.join(WK, 'queues'), { recursive: true });
  const a1 = core.runTaskAdd({ project: 'p', text: 'first job\nwith a brief', assignee: 'w1', importance: 'high', by: 'dev-t' }).task.id;
  const a2 = core.runTaskAdd({ project: 'p', text: 'second job', assignee: 'w1', by: 'dev-t' }).task.id;
  const a3 = core.runTaskAdd({ project: 'p', text: 'after the first', assignee: 'w1', depends_on: [a1], by: 'dev-t' }).task.id;
  core.runTaskAdd({ project: 'p', text: 'someone else\'s', assignee: 'w2', by: 'dev-t' });
  const w1 = await queueLib.queueWait('w1', { timeout: 0, root: WK, work: true });
  ok(w1.changed && w1.offered.join(',') === [a1, a2].join(',') && !w1.work.some(w => w.id === a3),
    'work: the view is the role\'s ready tasks, most urgent first — a task waiting on an open one is not offered');
  const w2 = await queueLib.queueWait('w1', { timeout: 0, root: WK, work: true });
  ok(w2.changed && w2.offered.includes(a1), 'work: reading the view consumes nothing — a turn that did nothing with a task gets it again');
  core.runClaim({ task: a1, agent: 'w1', ttlMin: 30 });
  core.runClaim({ task: a2, agent: 'w1', ttlMin: 30 });
  const w3 = await queueLib.queueWait('w1', { timeout: 0, root: WK, work: true });
  ok(!w3.changed, 'work: a started (claimed) task is in progress and does not wake the role again');
  const db = core.loadClaims(); for (const c of db.claims) if (c.area === core.taskClaimArea(a1)) c.since = '2020-01-01 00:00';
  fs.writeFileSync(path.join(WK, 'claims.json'), JSON.stringify(db));
  const w4 = await queueLib.queueWait('w1', { timeout: 0, root: WK, work: true });
  ok(w4.changed && w4.offered.join(',') === String(a1), 'work: when the claim lapses — a dead session, an abandoned turn — the task is offered again');
  queueLib.queueSend('w1', 'clarification: use the staging db', { from: 'head-x', root: WK, node: 'n1', task: String(a2) });
  queueLib.queueSend('w1', 'ORDER: do the second job now', { from: 'head-x', root: WK, node: 'n1', task: String(a2) });
  core.runTaskUpdate({ id: a2, status: 'done', by: 'head-x' });   // the cancellation
  queueLib.queueSend('w1', 'general note, no task', { from: 'head-x', root: WK, node: 'n1' });
  const w5 = await queueLib.queueWait('w1', { timeout: 0, root: WK, work: true });
  ok(w5.changed && !/second job now/.test(w5.text) && /general note/.test(w5.text) && w5.skipped.length === 2 && w5.skipped[0].status[0] === 'done',
    'work: an order about a task that was closed meanwhile is held back — cancelling is closing, and nothing is left to execute');
  queueLib.queueSend('w1', 'note on the first: tests live in ci/', { from: 'head-x', root: WK, node: 'n1', task: String(a1) });
  const view = queueLib.roleWork('w1', { root: WK });
  ok(view.find(w => w.id === a1).messages.some(m => /tests live in ci/.test(m.text)) && view.find(w => w.id === a1).title === 'first job',
    'work: what was said about a task travels with it, and the task carries its short title');
  let ec = null; try { core.runClaim({ task: a2, agent: 'w1' }); } catch (e) { ec = e.message; }
  ok(/nothing to start/.test(ec || ''), 'work: a closed task cannot be started');
  core.runRelease({ task: a1, agent: 'w1' });
  ok(!core.activeClaims(core.loadClaims().claims).some(c => c.area === core.taskClaimArea(a1)), 'work: release --task gives a started task back');
  // without work mode nothing changes: the closed task's order is delivered like any message
  queueLib.queueSend('w9', 'plain order', { from: 'head-x', root: WK, node: 'n1', task: String(a2) });
  const w6 = await queueLib.queueWait('w9', { timeout: 0, root: WK });
  ok(w6.changed && /plain order/.test(w6.text) && !('work' in w6), 'work: a wait without work mode delivers exactly as before');
  const cli = run(`queue work w1 --json`, { HUBD_DIR: WK, HUBD_TEAM_DIR: WK, HUBD_NODE: 'n1' });
  ok(cli.code === 0 && JSON.parse(cli.out).offered.includes(a1), 'work: hub queue work reads the view without waiting');
}
core.setHubBase(T0);

// ── two readers of one work queue, across nodes ──
const RD = mktmp();
core.setHubBase(RD);
{
  core.runResourceSet({ slug: 'rw', type: 'role', attrs: { rank: 'worker', project: 'p' }, by: 'dev-t' });
  core.runHeartbeat({ agent: 'rw', role: 'rw' });
  const nobody = core.queueReaderConflicts();
  ok(!nobody.length, 'readers: one live session of a role is no conflict');
  fs.writeFileSync(path.join(RD, 'presence.n2.json'), JSON.stringify({ node: 'n2', written: core.now(), agents: [{ agent: 'rw', role: 'rw', last_seen: core.now(), ttlMin: 15, node: 'n2' }] }));
  const two = core.queueReaderConflicts();
  ok(two.length === 1 && two[0].how === 'nodes' && two[0].nodes.join() === 'cedar,n2', `readers: the same role alive on two nodes is two readers (${JSON.stringify(two)})`);
  ok(core.runLint().findings.some(f => f.id === 'two-readers-one-queue' && /alive on 2 nodes/.test(f.what)), 'lint: and a finding');
  const au = core.runAudit({ git: false });
  ok(au.findings.some(f => f.id === 'two-readers-one-queue' && f.key === 'two-readers-one-queue:rw:nodes'), 'audit: and an audit finding with a stable key');
  fs.writeFileSync(path.join(RD, 'subscriber-roles.json'), '["rw"]');
  ok(!core.queueReaderConflicts().length, 'readers: a broadcast role has many readers by design');
}
core.setHubBase(T0);

// ── acks: an acked block leaves the unacked list, and id 1 is not id 12 ──
const AK = mktmp();
{
  for (let i = 1; i <= 12; i++) queueLib.queueSend('ak', 'order ' + i, { from: 'dev-t', root: AK, node: 'n1' });
  await queueLib.queueWait('ak', { root: AK, timeout: 0 });
  ok(queueLib.peekQueueDepthWithAcks('ak', { root: AK }).unacked === 12, 'acks: a delivered block is unacked until acked');
  queueLib.queueAck('ak', 12, { root: AK });
  queueLib.queueAck('ak', '3', { root: AK });
  const u = queueLib.peekQueueDepthWithAcks('ak', { root: AK });
  ok(u.unacked === 10 && !u.unackedBlocks.some(b => b.id === 12 || b.id === 3),
    `acks: an acked block leaves the unacked count, a string id included (it only ever grew; got ${u.unacked})`);
  // a trimmed shard that still holds id 12 but not id 1, read before the shard that holds id 1
  fs.writeFileSync(path.join(AK, 'queues', 'ak2.a.queue.md'), '## 2026-09-01 10:00 · from dev-t · id 12\nlate\n');
  fs.writeFileSync(path.join(AK, 'queues', 'ak2.b.queue.md'), '## 2026-09-01 10:00 · from dev-t · id 1\nfirst\n');
  queueLib.queueAck('ak2', 1, { root: AK });
  ok(!fs.existsSync(path.join(AK, 'queues', 'ak2.a.acks')) && fs.existsSync(path.join(AK, 'queues', 'ak2.b.acks')),
    'acks: id 1 is acked in the shard that holds id 1, not in one that holds id 12');
  let bad = null; try { queueLib.queueAck('ak', 'x1', { root: AK }); } catch (e) { bad = e.message; }
  ok(/positive integer/.test(bad || ''), 'acks: a block id that is not a number is refused, not searched for');
}

// ── the queue from the CLI: a roundtrip, what doctor sees of it, a second waiter, the sender rule ──
{
  const Q = mktmp(), hub = path.join(Q, 'hub'), team = path.join(Q, 'team'); fs.mkdirSync(team);
  const env = { HUBD_DIR: hub, HUBD_TEAM_DIR: team, HUBD_QUEUE_DIR: team };
  const q = (argv, more = {}) => cli(argv, { env: { ...env, ...more }, cwd: team });
  ok(q(['queue', 'send', 'smoketest', 'hello smoke', '--from', 'tester']).code === 0, 'queue send: exit 0');
  const w1 = q(['queue', 'wait', 'smoketest', '--timeout', '0']);
  ok(w1.code === 0 && /hello smoke/.test(w1.out), 'queue wait: delivers what was sent, exit 0');
  const w2 = q(['queue', 'wait', 'smoketest', '--timeout', '0']);
  ok(w2.code === 2 && /NO_CHANGES/.test(w2.out), 'queue wait: a second wait finds nothing, exit 2 and NO_CHANGES');
  // doctor reads the cursor the consumer really writes: a path it never wrote showed the full size
  ok(/smoketest.*pending 0B/.test(q(['doctor']).out), 'doctor: a consumed queue shows pending 0B');
  const bg = spawn(process.execPath, [path.join(REPO, 'hub/cli.mjs'), 'queue', 'wait', 'smoketest', '--timeout', '6'], { env: { ...process.env, ...env }, cwd: team, stdio: 'ignore' });
  const marker = path.join(team, '.qstate', 'smoketest.waiter');
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 50));
  ok(new RegExp(`live waiter: pid ${bg.pid}\\b`).test(q(['doctor']).out), 'doctor: a live waiter is shown with its pid');
  bg.kill(); await new Promise(r => bg.once('exit', r));
  // a second waiter on one cursor is told so, and still waits: the warning is advisory
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  const w3 = q(['queue', 'wait', 'smoketest', '--timeout', '0']);
  ok(/another waiter/i.test(w3.stderr) && (w3.code === 0 || w3.code === 2), 'queue wait: another live waiter is a warning on stderr, and the wait still runs');
  fs.rmSync(marker, { force: true });
  const s0 = q(['queue', 'send', 'smoketest', 'no author'], { HUBD_AGENT: '' });
  ok(s0.code !== 0 && /from required/.test(s0.out), 'queue send: refused without --from or HUBD_AGENT, and the error names the flag');
  ok(q(['queue', 'send', 'smoketest', 'floored'], { HUBD_AGENT: 'dev-smoke' }).code === 0, 'queue send: HUBD_AGENT floors an omitted --from');
}

done();
