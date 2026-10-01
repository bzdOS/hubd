// doctor.mjs — doctor: rewrites, the rules source, locks and cursors, which dir is the hub, freeze, a malformed line
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, ok, mktmp, run, cli, core, doc, queueLib, done } from './_h.mjs';

// ── CLI: doctor catches a LARGE destructive rewrite (numstat, no maxBuffer blind spot) ──
const T2 = mktmp();
const ev = path.join(T2, 'tasks.cedar.events.jsonl');
let lines = '';
for (let i = 1; i <= 8000; i++) lines += JSON.stringify({ ts: '2026-01-01 10:00', node: 'cedar', ev: 'add', id: i, t: { id: i, text: 'task ' + 'y'.repeat(220) } }) + '\n';
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

// ── CLI: hub brief must not crash on a journal entry missing fields (malformed/old/mesh) ──
const T4 = mktmp();
const recentTs = new Date(Date.now() - 3600000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(T4, 'journal.cedar.jsonl'),
  JSON.stringify({ ts: recentTs, project: 'x', agent: 'a', kind: 'note' }) + '\n');   // no `text` field
const b = run('brief', { HUBD_DIR: T4, HUBD_TEAM_DIR: T4 });
ok(b.code === 0, `hub brief: no crash on a journal entry missing 'text' (exit ${b.code})`);
ok(/JOURNAL/.test(b.out), 'hub brief: still renders the JOURNAL section');
fs.rmSync(T4, { recursive: true, force: true });

// ── a malformed line that cannot be repaired must not warn forever ───────────
/* This tool's own comment says a warning that can never be cleared is one a reader learns to skip
 * — and then doctor was set to nag about two malformed journal lines with no legitimate repair:
 * editing them rewrites an append-only log and trips the sync guard on every peer.
 *
 * The distinction is not "malformed" but "still happening". A torn write at the TAIL of a live log
 * means a writer is failing now. The same line with good entries appended after it is history. And
 * the measure has to be entries-after, not a trailing line window: the first version of this used
 * a 200-line window and called two June-era lines at the head of a 58-line log "happening NOW",
 * because the whole file fitted inside the window. */
const ML = mktmp();
core.setHubBase(ML); core.ensureHubDirs();
const mlGood = (n) => Array.from({ length: n }, (_, i) =>
  JSON.stringify({ ts: '2026-08-0' + (1 + (i % 9)) + '10:00', project: 'p', agent: 'dev-t', kind: 'note', text: 'ok' + i })).join('\n');
// Torn line at the HEAD, 30 good entries after it: the writer plainly recovered.
fs.writeFileSync(path.join(ML, 'journal.old.jsonl'), 'oject":"p","kind":"note"\n' + mlGood(30) + '\n');
let mlc = doc.journalCounts();
ok(mlc.malformed === 1 && mlc.malformedRecent === 0,
  `journalCounts: an old torn line counts as malformed but not as recent (got ${mlc.malformed}/${mlc.malformedRecent})`);
ok(!/WARNING/.test(run('doctor', { HUBD_DIR: ML, HUBD_TEAM_DIR: ML }).out.split('\n').find(l => /journal:/.test(l)) || ''),
  'doctor: an unrepairable old line is stated, not turned into a permanent warning');
ok(/not repairable without rewriting an append-only log/.test(run('doctor', { HUBD_DIR: ML, HUBD_TEAM_DIR: ML }).out),
  'doctor: and it says why nothing can be done about it');
// Torn line at the TAIL of a live log: a writer is failing right now.
fs.appendFileSync(path.join(ML, 'journal.old.jsonl'), 'oject":"p","kind":"task"\n');
mlc = doc.journalCounts();
ok(mlc.malformed === 2 && mlc.malformedRecent === 1,
  `journalCounts: a tear at the tail IS recent (got ${mlc.malformed}/${mlc.malformedRecent})`);
