// mesh.mjs — the mesh: duplicated lines, which version wrote what, a sync that keeps failing, conflicts, absorb
import fs from 'node:fs';
import path from 'node:path';
import { ok, mktmp, run, core, doc, conflictsLib, absorbLib, done } from './_h.mjs';

// ── a mesh merge can duplicate lines in an append-only log, and every count believed them ──
/* merge=union, the natural .gitattributes for logs like these, keeps BOTH sides of a conflicting
 * hunk and never dedups — so a line present on both sides survives repeatedLine, and the next merge sees
 * the doubled file as one side of the next union. Nothing errors anywhere: clean merge, valid
 * JSONL, every line really written, append-only never violated. In the hub this was found in the
 * journal held 27459 lines for 1916 entries and one task log 5359 for 519, and `hub doctor`
 * reported the inflated figure as fact. */
const DUP = mktmp();
core.setHubBase(DUP);
const dline = (ts, text) => JSON.stringify({ ts, project: 'p', agent: 'dev-t', kind: 'note', text });
const repeatedLine = dline('2026-08-01 10:00', 'said once');
fs.writeFileSync(path.join(DUP, 'journal.pine.jsonl'),
  (repeatedLine + '\n').repeat(4) + dline('2026-08-01 10:05', 'said separately') + '\n');
ok(core.journalTail(null, 50).length === 2,
  `journal: four copies of one line read as ONE entry (got ${core.journalTail(null, 50).length})`);

/* A node's month archives are the same log: journalAppend rotates journal.<node>.jsonl out to
 * journal.<node>-<YYYY-MM>[.n].jsonl, and union left one archive a near-subset of the next —
 * 1271 of 1272 lines shared, counted repeatedLine by every reader that globs journal*.jsonl. */
fs.writeFileSync(path.join(DUP, 'journal.pine-2026-07.jsonl'), repeatedLine + '\n');
fs.writeFileSync(path.join(DUP, 'journal.pine-2026-07.2.jsonl'), repeatedLine + '\n');
ok(core.journalTail(null, 50).length === 2,
  'journal: a line repeated across a node\'s live log and its month archives is still one entry');

/* But never across nodes. A journal entry carries no node field, so the file name is the only
 * place that distinction lives, and two machines writing one sentence really are two events. */
fs.writeFileSync(path.join(DUP, 'journal.fir.jsonl'), repeatedLine + '\n');
ok(core.journalTail(null, 50).length === 3,
  'journal: the same line under a DIFFERENT node is kept — dedup is per node, never global');

/* And it keys on the whole line, not the timestamp: the journal stamps to the minute, so distinct
 * entries routinely share a ts and collapsing those would delete real work. */
fs.appendFileSync(path.join(DUP, 'journal.pine.jsonl'), dline('2026-08-01 10:00', 'other text, same minute') + '\n');
ok(core.journalTail(null, 50).length === 4,
  'journal: two different entries written in the same minute both survive');

const jcounts = doc.journalCounts();
ok(jcounts.lines === 9 && jcounts.entries === 4 && jcounts.duplicate === 5,
  `journalCounts: 9 lines on disk, 4 entries, 5 dropped (got ${jcounts.lines}/${jcounts.entries}/${jcounts.duplicate})`);
const jdup = doc.logDuplication().find(g => g.kind === 'journal' && g.node === 'pine');
ok(jdup && jdup.lines === 8 && jdup.distinct === 3,
  `logDuplication: names the inflated node log family (${jdup ? jdup.lines + '/' + jdup.distinct : 'missing'})`);
ok(!doc.logDuplication().some(g => g.node === 'fir'),
  'logDuplication: a clean log is not reported as duplicated');

/* The task logs are where this actually cost work — union made the replays that the 0.9.2 fold
 * bug then minted a task from, one per line. The fold is idempotent now, but a duplicated log
 * still has to read as the events it holds and not as the lines it holds. */
fs.writeFileSync(path.join(DUP, 'tasks.pine.events.jsonl'),
  (JSON.stringify({ ts: '2026-08-02 09:00', node: 'pine', ev: 'add', id: 'pine-1',
    t: { id: 'pine-1', project: 'p', text: 'one task', status: 'open' } }) + '\n').repeat(9));
