// audit.mjs — rules and audit: a check or an admitted wish, incidents that quote the owner, the audit passes
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, ok, mktmp, T0, core, cardsLib, done } from './_h.mjs';

// ── rules: a check, or an admitted wish ──
const RL = mktmp();
core.setHubBase(RL); core.ensureHubDirs();
fs.writeFileSync(path.join(RL, 'projects', 'shop.md'),
  '# shop\n\n- slug: shop\n- set: 2026-08-09 10:00 by dev-t\n\nMODE: active — selling\n\n## Digest\n\nx\n\n## Gates\n\n- 100 paying users, or stop\n');
fs.writeFileSync(path.join(RL, 'projects', 'craft.md'),
  '# craft\n\n- slug: craft\n- set: 2026-08-09 10:00 by dev-t\n\n## Digest\n\ny\n\n## Gates\n\n- not a money bet, no date on purpose\n');
const lintQuiet = core.runLint({});
ok(!lintQuiet.findings.some(f => f.id === 'gate-without-date') && lintQuiet.notes.some(n => /no money bets are declared/.test(n)),
  'lint: with no money bet declared the gate rule checks nothing AND says so (silence is reported, not implied)');
fs.writeFileSync(path.join(RL, 'rules.json'), JSON.stringify({
  money: ['shop'],
  strict: { 'gate-without-date': true, rejectNoteOnlyReport: true },
  laws: { 'gate-without-date': { text: 'A money bet without a dated gate goes to background', since: '2026-07-04' } },
}));
const lintOn = core.runLint({});
const gwd = lintOn.findings.filter(f => f.id === 'gate-without-date');
ok(gwd.length === 1 && gwd[0].project === 'shop',
  `lint: only the DECLARED money bet is held to the gate rule (got ${gwd.map(f => f.project).join(',') || 'none'})`);
ok(gwd[0].enforced === true && gwd[0].lawDeclared === true && gwd[0].lawSince === '2026-07-04',
  'lint: the finding quotes the local law with its date and says it is enforced');
core.runTaskAdd({ project: 'shop', text: 'ask the owner to post it', cat: 'communicative', by: 'dev-t' });
const humanTask = core.runTaskAdd({ project: 'shop', text: 'owner posts it', cat: 'communicative', by: 'dev-t' }).task;
core.runTaskUpdate({ id: humanTask.id, by: 'dev-t', tags: [] });   // no-op edit, keeps shape
fs.appendFileSync(path.join(RL, `tasks.${core.JOURNAL_NODE}.events.jsonl`),
  JSON.stringify({ ts: core.now(), node: core.JOURNAL_NODE, ev: 'set', id: humanTask._origin ? humanTask._origin.id : humanTask.id, patch: { owner_kind: 'human' } }) + '\n');
const lintBtn = core.runLint({}).findings.filter(f => f.id === 'button-without-prep');
ok(lintBtn.length === 1 && String(lintBtn[0].task) === String(humanTask.id),
  `lint: a human-owned communicative task with no prep is flagged (got ${lintBtn.length})`);
core.runTaskUpdate({ id: humanTask.id, depends_on: [1], by: 'dev-t' });
ok(!core.runLint({}).findings.some(f => f.id === 'button-without-prep'),
  'lint: giving it a prep it depends on clears the finding');

// strict: prose-only reports are refused ONLY when the instance opted in, and an explicit
// NOTE: is a deliberate aside, not the thing being refused
let strictErr = '';
try { core.runReport({ project: 'shop', by: 'dev-t', text: 'just working on it' }); } catch (e) { strictErr = e.message; }
ok(/strict/.test(strictErr) && /hub claim/.test(strictErr), 'strict: a prose-only report is refused with the alternative named');
ok(core.runReport({ project: 'shop', by: 'dev-t', text: 'NOTE: a real aside' }).note === true,
  'strict: an explicit NOTE: still lands — the message promises that, so it must be true');
ok(core.runReport({ project: 'shop', by: 'dev-t', text: 'FACT: three paying users' }).facts === 1,
  'strict: a structured report is untouched');
