// escalations.mjs — what was escalated to the fleet, waiting or answered, matched by its key alone
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { REPO, ok, mktmp, freePort, T0, core, done } from './_h.mjs';

const es = await import(path.join(REPO, 'hub/lib/escalations.mjs'));
const sm = await import(path.join(REPO, 'hub/lib/summary.mjs'));
const NOW = Date.UTC(2026, 9, 5, 12, 0);   // 2026-10-05 12:00 UTC

/* Queue files, the card and its history are written with fixed stamps, as the fleet writes them. */
const ES = mktmp();
core.setHubBase(ES); core.ensureHubDirs();
core.runResourceSet({ slug: 'coord', type: 'role', attrs: { rank: 'fleet', project: 'infra' }, by: 'dev-t' });
core.runResourceSet({ slug: 'web-head', type: 'role', attrs: { rank: 'head', project: 'web' }, by: 'dev-t' });
const Q = path.join(ES, 'queues');
fs.mkdirSync(Q, { recursive: true });
const block = (header, body) => `\n## ${header}\n${body}\n`;
const EVIL = '"><img src=x onerror=alert(5)> the disk is full';
fs.writeFileSync(path.join(Q, 'coord.n1.queue.md'), [
  block('2026-10-01 08:00 · from web-head', 'an old block without an id'),
  block('2026-10-02 07:00 · from web-head · id 1', 'the backup failed'),
  block('2026-10-04 09:00 · from web-head · id 3', 'the build box is down'),
  block('2026-10-05 08:00 · from web-head · id 5', 'the cert expires tomorrow'),
  block('2026-10-05 11:00 · from web-head · id 6', EVIL),
].join(''));
fs.writeFileSync(path.join(Q, 'coord.n2.queue.md'), block('2026-10-05 10:32 · from api-head · id 32 · task #cedar-6', 'the key server rejects the new key\nit worked yesterday'));
fs.writeFileSync(path.join(Q, 'web-head.n1.queue.md'), block('2026-10-05 09:00 · from coord · id 1', 'a message to a head, not an escalation'));

// the hub calls the section by its own name; the history still has it under the default one
fs.writeFileSync(path.join(ES, 'sections.json'), JSON.stringify({ 'owner-decisions': 'Entscheidungen' }));
fs.writeFileSync(path.join(ES, 'projects', 'infra.md'), [
  '# infra', '', '## Digest', '', 'the fleet', '', '## Entscheidungen', '',
  '- … older entries moved to projects/history/infra.md',
  '- 2026-10-05 10:48: answered 2026-10-05 10:32 · from api-head · id 32 — rotate it again',
  '  the old key stays valid until Friday',
  '- 2026-10-05 11:20: answered 2026-10-04 09:00 · from web-head · id 33 — no such escalation',
  '- 2026-10-05 11:25: moved the backups to the new box', '',
].join('\n'));
fs.mkdirSync(path.join(ES, 'projects', 'history'), { recursive: true });
fs.writeFileSync(path.join(ES, 'projects', 'history', 'infra.md'), [
  '', '---', '### until 2026-10-02 12:00 (Owner decisions — overflow past 8192B, by coord)',
  '- 2026-10-02 09:00: answered 2026-10-02 07:00 · from web-head · id 1 — rerun it',
  '', '---', '### until 2026-10-05 11:30 (Owner decisions — overflow past 8192B, by coord)',
  '- 2026-10-05 08:30: answered 2026-10-05 08:00 · from web-head · id 5 — renew it today',
  '- 2026-10-05 10:40: answered 2026-10-05 10:32 · from api-head · id 32 — first answer',
  '', '---', '### until 2026-10-05 11:40 (Decisions — overflow past 8192B, by coord)',
  '- 2026-10-05 11:05: noted 2026-10-05 11:00 · from web-head · id 6, not an answer', '',
].join('\n'));

const row = (key, node, id, ts, waitedMin, text, task = null, answer = null) => ({ key, to: 'coord', node, from: key.split(' · from ')[1].split(' · ')[0],
  id, task, ts, waitedMin, subject: text.split('\n')[0], text, answer });
const EXPECTED = {
  fleet: ['coord'],
  waiting: [
    row('2026-10-04 09:00 · from web-head · id 3', 'n1', 3, '2026-10-04 09:00', 1620, 'the build box is down'),
    row('2026-10-05 11:00 · from web-head · id 6', 'n1', 6, '2026-10-05 11:00', 60, EVIL),
  ],
  answered: [
    row('2026-10-05 08:00 · from web-head · id 5', 'n1', 5, '2026-10-05 08:00', 30, 'the cert expires tomorrow', null,
      { ts: '2026-10-05 08:30', text: '- 2026-10-05 08:30: answered 2026-10-05 08:00 · from web-head · id 5 — renew it today' }),
    row('2026-10-05 10:32 · from api-head · id 32', 'n2', 32, '2026-10-05 10:32', 16, 'the key server rejects the new key\nit worked yesterday', 'cedar-6',
      { ts: '2026-10-05 10:48', text: '- 2026-10-05 10:48: answered 2026-10-05 10:32 · from api-head · id 32 — rotate it again\n  the old key stays valid until Friday' }),
  ],
};