ok(core.foldTasks().tasks.length === 1,
  `fold: nine duplicate lines of one add are one task (got ${core.foldTasks().tasks.length})`);
const tdup = doc.logDuplication().find(g => g.kind === 'tasks' && g.node === 'pine');
ok(tdup && tdup.lines === 9 && tdup.distinct === 1,
  `logDuplication: reports the task logs too (${tdup ? tdup.lines + '/' + tdup.distinct : 'missing'})`);

/* Serving a corrected number over files that quietly keep the duplicates is the same lie one
 * level down, so doctor prints the entry count AND the bloat AND what causes it. */
const docDup = run('doctor', { HUBD_DIR: DUP, HUBD_TEAM_DIR: DUP });
ok(/journal: +4 file\(s\), 4 entries/.test(docDup.out),
  'doctor: the journal line counts ENTRIES a reader sees, not lines on disk');
ok(/duplicate line\(s\)/.test(docDup.out) && /merge=union/.test(docDup.out),
  'doctor: and it names the bloat and the cause instead of hiding the correction');

// ── which hubd wrote which line ───────────────────────────────────────────────
/* The global `hub` on the machine that develops hubd sat nine releases behind for weeks. Nothing
 * could have said so: the lines it wrote were indistinguishable from current ones, and the tool
 * had no way to state its own version — `npm ls -g` was the only route. So the log carries the
 * writer now, and it is the only place that can: presence/ is node-local and never mesh-synced,
 * so it can only ever describe the machine already asking. */
const WV = mktmp();
core.setHubBase(WV);
core.journalAppend({ ts: '2026-09-01 10:00', project: 'p', agent: 'dev-t', kind: 'note', text: 'fresh write' });
const wvLine = JSON.parse(fs.readFileSync(path.join(WV, 'journal.' + core.JOURNAL_NODE + '.jsonl'), 'utf8').trim());
ok(wvLine.v === core.VERSION,
  `journalAppend: stamps the writing version onto the entry (got ${JSON.stringify(wvLine.v)})`);
core.journalAppend({ ts: '2026-09-01 10:01', project: 'p', agent: 'dev-t', kind: 'note', text: 'relayed', v: '0.4.8' });
const wvRelay = fs.readFileSync(path.join(WV, 'journal.' + core.JOURNAL_NODE + '.jsonl'), 'utf8').trim().split('\n');
ok(JSON.parse(wvRelay[1]).v === '0.4.8',
  'journalAppend: an entry that already names a version keeps it — a relayed line describes its origin');

const wvl = (ts, v, text, agent = 'dev-t') => JSON.stringify({ ts, project: 'p', agent, kind: 'note', text, ...(v ? { v } : {}) });
fs.writeFileSync(path.join(WV, 'journal.pine.jsonl'),
  wvl('2026-08-01 09:00', '0.9.1', 'old') + '\n' + wvl('2026-08-02 09:00', '0.9.2', 'newer') + '\n');
fs.writeFileSync(path.join(WV, 'journal.attic.jsonl'),
  wvl('2026-07-01 09:00', null, 'from before stamps existed') + '\n');
const wvNodes = core.writerVersions();
const wvPine = wvNodes.find(g => g.node === 'pine');
ok(wvPine && wvPine.last === '0.9.2' && wvPine.lastAt === '2026-08-02 09:00',
  `writerVersions: a node's version is the one on its NEWEST stamped entry (got ${wvPine && wvPine.last})`);
const wvAttic = wvNodes.find(g => g.node === 'attic');
ok(wvAttic && wvAttic.last === null && wvAttic.unstamped === 1,
  'writerVersions: pre-0.9.4 entries count as unstamped, never guessed from the line next to them');

/* 0.9.10 is NEWER than 0.9.2 and sorts before it as text — the whole check inverts on a
 * two-digit patch, which is four releases away. */
ok(core.cmpVersion('0.9.10', '0.9.2') > 0 && core.cmpVersion('0.9.2', '0.9.10') < 0 && core.cmpVersion('1.0', '1.0.0') === 0,
  'cmpVersion: compares numerically, so 0.9.10 outranks 0.9.2');

