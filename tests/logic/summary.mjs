// summary.mjs — where each track stands, as a script states it: one hub state, one answer
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { REPO, ok, mktmp, freePort, T0, core, done } from './_h.mjs';

const sm = await import(path.join(REPO, 'hub/lib/summary.mjs'));
const NOW = Date.UTC(2026, 9, 5, 12, 0);   // 2026-10-05 12:00 UTC: every age below counts from here

/* The fixture is written as files with fixed stamps (task events, journal, cards), not through the
 * engine, which would stamp each write with the moment the test runs. */
const SM = mktmp();
core.setHubBase(SM); core.ensureHubDirs();
core.runResourceSet({ slug: 'web-head', type: 'role', attrs: { rank: 'head', project: 'web' }, by: 'dev-t' });
core.runResourceSet({ slug: 'web-dev', type: 'role', attrs: { rank: 'worker', project: 'web-ui' }, edges: { head: ['web-head'] }, by: 'dev-t' });
core.runResourceSet({ slug: 'api-head', type: 'role', attrs: { rank: 'head', project: 'api' }, by: 'dev-t' });
core.runResourceSet({ slug: 'api-dev', type: 'role', attrs: { rank: 'worker', project: 'api' }, by: 'dev-t' });

const EV = path.join(SM, 'tasks.cedar.events.jsonl');
const add = (id, project, text, { assignee = null, created, depends_on = [] }) => JSON.stringify({ ts: created, node: 'cedar', ev: 'add', id,
  t: { id, project, text, importance: 'normal', deadline: null, cat: null, tags: [], assignee, status: 'open', created, by: 'dev-t', depends_on, resources: [] } });
const close = (id, ts) => JSON.stringify({ ts, node: 'cedar', ev: 'set', id, keyed: 'origin', patch: { status: 'done', done: ts } });
fs.writeFileSync(EV, [
  add('cedar-1', 'web', 'ship the login page\nwith the remember-me box', { assignee: 'web-dev', created: '2026-10-01 09:00' }),
  add('cedar-2', 'web-ui', 'style the form', { assignee: 'web-dev', created: '2026-10-02 10:00', depends_on: ['cedar-3'] }),
  add('cedar-3', 'web', 'pick a font', { created: '2026-10-03 08:00' }),                        // ready, nobody on it: not "in work"
  add('cedar-4', 'web', 'fix the header', { assignee: 'web-dev', created: '2026-09-30 10:00' }),
  add('cedar-5', 'web', 'old cleanup', { assignee: 'web-dev', created: '2026-09-29 10:00' }),
  add('12', 'web', 'count the visitors', { assignee: 'web-dev', created: '2026-10-04 07:00' }),     // a bare number: named only as #12
  add('cedar-6', 'api', 'rotate the key', { assignee: 'api-dev', created: '2026-10-04 06:00' }),
  close('cedar-4', '2026-10-05 08:00'),
  close('cedar-5', '2026-10-03 10:00'),                                                             // closed, but not in the last 24 hours
].join('\n') + '\n');

const J = (ts, agent, kind, text) => JSON.stringify({ ts, project: agent.split('-')[0], agent, kind, text });
fs.writeFileSync(path.join(SM, 'journal.cedar.jsonl'), [
  J('2026-09-01 10:00', 'web-head', 'note', 'REJECT cedar-1'),                       // older than the 30-day window
  J('2026-10-03 07:00', 'web-dev', 'blocked', 'stuck on cedar-4'),                  // not the role's newest blocked entry
  J('2026-10-04 06:00', 'web-head', 'blocked', 'waiting for cedar-4 to land'),      // cedar-4 closed after it
  J('2026-10-04 08:00', 'api-dev', 'blocked', 'cedar-6 needs a key from the owner'),
  J('2026-10-04 09:00', 'api-dev', 'done', 'cedar-6: key arrived, unblocked'),      // handed in after the blocked entry
  J('2026-10-04 10:00', 'web-head', 'note', 'ACCEPT for cedar-1, first part'),
  J('2026-10-04 12:00', 'web-head', 'note', 'REJECT #12: wrong numbers'),
  J('2026-10-05 06:00', 'api-head', 'blocked', 'no reply from the owner yet'),      // names no task, no done after it
  J('2026-10-05 07:00', 'web-dev', 'blocked', 'waiting on cedar-3 (the font) before cedar-2'),
  J('2026-10-05 08:30', 'web-dev', 'done', 'finished cedar-4'),                     // a done entry about another task
  J('2026-10-05 09:00', 'web-head', 'note', 'ACCEPT abc1234 task/header: closes cedar-4'),
  J('2026-10-05 10:00', 'web-head', 'note', 'cedar-1 NICHT ANGENOMMEN: the form loses input; cedar-4 ACCEPT'),
  J('2026-10-05 11:00', 'web-dev', 'note', 'ACCEPT cedar-1 please'),                // not a head of the track
  J('2026-10-05 11:15', 'api-head', 'note', 'ACCEPT cedar-6'),
  J('2026-10-05 11:20', 'web-head', 'note', 'ANGENOMMEN #12, REJECT cedar-6'),      // web-head is no head of api
  J('2026-10-05 11:30', 'web-head', 'note', '12 tests pass, ACCEPT abc9999 task/tests'),   // a count, not #12
  J('2026-10-05 11:40', 'web-head', 'note', 'I will accept cedar-2 later'),         // a word in a sentence, not a verdict
].join('\n') + '\n');
fs.writeFileSync(path.join(SM, 'verdicts.json'), JSON.stringify({ accept: ['ANGENOMMEN'], reject: ['NICHT ANGENOMMEN', 'ABGELEHNT'] }));

