// board.mjs — the owner's board: tracks, done and why, what waits, and the page in the browser
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, ok, mktmp, freePort, T0, core, queueLib, done } from './_h.mjs';

// ── the owner's board: tracks, what got done and why, what is next, what waits for the owner ──
const BD = mktmp();
core.setHubBase(BD); core.ensureHubDirs();
{
  const board = await import(path.join(REPO, 'hub/lib/board.mjs'));
  fs.mkdirSync(path.join(BD, 'queues'), { recursive: true });
  core.runResourceSet({ slug: 'web-head', type: 'role', attrs: { rank: 'head', project: 'web' }, by: 'dev-t' });
  core.runResourceSet({ slug: 'web-dev', type: 'role', attrs: { rank: 'worker', project: 'web-ui' }, edges: { head: ['web-head'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'web-old', type: 'role', status: 'off', attrs: { rank: 'worker', project: 'web' }, edges: { head: ['web-head'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'coord', type: 'role', attrs: { rank: 'fleet', project: 'infra' }, by: 'dev-t' });
  fs.writeFileSync(path.join(BD, 'owner-roles.json'), '["boss"]');
  const long = 'A very long first line of a brief that keeps going well past any width a board card could show without wrapping twice\nsecond line';
  const tDone = core.runTaskAdd({ project: 'web', text: 'ship the login page', assignee: 'web-dev', by: 'dev-t' }).task.id;
  const tDep = core.runTaskAdd({ project: 'web-ui', text: long, assignee: 'web-dev', by: 'dev-t' }).task.id;
  const tBlk = core.runTaskAdd({ project: 'web', text: 'deploy after the ui work', assignee: 'web-dev', depends_on: [tDep], by: 'dev-t' }).task.id;
  core.runTaskAdd({ project: 'web', text: 'on a retired role', assignee: 'web-old', by: 'dev-t' });
  core.runTaskAdd({ project: 'web', text: 'on nobody we know', assignee: 'ghost', by: 'dev-t' });
  core.runTaskAdd({ project: 'web', text: 'press the button', assignee: 'boss', by: 'dev-t' });
  core.journalAppend({ ts: core.now(), project: 'web', agent: 'web-dev', kind: 'note', text: `login page done, see #${tDone}` });
  core.runTaskUpdate({ id: tDone, status: 'done', by: 'web-dev' });
  core.journalAppend({ ts: core.now(), project: 'web', agent: 'web-head', kind: 'decision', text: 'ACCEPT 0123456789abcdef task/login → main: reviewed' });
  core.journalAppend({ ts: core.now(), project: 'web', agent: 'web-head', kind: 'decision', text: 'REJECT fedcba9876 task/other: tests missing' });
  core.runHeartbeat({ agent: 'web-dev', state: 'turn', turn: 3, turn_started: 'now', task_id: String(tDep) });
  queueLib.queueSend('boss', 'BUTTON: approve the budget', { from: 'web-head', root: BD, node: 'n1' });
  queueLib.queueSend('coord', 'escalation: the build box is down', { from: 'web-head', root: BD, node: 'n1', task: String(tBlk) });
  queueLib.queueSend('coord', 'escalation: the disk is full', { from: 'web-head', root: BD, node: 'n1' });
  queueLib.queueSend('web-head', 'rebooted it', { from: 'coord', root: BD, node: 'n1' });
  const disk = board.runBoard({ queueRoot: BD }).waiting.escalations.find(x => /disk is full/.test(x.text));
  core.runSectionAdd({ project: 'infra', section: 'owner-decisions', text: `${disk.key}: cleaned it`, by: 'boss' });

  const b = board.runBoard({ queueRoot: BD });
  const t = b.tracks.find(x => x.project === 'web');
  ok(b.tracks.length === 1 && t && t.heads[0] === 'web-head' && t.rows.map(r => r.role).join(',') === 'web-head,web-dev,web-old',
    'board: a track is a head\'s project, its rows the head and every role whose head link points at it');
  const dev = t.rows.find(r => r.role === 'web-dev');
  ok(dev.state.kind === 'turn' && dev.state.turn === 3 && dev.task === String(tDep) && t.rows.find(r => r.role === 'web-old').state.kind === 'off',
    'board: a row says what the role is doing from the heartbeat fields, and a switched-off role says off');
  ok(t.next.some(x => x.id === tDep), 'board: the track reads the projects its workers file under, not only the head\'s');
  const d0 = t.done.find(x => x.id === tDone);
  ok(d0 && /login page done/.test(d0.acceptance.text) && d0.acceptance.agent === 'web-dev', 'board: a done task carries the line that accepted it, not the automatic close stamp');
  ok(t.blocked.length === 1 && t.blocked[0].id === tBlk && t.blocked[0].waitingOn[0].id === String(tDep), 'board: a blocked task names what it waits on');
  ok(t.decisions.length === 2 && t.decisions[0].verdict === 'reject' && t.decisions[1].sha === '0123456789abcdef' && t.decisions[1].branch === 'task/login',
    'board: branch verdicts in the journal are listed with sha and branch');
  const all = [...t.next, ...t.blocked, ...t.done, ...b.waiting.tasks];
  ok(all.every(x => x.title.length <= 80) && all.find(x => x.id === tDep).text === long, 'board: every title fits 80 characters, the full text stays one click away');
  ok(!('text' in d0), 'board: a done task is sent as title and acceptance, not the whole brief');
  const off = t.next.find(x => x.assignee === 'web-old'), ghost = t.next.find(x => x.assignee === 'ghost');
  ok(off && off.assigneeOff && ghost && !ghost.assigneeKnown && b.unknownAssignees.join(',') === 'ghost', 'board: work on a switched-off role and on a name that is no role are both marked');
  ok(b.waiting.queue.length === 1 && /approve the budget/.test(b.waiting.queue[0].subject) && b.waiting.tasks.some(x => x.assignee === 'boss'),
    'board: waiting for the owner lists the owner queue and the owner\'s own tasks');
  ok(b.waiting.escalations.length === 1 && b.waiting.escalations[0].task === String(tBlk) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · from web-head · id n1-\d+$/.test(b.waiting.escalations[0].key)
    && b.waiting.answered.length === 1 && b.waiting.answered[0].key === disk.key && /cleaned it/.test(b.waiting.answered[0].answer.text),
    'board: an escalation to the fleet coordinator waits until an entry of the fleet card\'s Owner decisions quotes its key, then shows with that answer');
  ok(!t.next.some(x => x.assignee === 'boss' && !x.owner), 'board: an owner task in a track is marked as the owner\'s');
  // a tenant board reads the tenant's queues, never the operator's
  const OP = mktmp(); fs.mkdirSync(path.join(OP, 'queues'));
  queueLib.queueSend('boss', 'operator secret', { from: 'x-y', root: OP, node: 'n1' });
  const bt = board.runBoard({ queueRoot: BD });
  ok(!bt.waiting.queue.some(x => /operator secret/.test(x.subject)), 'board: with an explicit queue root, another directory\'s owner queue never appears');
  fs.rmSync(OP, { recursive: true, force: true });
  ok(board.taskTitle('short') === 'short' && board.taskTitle(long).length <= 80 && board.taskTitle(long).endsWith('…'), 'board: taskTitle keeps a short line and cuts a long one at a word');
  ok(board.parseVerdict('decision: ACCEPT abcdef1234 task/x → main') .verdict === 'accept' && board.parseVerdict('accepted it') === null,
    'board: a verdict is parsed with or without the decision: prefix, and nothing else is one');
  const k = core.runKanban({});
  ok([...k.queued, ...k.inProgress].every(x => x.title && x.title.length <= 80), 'board: the live kanban cards carry the same short title');
}
core.setHubBase(T0); core.ensureHubDirs();

// ── the board in the browser: nothing from the hub is markup ──
const XS = mktmp();
core.setHubBase(XS); core.ensureHubDirs();
{
  core.runResourceSet({ slug: 'h9', type: 'role', attrs: { rank: 'head', project: 'px' }, by: 'dev-t' });
  core.runResourceSet({ slug: 'w9', type: 'role', attrs: { rank: 'worker', project: 'px' }, edges: { head: ['h9'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'w8', type: 'role', attrs: { rank: 'worker', project: 'px' }, edges: { head: ['h9'] }, by: 'dev-t' });
  const evil = 'ok" autofocus onfocus="alert(1)';
  core.runHeartbeat({ agent: 'w9', status: evil, state: 'waiting' });
  core.runHeartbeat({ agent: 'w8', status: 'plain loop' });
  core.runTaskAdd({ project: 'px', text: `title "><img src=x onerror=alert(2)> it's`, assignee: 'w9', by: 'dev-t' });
  const port = await freePort();
  const srvB = spawn('node', [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(port)], { env: { ...process.env, HUBD_DIR: XS, HUBD_TEAM_DIR: XS }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('board server did not start')), 8000);
    srvB.stdout.on('data', (d) => { if (String(d).includes('hubd kanban')) { clearTimeout(to); resolve(); } });
  });
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    const vm = await import('node:vm');
    const els = {};
    const mkEl = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelectorAll() { return []; } });
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || (els[id] = mkEl()), querySelectorAll: () => [] },
      localStorage: { getItem: (k) => (k === 'hubd-mode' ? 'tracks' : null), setItem() {} },
      location: { search: '', hash: '' },
      fetch: (u) => fetch(`http://127.0.0.1:${port}${u}`),
      setInterval: () => 0, clearInterval: () => {}, console,
    });
    vm.runInContext(script, ctx);
    for (let i = 0; i < 100 && !(els.tracks && els.tracks.innerHTML); i++) await new Promise(r => setTimeout(r, 30));
    const html = (els.tracks ? els.tracks.innerHTML : '') + (els['waiting-body'] ? els['waiting-body'].innerHTML : '');
    ok(vm.runInContext('esc(`"\'<>&`)', ctx) === '&quot;&#39;&lt;&gt;&amp;', 'serve: esc() escapes both quotes as well as <, > and &');
    ok(html.includes('ok&quot; autofocus onfocus=&quot;alert(1)') && !html.includes(evil),
      'serve: a heartbeat status with quotes stays inside its title attribute (it used to open an event handler in the owner\'s browser)');
    ok(!/<img src=x/.test(html) && html.includes('&lt;img src=x'), 'serve: a task title is text, never markup');
    ok(/alive<div class="meta">seen \d+m ago/.test(html), 'serve: a role alive without state fields says how long ago it was seen');
    const b = await (await fetch(`http://127.0.0.1:${port}/api/board?all=1`)).json();
    ok(b.all === true && b.journalDays >= 30, 'serve: the board takes all=1 (every project) and reads a journal window, not the whole journal');
  } finally { srvB.kill(); }
}