const wvSkew = doc.versionSkew();
ok(wvSkew.installed === core.VERSION && wvSkew.behind.some(n => n.node === 'pine' && n.v === '0.9.2'),
  'versionSkew: names a node whose newest write came from an older hubd than this install');
fs.writeFileSync(path.join(WV, 'journal.future.jsonl'), wvl('2026-08-05 09:00', '99.0.0', 'from ahead') + '\n');
ok(doc.versionSkew().ahead.some(n => n.node === 'future'),
  'versionSkew: a node writing with a NEWER hubd means this copy is the stale one');

/* Interleaving, not mere co-presence: an upgrade partitions old lines from new ones, two installs
 * on one machine keep taking turns. Only the second is worth a warning. */
fs.writeFileSync(path.join(WV, 'journal.clean.jsonl'),
  wvl('2026-08-01 09:00', '0.4.8', 'a') + '\n' + wvl('2026-08-02 09:00', '0.4.8', 'b') + '\n' +
  wvl('2026-08-03 09:00', '0.9.4', 'c') + '\n' + wvl('2026-08-04 09:00', '0.9.4', 'd') + '\n');
fs.writeFileSync(path.join(WV, 'journal.twoinstalls.jsonl'),
  wvl('2026-08-01 09:00', '0.4.8', 'a', 'resident') + '\n' + wvl('2026-08-02 09:00', '0.9.4', 'b', 'fresh') + '\n' +
  wvl('2026-08-03 09:00', '0.4.8', 'c', 'resident') + '\n' + wvl('2026-08-04 09:00', '0.9.4', 'd', 'fresh') + '\n');
const wvCon = doc.versionSkew().concurrent;
ok(!wvCon.some(n => n.node === 'clean'),
  'writerVersions: a clean upgrade cutover is not reported as two versions running side by side');
ok(wvCon.some(n => n.node === 'twoinstalls' && n.versions.join(',') === '0.4.8,0.9.4'),
  'writerVersions: an older version still appearing after a newer one is two hubds writing at once');

/* WHO holds the old one. Without the names the reader was sent to look for a second install, and
 * on the hub this shipped from there was none: a resident MCP server was writing the version it had
 * imported while a fresh CLI wrote the current one out of the same file. */
// Read through a helper, not by indexing: a regression that drops the map should FAIL here, not
// throw and take every assertion after it down with it.
const wvWho = (v) => ((wvCon.find(n => n.node === 'twoinstalls') || {}).by || {})[v] || [];
ok(wvWho('0.4.8').join(',') === 'resident' && wvWho('0.9.4').join(',') === 'fresh',
  `writerVersions: reports which agents wrote each version, so the stale process is addressable (got ${JSON.stringify(wvWho('0.4.8'))})`);
fs.appendFileSync(path.join(WV, 'journal.twoinstalls.jsonl'), wvl('2026-08-05 09:00', '0.4.8', 'e', 'fresh') + '\n');
const wvBoth = ((doc.versionSkew().concurrent.find(n => n.node === 'twoinstalls') || {}).by || {})['0.4.8'] || [];
ok(wvBoth.join(',') === 'fresh,resident',
  `writerVersions: one agent name under both versions is reported as such, not smoothed away (got ${JSON.stringify(wvBoth)})`);

const wvDoc = run('doctor', { HUBD_DIR: WV, HUBD_TEAM_DIR: WV });
ok(/writers: +.*pine 0\.9\.2/.test(wvDoc.out),
  'doctor: prints which hubd wrote into each node log');
ok(/THIS copy is older than the mesh/.test(wvDoc.out) && /0\.4\.8 and 0\.9\.4 both writing recently/.test(wvDoc.out),
  'doctor: warns on both directions of skew and on two versions writing at once');
ok(/0\.4\.8: fresh, resident/.test(wvDoc.out) && /long-lived process, not a second install/.test(wvDoc.out),
  'doctor: names the agents on the old version and stops asserting a cause it cannot observe');
/* The `behind` direction must report what was SEEN, not a remedy inferred from it. "upgrade that
 * node" was wrong on a live hub the day it shipped: two nodes whose packages were already current
 * had simply not written since, and doctor sent a human to go and upgrade what was done. */
ok(!/upgrade that node/.test(wvDoc.out),
  'doctor: does not instruct an upgrade it cannot know is needed');
