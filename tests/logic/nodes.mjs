// nodes.mjs — each node as its own snapshot.<node>.json states it, and what is wrong with it
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { REPO, ok, mktmp, freePort, T0, core, done } from './_h.mjs';

const nd = await import(path.join(REPO, 'hub/lib/nodes.mjs'));
const sm = await import(path.join(REPO, 'hub/lib/summary.mjs'));
const NOW = Date.UTC(2026, 9, 5, 12, 0);   // 2026-10-05 12:00 UTC

/* The snapshots a fleet tool writes; hubd only reads them. */
const ND = mktmp();
core.setHubBase(ND); core.ensureHubDirs();
const put = (f, o) => fs.writeFileSync(path.join(ND, f), typeof o === 'string' ? o : JSON.stringify(o, null, 1));
const EVIL = '"><img src=x onerror=alert(7)>';
const FIR = {
  v: 1, node: 'fir', ts: '2026-10-05T11:58:00Z', load: 3,   // fresh, with a disk at 93% and a failed relay
  sessions: [
    { session: 'fir-head', role: 'web-head', state: 'WORKING', hub_age_min: 0, motion_min: 1, pid: 4242 },
    { session: 'fir-dev', role: 'web-dev', state: 'DOWN', hub_age_min: '3', motion_min: null },
    'not a session',
    { session: EVIL, role: 'web-qa', state: 'IDLE', hub_age_min: 12, motion_min: 7 },
  ],
  disks: [{ mount: '/var', used_pct: 93, free_gb: 69 }, { mount: '/', used_pct: 64, free_gb: 13 }],
  relays: [
    { pair: 'pine→fir', active: true, failed: false, last_ok: '2026-10-05T11:57:30Z' },
    { pair: 'fir→maple', active: true, failed: true, last_ok: null },
  ],
};
put('snapshot.fir.json', FIR);
put('snapshot.pine.json', {   // ten minutes old, a disk at exactly 90%, a relay not active
  v: 1, node: 'pine', ts: '2026-10-05T11:50:00Z',
  sessions: [{ session: 'pine-head', role: 'api-head', state: 'IDLE', hub_age_min: 2, motion_min: 2 }],
  disks: [{ mount: '/', used_pct: 90, free_gb: 20 }, { mount: '/home', used_pct: 89, free_gb: 40 }],
  relays: [{ pair: 'pine→fir', active: false, failed: false, last_ok: '2026-10-05T11:00:00Z' }],
});
put('snapshot.maple.json', '{"v":1,"node":"maple","ts":"2026-10-05T1');   // cut off mid-write
put('snapshot.cedar.json', { v: 2, node: 'cedar', ts: '2026-10-05T11:59:00Z', sessions: [] });
put('snapshot.elm.json', '[]');
put('snapshot.oak.json', { v: 1, node: 'oak', sessions: [] });   // no time
put('presence.fir.json', { node: 'fir', agents: [] });
put('snapshot.json', { v: 1 });

const bad = (node, why) => ({ node, ts: null, ageMin: null, stale: null, unreadable: why, sessions: [], disks: [], relays: [] });
const EXPECTED = [
  bad('cedar', 'schema 2, not 1'),
  bad('elm', 'not an object'),
  { node: 'fir', ts: '2026-10-05T11:58:00Z', ageMin: 2, stale: false, unreadable: null,
    sessions: [
      { session: EVIL, role: 'web-qa', state: 'IDLE', hubAgeMin: 12, motionMin: 7 },
      { session: 'fir-dev', role: 'web-dev', state: 'DOWN', hubAgeMin: null, motionMin: null },
      { session: 'fir-head', role: 'web-head', state: 'WORKING', hubAgeMin: 0, motionMin: 1 },
    ],
    disks: [{ mount: '/', usedPct: 64, freeGb: 13, full: false }, { mount: '/var', usedPct: 93, freeGb: 69, full: true }],
    relays: [
      { pair: 'fir→maple', active: true, failed: true, lastOk: null, down: true },
      { pair: 'pine→fir', active: true, failed: false, lastOk: '2026-10-05T11:57:30Z', down: false },
    ] },
  bad('maple', 'not JSON'),
  { node: 'oak', ts: null, ageMin: null, stale: true, unreadable: null, sessions: [], disks: [], relays: [] },
  { node: 'pine', ts: '2026-10-05T11:50:00Z', ageMin: 10, stale: true, unreadable: null,
    sessions: [{ session: 'pine-head', role: 'api-head', state: 'IDLE', hubAgeMin: 2, motionMin: 2 }],
    disks: [{ mount: '/', usedPct: 90, freeGb: 20, full: true }, { mount: '/home', usedPct: 89, freeGb: 40, full: false }],
    relays: [{ pair: 'pine→fir', active: false, failed: false, lastOk: '2026-10-05T11:00:00Z', down: true }] },
];

