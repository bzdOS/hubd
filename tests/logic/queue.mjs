// queue.mjs — queues: depth, buttons, ghosts, task refs, the ledger, spellings, a role's work, two readers, acks, the CLI
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
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
core.setHubBase(qRoot2); core.ensureHubDirs();
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
core.setHubBase(btnRoot1); core.ensureHubDirs();
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
core.setHubBase(owRoot); core.ensureHubDirs();
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
core.setHubBase(lrRoot); core.ensureHubDirs();
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
core.setHubBase(QG); core.ensureHubDirs();   // ownerRoles() reads HUB
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
 * role does not do — and a reader on a hubd from before read marks leaves nothing in the mesh, so a
 * queue fed here and drained on such a node looks from here exactly like one addressed to nobody.
 * Split on the one local piece of evidence: is anything still ARRIVING. */
fs.writeFileSync(path.join(QG, 'queues', 'wentquiet.n1.queue.md'),
  '\n## ' + new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 16).replace('T', ' ') + ' · from alice\nold work\n');
const strandDoc = run('doctor', { HUBD_DIR: QG, HUBD_TEAM_DIR: QG });
ok(/1 message\(s\) in 1 queue\(s\) nobody took, and nothing new has arrived in 7d {2}WARNING/.test(strandDoc.out),
  'doctor: a queue that has gone quiet with work still in it is the one that warns');
ok(/1 message\(s\) in 1 queue\(s\) no node has read, still being written to/.test(strandDoc.out) &&
   /NOT a backlog yet/.test(strandDoc.out),
  'doctor: a queue still being fed is reported as unverifiable from here, not as dropped work');
/* The claim has to be bounded. Presence is not mesh-synced, and a reader on a hubd from before read
 * marks keeps its cursor on its own node — and the numbers really did diverge: 473 messages looked
 * untaken from a laptop, 53 from the node whose consumers held the cursors. Printing the caveat is
 * what keeps the line honest. */
ok(/presence is node-local, and a reader on a hubd from before read marks/.test(strandDoc.out),
  'doctor: and says out loud what a node still cannot see from here');
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

/* ── a failed merge in the hub must not re-deliver ──
 * A sync merged in the live hub dir and stopped on a conflict in other files. While the merge stood
 * open, the queue file held the other side's version, one block longer, and a reader took that
 * block; the abort put the shorter version back, the watermark was not in it, and the cursor fell
 * to 0: the worker got its whole queue again, on every failed run. Here git does the merging, in a
 * real repo used as the hub: open, aborted, tried again, aborted, then made. */
const FM = mktmp();
const fmGit = (args) => execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, { cwd: FM, stdio: 'pipe' });
const fmQ = path.join(FM, 'queues', 'w.n1.queue.md');
const fmBlk = (id) => `\n## 2026-10-01 18:0${id} · from orch · id ${id}\nmessage ${id}\n`;
fs.mkdirSync(path.join(FM, 'queues'), { recursive: true });
fs.writeFileSync(path.join(FM, '.gitignore'), '.qstate/\nqueues/read/\n*.acks\n');
fs.writeFileSync(fmQ, fmBlk(1) + fmBlk(2) + fmBlk(3));
fs.writeFileSync(path.join(FM, 'notes.md'), 'base\n');
fmGit('init -q -b main'); fmGit('add -A'); fmGit('commit -q -m base');
fmGit('checkout -q -b other');
fs.appendFileSync(fmQ, fmBlk(4)); fs.writeFileSync(path.join(FM, 'notes.md'), 'other\n'); fmGit('commit -q -am other');
fmGit('checkout -q main');
fs.writeFileSync(path.join(FM, 'notes.md'), 'local\n'); fmGit('commit -q -am local');
const fmSeen = [];
const fmWait = async () => {
  const r = await queueLib.queueWait('w', { timeout: 0, root: FM });
  const ids = r.changed ? [...r.text.matchAll(/· id (\d+)/g)].map(m => Number(m[1])) : [];
  fmSeen.push(...ids);
  return ids.join();
};
const fmOff = () => parseInt(fs.readFileSync(path.join(FM, '.qstate', 'w.n1.queue.md.offset'), 'utf8'), 10);
const fmMerge = () => { try { fmGit('merge --no-edit -q other'); return 'made'; } catch { return 'conflict'; } };
ok(await fmWait() === '1,2,3', 'failed merge: before it, the queue is read to its end');
ok(fmMerge() === 'conflict' && /message 4/.test(fs.readFileSync(fmQ, 'utf8')),
  'failed merge: the merge stops on a conflict elsewhere, with the longer queue file in the hub');