ok(/has not written since reads the same as one that did not/.test(wvDoc.out),
  'doctor: and says once why a quiet up-to-date node is indistinguishable from a stale one');
const wvEmpty = mktmp();
ok(/no version stamps yet/.test(run('doctor', { HUBD_DIR: wvEmpty, HUBD_TEAM_DIR: wvEmpty }).out),
  'doctor: says the record is empty rather than printing a reassuring nothing');
fs.rmSync(wvEmpty, { recursive: true, force: true });

// ── a sync that keeps retrying looks exactly like one that works ─────────────
/* One node's mesh-sync failed every 60 seconds for 228 commits of the other nodes' history. The
 * job ran, logged a line, exited non-zero, and was restarted a minute later to fail identically —
 * while hub status, hub brief and hub doctor all reported a healthy hub, because none of them
 * looked. The divergence is read from git rather than from the log: the log says whatever the
 * script decided to say, and in that incident the script's own diagnosis named the wrong cause. */
const MS = mktmp();
core.setHubBase(MS);
ok(doc.meshStatus() === null, 'meshStatus: a hub that is not a git repo reports nothing to sync');
core.sh('git init -q -b main', MS);
core.sh('git config user.email t@t && git config user.name t', MS);
fs.writeFileSync(path.join(MS, 'journal.a.jsonl'), '{"ts":"2026-09-01 10:00","kind":"note","text":"x"}\n');
core.sh('git add -A && git commit -q -m seed', MS);
const msNoRemote = doc.meshStatus();
ok(msNoRemote && msNoRemote.remote === null && msNoRemote.branch === 'main',
  'meshStatus: a hub with no origin is not a mesh member and is not warned about');

const MSUP = mktmp();
core.sh(`git clone -q "${MS}" "${MSUP}"`, MS);
core.setHubBase(MSUP);
core.sh('git config user.email t@t && git config user.name t', MSUP);
ok(doc.meshStatus().behind === 0 && doc.meshStatus().ahead === 0,
  'meshStatus: a fresh clone is in sync, and reports 0/0 rather than staying silent');
fs.appendFileSync(path.join(MS, 'journal.a.jsonl'), '{"ts":"2026-09-01 11:00","kind":"note","text":"y"}\n');
core.sh('git add -A && git commit -q -m more', MS);
core.sh('git fetch -q origin', MSUP);
const msBehind = doc.meshStatus();
ok(msBehind.behind === 1 && msBehind.ahead === 0,
  `meshStatus: counts the commits this hub has not received (got ${msBehind.behind}/${msBehind.ahead})`);
fs.writeFileSync(path.join(MSUP, '.mesh-sync.log'),
  'mesh-sync: ok (n 2026-09-01 10:00, main)\nmesh-sync: pull/merge failed on main (bogus reason) - aborted\n');
ok(doc.meshStatus().lastError === 'mesh-sync: pull/merge failed on main (bogus reason) - aborted',
  'meshStatus: quotes the sync\'s last complaint for a human, without trusting it for the verdict');
const msDoc = run('doctor', { HUBD_DIR: MSUP, HUBD_TEAM_DIR: MSUP });
ok(/mesh: +origin\/main: 1 behind, 0 ahead {2}WARNING/.test(msDoc.out) && /not receiving the other nodes/.test(msDoc.out),
  'doctor: says out loud that the hub has stopped receiving the mesh');

/* Two tracked paths differing only by case. On Linux they are two files; where it matters they are
 * one, git maps it to a single index entry, and the other can never be satisfied — add -A stages
 * nothing and every merge that must write it refuses. Read from the REMOTE's tree as well as this
 * index, because the pair that blocks the pull usually arrived from another node and is not
 * tracked here yet: looking only at the local index finds nothing wrong with a hub that cannot
 * sync. That is precisely the state the incident was found in. */
const csBlob = core.sh('printf "legacy\\n" | git hash-object -w --stdin', MS);
core.sh(`git update-index --add --cacheinfo 100644,${csBlob},queues/r.Node.queue.md`, MS);
core.sh(`git update-index --add --cacheinfo 100644,${csBlob},queues/r.node.queue.md`, MS);
const csTree = core.sh('git write-tree', MS);
const csCommit = core.sh(`git commit-tree ${csTree} -p HEAD -m pair`, MS);
core.sh(`git update-ref refs/heads/main ${csCommit}`, MS);
core.sh('git fetch -q origin', MSUP);
const coll = doc.caseCollisions();
ok(coll.length === 1 && coll[0].paths.join(' ') === 'queues/r.Node.queue.md queues/r.node.queue.md',
  `caseCollisions: finds a pair that exists only in the remote's tree (got ${JSON.stringify(coll)})`);