/* ── a journal window does not open the month archives that end before it ──
 * Each archive below carries a probe line stamped today, which a real archive cannot hold (it was
 * cut during its own month): the probe shows up exactly when the file was read. */
{
  const JW = mktmp();
  core.setHubBase(JW); core.ensureHubDirs();
  const line = (ts, text) => JSON.stringify({ ts, project: 'p', agent: 'a', kind: 'note', text }) + '\n';
  const today = core.now(), ym = today.slice(0, 7);
  const prev = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
  fs.writeFileSync(path.join(JW, 'journal.cedar-2025-01.jsonl'), line('2025-01-10 10:00', 'old') + line(today, 'probe-2025-01'));
  fs.writeFileSync(path.join(JW, `journal.cedar-${prev}.2.jsonl`), line(`${prev}-10 10:00`, 'last month') + line(today, `probe-${prev}`));
  fs.writeFileSync(path.join(JW, `journal.cedar-${ym}.jsonl`), line(today, 'this month'));
  fs.writeFileSync(path.join(JW, 'journal.cedar.jsonl'), line(today, 'live'));
  const texts = (ms) => core.journalSinceMs(ms).map(e => e.text).sort().join(',');
  const startOfMonth = Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1);
  ok(texts(startOfMonth) === 'live,this month',
    `journal window: archives of months that ended before the cutoff are not read; this month's and the live log are (${texts(startOfMonth)})`);
  ok(texts(startOfMonth - 1) === `live,probe-${prev},this month`,
    `journal window: a cutoff inside last month reads last month's archive, numbered name included (${texts(startOfMonth - 1)})`);
  ok(texts(-Infinity).split(',').length === 6 && [...core.journalEntries()].length === 6, 'journal window: with no cutoff every file is read, as before');
}
core.setHubBase(T0); core.ensureHubDirs();

done();