ok(await fmWait() === '4', 'failed merge: a reader takes the new block while it stands open, and only that block');
fmGit('merge --abort');
const fmShort = fs.statSync(fmQ).size;
const fmAbort = await fmWait();
ok(fmAbort === '', `failed merge: after the abort put the shorter file back, nothing is handed out again (got ${fmAbort})`);
ok(fmOff() === fmShort, `failed merge: and the cursor is at the end of that file, not at 0 (got ${fmOff()} of ${fmShort})`);
ok(fmMerge() === 'conflict' && await fmWait() === '',
  'failed merge: the next failed try hands out nothing — its one new block was had the first time');
fmGit('merge --abort');
ok(await fmWait() === '' && fmOff() === fmShort, 'failed merge: nor does its abort');
fmMerge(); fs.writeFileSync(path.join(FM, 'notes.md'), 'merged\n'); fmGit('commit -q -am merged');
ok(await fmWait() === '', 'failed merge: the merge that is made hands out nothing new');
fs.appendFileSync(fmQ, fmBlk(5));
ok(await fmWait() === '5', 'failed merge: and the block after it is delivered, alone');
ok(fmSeen.join() === '1,2,3,4,5', `failed merge: every block was delivered exactly once (got ${fmSeen})`);
// What the watermark's id does NOT cover: a file that holds nothing it has seen is delivered whole.
const fmAt = async (file, cursor) => {
  fs.writeFileSync(fmQ, file);
  fs.writeFileSync(path.join(FM, '.qstate', 'w.n1.queue.md.offset'), cursor);
  return fmWait();
};
const fmMark = '## 2026-10-01 18:04 · from orch · id 4';
const fmLater = (id) => `\n## 2026-10-02 09:0${id} · from orch · id ${id}\nmessage ${id}\n`;
ok(await fmAt(fmLater(1) + fmLater(2), `999999\n${fmMark}\n`) === '1,2',
  'shrunk: a file recreated with its ids from 1 again, written after the watermark, is delivered whole');
ok(await fmAt(fmBlk(5) + fmBlk(6), `999999\n${fmMark}\n`) === '5,6',
  'shrunk: a purge that took the watermark with it leaves only newer ids, and they are delivered');
const fm123 = fmBlk(1) + fmBlk(2) + fmBlk(3);
ok(await fmAt(fm123 + fmBlk(4) + fmBlk(5), `${Buffer.byteLength(fm123)}\n${fmMark}\n`) === '5',
  'ahead: with the watermark past the cursor, the blocks up to it are skipped and the one after it delivered');