core.setHubBase(MS);
ok(doc.caseCollisions().length === 1,
  'caseCollisions: and finds it from the index too, on the node that can hold both');
const collDoc = run('doctor', { HUBD_DIR: MSUP, HUBD_TEAM_DIR: MSUP });
ok(/r\.Node\.queue\.md {2}\+ {2}queues\/r\.node\.queue\.md/.test(collDoc.out),
  'doctor: prints the colliding pair');
ok(/one of each pair must leave the mesh/.test(collDoc.out),
  'doctor: and that no local commit can fix it, because the obvious remedies do not work');
fs.rmSync(MSUP, { recursive: true, force: true });

// ── a conflicted queue: ours in place, theirs appended, cursors untouched ────
/* Queue files are append-only by contract but have no union merge (only the journals and task
 * event logs do), so two sides that both appended really do conflict — one node came back after
 * two days holding 49 local commits with five queue files conflicted at once, and every block on
 * both sides was a message somebody sent.
 *
 * Appending theirs at the END is the load-bearing choice, and it is a better trade than the
 * ts-ordered union this was first designed as: cursors are byte offsets, so inserting a block
 * before one silently moves it, and a ts-ordered merge would have to recompute every cursor in
 * the hub including those on nodes this one cannot see. Appending inserts nothing before anything.
 * Strict time order is the cost, and it costs nothing — a reader walks forward from its cursor and
 * every block carries its own timestamp. */
const QRC = mktmp();
const qrcHead = '\n## 2026-09-01 10:00 · from alice\nshared\n';
const qrcText = qrcHead +
  '<<<<<<< HEAD\n\n## 2026-09-02 11:00 · from ours\nmine\n' +
  '=======\n\n## 2026-09-02 09:00 · from theirs\ntheirs\n' +
  '>>>>>>> abc\n';
const qrc = conflictsLib.resolveQueueConflicts(qrcText);
ok(qrc.hunks === 1 && qrc.carried === 1,
  `resolveQueueConflicts: one hunk, one block carried over (got ${qrc.hunks}/${qrc.carried})`);
ok(qrc.text.startsWith(qrcHead),
  'resolveQueueConflicts: every byte that was already there stays where it was — cursors keep pointing at it');
ok(qrc.text.indexOf('from ours') < qrc.text.indexOf('from theirs'),
  'resolveQueueConflicts: theirs lands at the END even though its timestamp is EARLIER — position beats chronology, because position is what a cursor means');
/* Dedup is on the whole block, not the header: the same minute and sender can carry two different
 * messages, and collapsing those would be losing work to save a line. */
const qrcSame = conflictsLib.resolveQueueConflicts(
  '<<<<<<< HEAD\n\n## 2026-09-02 11:00 · from bob\nfirst\n=======\n\n## 2026-09-02 11:00 · from bob\nsecond\n>>>>>>> abc\n');
ok(qrcSame.carried === 1 && /first/.test(qrcSame.text) && /second/.test(qrcSame.text),
  'resolveQueueConflicts: same minute and sender, different bodies — both survive');
const qrcDup = conflictsLib.resolveQueueConflicts(
  '<<<<<<< HEAD\n\n## 2026-09-02 11:00 · from bob\nsame\n=======\n\n## 2026-09-02 11:00 · from bob\nsame\n>>>>>>> abc\n');
ok(qrcDup.carried === 0 && (qrcDup.text.match(/from bob/g) || []).length === 1,
  'resolveQueueConflicts: an identical block on both sides appears once');
const qrcClean = conflictsLib.resolveQueueConflicts(qrcHead);
ok(qrcClean.hunks === 0 && qrcClean.text === qrcHead,
  'resolveQueueConflicts: a file with no conflict is returned byte-for-byte');