fs.writeFileSync(path.join(SM, 'projects', 'web.md'), '# web\n\n## Digest\n\n- 2026-10-04 09:00: MAIN=abc1234\n\n## Goal\n\nShip the login page by Friday.\n');
fs.writeFileSync(path.join(SM, 'projects', 'api.md'), '# api\n\n## Digest\n\n- 2026-10-04 09:00: key rotation is the only open item\n- 2026-10-01 09:00: older line\n\n## Goal\n\n<what the track is for>\n');

const v = (ts, agent, verdict, text) => ({ ts, agent, verdict, text });
const EXPECTED = {
  v: 1, asOf: '2026-10-05 12:00', journalDays: 30, closedHours: 24,
  tracks: [
    {
      project: 'api', heads: ['api-head'], roles: ['api-dev'],
      goal: { text: '- 2026-10-04 09:00: key rotation is the only open item', from: 'digest' },
      working: [{ id: 'cedar-6', title: 'rotate the key', assignee: 'api-dev', created: '2026-10-04 06:00', ageMin: 1800,
        verdict: v('2026-10-05 11:15', 'api-head', 'accept', 'ACCEPT cedar-6') }],
      blocked: [], closed: [],
      stalled: [{ role: 'api-head', ts: '2026-10-05 06:00', ageMin: 360, task: null, text: 'no reply from the owner yet' }],
    },
    {
      project: 'web', heads: ['web-head'], roles: ['web-dev'],
      goal: { text: 'Ship the login page by Friday.', from: 'goal' },
      working: [
        { id: 'cedar-1', title: 'ship the login page', assignee: 'web-dev', created: '2026-10-01 09:00', ageMin: 5940,
          verdict: v('2026-10-05 10:00', 'web-head', 'reject', 'cedar-1 NICHT ANGENOMMEN: the form loses input; cedar-4 ACCEPT') },
        { id: '12', title: 'count the visitors', assignee: 'web-dev', created: '2026-10-04 07:00', ageMin: 1740,
          verdict: v('2026-10-05 11:20', 'web-head', 'accept', 'ANGENOMMEN #12, REJECT cedar-6') },
      ],
      blocked: [{ id: 'cedar-2', title: 'style the form', assignee: 'web-dev', created: '2026-10-02 10:00', ageMin: 4440, verdict: null, waitingOn: ['cedar-3'] }],
      closed: [{ id: 'cedar-4', title: 'fix the header', assignee: 'web-dev', closed: '2026-10-05 08:00', ageMin: 240,
        verdict: v('2026-10-05 10:00', 'web-head', 'accept', 'cedar-1 NICHT ANGENOMMEN: the form loses input; cedar-4 ACCEPT') }],
      stalled: [{ role: 'web-dev', ts: '2026-10-05 07:00', ageMin: 300, task: 'cedar-3', text: 'waiting on cedar-3 (the font) before cedar-2' }],
    },
  ],
};

const s1 = sm.runSummary({ now: NOW });
ok(isDeepStrictEqual(s1, EXPECTED), 'summary: a fixed hub and a fixed moment give exactly the expected answer' +
  (isDeepStrictEqual(s1, EXPECTED) ? '' : '\n  got ' + JSON.stringify(s1)));