const got = nd.nodeSnapshots({ root: ND, nowMs: NOW });
ok(isDeepStrictEqual(got, EXPECTED), 'nodes: fixed snapshots at a fixed moment give exactly the expected rows and flags' +
  (isDeepStrictEqual(got, EXPECTED) ? '' : '\n  got ' + JSON.stringify(got)));
const fir = got.find(n => n.node === 'fir'), pine = got.find(n => n.node === 'pine');
ok(!fir.stale && pine.stale, 'nodes: a snapshot ten minutes old is stale, one two minutes old is not');
ok(fir.disks.find(d => d.mount === '/var').full && pine.disks[0].full && !pine.disks[1].full, 'nodes: a disk at 90% or more is full, 89% is not');
ok(fir.relays[0].down && pine.relays[0].down && !fir.relays[1].down, 'nodes: a relay that failed, or is not active, is down');
ok(!('load' in fir) && !('pid' in fir.sessions[2]) && fir.sessions.length === 3 && fir.sessions[1].hubAgeMin === null,
  'nodes: unknown fields are ignored, an entry that is not an object is skipped, a value of another type reads as missing');
ok(['maple', 'cedar', 'elm'].every(n => got.find(x => x.node === n).unreadable) && !got.some(n => n.node === 'json'),
  'nodes: a file cut off, of another schema or not an object is a row of its own; other files are not snapshots');
ok(got.find(n => n.node === 'oak').stale === true, 'nodes: a snapshot with no time is stale');
const at = (ms) => nd.nodeSnapshots({ root: ND, nowMs: ms }).find(n => n.node === 'fir').stale;
ok(at(Date.UTC(2026, 9, 5, 12, 3, 0)) === false && at(Date.UTC(2026, 9, 5, 12, 3, 1)) === true,
  'nodes: five minutes old is not stale yet; a second more is');
ok(isDeepStrictEqual(sm.runSummary({ now: NOW }).nodes, EXPECTED), 'summary: the nodes are part of the summary');
ok(isDeepStrictEqual(nd.nodeSnapshots({ root: path.join(ND, 'none'), nowMs: NOW }), []), 'nodes: a hub with no directory has no nodes');

// ── the page: a fresh fir and a stale pine, as the summary renders them ──
put('snapshot.fir.json', { ...FIR, ts: new Date().toISOString() });
{
  const port = await freePort();
  const srv = spawn('node', [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(port)], { env: { ...process.env, HUBD_DIR: ND, HUBD_TEAM_DIR: ND }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('nodes server did not start')), 8000);
    srv.stdout.on('data', (d) => { if (String(d).includes('hubd kanban')) { clearTimeout(to); resolve(); } });
  });
  try {
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
    const vm = await import('node:vm');
    const els = {};
    const mkEl = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelectorAll() { return []; } });
    const ctx = vm.createContext({
      document: { getElementById: (id) => els[id] || (els[id] = mkEl()), querySelectorAll: () => [] },
      localStorage: { getItem: (k) => (k === 'hubd-mode' ? 'summary' : null), setItem() {} },
      location: { search: '', hash: '' },
      fetch: (u) => fetch(`http://127.0.0.1:${port}${u}`),
      setInterval: () => 0, clearInterval: () => {}, console,
    });
    vm.runInContext(script, ctx);
    for (let i = 0; i < 100 && !(els.summary && els.summary.innerHTML); i++) await new Promise(r => setTimeout(r, 30));
    const html = els.summary ? els.summary.innerHTML : '';
    const rows = html.split('<tr>').slice(1);
    ok(rows.some(r => r.includes('<td>pine-head</td><td><span class="bad">pine</span></td>')) && rows.some(r => r.includes('<td>fir-head</td><td>fir</td>')),
      'serve: a session on a stale node has its node in red, on a fresh one not');
    ok(html.includes('<span class="bad">/var 93%</span>') && html.includes('<span class="bad">/ 90%</span>') && !html.includes('<span class="bad">/ 64%'),
      'serve: a full disk is red, the others are not');
    ok(html.includes('<span class="bad">fir→maple failed</span>') && html.includes('<span class="bad">pine→fir not active</span>') && !html.includes('<span class="bad">pine→fir active'),
      'serve: a relay down is red, one active is not');
    ok(rows.some(r => r.includes('<td class="bad">maple</td>') && r.includes('snapshot unreadable: not JSON')),
      'serve: an unreadable snapshot is a row naming its node');
    ok(!/<img src=x/.test(html) && html.includes('&lt;img src=x'), 'serve: a snapshot\'s text is text, never markup');
  } finally { srv.kill(); }
}
core.setHubBase(T0); core.ensureHubDirs();

done();