fs.writeFileSync(path.join(RL, 'rules.json'), '{}');
ok(core.runReport({ project: 'shop', by: 'dev-t', text: 'prose again' }).note === true,
  'strict: off by default — an upgrade never starts refusing writes uninvited');

// ── audit: declarations vs behaviour, filed as incidents that quote the owner ──
const AUD = mktmp();
core.setHubBase(AUD); core.ensureHubDirs();
fs.writeFileSync(path.join(AUD, 'rules.json'), JSON.stringify({
  money: ['shop'],
  laws: { 'gate-expired': { text: 'An expired gate means background until a DECIDE sets a new date', since: '2026-07-04' } },
}));
fs.writeFileSync(path.join(AUD, 'projects', 'shop.md'),
  '# shop\n\n- slug: shop\n- set: 2026-08-09 10:00 by dev-t\n\nMODE: active — selling\n\n## Digest\n\nx\n\n## Gates\n\n- 100 paying users by 2026-07-01, or stop\n');
fs.writeFileSync(path.join(AUD, 'projects', 'hobby.md'),
  '# hobby\n\n- slug: hobby\n- set: 2026-08-09 10:00 by dev-t\n\nMODE: background — for fun\n\n## Digest\n\ny\n');
const auRows = [];
for (let i = 0; i < 9; i++) auRows.push({ ts: `2026-08-09 10:0${i}`, project: 'hobby', agent: 'dev-t', kind: 'note', text: 'tinkering' });
auRows.push({ ts: '2026-08-09 11:00', project: 'shop', agent: 'dev-t', kind: 'note', text: 'one shop thing' });
fs.writeFileSync(path.join(AUD, 'journal.t.jsonl'), auRows.map(r => JSON.stringify(r)).join('\n') + '\n');
const au = core.runAudit({ days: 3650 });
const auGate = au.findings.find(f => f.id === 'gate-expired');
const auAttn = au.findings.find(f => f.id === 'attention-vs-mode');
ok(auGate && auGate.project === 'shop' && /2026-07-01/.test(auGate.what),
  'audit: a money bet whose gate date passed with no decision since is a finding');
ok(auGate.lawDeclared && auGate.lawSince === '2026-07-04',
  'audit: the incident quotes the owner\'s own rule and the date it was written');
ok(auAttn && auAttn.project === 'hobby' && /90%/.test(auAttn.what),
  `audit: a background project taking most of the attention is a finding (got ${auAttn && auAttn.what})`);
ok(au.numbers && au.numbers.attentionShare && !au.findings.some(f => f.id === 'done-rate'),
  'audit: close rates are numbers in the report, never filed as violations');
ok(au.apply === false && core.runTaskList({ status: 'all' }).count === 0, 'audit: read-only unless asked');