const qrcTorn = conflictsLib.resolveQueueConflicts('<<<<<<< HEAD\n\n## 2026-09-02 11:00 · from bob\nx\n');
ok(qrcTorn.hunks === 0 && qrcTorn.malformed === 1 && qrcTorn.text.includes('<<<<<<< HEAD'),
  'resolveQueueConflicts: a hunk with no separator is counted and left untouched');
fs.mkdirSync(path.join(QRC, 'queues'), { recursive: true });
fs.writeFileSync(path.join(QRC, 'queues', 'r.n1.queue.md'), qrcText);
const qrcCli = run('queue resolve', { HUBD_DIR: QRC, HUBD_TEAM_DIR: QRC });
ok(/1 hunk\(s\), 1 block\(s\) carried over/.test(qrcCli.out) && qrcCli.code === 0,
  `queue resolve: the command reports what it carried (code ${qrcCli.code})`);
ok(!/<<<<<<</.test(fs.readFileSync(path.join(QRC, 'queues', 'r.n1.queue.md'), 'utf8')),
  'queue resolve: and leaves no markers behind');
fs.rmSync(QRC, { recursive: true, force: true });

// ── absorb: a hub base written in isolation joins this one as a new node ──
// Real incident: roles wrote to a private ~/.hubd for a day; its pine-1..23
// collided with the shared hub's own pine-1..23, naming different work.
const AB = mktmp(); const ABSRC = mktmp();
core.setHubBase(AB);
fs.writeFileSync(path.join(AB, 'tasks.pine.events.jsonl'),
  JSON.stringify({ ts: '2026-08-01 10:00', node: 'pine', ev: 'add', id: 'pine-1', t: { id: 'pine-1', project: 'barechat', text: 'shared old work', status: 'open' } }) + '\n');
fs.writeFileSync(path.join(AB, 'journal.pine.jsonl'), JSON.stringify({ ts: '2026-08-01 10:01', project: 'barechat', agent: 'x', kind: 'note', text: 'shared entry' }) + '\n');
fs.mkdirSync(path.join(AB, 'projects'), { recursive: true });
fs.writeFileSync(path.join(AB, 'projects', 'barechat.md'), '# barechat\n\n## Digest\n\nshared digest\n');
for (const d of ['projects', 'queues', '.qstate', 'presence']) fs.mkdirSync(path.join(ABSRC, d), { recursive: true });
fs.writeFileSync(path.join(ABSRC, 'tasks.pine.events.jsonl'),
  JSON.stringify({ ts: '2026-09-10 18:09', node: 'pine', ev: 'add', id: 'pine-1', t: { id: 'pine-1', project: 'barechat', text: 'private T5.3 snapshots', status: 'open' } }) + '\n' +
  JSON.stringify({ ts: '2026-09-10 19:00', node: 'pine', ev: 'set', id: 'pine-1', patch: { status: 'done' }, keyed: 'origin' }) + '\n' +
  JSON.stringify({ ts: '2026-09-11 12:00', node: 'pine', ev: 'add', id: 'pine-12', t: { id: 'pine-12', project: 'barechat', text: 'batch5 after pine-1 done', status: 'open', depends_on: ['pine-1'] } }) + '\n');
fs.writeFileSync(path.join(ABSRC, 'journal.pine.jsonl'),
  JSON.stringify({ ts: '2026-09-11 12:05', project: 'barechat', agent: 'barechat-dev', kind: 'note', text: 'took pine-12, see #pine-1 and pine-120' }) + '\n' +
  JSON.stringify({ ts: '2026-09-11 13:00', project: 'barechat', agent: 'barechat-dev', kind: 'done', text: 'done' }) + '\n');