const mlDoc = run('doctor', { HUBD_DIR: ML, HUBD_TEAM_DIR: ML });
ok(/journal:.*malformed  WARNING/.test(mlDoc.out) && /a writer is tearing writes NOW/.test(mlDoc.out),
  'doctor: warns, loudly, only while it is still happening');
// The same tear inside a month-archive is closed history: journalAppend only renames INTO one.
fs.writeFileSync(path.join(ML, 'journal.old-2026-07.jsonl'), mlGood(3) + '\noject":"p","kind":"note"\n');
ok(doc.journalCounts().malformedRecent === 1,
  'journalCounts: a tear at the end of a month-archive is history, whatever its position');
fs.rmSync(ML, { recursive: true, force: true });

/* ── a card is a snapshot, and the cap is what holds it to that ──
 * Measured on a live hub: 41 cards, three past 72 KB, one past 250 KB, and hub_get on the largest
 * returned 72444 characters that the caller's context refused. The growth is
 * NOT in the digest (1.7-3.6 KB everywhere) — it is `## Facts & hypotheses`, one `- fact:` line at
 * a time from hub_report, with nothing to rotate it. */
{
  const CL = mktmp();
  core.setHubBase(CL); core.ensureHubDirs();
  // ACCEPTANCE (from the task): a 70 KB digest must be refused.
  let thrown = null;
  try { core.runCardSet({ project: 'big', digest: 'x'.repeat(70000), by: 'dev-t' }); } catch (e) { thrown = e.message; }
  ok(/over this hub's limit/.test(thrown || '') && /hub_report/.test(thrown || ''),
    `card cap: a 70 KB digest is refused, and the refusal says where the text goes (got ${String(thrown).slice(0, 60)})`);
  ok(!fs.existsSync(core.cardPath('big')), 'card cap: and nothing is written — a refusal that half-wrote would be worse than none');
  // A dated line is an event, not state.
  core.runCardSet({ project: 'big', digest: 'a real snapshot', by: 'dev-t' });
  thrown = null;
  try { core.runCardSet({ project: 'big', appendLine: '- 2026-09-23: shipped the thing', by: 'dev-t' }); } catch (e) { thrown = e.message; }
  ok(/event, not state/.test(thrown || '') && /hub_report/.test(thrown || ''),
    `card cap: a dated appendLine is refused with the channel that takes it (got ${String(thrown).slice(0, 50)})`);
  ok(core.runCardSet({ project: 'big', appendLine: '- ships on Fridays', by: 'dev-t' }).ok,
    'card cap: an undated line still patches the digest — the rule is about dates, not about appendLine');
  // The real growth channel: FACT: lines accumulating in one section.
  const factCount = 400;
  for (let i = 0; i < factCount; i++) core.runReport({ project: 'big', by: 'dev-t', text: `FACT: finding number ${i} ${'y'.repeat(60)}` });
  const card = core.readCard('big');
  const SEC = core.reportSections ? core.reportSections() : null;
  const factBody = core.sectionBody(card, (SEC && SEC.fact) || 'Facts & hypotheses');
  ok(Buffer.byteLength(factBody, 'utf8') <= core.cardLimits().sectionBytes + 200,
    `card cap: the accumulating section stays under the cap after ${factCount} facts (got ${Buffer.byteLength(factBody, 'utf8')}B)`);
  const hist = fs.readFileSync(path.join(CL, 'projects', 'history', 'big.md'), 'utf8');
  ok(/finding number 0\b/.test(hist), 'card cap: the oldest fact is in history — moved, not dropped (it lives nowhere else)');
  ok(new RegExp(`finding number ${factCount - 1}\\b`).test(card), 'card cap: the newest fact is still on the card');
  ok(/older entries moved to projects\/history\/big\.md/.test(card), 'card cap: the card says where the rest went');
  // Every fact ever written is still readable, card + history together.
  let seen = 0;
  for (let i = 0; i < factCount; i++) if (hist.includes(`finding number ${i} `) || card.includes(`finding number ${i} `)) seen++;
  ok(seen === factCount, `card cap: all ${factCount} facts survive between card and history (found ${seen})`);
  // The limit is the hub's, not the code's.
  fs.writeFileSync(path.join(CL, 'limits.json'), JSON.stringify({ card: { digestBytes: 200, sectionBytes: 1024 } }));
  ok(core.cardLimits().digestBytes === 200 && core.cardLimits().sectionBytes === 1024, 'card cap: limits.json in the hub overrides the defaults');
  thrown = null;
  try { core.runCardSet({ project: 'big', digest: 'z'.repeat(300), by: 'dev-t' }); } catch (e) { thrown = e.message; }
  ok(/over this hub's limit of 200/.test(thrown || ''), 'card cap: and the configured number is the one enforced');
  fs.rmSync(path.join(CL, 'limits.json'));
  // A half-merged card is not ours to rewrite.
  const conflicted = '# c\n\n## Digest\n\nd\n\n## Facts & hypotheses\n\n<<<<<<< HEAD\n' + '- fact: a\n'.repeat(2000) + '=======\n- fact: b\n>>>>>>> x\n';
  ok(core.rotateCardOverflow(conflicted, 'c', 'dev-t').moved.length === 0,
    'card cap: a card holding conflict markers is left alone — resolving it is a human decision');
  // hub_get must stay readable: the card is a STRING, and the budget used to see only arrays.
  const got = core.runGet({ project: 'big' });
  // A card can still outgrow the read budget by having MANY sections, each inside the cap — so the
  // read-side trim is tested against a limit this card really exceeds, not against luck.
  const capped = core.capOutput(got, [['card', 4000], ['journal', 15], ['claims', 20]], { maxChars: 40000 });
  ok(capped.card.length <= 4000 && capped.truncated && capped.truncated.card.hiddenChars > 0,
    `card cap: hub_get trims an over-long card and says how much it hid (${capped.card.length} chars, hidden ${capped.truncated && capped.truncated.card && capped.truncated.card.hiddenChars})`);
  ok(JSON.stringify(capped, null, 1).length <= 40000, 'card cap: and the whole answer fits the budget it was given');
  ok(/## Digest/.test(capped.card), 'card cap: what survives the cut is the head — the snapshot, not the tail');
  fs.rmSync(CL, { recursive: true, force: true });
}

/* ── the half of mesh health only a PEER can see ──
 * A node whose pull keeps aborting knows it and nobody reads its doctor; from every other node it
 * simply stops appearing in the shared history. One sat 77 commits behind on one card conflict. */
{
  const MN = mktmp();
  const git = (args, env) => execSync(`git -C ${MN} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env } });
  git('init -q -b main');
  const commitAs = (node, file, iso) => {
    fs.writeFileSync(path.join(MN, file), String(Date.now()) + Math.random());
    git('add -A');
    git(`-c user.name=${node} -c user.email=x@x commit -q -m sync`,
      { GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });
  };
  const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
  commitAs('Pine', 'journal.pine.jsonl', iso(30));     // raw hostname vs normalised file name
  commitAs('fir', 'journal.fir.jsonl', iso(0.2));
  fs.writeFileSync(path.join(MN, 'journal.pine-agent.jsonl'), '{}\n');   // absorbed: never a committer
  core.setHubBase(MN); core.ensureHubDirs();
  const quiet = doc.meshNodes({ staleHours: 6 });
  ok(quiet.length === 1 && quiet[0].node === 'pine' && quiet[0].ageHours >= 29,
    `mesh peers: the node that stopped pushing is named, matched across hostname case (got ${JSON.stringify(quiet)})`);
  ok(!quiet.find(n => n.node === 'pine-agent'),
    'mesh peers: a node that never committed here is an absorbed log, not a machine gone quiet');
  ok(doc.meshNodes({ staleHours: 72 }).length === 0, 'mesh peers: within the threshold, nothing is reported');
  // A mesh nobody has touched for days says nothing about any single node.
  const MN2 = mktmp();
  const git2 = (args, env) => execSync(`git -C ${MN2} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env } });
  git2('init -q -b main');
  fs.writeFileSync(path.join(MN2, 'journal.pine.jsonl'), '{}\n');
  git2('add -A');
  git2('-c user.name=Pine -c user.email=x@x commit -q -m sync', { GIT_COMMITTER_DATE: iso(200), GIT_AUTHOR_DATE: iso(200) });
  core.setHubBase(MN2); core.ensureHubDirs();
  ok(doc.meshNodes({ staleHours: 6 }).length === 0,
    'mesh peers: a mesh where NOBODY has committed lately is a quiet week, not a stuck node');
  for (const d of [MN, MN2]) fs.rmSync(d, { recursive: true, force: true });
}