// ── audit (7)+(8): the end-of-session dump, and commits with no journal ──
{
  const TE = mktmp();
  core.setHubBase(TE); core.ensureHubDirs();
  const at = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const line = (agent, kind, text, minAgo) => JSON.stringify({ ts: at(minAgo), project: 'psy', agent, kind, text }) + '\n';
  // "dumper": one bookkeeping line an hour ago, then three structured lines in the last minute.
  // "steady": three structured lines spread across the hour. Same day for both, by construction.
  fs.writeFileSync(path.join(TE, 'journal.t.jsonl'),
    line('dumper', 'task', '+ task #1: start', 60) + line('dumper', 'decision', 'd1', 1) + line('dumper', 'note', 'n1', 1) + line('dumper', 'done', '#1 x', 0) +
    line('steady', 'decision', 's1', 50) + line('steady', 'note', 's2', 25) + line('steady', 'done', '#2 y', 1));
  const a80 = core.runAudit({ days: 1, git: false });
  const dump = a80.findings.filter(f => f.id === 'report-at-end-only');
  ok(dump.length === 1 && dump[0].agent === 'dumper' && /3 structured entries/.test(dump[0].what) && /60-min trace|59-min trace|61-min trace/.test(dump[0].what),
    `audit: the end-of-session dump is found for the dumper only (${dump.map(f => f.agent).join(',')}: ${dump[0] && dump[0].what})`);
  ok(/moment of the finding/.test(dump[0].law) && /calendar day/.test(a80.notes.join(' ')), 'audit: the finding quotes the law and the notes say the session is approximated by the day');
  // A heartbeat extends the trace: with the dumper's presence record now, the structured burst is still at the end.
  core.runHeartbeat({ agent: 'dumper', role: 'auditor' });
  ok(core.runAudit({ days: 1, git: false }).findings.some(f => f.id === 'report-at-end-only'), 'audit: presence counts as activity in the trace');
  // (8) a local checkout with five commits today and a project journal with nothing
  const repo = path.join(TE, 'repo'); fs.mkdirSync(repo, { recursive: true });
  const git = (c) => execSync(`git ${c}`, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init -q'); for (let i = 0; i < 5; i++) { fs.writeFileSync(path.join(repo, 'f.txt'), String(i)); git('add f.txt'); git(`commit -q -m c${i}`); }
  fs.writeFileSync(path.join(TE, 'projects', 'silent.md'), `# silent\n\n- slug: silent\n- path: ${repo}\n- synced: ${at(0)} by t\n\n## Digest\n\nquiet\n`);
  const a80g = core.runAudit({ days: 7 });
  const wwj = a80g.findings.find(f => f.id === 'work-without-journal');
  ok(wwj && wwj.project === 'silent' && /5 commit/.test(wwj.what), `audit: five commits and no journal entry is a finding (${wwj && wwj.what})`);
  fs.appendFileSync(path.join(TE, 'journal.t.jsonl'), JSON.stringify({ ts: at(0), project: 'silent', agent: 'dev', kind: 'note', text: 'learned x' }) + '\n');
  ok(!core.runAudit({ days: 7 }).findings.some(f => f.id === 'work-without-journal'), 'audit: one journal entry for the project clears it');
  ok(!core.runAudit({ days: 7, git: false }).notes.some(n => /work-without-journal/.test(n)), 'audit: git:false skips the checkout scan entirely');
  fs.rmSync(TE, { recursive: true, force: true });
  core.setHubBase(AUD); core.ensureHubDirs();
}
const applied = core.runAudit({ days: 3650, apply: true, by: 'auditor-t' });
ok(applied.filed.length === applied.findings.length && applied.filed.length >= 2,
  `audit: apply files one incident per finding (${applied.filed.length}/${applied.findings.length})`);
const incident = core.runTaskList({ status: 'open' }).tasks.find(t => /AUDIT gate-expired/.test(t.text));
ok(incident && /Rule: An expired gate/.test(incident.text) && /\[audit:gate-expired:shop:2026-07-01\]/.test(incident.text),
  'audit: the incident carries the quoted rule and a stable key');
const twice = core.runAudit({ days: 3650, apply: true, by: 'auditor-t' });
ok(twice.filed.length === 0 && twice.skipped.length === applied.filed.length,
  `audit: a second pass files nothing — keyed dedup, so a weekly run cannot pile up (${twice.filed.length} filed)`);
// The keys are not the only way a weekly pass could grow its own backlog: filing an incident
// writes a journal line FOR that project, which once made the project's card look 17 days behind
// its journal on the next run — an incident generated by the act of filing an incident. Bookkeeping
// kinds are excluded from the freshness signal; a third pass is the proof it converged.
const thrice = core.runAudit({ days: 3650, apply: true, by: 'auditor-t' });
ok(thrice.filed.length === 0,
  `audit: it does not generate findings out of its own bookkeeping (${thrice.filed.length} filed on the third pass)`);
ok(!core.runAudit({ days: 3650 }).findings.some(f => f.id === 'card-behind-journal'),
  'audit: a card is behind when WORK it does not reflect happened, not when the tracker took notes');
core.runReport({ project: 'shop', by: 'dev-t', text: 'DECIDE: shop stays active, new gate 2026-12-01 | two paying users appeared' });
ok(!core.runAudit({ days: 3650 }).findings.some(f => f.id === 'gate-expired'),
  'audit: a DECIDE recorded after the gate date clears the finding — the verdict is what was missing');
ok(core.runAudit({ days: 3650 }).notes.some(n => /buttons not checked/.test(n)),
  'audit: with no queue rows passed in, the button check says it was skipped instead of reporting all-clear');

// ── audit pass 2026-09-23: each of these was a live defect ──
const AUP = mktmp();
core.setHubBase(AUP); core.ensureHubDirs();
{
  // capOutput: a string cut is reported in characters. The hint read "undefined shown".
  const c = core.capOutput({ card: 'x'.repeat(20000) }, [['card', 12000]]);
  ok(/card: 12000 chars shown, 8000 hidden/.test(c.hint) && !/undefined/.test(c.hint), `budget: a cut string is described in chars (got ${c.hint.slice(0, 80)})`);

  // hub_section_add grew a card with no cap — the one write path 0.9.23 did not rotate.
  fs.writeFileSync(path.join(AUP, 'limits.json'), JSON.stringify({ card: { sectionBytes: 400 } }));
  core.runCardSet({ project: 'sec', digest: 'state', by: 'dev-t' });
  let last;
  for (let i = 0; i < 20; i++) last = core.runSectionAdd({ project: 'sec', section: 'gates', text: `gate line ${i} ` + 'y'.repeat(30), by: 'dev-t' });
  const gates = core.sectionBody(core.readCard('sec'), 'Gates');
  ok(Buffer.byteLength(gates, 'utf8') <= 520 && /gate line 19/.test(gates) && /older entries moved to/.test(gates),
    `section add: an over-cap section rotates on write, newest kept (${Buffer.byteLength(gates, 'utf8')}B)`);
  ok(/gate line 0 /.test(fs.readFileSync(path.join(AUP, 'projects', 'history', 'sec.md'), 'utf8')) && Array.isArray(last.rotated),
    'section add: the oldest lines are in history, and the reply says what moved');
  fs.rmSync(path.join(AUP, 'limits.json'));

  // History files in a shared (group-writable) hub are group-writable too, like every other append.
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(path.join(AUP, 'projects', 'history'), 0o2775);
    core.runCardSet({ project: 'shared', digest: 'one', by: 'dev-t' });
    core.runCardSet({ project: 'shared', digest: 'two', by: 'dev-t' });
    const mode = fs.statSync(path.join(AUP, 'projects', 'history', 'shared.md')).mode;
    ok((mode & 0o060) === 0o060, `history: a digest archived in a shared hub is group rw (mode ${(mode & 0o777).toString(8)})`);
  }

  // DECIDE: kept only the first two "|" parts.
  core.runReport({ project: 'dec', by: 'dev-t', text: 'DECIDE: ship it | tests pass | and the owner agreed' });
  ok(/ship it — tests pass \| and the owner agreed/.test(core.readCard('dec')), 'report: DECIDE splits on the first "|" only, the rest stays in the why');
  ok(core.journalTail('dec', 3).some(e => e.kind === 'decision' && /and the owner agreed/.test(e.text)), 'report: and the journal copy is whole too');

  // A claim written without ttlMin made the conflict warning throw after the new claim was saved.
  fs.writeFileSync(path.join(AUP, 'claims.json'), JSON.stringify({ claims: [{ id: 'old', project: 'p', area: 'src/**', agent: 'legacy-agent', since: core.now() }] }));
  let cl = null, clErr = null;
  try { cl = core.runClaim({ project: 'p', area: 'src/**', agent: 'dev-t' }); } catch (e) { clErr = e.message; }
  ok(cl && /claimed by legacy-agent until/.test(cl.warning || ''), `claim: a legacy claim with no ttlMin still yields a warning, not a crash (${clErr || cl.warning})`);

  // A role or subscriber is a path component, checked before any disk access.
  const qlib = await import(path.join(REPO, 'hub/lib/queue.mjs'));
  let qe = null; try { qlib.queueSend('../evil', 'x', { from: 'dev-t', root: AUP }); } catch (e) { qe = e.message; }
  ok(/invalid role/.test(qe || ''), 'queue: send refuses a role with a path separator');
  qe = null; try { await qlib.queueWait('ok-role', { root: AUP, timeout: 0, subscriber: '../../x' }); } catch (e) { qe = e.message; }
  ok(/invalid subscriber/.test(qe || ''), 'queue: wait refuses a subscriber that would leave .qstate');
  qe = null; try { qlib.queueSend('head-orchestrator', 'x', { from: 'dev-t', root: AUP }); } catch (e) { qe = e.message; }
  ok(qe === null, 'queue: an ordinary role name still works');

  // whereami ran the marker's inventory through a shell, where "$(...)" in the path expands.
  const WI = mktmp();
  const script = 'inv$(touch pwned).sh';
  fs.writeFileSync(path.join(WI, script), '#!/bin/sh\necho inventory-ok\n', { mode: 0o755 });
  fs.writeFileSync(path.join(WI, '.hubd'), 'wi\n' + script + '\n');
  const w = core.runWhereAmI({ cwd: WI });
  ok(/inventory-ok/.test((w.localInventory || {}).output || '') && !fs.existsSync(path.join(WI, 'pwned')),
    `whereami: the inventory script runs without a shell — no $(...) expansion (${JSON.stringify(w.localInventory).slice(0, 80)})`);
  fs.rmSync(WI, { recursive: true, force: true });
}
core.setHubBase(T0); core.ensureHubDirs();