const got = es.escalationState({ root: ES, nowMs: NOW });
ok(isDeepStrictEqual(got, EXPECTED), 'escalations: a fixed hub and moment give exactly the expected waiting and answered lists' +
  (isDeepStrictEqual(got, EXPECTED) ? '' : '\n  got ' + JSON.stringify(got)));
ok(got.waiting.length === 2 && got.answered.length === 2,
  'escalations: of the escalations quoted in Owner decisions, the answered wait no more; the rest wait, however old');
ok(got.waiting.some(x => x.id === 3), 'escalations: an answer quoting "id 33" does not answer "id 3"');
ok(got.waiting.some(x => x.id === 6), 'escalations: a key quoted in another section\'s history is no answer');
ok(got.answered.some(x => x.id === 5), 'escalations: an answer moved to the history by the section cap still answers');
ok(got.answered.find(x => x.id === 32).answer.ts === '2026-10-05 10:48', 'escalations: of two answers to one key, the later one stands');
ok(![...got.waiting, ...got.answered].some(x => x.id === 1), 'escalations: an escalation answered more than 24 hours ago is no longer listed');
ok(![...got.waiting, ...got.answered].some(x => x.to !== 'coord' || x.id == null), 'escalations: only blocks with an id in a fleet role\'s queue are escalations');
const short = es.escalationState({ root: ES, nowMs: NOW, textChars: 10 });
ok(short.answered[1].text === 'the key se…' && short.answered[1].answer.text === '- 2026-10-…' && short.answered[1].key === EXPECTED.answered[1].key,
  'escalations: textChars cuts the escalation and the answer, never the key');
ok(JSON.stringify(sm.runSummary({ now: NOW, queueRoot: ES }).escalations) === JSON.stringify(EXPECTED),
  'summary: the escalations are part of the summary, whole');
// a fleet role with no project has no card to be answered in
const noCard = es.escalationState({ roles: new Map([['coord', { role: 'coord', rank: 'fleet', project: null }]]), root: ES, nowMs: NOW });
ok(noCard.waiting.length === 5 && !noCard.answered.length, 'escalations: with no fleet card to read, every escalation waits');

// ── the page: Summary and the Tracks' "waiting for you" both list them, as text ──
{
  const port = await freePort();
  const srv = spawn('node', [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(port)], { env: { ...process.env, HUBD_DIR: ES, HUBD_TEAM_DIR: ES }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('escalations server did not start')), 8000);
    srv.stdout.on('data', (d) => { if (String(d).includes('hubd kanban')) { clearTimeout(to); resolve(); } });
  });
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    const vm = await import('node:vm');
    const render = async (mode, id) => {
      const els = {};
      const mkEl = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelectorAll() { return []; } });
      const ctx = vm.createContext({
        document: { getElementById: (x) => els[x] || (els[x] = mkEl()), querySelectorAll: () => [] },
        localStorage: { getItem: (k) => (k === 'hubd-mode' ? mode : null), setItem() {} },
        location: { search: '', hash: '' },
        fetch: (u) => fetch(`http://127.0.0.1:${port}${u}`),
        setInterval: () => 0, clearInterval: () => {}, console,
      });
      vm.runInContext(script, ctx);
      for (let i = 0; i < 100 && !(els[id] && els[id].innerHTML); i++) await new Promise(r => setTimeout(r, 30));
      return { html: els[id] ? els[id].innerHTML : '', els };
    };
    const s = await render('summary', 'summary');
    ok(s.html.includes('2026-10-04 09:00 · from web-head · id 3') && s.html.includes('Unanswered (2)'),
      'serve: the summary lists the unanswered escalations by key');
    const t = await render('tracks', 'waiting-body');
    ok(t.html.includes('Escalations, unanswered (2)') && /2 escalations unanswered/.test(t.els['waiting-sum'].textContent),
      'serve: "waiting for you" counts and lists the unanswered escalations');
    ok(![s.html, t.html].some(h => /<img src=x/.test(h)) && s.html.includes('&lt;img src=x') && t.html.includes('&lt;img src=x'),
      'serve: an escalation\'s text is text, never markup');
  } finally { srv.kill(); }
}
core.setHubBase(T0); core.ensureHubDirs();

done();