/* ── a broadcast role has no single "pending", so no single number is printed ──
 * The shared cursor of a fan-out role is never advanced by anyone — every reader keeps its own —
 * so the arithmetic against it only grows. It was read as a delivery failure and quoted as
 * evidence for one, about a role that was working all day. */
{
  const FL = mktmp();
  fs.mkdirSync(path.join(FL, 'queues'), { recursive: true });
  fs.writeFileSync(path.join(FL, 'subscriber-roles.json'), JSON.stringify(['head']));
  core.setHubBase(FL); core.ensureHubDirs();
  queueLib.queueSend('head', 'one', { from: 'orch', root: FL, node: 'n1' });
  queueLib.queueSend('head', 'two', { from: 'orch', root: FL, node: 'n1' });
  await queueLib.queueWait('head', { timeout: 0, root: FL, subscriber: 'reader-a' });    // reads both
  queueLib.queueSend('head', 'three', { from: 'orch', root: FL, node: 'n1' });
  const row = queueLib.queueLedger({ root: FL }).roles.find(r => r.role === 'head');
  ok(row.fanout && row.pending === null && row.delivered === null,
    `fanout ledger: no shared delivered/pending is reported (got ${row.delivered}/${row.pending})`);
  ok(row.total === 3 && row.sharedCursorPending === 3,
    `fanout ledger: the shared-cursor arithmetic is kept for forensics, out of the headline (got ${row.sharedCursorPending})`);
  const ra = row.readers.find(x => x.subscriber === 'reader-a');
  ok(ra && ra.delivered === 2 && ra.behind === 1,
    `fanout ledger: each reader's own position and how far behind it is (got ${ra && ra.delivered}/${ra && ra.behind})`);
  fs.rmSync(FL, { recursive: true, force: true });
}