ok(JSON.stringify(sm.runSummary({ now: NOW })) === JSON.stringify(s1), 'summary: two calls on one hub give the same bytes');
{
  const [api, web] = s1.tracks;
  ok(!web.working.some(t => t.id === 'cedar-3'), 'summary: a ready task nobody took is not "in work"');
  ok(web.working[0].verdict.verdict === 'reject' && web.closed[0].verdict.verdict === 'accept',
    'summary: in an entry that names a task first, each task takes the verdict after its name (a negated form from verdicts.json wins over the word inside it)');
  ok(web.working[1].verdict.verdict === 'accept', 'summary: in an entry that opens with a verdict, each task takes the verdict before its name');
  ok(web.working[1].verdict.ts === '2026-10-05 11:20', 'summary: a bare number in prose ("12 tests") does not name task 12; "#12" does');
  ok(web.blocked[0].verdict === null, 'summary: "accept" in a sentence is no verdict, and a worker\'s ACCEPT is not the head\'s');
  ok(api.working[0].verdict.agent === 'api-head', 'summary: a head of another track does not judge this track\'s tasks');
  ok(!api.stalled.some(x => x.role === 'api-dev') && !web.stalled.some(x => x.role === 'web-head'),
    'summary: a blocked entry stops standing when the role hands that task in or the task closes after it');
  ok(web.stalled[0].task === 'cedar-3', 'summary: a done entry about another task leaves a blocked entry standing');
}
ok(sm.namesTask('cedar-1').test('see cedar-1.') && !sm.namesTask('cedar-1').test('cedar-12') && !sm.namesTask('cedar-1').test('xcedar-1')
  && sm.namesTask('7').test('closes #7') && !sm.namesTask('7').test('7 files') && !sm.namesTask('7').test('#71'),
  'summary: a task is named whole, and a bare number only with #');
ok(isDeepStrictEqual(sm.emptySummary(NOW), { v: 1, asOf: '2026-10-05 12:00', journalDays: 30, closedHours: 24, tracks: [] }),
  'summary: an empty hub has the same shape with no tracks');

// ── the endpoint and the page: the same answer, and nothing from the hub is markup ──
fs.appendFileSync(EV, add('cedar-7', 'web', 'evil "><img src=x onerror=alert(3)> title', { assignee: 'web-dev', created: '2026-10-05 09:00' }) + '\n');
fs.writeFileSync(path.join(SM, 'projects', 'web.md'), '# web\n\n## Goal\n\nship it "><svg onload=alert(4)>\n');
{
  const port = await freePort();
  const srv = spawn('node', [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(port)], { env: { ...process.env, HUBD_DIR: SM, HUBD_TEAM_DIR: SM }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('summary server did not start')), 8000);
    srv.stdout.on('data', (d) => { if (String(d).includes('hubd kanban')) { clearTimeout(to); resolve(); } });
  });
  try {
    const got = await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json();
    // the server answers for the moment it is asked, so ages and the stamp are left out
    const timeless = (o) => JSON.parse(JSON.stringify(o, (k, x) => (k === 'ageMin' || k === 'asOf' ? undefined : x)));
    ok(isDeepStrictEqual(timeless(got), timeless(sm.runSummary())), 'serve: /api/summary is the engine\'s answer');
    const one = await (await fetch(`http://127.0.0.1:${port}/api/summary?project=api`)).json();
    ok(one.tracks.length === 1 && one.tracks[0].project === 'api', 'serve: /api/summary?project= answers for one track');

    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    const vm = await import('node:vm');
    const els = {};
    const mkEl = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelectorAll() { return []; } });
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || (els[id] = mkEl()), querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {} },   // nothing saved: a hub with heads opens on Summary
      location: { search: '', hash: '' },
      fetch: (u) => fetch(`http://127.0.0.1:${port}${u}`),
      setInterval: () => 0, clearInterval: () => {}, console,
    });
    vm.runInContext(script, ctx);
    for (let i = 0; i < 100 && !(els.summary && els.summary.innerHTML); i++) await new Promise(r => setTimeout(r, 30));
    const html = els.summary ? els.summary.innerHTML : '';
    ok(html.includes('#cedar-1 ship the login page') && html.includes('waits on #cedar-3'), 'serve: the first screen of a hub with heads is the summary');
    ok(!/<img src=x|<svg onload/.test(html) && html.includes('&lt;img src=x') && html.includes('&lt;svg onload'),
      'serve: a task title and a goal in the summary are text, never markup');
  } finally { srv.kill(); }
}
core.setHubBase(T0); core.ensureHubDirs();

done();
