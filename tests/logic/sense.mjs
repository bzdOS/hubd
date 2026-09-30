// sense.mjs — a head's sensor: events from the hub, not from a loop's wording
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, ok, mktmp, run, T0, core, done } from './_h.mjs';

// ── a head's sensor: events from the hub, not from a loop's wording ──
const SN = mktmp();
core.setHubBase(SN);
{
  const sense = await import(path.join(REPO, 'hub/lib/sense.mjs'));
  const cfg = { ...sense.SENSE_DEFAULTS, quietRe: [/^still waiting/i], privateRe: [] };
  const nowS = Date.parse('2026-05-01T12:00:00Z') / 1000;
  const ts = (minAgo) => new Date((nowS - minAgo * 60) * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const W = (o) => ({ agent: 'w', last_seen: ts(1), ...o });
  const ws = (p) => sense.workerState(p, nowS, cfg)[0];
  ok(ws(null) === 'unknown' && ws(W({ last_seen: ts(45) })) === 'dead' && ws(W({ silent_count: 3 })) === 'stuck' &&
    ws(W({ state: 'exit', exit_reason: 'account out' })) === 'exit' && ws(W({ state: 'waiting', empty_count: 4 })) === 'idle' &&
    ws(W({ state: 'waiting', empty_count: 1 })) === 'busy' && ws(W({ state: 'turn', turn: 2, turn_started: ts(150) })) === 'long' &&
    ws(W({ state: 'turn', turn: 2, turn_started: ts(10) })) === 'busy' && ws(W({ status: 'free text only' })) === 'busy',
    'sense: a worker\'s state is read from heartbeat fields — dead, stuck, exit, idle, long, busy — and free text alone judges nothing');

  const conf = { head: 'h', project: 'p', repo: '', base: 'main', review: '', workers: ['a', 'b'], idleMin: { b: 40 }, cwd: {} };
  const st = {};
  const pres = { a: W({ agent: 'a', state: 'waiting', empty_count: 1, state_since: ts(20) }), b: W({ agent: 'b', state: 'waiting', empty_count: 1, state_since: ts(20) }) };
  const ents = [{ ts: ts(30), agent: 'a', text: 'old report', project: 'p' }, { ts: ts(30), agent: 'b', text: 'old report of b', project: 'p' }];
  const r1 = sense.collectEvents(conf, st, nowS, pres, [{ id: 't1', assignee: 'a', status: 'open' }], ents, null, null, {}, cfg);
  ok(r1.ev.map(e => e[0]).join(',') === '' , 'sense: a worker seen waiting for the first time is not idle yet — the sensor starts its own clock');
  const stI = { waiting: { a: nowS - 20 * 60, b: nowS - 20 * 60 } };
  const presI = { a: W({ agent: 'a', state: 'waiting', empty_count: 9 }), b: W({ agent: 'b', state: 'waiting', empty_count: 9 }) };
  const rI = sense.collectEvents(conf, stI, nowS, presI, [{ id: 't1', assignee: 'a', status: 'open' }], [], null, null, {}, cfg);
  ok(rI.ev.map(e => e[0]).join(',') === 'idle:a' && /t1/.test(rI.ev[0][2]),
    'sense: 20 min waiting is idle for a role on the default threshold; a role with its own idle_min is judged by time only, whatever its empty count');
  ok(!r1.ev.some(e => e[0].startsWith('rep:')), 'sense: the first pass only marks the journal, it does not replay history as reports');
  st.waiting = { a: nowS - 20 * 60 };
  const r2a = sense.collectEvents(conf, st, nowS + 30, pres, [], ents, null, null, {}, cfg);
  const r2 = sense.collectEvents(conf, st, nowS + 60, pres, [], ents, null, null, {}, cfg);
  ok(r2a.ev.map(e => e[0]).join() === 'idle:a' && !r2.ev.length, 'sense: a standing condition is raised once and not repeated on the next pass');
  const twin = { ts: ts(-2), agent: 'b', text: '#t9 · Handoff b: the parser is merged, tests green on main', project: 'p' };
  const ents2 = [...ents, { ts: ts(-1), agent: 'a', text: 'branch task/x ready', project: 'p' }, { ts: ts(-1), agent: 'b', text: 'still waiting for an order', project: 'p' },
    twin, { ts: ts(-2), agent: 'b', text: 'EMPTY TURN, nothing to report here at all', project: 'p' }];
  const qb = { b: [[nowS + 60, 'report to head: handoff b: the parser is merged, tests green on main. details follow']] };
  const r3 = sense.collectEvents(conf, st, nowS + 180, pres, [], ents2, null, null, qb, cfg);
  ok(r3.ev.some(e => e[0] === `rep:a:${ts(-1)}:${sense.entryHash(ents2.find(e => e.text === 'branch task/x ready'))}`) && !r3.ev.some(e => e[0].startsWith('rep:b:') && /parser is merged/.test(e[2])),
    'sense: a new report wakes the head; a "still waiting" line and a report whose text the worker already sent to the head\'s queue do not');
  ok(r3.ev.some(e => e[0].startsWith('rep:b:') && /EMPTY TURN/.test(e[2])), 'sense: a twin is matched by text, not by time — another report of the same minutes still wakes the head');
  ok(sense.isTwin(twin, qb.b, cfg) && !sense.isTwin({ ...twin, text: 'short' }, qb.b, cfg) && !sense.isTwin({ ...twin, ts: ts(-120) }, qb.b, cfg),
    'sense: a twin needs 20+ characters of the first line inside a queue message of that sender, within the window');
  // two reports of one minute: the second is not lost; more than three are summed up, not dropped
  const stM = {};
  sense.collectEvents(conf, stM, nowS, pres, [], [{ ts: ts(10), agent: 'a', text: 'first', project: 'p' }], null, null, {}, cfg);
  const same = [{ ts: ts(10), agent: 'a', text: 'first', project: 'p' }, { ts: ts(10), agent: 'a', text: 'second of the same minute', project: 'p' }];
  const rM = sense.collectEvents(conf, stM, nowS + 60, pres, [], same, null, null, {}, cfg);
  ok(rM.ev.filter(e => e[0].startsWith('rep:a:')).length === 1 && rM.ev.some(e => /second of the same minute/.test(e[2])),
    'sense: a second report in the minute of the mark wakes the head, the one already seen does not');
  const many = [1, 2, 3, 4, 5].map(i => ({ ts: ts(-10 - i), agent: 'a', text: 'report number ' + i, project: 'p' }));
  const rN = sense.collectEvents(conf, stM, nowS + 120, pres, [], [...same, ...many], null, null, {}, cfg);
  ok(rN.ev.filter(e => e[0].startsWith('rep:a:') && !e[0].includes(':more:')).length === 3 && rN.ev.some(e => e[0].startsWith('rep:a:more:') && /2 MORE REPORTS/.test(e[2])),
    'sense: beyond three reports the rest is one line saying how many, never silently dropped');
  const fresh = (p) => ({ ...p, last_seen: ts(-64) });   // still heartbeating an hour later
  const pres4 = { a: fresh(pres.a), b: fresh(pres.b) };
  st.waiting.a = nowS + 200;   // a pass after its report saw it waiting again
  const r4 = sense.collectEvents(conf, st, nowS + 3900, pres4, [], ents2, null, null, {}, cfg);
  ok(r4.esc.some(t => /WORKER IDLE: a/.test(t)) && r4.ev.some(e => e[0] === 'idle:a' && /reminder/.test(e[2])),
    'sense: an event still standing is reminded to the head and, after an hour, escalated to the fleet');
  const stD = {};
  const deadP = { a: W({ agent: 'a', last_seen: ts(60) }), b: null };
  sense.collectEvents(conf, stD, nowS, deadP, [], [], null, null, {}, cfg);
  const rD = sense.collectEvents(conf, stD, nowS + 1900, deadP, [], [], null, null, {}, cfg);
  ok(!rD.ev.length && rD.esc.length === 2, 'sense: a worker that is not running goes to the fleet, never to the head');
  const rO = sense.collectEvents(conf, { waiting: { a: nowS - 20 * 60 } }, nowS, presI, [{ id: 't1', assignee: 'a', status: 'open' }, { id: 't2', assignee: 'a', status: 'in_progress' }, { id: 't3', assignee: 'a', status: 'done' }], [], null, null, {}, cfg);
  ok(/open on it: t1, t2\./.test(rO.ev[0][2]), 'sense: a task in progress is still open work on the worker; a done one is not');
  const stB = { wakes: [nowS - 10, nowS - 20, nowS - 30, nowS - 40] };
  ok(!sense.budgetOk(stB, nowS, false, cfg) && sense.budgetOk(stB, nowS, true, cfg), 'sense: past the hourly budget only critical events wake the head');

  // branches: a real repo, a review clone, a task branch
  const G = mktmp();
  const sh = (c, cwd) => execSync(c, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
  sh('git init -q --bare canon.git', G);
  sh(`git clone -q ${G}/canon.git work`, G);
  sh('git checkout -q -b main && echo a > a.txt && git add a.txt && git commit -q -m base && git push -q origin main', path.join(G, 'work'));
  sh('git checkout -q -b task/feat && echo b > b.txt && git add b.txt && git commit -q -m "feat: b" && git push -q origin task/feat', path.join(G, 'work'));
  sh(`git clone -q ${G}/canon.git review`, G);
  core.runResourceSet({ slug: 'h1', type: 'role', attrs: { rank: 'head', project: 'p', repo: path.join(G, 'canon.git'), base: 'main', review: path.join(G, 'review') }, by: 'dev-t' });
  core.runResourceSet({ slug: 'w1', type: 'role', attrs: { rank: 'worker', project: 'p' }, edges: { head: ['h1'] }, by: 'dev-t' });
  // before any pattern is declared: a check with nothing to check with is not a pass
  const [okn, txtn] = sense.checkBranch(sense.senseConf('h1'), 'task/feat');
  ok(okn === false && /FAIL no private patterns declared/.test(txtn), 'sense: with no private patterns declared, a branch fails the checklist — nothing was checked, so nothing passes');
  ok(core.runLint().findings.some(f => f.id === 'private-check-undeclared' && f.role === 'h1'), 'lint: a head that accepts branches of a repo with no private patterns is a finding');
  fs.writeFileSync(path.join(SN, 'sense.json'), JSON.stringify({ private: ['secret-host-[0-9]+'] }));
  ok(!core.runLint().findings.some(f => f.id === 'private-check-undeclared'), 'lint: and declaring them in sense.json clears it');
  const sc = sense.senseConf('h1');
  ok(sc && sc.workers.join(',') === 'w1' && Object.keys(sense.remoteBranches(sc.repo)).join(',') === 'task/feat', 'sense: the head\'s repo and workers come from the registry; task branches are listed');
  const [okc, txt] = sense.checkBranch(sc, 'task/feat');
  ok(okc === true && /commits: 1/.test(txt) && /nothing private/.test(txt), 'sense: a clean branch on the current base passes the checklist');
  sh('git checkout -q task/feat && echo "see secret-host-7" > c.txt && git add c.txt && git commit -q -m leak && git push -q origin task/feat', path.join(G, 'work'));
  const [okp, txtp] = sense.checkBranch(sc, 'task/feat');
  ok(okp === false && /PRIVATE/.test(txtp), 'sense: a branch carrying a declared private pattern fails, the pattern coming from the hub, not the code');
  const rej = sense.runSenseVerdict('h1', 'task/feat', 'reject', 'drop c.txt');
  ok(rej.code === 0 && rej.worker === 'w1' && core.journalSinceMs(0).some(e => e.kind === 'decision' && /^REJECT [0-9a-f]{40} task\/feat/.test(e.text)),
    'sense: a verdict is written to the journal as a decision and the order goes to the branch\'s worker');
  const acc = sense.runSenseVerdict('h1', 'task/feat', 'accept', 'looks fine');
  ok(acc.code === 1 && /REFUSED/.test(acc.text), 'sense: accept is refused for a branch that fails the checklist');
  const ev1 = sense.runSenseEvents('h1', { nowS: Date.now() / 1000 });
  ok(ev1.code === 1 || ev1.events.every(e => !e.key.startsWith('br:task/feat')), 'sense: a branch already decided at this sha is not raised again');
  fs.rmSync(path.join(SN, '.sense'), { recursive: true, force: true });
  const evF = sense.runSenseEvents('h1', { nowS: Date.now() / 1000 });
  ok(evF.events.every(e => !e.key.startsWith('br:task/feat')), 'sense: a fresh sensor state does not re-raise a branch the journal already has a verdict for at that sha');
  sh('git checkout -q task/feat && git rm -q c.txt && git commit -q -m unleak && git push -q origin task/feat', path.join(G, 'work'));
  const ev2 = sense.runSenseEvents('h1', { nowS: Date.now() / 1000 + 5 });
  ok(ev2.code === 0 && ev2.events.some(e => e.key.startsWith('br:task/feat:')) && /hub sense h1 verdict/.test(ev2.text),
    'sense: a new push to the branch is an event, and the text says how to decide it');
  const snap = sense.senseSnapshots();
  ok(snap.h1 && snap.h1.pending.some(k => k.startsWith('br:task/feat:')), 'sense: what the sensor raised is published for boards on every node');
  const cliR = run('sense h1 --json', { HUBD_DIR: SN, HUBD_TEAM_DIR: SN, HUBD_NODE: 'cedar' });
  ok(cliR.code === 1, `sense: the CLI keeps the loop contract — 1 when there is nothing new (got ${cliR.code})`);
  const cliE = run('sense nobody', { HUBD_DIR: SN, HUBD_TEAM_DIR: SN });
  ok(cliE.code >= 2, 'sense: a failure is never mistaken for "no events" (exit above 1)');

  /* A wake held back by the budget puts back everything the pass moved. The journal marks were put
   * back and the fingerprints of the mark's minute were not: the held-back report then counted as
   * seen, and the head never got it. */
  core.runResourceSet({ slug: 'h2', type: 'role', attrs: { rank: 'head', project: 'p2' }, by: 'dev-t' });
  core.runResourceSet({ slug: 'w2', type: 'role', attrs: { rank: 'worker', project: 'p2' }, edges: { head: ['h2'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'w3', type: 'role', attrs: { rank: 'worker', project: 'p2' }, edges: { head: ['h2'] }, by: 'dev-t' });
  core.runHeartbeat({ agent: 'w2', state: 'turn', turn: 1, turn_started: 'now' });
  const T = core.now();
  core.journalAppend({ ts: T, project: 'p2', agent: 'w2', kind: 'note', text: 'first report of the minute' });
  ok(sense.runSenseEvents('h2').code === 1, 'sense budget: the first pass only marks the journal');
  core.journalAppend({ ts: T, project: 'p2', agent: 'w2', kind: 'note', text: 'second report of the same minute' });
  const sp = path.join(sense.senseDir(), 'head.h2.json');
  const busy = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const hBefore = JSON.stringify(busy.journal_h);
  busy.wakes = [1, 2, 3, 4].map(i => Date.now() / 1000 - i * 60);
  fs.writeFileSync(sp, JSON.stringify(busy));
  const held = sense.runSenseEvents('h2');
  const after = JSON.parse(fs.readFileSync(sp, 'utf8'));
  ok(held.code === 1 && JSON.stringify(after.journal_h) === hBefore && after.journal.w2 === busy.journal.w2,
    `sense budget: a held-back wake restores the journal mark AND the minute's fingerprints (${JSON.stringify(after.journal_h)})`);
  after.wakes = []; fs.writeFileSync(sp, JSON.stringify(after));
  const late = sense.runSenseEvents('h2');
  ok(late.code === 0 && /second report of the same minute/.test(late.text) && !/first report of the minute/.test(late.text),
    'sense budget: the held-back report arrives on the next pass, once');
  ok(sense.runSenseEvents('h2').code === 1, 'sense budget: and is not repeated after that');
  // escalations go to the file the monitor reads when HUBD_SENSE_ESCALATIONS names it
  const escLog = path.join(SN, 'monitor-escalations.log');
  process.env.HUBD_SENSE_ESCALATIONS = escLog;
  const dead = JSON.parse(fs.readFileSync(sp, 'utf8'));
  dead.pending['dead:w3'] = { first: Date.now() / 1000 - 2000, last: Date.now() / 1000 - 2000, esc: 0 };
  fs.writeFileSync(sp, JSON.stringify(dead));
  sense.runSenseEvents('h2');
  delete process.env.HUBD_SENSE_ESCALATIONS;
  ok(fs.existsSync(escLog) && /^\d+\th2\tworker w3 not running/m.test(fs.readFileSync(escLog, 'utf8')) && !fs.existsSync(path.join(sense.senseDir(), 'escalations.log')),
    'sense: escalations are appended to HUBD_SENSE_ESCALATIONS when set, in the line format a monitor reads, and nowhere else');
  fs.rmSync(G, { recursive: true, force: true });
}
core.setHubBase(T0);

done();