/* ── in a SHARED hub, a file hubd creates is writable by the group ──
 * Measured on bsdbox 2026-09-14: the role ran as `freebsd`, its cursor had been created by
 * `agent` with the default umask (rw-r--r--), and nine orders could not be delivered because the
 * byte offset could not be advanced. Neither user could repair it — chmod needs ownership. */
if (process.getuid && process.getuid() !== 0) {
  const SH = mktmp(), PV = mktmp();
  for (const d of [SH, PV]) fs.mkdirSync(path.join(d, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(SH, '.qstate'), { recursive: true });
  for (const d of [SH, path.join(SH, 'queues'), path.join(SH, '.qstate')]) fs.chmodSync(d, 0o770);
  fs.chmodSync(PV, 0o700); fs.chmodSync(path.join(PV, 'queues'), 0o700);
  const groupRW = (f) => (fs.statSync(f).mode & 0o060) === 0o060;
  core.setHubBase(SH); core.ensureHubDirs();
  queueLib.queueSend('w', 'an order', { from: 'orch', root: SH, node: 'n1' });
  await queueLib.queueWait('w', { timeout: 0, root: SH });
  core.journalAppend({ ts: core.now(), project: 'p', agent: 'dev-t', kind: 'note', text: 'x' });
  ok(groupRW(path.join(SH, 'queues', 'w.n1.queue.md')), 'shared hub: a queue file is group-writable');
  ok(groupRW(path.join(SH, '.qstate', 'w.n1.queue.md.offset')), 'shared hub: so is the cursor — the file the stall was about');
  ok(groupRW(core.JOURNAL), 'shared hub: so is the journal this node appends to');
  core.setHubBase(PV); core.ensureHubDirs();
  queueLib.queueSend('w', 'an order', { from: 'orch', root: PV, node: 'n1' });
  ok(!groupRW(path.join(PV, 'queues', 'w.n1.queue.md')), 'private hub: modes are left exactly as the umask made them');
  for (const d of [SH, PV]) fs.rmSync(d, { recursive: true, force: true });
}

// ── node-local files stay node-local, through .git/info/exclude: it never travels, so no two nodes
// append different lines to a tracked file; the shared .gitignore is completed by `hub init` only ──
const GI = mktmp();
{
  const gEnv = { HUBD_DIR: GI, HUBD_TEAM_DIR: GI };
  fs.writeFileSync(path.join(GI, '.gitignore'), 'node_modules/\n');
  execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m seed', { cwd: GI, stdio: 'pipe' });
  const exclude = path.join(GI, '.git', 'info', 'exclude');
  const d0 = run('doctor', gEnv);
  ok(/NOT IGNORED here {2}WARNING — .*\.mesh-freeze/.test(d0.out), 'doctor: a node-local file nothing ignores here is a warning');
  const fr = run('freeze "testing the ignore lines" --by dev-t', gEnv);
  const ex = fs.readFileSync(exclude, 'utf8');
  ok(fr.code === 0 && /^\.mesh-freeze$/m.test(ex) && /^\.qstate\/$/m.test(ex) && /^presence\/$/m.test(ex) && /^\.checkins\.json$/m.test(ex),
    'gitignore: freeze puts the node-local lines in .git/info/exclude (presence/ with its slash, .checkins.json)');
  ok(fs.readFileSync(path.join(GI, '.gitignore'), 'utf8') === 'node_modules/\n', 'gitignore: and leaves the tracked .gitignore byte for byte as it was');
  run('unfreeze', gEnv);
  const d1 = run('doctor', gEnv);
  ok(!/NOT IGNORED/.test(d1.out) && /ignored by \.git\/info\/exclude only — `hub init /.test(d1.out),
    'doctor: lines only the exclude file has are a note pointing at hub init, not a warning');
  run('init ' + GI, gEnv);
  const gi = fs.readFileSync(path.join(GI, '.gitignore'), 'utf8');
  ok(/^node_modules\/$/m.test(gi) && /^\.mesh-freeze$/m.test(gi) && /^\.qstate\/$/m.test(gi), 'gitignore: hub init completes the shared .gitignore, its own lines kept');
  ok(!/exclude only/.test(run('doctor', gEnv).out), 'doctor: and then has nothing to say about it');
  execSync('echo "{}" > .mesh-freeze && git add -f .mesh-freeze && git -c user.name=t -c user.email=t@t commit -q -m oops && rm .mesh-freeze', { cwd: GI, stdio: 'pipe' });
  const doc = run('doctor', gEnv);
  ok(/TRACKED anyway {2}WARNING — \.mesh-freeze/.test(doc.out), 'doctor: a node-local file git tracks anyway is a warning, with how to untrack it');
  const fr2 = run('freeze "again" --by dev-t', gEnv);
  ok(/WARNING: \.mesh-freeze is TRACKED/.test(fr2.out), 'freeze: says so when its marker would travel with a hand-made commit');
  run('unfreeze', gEnv);
}

// ── doctor on a fresh team is ok; a stale lock and a cursor past the end are warnings ──
{
  const D = mktmp(), hub = path.join(D, 'hub'), team = path.join(D, 'team'); fs.mkdirSync(team);
  const env = { HUBD_DIR: hub, HUBD_TEAM_DIR: team, HUBD_QUEUE_DIR: team };
  const dr = () => cli(['doctor'], { env, cwd: team });
  cli(['init', team], { env });
  const d0 = dr(), tail0 = d0.out.trim().split('\n').pop();
  ok(d0.code === 0 && /doctor:/i.test(tail0) && /ok/i.test(tail0), `doctor: a fresh team is ok, exit 0 (last line: ${tail0})`);
  fs.mkdirSync(hub, { recursive: true });
  const lock = path.join(hub, 'tasks.json.lock'), past = Date.now() / 1000 - 120;
  fs.writeFileSync(lock, ''); fs.utimesSync(lock, past, past);
  const d1 = dr();
  ok(d1.code !== 0 && /stale/i.test(d1.out), 'doctor: a two-minute-old task lock is a stale-lock warning, exit non-zero');
  fs.rmSync(lock);
  // the cursor is keyed by the FULL file name, the path the consumer writes and doctor must read
  fs.mkdirSync(path.join(team, '.qstate'), { recursive: true }); fs.mkdirSync(path.join(team, 'queues'), { recursive: true });
  fs.writeFileSync(path.join(team, 'queues', 'smoketest.queue.md'), '');
  fs.writeFileSync(path.join(team, '.qstate', 'smoketest.queue.md.offset'), '999999');
  const d2 = dr();
  ok(d2.code !== 0 && /offset beyond file size/i.test(d2.out), 'doctor: a cursor past the end of its file is the offset warning, exit non-zero');
}

// ── HUBD_TEAM_DIR alone names the whole hub, not only the queues ──
// A fleet that passes one directory to every role expects presence, journal and tasks there too.
{
  const ONLY = mktmp(), env = { HUBD_DIR: undefined, HUBD_QUEUE_DIR: undefined, HUBD_TEAM_DIR: ONLY };
  ok(cli(['doctor'], { env, cwd: ONLY }).out.includes(`path:     ${ONLY}  (via env HUBD_TEAM_DIR)`), 'team dir: HUBD_TEAM_DIR without HUBD_DIR is the hub base, and doctor says so');
  cli(['task', 'add', 'one dir', '-p', 'onlyproj', '--by', 'smoke'], { env, cwd: ONLY });
  ok(fs.readdirSync(ONLY).some(f => /^tasks\..*\.events\.jsonl$/.test(f)), 'team dir: a task filed under HUBD_TEAM_DIR lands in that directory');
  const H = mktmp();
  ok(cli(['doctor'], { env: { HUBD_DIR: H, HUBD_TEAM_DIR: ONLY } }).out.includes(`path:     ${H}  (via env HUBD_DIR)`), 'team dir: HUBD_DIR still wins when both are set');
}

// ── freeze is the stop-cock, and a forgotten one is not silent ──
{
  const F = mktmp(), env = { HUBD_DIR: F, HUBD_TEAM_DIR: F };
  const f0 = cli(['freeze'], { env });
  ok(f0.code !== 0 && /say why/.test(f0.out), 'freeze: refused without a reason');
  const f1 = cli(['freeze', 'purge duplicate blocks', '--by', 'dev-t'], { env });
  ok(f1.code === 0 && fs.existsSync(path.join(F, '.mesh-freeze')) && /mesh: FROZEN/.test(cli(['doctor'], { env }).out),
    'freeze: writes the marker mesh-sync looks for, and doctor states it');
  ok(/FROZEN/.test(execSync(`sh ${REPO}/scripts/mesh-sync.sh 2>&1`, { env: { ...process.env, HUBD_DIR: F }, encoding: 'utf8' })), 'freeze: mesh-sync skips the run and says why');
  const f2 = cli(['unfreeze'], { env });
  ok(f2.code === 0 && !fs.existsSync(path.join(F, '.mesh-freeze')) && /Unfrozen/.test(f2.out), 'unfreeze: removes it and says the mesh runs again');
}

done();