const qBlock1 = '\n## 2026-09-11 12:10 · from barechat-orch · task #pine-12\ndo batch5\n';
const qBlock2 = '\n## 2026-09-11 14:00 · from barechat-orch\nunread order\n';
fs.writeFileSync(path.join(ABSRC, 'queues', 'barechat-dev.Pine.queue.md'), qBlock1 + qBlock2);
fs.writeFileSync(path.join(ABSRC, '.qstate', 'barechat-dev.Pine.queue.md.offset'), String(Buffer.byteLength(qBlock1)) + '\n');
fs.writeFileSync(path.join(ABSRC, '.qstate', 'barechat-dev.waiter'), JSON.stringify({ pid: 999999, since: '2026-09-11T21:26:09Z' }));
fs.writeFileSync(path.join(ABSRC, 'projects', 'barechat.md'), '# barechat\n\n## Digest\n\nprivate digest about pine-1\n');
fs.writeFileSync(path.join(ABSRC, 'projects', 'newproj.md'), '# newproj\n\n## Digest\n\nonly here\n');
fs.writeFileSync(path.join(ABSRC, 'presence', 'barechat-dev.json'), '{}');
fs.writeFileSync(path.join(ABSRC, 'claims.json'), '{"claims":[]}');
fs.writeFileSync(path.join(ABSRC, 'tasks.json'), '{}');
{
  const plan = absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent' });
  ok(plan.apply === false && !fs.existsSync(path.join(AB, 'tasks.pine-agent.events.jsonl')), 'absorb: without apply nothing is written');
  ok(plan.tasks.added === 2 && plan.tasks.idMap['pine-1'] === 'pine-agent-1' && plan.tasks.idMap['pine-12'] === 'pine-agent-12',
    `absorb: ids are renamed <label>-<n> keeping their number (got ${JSON.stringify(plan.tasks.idMap)})`);
  ok(plan.unread.length === 1 && plan.unread[0].blocks === 1 && plan.unread[0].file === 'barechat-dev.Pine.queue.md',
    `absorb: the plan names the one queue block nobody read (got ${JSON.stringify(plan.unread)})`);
  ok(plan.cards.find(c => c.slug === 'barechat').kept.startsWith('absorbed/pine-agent/') && plan.cards.find(c => c.slug === 'newproj').kept === 'projects/newproj.md',
    'absorb: an existing slug is kept aside, a new slug joins the hub');
  ok(plan.skipped.includes('presence/') && plan.skipped.includes('claims.json') && plan.skipped.includes('tasks.json'), 'absorb: node-local and generated files are listed as not absorbed');
  let thrown = null; try { absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent', apply: true }); } catch (e) { thrown = e.message; }
  ok(/by required/.test(thrown || ''), 'absorb: apply without an author is refused');
  thrown = null; try { absorbLib.runAbsorb({ from: ABSRC, as: 'Pine Agent' }); } catch (e) { thrown = e.message; }
  ok(/as required/.test(thrown || ''), 'absorb: a label with spaces or capitals is refused');
  fs.writeFileSync(path.join(ABSRC, '.qstate', 'barechat-dev.waiter'), JSON.stringify({ pid: process.pid }));
  thrown = null; try { absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent' }); } catch (e) { thrown = e.message; }
  ok(/live waiter/.test(thrown || ''), 'absorb: a waiter still alive in the source refuses the copy');
  ok(absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent', force: true }).warnings.length === 1, 'absorb: force passes the live waiter as a warning');
  fs.writeFileSync(path.join(ABSRC, '.qstate', 'barechat-dev.waiter'), JSON.stringify({ pid: 999999 }));
  fs.mkdirSync(path.join(ABSRC, '.git'));
  thrown = null; try { absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent' }); } catch (e) { thrown = e.message; }
  ok(/git repository/.test(thrown || ''), 'absorb: a source that is itself a mesh node is refused');
  fs.rmdirSync(path.join(ABSRC, '.git'));
  thrown = null; try { absorbLib.runAbsorb({ from: AB, as: 'pine-agent' }); } catch (e) { thrown = e.message; }
  ok(/itself/.test(thrown || ''), 'absorb: the hub base cannot absorb itself');

  const done = absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent', apply: true, by: 'head-orchestrator' });
  ok(done.tasksVisible === 2, `absorb: both absorbed tasks are visible after the fold (got ${done.tasksVisible})`);
  const db2 = core.foldTasks();
  const t = (id) => db2.tasks.find(x => x.id === id);
  ok(db2.tasks.length === 3 && t('pine-1') && t('pine-1').text === 'shared old work', 'absorb: the shared pine-1 is untouched and still pine-1');
  ok(t('pine-agent-1') && t('pine-agent-1').status === 'done', 'absorb: the absorbed set event followed its add to the renamed id');
  ok(t('pine-agent-12') && t('pine-agent-12').text === 'batch5 after pine-agent-1 done' && t('pine-agent-12').depends_on[0] === 'pine-agent-1',
    `absorb: ids inside text and depends_on are renamed (got ${t('pine-agent-12') && t('pine-agent-12').text})`);
  const j = fs.readFileSync(path.join(AB, 'journal.pine-agent.jsonl'), 'utf8');
  ok(/took pine-agent-12, see #pine-agent-1 and pine-120/.test(j), 'absorb: journal text renames pine-1 and pine-12 but not pine-120');
  ok(fs.readFileSync(path.join(AB, 'journal.pine.jsonl'), 'utf8').split('\n').filter(Boolean).length === 1, 'absorb: the shared journal file gained nothing (only new files are written)');
  const qcopy = fs.readFileSync(path.join(AB, 'absorbed', 'pine-agent', 'queues', 'barechat-dev.Pine.queue.md'), 'utf8');
  ok(/task #pine-agent-12/.test(qcopy) && !fs.existsSync(path.join(AB, 'queues', 'barechat-dev.Pine.queue.md')), 'absorb: queue history is kept aside with renamed refs, not placed where a waiter would re-read it');
  ok(fs.existsSync(path.join(AB, 'absorbed', 'pine-agent', 'projects', 'barechat.md')) && fs.readFileSync(path.join(AB, 'projects', 'barechat.md'), 'utf8').includes('shared digest')
    && fs.existsSync(path.join(AB, 'projects', 'newproj.md')), 'absorb: existing card untouched and kept aside, new card joined');
  const man = JSON.parse(fs.readFileSync(path.join(AB, 'absorbed', 'pine-agent', 'manifest.json'), 'utf8'));
  ok(man.by === 'head-orchestrator' && man.tasks.idMap['pine-12'] === 'pine-agent-12' && man.unread.length === 1, 'absorb: the manifest records author, id map and unread blocks');
  ok(core.journalTail('hub', 5).some(e => /absorbed .* as node pine-agent: 2 task/.test(e.text) && e.agent === 'head-orchestrator'), 'absorb: the absorb itself is journaled under the author');
  thrown = null; try { absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent', apply: true, by: 'x', force: true }); } catch (e) { thrown = e.message; }
  ok(/label already used/.test(thrown || ''), 'absorb: a second absorb under the same label is refused, even forced');
  // A write that fails half-way leaves nothing behind: the label stays free and no log is on disk.
  // (Field run: absorbed/ arrived by a root git pull without group write; the logs landed, the queues did not.)
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(path.join(AB, 'absorbed'), 0o555);          // as a root git pull leaves it: no group write
    thrown = null; try { absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent3', apply: true, by: 'x' }); } catch (e) { thrown = e.message; }
    ok(/aborted, nothing kept/.test(thrown || ''), `absorb: a failed write aborts with a clear message (got ${thrown})`);
    ok(!fs.existsSync(path.join(AB, 'journal.pine-agent3.jsonl')) && !fs.existsSync(path.join(AB, 'tasks.pine-agent3.events.jsonl')),
      'absorb: no log of the failed label is left on disk');
    fs.chmodSync(path.join(AB, 'absorbed'), 0o755);
    ok(absorbLib.runAbsorb({ from: ABSRC, as: 'pine-agent3', apply: true, by: 'x' }).tasksVisible === 2, 'absorb: the same label works once the permission is fixed');
  }
  const cli = run(`absorb ${ABSRC} --as pine-agent2`, { HUBD_DIR: AB, HUBD_TEAM_DIR: AB });
  ok(cli.code === 0 && /Would absorb .* as node pine-agent2/.test(cli.out) && /UNREAD  barechat-dev.Pine.queue.md: 1 block/.test(cli.out) && /pine-1 -> pine-agent2-1/.test(cli.out),
    `absorb CLI: dry run prints the plan, the unread block and the id map (code ${cli.code})`);
  const cliBad = run(`absorb ${ABSRC} --as pine-agent2 --bogus`, { HUBD_DIR: AB, HUBD_TEAM_DIR: AB });
  ok(cliBad.code !== 0 && /unknown flag --bogus/.test(cliBad.out), 'absorb CLI: an unknown flag is refused');
}

done();