const fmLegacy = (n) => `\n## 2026-10-01 18:0${n} · from orch\nlegacy ${n}\n`;
fs.writeFileSync(fmQ, fmLegacy(1) + fmLegacy(2));
fs.writeFileSync(path.join(FM, '.qstate', 'w.n1.queue.md.offset'), `0\n## 2026-10-01 18:01 · from orch\n`);
const fmNoId = await queueLib.queueWait('w', { timeout: 0, root: FM });
ok(fmNoId.changed && /legacy 1/.test(fmNoId.text) && /legacy 2/.test(fmNoId.text),
  'ahead: a watermark without an id is not trusted to skip anything');

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
/* A node is live by its own files, whatever name its commits carry: mesh-sync commits under the
 * hostname unless HUBD_NODE is set where it runs. Node pine syncs as "pine-box", has no presence
 * snapshot, and wrote its journal today; node gone wrote its last line two months ago. */
{
  const prevHub = core.HUB, LM = mktmp();
  execSync('git init -q', { cwd: LM });
  core.setHubBase(LM); core.ensureHubDirs(); fs.mkdirSync(path.join(LM, 'queues'));
  const line = (ts) => JSON.stringify({ ts, project: 'p', agent: 'a', kind: 'note', text: 'x' }) + '\n';
  fs.writeFileSync(path.join(LM, 'journal.pine.jsonl'), line('2026-01-01 10:00') + line(core.now()));
  fs.writeFileSync(path.join(LM, 'journal.gone.jsonl'), line('2026-01-01 10:00'));
  fs.writeFileSync(path.join(LM, 'queues', 'ghost.pine.queue.md'), '## 2026-01-01 10:00 · from x\n\nold\n');
  fs.writeFileSync(path.join(LM, 'queues', 'recent.fir.queue.md'), `## ${core.now()} · from x\n\nnew\n`);
  execSync('git add -A && git -c user.name=pine-box -c user.email=m@m commit -q -m seed', { cwd: LM });
  const lm = core.liveMeshNodes({ root: LM, days: 30 });
  ok(lm.has('pine') && lm.has('fir') && !lm.has('gone'),
    `liveMeshNodes: a node whose journal or a queue shard of its name has a recent stamp is live, one whose newest line is old is not (${[...lm].sort()})`);
  ok(/still writes to the mesh/.test(core.shardHold('pine', 1, lm)), 'liveMeshNodes: so the idle shard of a live node under another commit name is held');
  core.setHubBase(prevHub);
}
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
core.setHubBase(QT); core.ensureHubDirs();
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
  core.setHubBase(QS); core.ensureHubDirs();
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
core.setHubBase(QL); core.ensureHubDirs();
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
core.setHubBase(WK); core.ensureHubDirs();
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
core.setHubBase(T0); core.ensureHubDirs();

// ── two readers of one work queue, across nodes ──
const RD = mktmp();
core.setHubBase(RD); core.ensureHubDirs();
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
core.setHubBase(T0); core.ensureHubDirs();

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