// ── audit tails: the author rule everywhere, the lock steal, the secret store behind a symlink ──
const TL = mktmp();
core.setHubBase(TL); core.ensureHubDirs();
{
  let e1 = null; try { core.runClaim({ project: 'p', area: 'x', agent: 'claude' }); } catch (e) { e1 = e.message; }
  ok(/names a model/.test(e1 || ''), 'author: a claim holder is held to the author rule');
  let e2 = null; try { core.runHeartbeat({ agent: 'agent' }); } catch (e) { e2 = e.message; }
  ok(/names a model|placeholder/.test(e2 || ''), 'author: a heartbeat name is held to the author rule');
  let e3 = null; try { cardsLib.runCardsCompact({ apply: true }); } catch (e) { e3 = e.message; }
  ok(/by required/.test(e3 || ''), 'author: cards compact --apply needs an author');

  // A stale lock is stolen, and nothing is left behind by the steal.
  const lf = path.join(TL, 'claims.json.lock');
  fs.writeFileSync(lf, '');
  const old = (Date.now() - 120000) / 1000; fs.utimesSync(lf, old, old);
  const c = core.runClaim({ project: 'p', area: 'y', agent: 'dev-t' });
  ok(c.ok && !fs.existsSync(lf) && !fs.readdirSync(TL).some(f => f.includes('.stale.')), 'lock: a stale lock is stolen by rename and leaves no grave file');

  // The secret store must not be reachable inside the replicated tree through a symlink.
  const sec = await import(path.join(REPO, 'hub/lib/secrets.mjs'));
  const link = path.join(mktmp(), 'store-link');
  fs.mkdirSync(path.join(TL, 'inside'));
  fs.symlinkSync(path.join(TL, 'inside'), link);
  const prev = process.env.HUBD_SECRETS_DIR; process.env.HUBD_SECRETS_DIR = link;
  let e4 = null; try { sec.assertNotReplicated(TL); } catch (e) { e4 = e.message; }
  ok(/inside the team root/.test(e4 || ''), 'secrets: a store symlinked into the team root is refused');
  if (prev === undefined) delete process.env.HUBD_SECRETS_DIR; else process.env.HUBD_SECRETS_DIR = prev;
  fs.rmSync(path.dirname(link), { recursive: true, force: true });
}
core.setHubBase(T0); core.ensureHubDirs();

done();