// ── read marks: every node counts what the role's reader read ──
/* Measured on a live mesh: one role, 71 messages; the node that wrote them said 44 pending, the node
 * that read them said 0. A cursor never leaves its node; a read mark does. Two roots stand in for
 * two nodes, the reader runs as a process with the other node's name, and copying queues/ across is
 * what the mesh does. Each test below fails if the mark, or the merge on read, is taken out. */
{
  const A = mktmp(), B = mktmp();
  const sync = (from, to) => fs.cpSync(path.join(from, 'queues'), path.join(to, 'queues'), { recursive: true });
  const asNode = (root, node) => ({ env: { HUBD_DIR: path.join(root, 'hub'), HUBD_TEAM_DIR: root, HUBD_QUEUE_DIR: root, HUBD_NODE: node }, cwd: root });
  const F = 'rm.cedar.queue.md';
  for (let i = 1; i <= 5; i++) queueLib.queueSend('rm', 'order ' + i, { from: 'dev-t', root: A, node: 'cedar' });
  sync(A, B);
  const w = cli(['queue', 'wait', 'rm', '--timeout', '0'], asNode(B, 'fir'));
  ok(w.code === 0 && /order 5/.test(w.out), 'read marks: setup — the reader on the other node took all five');
  ok(fs.existsSync(path.join(B, 'queues', 'read', 'rm.fir.json')), 'read marks: the reader publishes its position under its own node name');
  sync(B, A);
  const la = queueLib.queueLedger({ root: A, role: 'rm' }).roles[0], lb = queueLib.queueLedger({ root: B, role: 'rm' }).roles[0];
  ok(la.delivered === 5 && la.pending === 0,
    `read marks: the writing node no longer counts as pending what was read on another (got ${la.delivered} delivered, ${la.pending} pending)`);
  ok(la.delivered === lb.delivered && la.pending === lb.pending, 'read marks: and both nodes count the same');
  const fa = la.files.find(f => f.file === F);
  ok(fa.readBy === 'fir' && fa.cursor === null, 'read marks: the ledger says which node read it, and that this one holds no cursor');
  ok(queueLib.peekQueueDepth('rm', { root: A }).pending === 0, 'read marks: the depth a sender is shown agrees');
  ok(/read to \d+\/\d+B on fir at /.test(cli(['queue', 'status', 'rm'], asNode(A, 'cedar')).out), 'read marks: queue status names the reading node');
  ok(queueLib.queueInventory({ root: A }).find(x => x.file === F).read, 'read marks: a file read on another node is not a ghost or stranded here');

  // a cursor left here by an earlier reader does not drag the count back: the furthest one wins
  const text = fs.readFileSync(path.join(A, 'queues', F), 'utf8');
  const afterTwo = Buffer.byteLength(text.slice(0, text.indexOf('\n## ', text.indexOf('order 2')) + 1));
  fs.mkdirSync(path.join(A, '.qstate'), { recursive: true });
  fs.writeFileSync(path.join(A, '.qstate', F + '.offset'), String(afterTwo));
  const stale = queueLib.queueLedger({ root: A, role: 'rm' }).roles[0];
  ok(stale.delivered === 5 && stale.files.find(f => f.file === F).cursor === afterTwo,
    `read marks: a stale cursor here is kept for forensics and outranked (got ${stale.delivered} delivered)`);

  // the header is what is trusted, not the offset: trimmed above the mark still reads to the end,
  // recreated with other content does not look read at all
  const C = mktmp(), D = mktmp();
  sync(A, C); sync(A, D);
  fs.writeFileSync(path.join(C, 'queues', F), text.slice(text.indexOf('\n## ', text.indexOf('order 3'))));
  const tc = queueLib.queueLedger({ root: C, role: 'rm' }).roles[0];
  ok(tc.total === 2 && tc.delivered === 2, `read marks: a file trimmed above the mark is still read to its end (got ${tc.delivered}/${tc.total})`);
  fs.writeFileSync(path.join(D, 'queues', F), '\n## 2020-01-01 00:00 · from dev-t · id 1\nanother file now\n' + 'x'.repeat(text.length));
  const td = queueLib.queueLedger({ root: D, role: 'rm' }).roles[0];
  ok(td.delivered === 0 && td.pending === 1, 'read marks: a recreated file under the same name does not inherit the old mark');

  // handing the file out again — a cursor lost on the reader node — writes no second "delivered"
  fs.rmSync(path.join(B, '.qstate', F + '.offset'));
  const again = cli(['queue', 'wait', 'rm', '--timeout', '0'], asNode(B, 'fir'));
  const acks = fs.readFileSync(path.join(B, 'queues', 'rm.cedar.acks'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  ok(/order 1/.test(again.out) && acks.length === 5 && new Set(acks.map(a => a.id)).size === 5,
    `acks: a block handed out twice is delivered once in the log (got ${acks.length} lines)`);
  ok(queueLib.queueLedger({ root: B, role: 'rm' }).roles[0].delivered === 5, 'read marks: and the re-read leaves the position where it was');

  // a tap watches the fleet and reads for nobody: no mark, no ack
  const TP = mktmp();
  queueLib.queueSend('tp', 'watched, not taken', { from: 'dev-t', root: TP, node: 'cedar' });
  const tap = await queueLib.queueWaitAll({ root: TP, timeout: 0 });
  ok(tap.changed && !fs.existsSync(path.join(TP, 'queues', 'read')) && !fs.existsSync(path.join(TP, 'queues', 'tp.cedar.acks')),
    'read marks: a tap leaves no read mark and no ack');
  ok(queueLib.peekQueueDepth('tp', { root: TP }).pending === 1, 'read marks: so what a tap saw is still pending for the role');

  // a broadcast reader is counted per subscriber, from any node
  const S = mktmp(), S2 = mktmp();
  fs.writeFileSync(path.join(S, 'subscriber-roles.json'), '["bc"]');
  fs.writeFileSync(path.join(S2, 'subscriber-roles.json'), '["bc"]');
  queueLib.queueSend('bc', 'to everyone', { from: 'dev-t', root: S, node: 'cedar' });
  await queueLib.queueWait('bc', { root: S, subscriber: 'p1', timeout: 0 });
  sync(S, S2);
  const rd = queueLib.queueLedger({ root: S2, role: 'bc' }).roles[0].readers.find(x => x.subscriber === 'p1');
  ok(rd && rd.behind === 0 && rd.on.join() === 'cedar', `read marks: a subscriber read on another node shows as a reader there (${JSON.stringify(rd)})`);
}

// ── block ids continue past the ack log, and an archived file takes its log with it ──
{
  const I = mktmp();
  for (let i = 1; i <= 3; i++) queueLib.queueSend('ic', 'order ' + i, { from: 'dev-t', root: I, node: 'n1' });
  await queueLib.queueWait('ic', { root: I, timeout: 0 });
  fs.writeFileSync(path.join(I, 'queues', 'ic.n1.queue.md'), '');   // emptied by hand, as a purge does
  queueLib.queueSend('ic', 'after the purge', { from: 'dev-t', root: I, node: 'n1' });
  ok(/· id 4\n/.test(fs.readFileSync(path.join(I, 'queues', 'ic.n1.queue.md'), 'utf8')),
    'ids: a file emptied by hand continues at 4 — a second id 1 would be answered by the old log');
  queueLib.archiveQueueFile(I, 'ic.n1.queue.md');
  ok(fs.existsSync(path.join(I, 'queues', 'archive', 'ic.n1.acks')) && !fs.existsSync(path.join(I, 'queues', 'ic.n1.acks')),
    'archive: the ack log moves with its queue file');
  queueLib.queueSend('ic', 'a new file', { from: 'dev-t', root: I, node: 'n1' });
  ok(/· id 1\n/.test(fs.readFileSync(path.join(I, 'queues', 'ic.n1.queue.md'), 'utf8')), 'archive: and the next file starts over at id 1');
}

// ── a message is prose, not cargo ──
{
  const C = mktmp();
  const b64 = (n) => crypto.randomBytes(n).toString('base64');
  const qfile = path.join(C, 'queues', 'cg.cedar.queue.md');
  const size = () => { try { return fs.statSync(qfile).size; } catch { return 0; } };
  // refused, with the rule in the error, and nothing appended
  const refused = (text, re) => {
    const before = size();
    try { queueLib.queueSend('cg', text, { from: 'dev-t', root: C }); return false; }
    catch (e) { return re.test(e.message) && /prose, not cargo/.test(e.message) && /path, size and sha256sum/.test(e.message) && size() === before; }
  };
  ok(refused(b64(1_700_000), /^message refused: 22\d{5} bytes, over the 16384-byte limit \(HUBD_MSG_MAX\)/),
    'cargo: a 2.3 MB base64 bundle is refused, nothing is appended, and the error names the rule');
  ok(refused('plain words '.repeat(1450), /^message refused: 17399 bytes, over the 16384-byte limit/), 'cargo: 17 KB of plain text is refused');
  ok(refused('Build done, the bundle:\n' + b64(2300) + '\nPlease apply it.', /carries a base64 or hex run of 3068 characters \(line 2\)/),
    'cargo: a 3 KB base64 line inside a normal message is refused, though the message is under the size limit');
  ok(refused('the key:\n' + b64(2300).replace(/(.{76})/g, '$1\n'), /carries a base64 or hex run/), 'cargo: base64 wrapped at 76 columns is one run');
  ok(refused('hex: ' + crypto.randomBytes(1100).toString('hex'), /carries a base64 or hex run of 2200/), 'cargo: a 2.2 KB hex run is refused');
  ok(refused('fix:\ndiff --git a/x.c b/x.c\n--- a/x.c\n+++ b/x.c\n', /carries a git diff \(line 2\)/), 'cargo: a git diff is refused at any size');
  ok(refused('# v2 git bundle\n1f2e3d refs/heads/main\n', /carries a git bundle/), 'cargo: a git bundle header is refused');
  ok(refused('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----', /carries a PEM block/), 'cargo: a PEM block is refused');
  const sent = (text) => { try { queueLib.queueSend('cg', text, { from: 'dev-t', root: C }); return true; } catch { return false; } };
  ok(sent('Dispatch: build the image on your node and report its sha256. '.repeat(32)), 'cargo: a 2 KB dispatch passes');
  ok(sent('bundle at /srv/out/x.bundle, 2318044 bytes, sha256 ' + 'ab12'.repeat(16)), 'cargo: path, size and sha256 — what the rule asks for — pass');
  ok(sent('short token ' + b64(1100) + ' and a ruler\n' + ('='.repeat(80) + '\n').repeat(40)), 'cargo: a 1.5 KB token and a long ruler pass');
  process.env.HUBD_MSG_MAX = '32768';
  ok(sent('plain words '.repeat(1450)), 'cargo: HUBD_MSG_MAX raises the size limit');
  delete process.env.HUBD_MSG_MAX;
  // the same rule for a report and for a task's text
  const err = (f) => { try { f(); return ''; } catch (e) { return e.message; } };
  ok(/^report refused: it carries a git diff/.test(err(() => core.runReport({ project: 'cg', by: 'dev-t', text: 'FACT: built\ndiff --git a/y b/y' }))),
    'cargo: a report carrying a diff is refused');
  ok(/^task text refused: \d+ bytes, over the 16384-byte limit/.test(err(() => core.runTaskAdd({ project: 'cg', by: 'dev-t', text: 'x'.repeat(17000) }))),
    'cargo: a 17 KB task is refused');
  const t = core.runTaskAdd({ project: 'cg', by: 'dev-t', text: 'a task in prose' }).task;
  ok(/^task text refused: it carries a base64/.test(err(() => core.runTaskUpdate({ id: t.id, by: 'dev-t', text: b64(2300) }))),
    'cargo: a task update that pastes base64 into the text is refused');
  ok(err(() => core.runTaskUpdate({ id: t.id, by: 'dev-t', status: 'done' })) === '', 'cargo: an update that leaves the text alone is not checked');
}

// ── a queue nobody reads takes no more ──
{
  const D = mktmp();
  const send = (role, text = 'order', root = D) => { try { queueLib.queueSend(role, text, { from: 'dev-t', root }); return ''; } catch (e) { return e.message; } };
  const blocks = (f) => (fs.readFileSync(path.join(D, 'queues', f), 'utf8').match(/^## /gm) || []).length;
  for (let i = 1; i <= 50; i++) send('dq', 'order ' + i);
  ok(queueLib.unreadLoad('dq', { root: D }).msgs === 50 && blocks('dq.cedar.queue.md') === 50, 'depth: 50 unread messages are taken');
  const e51 = send('dq', 'order 51');
  ok(/^queue full: dq already holds 50 unread message\(s\)/.test(e51) && /HUBD_QUEUE_MAX_MSGS/.test(e51) && /hub queue status dq/.test(e51),
    'depth: the 51st unread message is refused, and the error names the limit and where to look');
  ok(blocks('dq.cedar.queue.md') === 50, 'depth: and nothing was appended');
  await queueLib.queueWait('dq', { root: D, timeout: 0 });
  fs.rmSync(path.join(D, 'queues', 'dq.cedar.acks'));   // the read position alone has to say it
  ok(send('dq', 'order 51') === '', 'depth: once the reader has taken them, the queue takes more');

  // a reader that leaves no mark (a hubd from before read marks) still leaves its acks in the mesh
  for (let i = 1; i <= 50; i++) send('da', 'order ' + i);
  fs.writeFileSync(path.join(D, 'queues', 'da.cedar.acks'),
    Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: i + 1, status: 'delivered', ts: '2026-10-03 10:00' })).join('\n') + '\n');
  ok(queueLib.unreadLoad('da', { root: D }).msgs === 0 && send('da') === '', 'depth: a block the ack log says was handed out is not unread');

  // a broadcast role counts its furthest reader
  fs.writeFileSync(path.join(D, 'subscriber-roles.json'), '["db"]');
  for (let i = 1; i <= 50; i++) send('db', 'news ' + i);
  await queueLib.queueWait('db', { root: D, subscriber: 'p1', timeout: 0 });
  fs.rmSync(path.join(D, 'queues', 'db.cedar.acks'));
  ok(send('db', 'news 51') === '', 'depth: a broadcast role is as full as its furthest reader leaves it');

  process.env.HUBD_QUEUE_MAX_BYTES = '4096';
  ok(send('dbytes', 'b'.repeat(1500)) === '' && send('dbytes', 'b'.repeat(1500)) === '', 'depth: under the byte limit, sends pass');
  ok(/^queue full: dbytes already holds 2 unread message\(s\), \d+ bytes/.test(send('dbytes', 'b'.repeat(1500))),
    'depth: a send that would take the unread bytes past HUBD_QUEUE_MAX_BYTES is refused');
  delete process.env.HUBD_QUEUE_MAX_BYTES;

  fs.writeFileSync(path.join(T0, 'owner-roles.json'), '["downer"]');
  for (let i = 1; i <= 51; i++) send('downer', 'button ' + i);
  ok(queueLib.unreadLoad('downer', { root: D }).msgs === 51, 'depth: an owner role is never refused — a human reads the file, not a loop');
  fs.rmSync(path.join(T0, 'owner-roles.json'));

  process.env.HUBD_QUEUE_MAX_MSGS = '0';
  for (let i = 1; i <= 51; i++) send('doff', 'order ' + i);
  ok(queueLib.unreadLoad('doff', { root: D }).msgs === 51, 'depth: HUBD_QUEUE_MAX_MSGS=0 turns the count limit off');
  delete process.env.HUBD_QUEUE_MAX_MSGS;

  // what doctor lists: 80% of a limit and up, fullest first
  const E = mktmp();
  for (const [role, n] of [['e39', 39], ['e40', 40], ['e50', 50]]) for (let i = 1; i <= n; i++) send(role, 'order ' + i, E);
  const near = queueLib.queuesNearFull({ root: E });
  ok(near.map(x => `${x.role}:${x.msgs}:${x.full}`).join() === 'e50:50:true,e40:40:false', `depth: queues at 80%+ of a limit are listed, full ones marked (${JSON.stringify(near)})`);
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
  // a file sent as the message: 20 KB is refused with the rule, 2 KB goes
  const fileSend = (bytes) => cli(['queue', 'send', 'smokefile', '-', '--from', 'tester'], { env, cwd: team, input: 'line of a log file\n'.repeat(Math.ceil(bytes / 19)).slice(0, bytes) });
  const big = fileSend(20480);
  ok(big.code === 1 && /^Error: message refused: \d+ bytes, over the 16384-byte limit \(HUBD_MSG_MAX\)\. A message is prose, not cargo: put the artifact in a file on your node and send its path, size and sha256sum\./m.test(big.stderr),
    'queue send: a 20 KB file is refused, exit 1, and the error says where the artifact goes');
  ok(!fs.existsSync(path.join(team, 'queues')) || !fs.readdirSync(path.join(team, 'queues')).some(f => f.startsWith('smokefile.')), 'queue send: and no queue file was written for it');
  ok(fileSend(2048).code === 0, 'queue send: a 2 KB dispatch from a file goes');
  // doctor says a queue is filling before its senders are refused
  for (let i = 1; i <= 41; i++) queueLib.queueSend('smokefull', 'order ' + i, { from: 'dev-t', root: team });
  const dr = q(['doctor']).out;
  ok(/1 queue\(s\) at 80%\+ of the send limit \(50 messages \/ 262144 bytes unread\)  WARNING/.test(dr) && /smokefull: 41 msg, \d+B unread\n/.test(dr),
    'doctor: a queue at 80% of the send limit is a warning, with the role and its unread count');
}

/* ── a file cut between the stat and the read ──
 * The cursor moves to the size taken by stat; the read comes after it. A sync that checks out a
 * shorter version in between left the read short, and the reader handed out the bytes it got plus
 * the uninitialised end of its buffer, then put the cursor past bytes it never read. */
{
  const SR = mktmp();
  fs.mkdirSync(path.join(SR, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(SR, '.qstate'), { recursive: true });
  const srQ = path.join(SR, 'queues', 'cut.n1.queue.md');
  const srOff = path.join(SR, '.qstate', 'cut.n1.queue.md.offset');
  const line = "\t@printf 'include_dir=%s/usr/include\\nsys_include_dir=%s/usr/include\\ncrt_dir=%s/usr/lib\\nmsvc_lib_dir=\\nkernel32_lib_dir=\\ngcc_dir=\\n' \\ $(SYSROOT) \"$(FLAGS)\" `x` 100% > $(LIBC_TXT) && echo \"written: $@\"";
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const first = '\n## 2026-09-04 10:00 · from alice\nfirst\n';
  const full = first + `\n## 2026-09-04 10:01 · from alice\n${line}\n${line}\n`;
  fs.writeFileSync(srQ, first);
  ok((await queueLib.queueWait('cut', { timeout: 0, root: SR })).changed, 'short read: the first block is delivered');
  const offBefore = parseInt(fs.readFileSync(srOff, 'utf8'), 10);
  fs.writeFileSync(srQ, full);
  // The swap lands between drainFile's stat and readTail's open: the file is replaced by a version
  // cut in the middle of the second block, as a checkout would leave it.
  const realOpen = fs.openSync;
  let armed = true;
  fs.openSync = function (p, flags, ...rest) {
    if (armed && p === srQ && (flags === 'r' || flags === undefined)) {
      armed = false;
      fs.writeFileSync(srQ + '.tmp', full.slice(0, first.length + 60));
      fs.renameSync(srQ + '.tmp', srQ);
    }
    return realOpen.call(fs, p, flags, ...rest);
  };
  let cut;
  try { cut = await queueLib.queueWait('cut', { timeout: 0, root: SR }); } finally { fs.openSync = realOpen; }
  ok(!armed, 'short read: the test did cut the file under the reader');
  ok(!cut.changed, `short read: nothing is handed out from a read that came up short (got ${JSON.stringify(String(cut.text || '').slice(-40))})`);
  ok(parseInt(fs.readFileSync(srOff, 'utf8'), 10) === offBefore, 'short read: and the cursor stays where it was');
  fs.writeFileSync(srQ, full);
  const after = await queueLib.queueWait('cut', { timeout: 0, root: SR });
  const lines = String(after.text || '').split('\n').filter(l => l === line);
  ok(after.changed && lines.length === 2 && lines.every(l => sha(l) === sha(line) && Buffer.byteLength(l) === Buffer.byteLength(line)),
    `short read: once the file is whole, the block arrives byte for byte (${Buffer.byteLength(line)}-byte lines, sha256 equal)`);
  fs.rmSync(SR, { recursive: true, force: true });
}

done();
