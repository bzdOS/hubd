// mail.mjs — the artifacts a mail relay delivered (journal kind delivery): a row of their own in
// Live, and on the Summary in the track of the recipient
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { REPO, ok, mktmp, freePort, T0, core, done } from './_h.mjs';

const ml = await import(path.join(REPO, 'hub/lib/mail.mjs'));
const sm = await import(path.join(REPO, 'hub/lib/summary.mjs'));
const NOW = Date.UTC(2026, 9, 5, 12, 0);   // 2026-10-05 12:00 UTC
const BU = String.fromCharCode(0x411);     // the byte unit a relay writing Russian puts after the size

const MD = mktmp();
core.setHubBase(MD); core.ensureHubDirs();
core.runResourceSet({ slug: 'web-head', type: 'role', attrs: { rank: 'head', project: 'web' }, by: 'dev-t' });
core.runResourceSet({ slug: 'web-dev', type: 'role', attrs: { rank: 'worker', project: 'web-ui' }, edges: { head: ['web-head'] }, by: 'dev-t' });
core.runResourceSet({ slug: 'api-head', type: 'role', attrs: { rank: 'head', project: 'api' }, by: 'dev-t' });

/* Journal lines with fixed stamps, as the relay's `hub report -k delivery` leaves them. */
const J = (ts, kind, text, agent = 'relay') => JSON.stringify({ ts, project: 'mail', agent, kind, text });
const EVIL = '"><img src=x onerror=alert(7)>.txt';
const hex = (i) => String(i).padStart(2, '0').repeat(6);
const builds = Array.from({ length: 25 }, (_, i) =>
  J('2026-10-04 10:' + String(i).padStart(2, '0'), 'delivery', `pine → web-head: build-${i}.log ${100 + i} ${BU} sha256 ${hex(i)}`));
fs.writeFileSync(path.join(MD, 'journal.cedar.jsonl'), [
  J('2026-08-01 10:00', 'delivery', 'fir → api-head: ancient.log 10 B sha256 aaaaaaaaaaaa'),       // older than the 30-day window
  ...builds,
  J('2026-10-05 09:00', 'done', 'shipped the form', 'web-dev'),
  J('2026-10-05 10:00', 'delivery', `pine → web-dev: report.txt 1706 ${BU} sha256 c38149fffd05`),
  J('2026-10-05 10:00', 'delivery', 'pine → web-dev: report-2.txt 2048 B sha256 0123456789ab'),  // the same minute, a later line
  J('2026-10-05 10:30', 'delivery', 'maple -> api-head: keys.tar 1048576 B sha256 ffffffffffff'),
  J('2026-10-05 11:00', 'note', 'looked at the mail', 'web-head'),
].join('\n') + '\n');
fs.writeFileSync(path.join(MD, 'journal.pine.jsonl'), [
  J('2026-10-05 11:30', 'delivery', 'pine → fir-head: other.log 5 B sha256 abcabcabcabc'),        // no such role: no track
  J('2026-10-05 11:40', 'delivery', 'relay lost the line'),                                         // does not read
  J('2026-10-05 11:50', 'delivery', `pine → web-dev: ${EVIL} 7 B sha256 dddddddddddd`),
  J('2026-10-05 11:55', 'note', 'pine → web-dev: not.txt 1 B sha256 eeeeeeeeeeee'),                // another kind is not mail
].join('\n') + '\n');

const D = (ts, from, to, name, bytes, sha256, text) => ({ ts, project: 'mail', agent: 'relay', from, to, name, bytes, sha256, text });
const EVIL_D = D('2026-10-05 11:50', 'pine', 'web-dev', EVIL, 7, 'dddddddddddd', `pine → web-dev: ${EVIL} 7 B sha256 dddddddddddd`);
const R2 = D('2026-10-05 10:00', 'pine', 'web-dev', 'report-2.txt', 2048, '0123456789ab', 'pine → web-dev: report-2.txt 2048 B sha256 0123456789ab');
const R1 = D('2026-10-05 10:00', 'pine', 'web-dev', 'report.txt', 1706, 'c38149fffd05', `pine → web-dev: report.txt 1706 ${BU} sha256 c38149fffd05`);
const KEYS = D('2026-10-05 10:30', 'maple', 'api-head', 'keys.tar', 1048576, 'ffffffffffff', 'maple -> api-head: keys.tar 1048576 B sha256 ffffffffffff');
const build = (i) => D('2026-10-04 10:' + String(i).padStart(2, '0'), 'pine', 'web-head', `build-${i}.log`, 100 + i, hex(i),
  `pine → web-head: build-${i}.log ${100 + i} ${BU} sha256 ${hex(i)}`);

ok(isDeepStrictEqual(ml.parseDelivery(`a-dev → b-head: x y.log 940 ${BU} sha256 16272bc3d6d3`), { from: 'a-dev', to: 'b-head', name: 'x y.log', bytes: 940, sha256: '16272bc3d6d3' })
  && ml.parseDelivery('a → b: f.log 9 KB sha256 16272bc3d6d3') === null && ml.parseDelivery('a → b: f.log 9 B sha256 XYZ') === null && ml.parseDelivery(null) === null,
  'mail: a delivery line reads into sender, recipient, name (spaces and all), bytes and sha256; any other line does not');

// ── Live: /api/kanban ──
const k = core.runKanban({});
ok(k.mail.length === 20, 'live: the newest 20 deliveries, no more');
const LIVE = [EVIL_D, D('2026-10-05 11:40', null, null, null, null, null, 'relay lost the line'),
  D('2026-10-05 11:30', 'pine', 'fir-head', 'other.log', 5, 'abcabcabcabc', 'pine → fir-head: other.log 5 B sha256 abcabcabcabc'), KEYS, R2, R1,
  ...Array.from({ length: 14 }, (_, i) => build(24 - i))];
ok(isDeepStrictEqual(k.mail, LIVE),
  'live: every delivery, newest first across the nodes\' files, the later line first within a minute; one that does not read stays whole' +
  (isDeepStrictEqual(k.mail, LIVE) ? '' : '\n  got ' + JSON.stringify(k.mail)));
ok(!k.inbox.some(e => e.kind === 'delivery') && isDeepStrictEqual(k.inbox.map(e => e.text), ['pine → web-dev: not.txt 1 B sha256 eeeeeeeeeeee', 'looked at the mail', 'shipped the form']),
  'live: a delivery is out of the activity feed, and an entry of another kind is not mail whatever its text');

// ── Summary: each track, the mail addressed to its roles ──
const s = sm.runSummary({ now: NOW });
const [api, web] = s.tracks;
ok(s.mailLimit === 20 && isDeepStrictEqual(api.mail, [KEYS]), 'summary: a track has the deliveries to its roles, and none older than the journal window');
ok(web.mail.length === 20 && isDeepStrictEqual(web.mail.slice(0, 3), [EVIL_D, R2, R1]) && isDeepStrictEqual(web.mail.slice(3), Array.from({ length: 17 }, (_, i) => build(24 - i))),
  'summary: the newest 20 to the head and its workers, newest first');
ok(!s.tracks.some(t => t.mail.some(m => m.to === 'fir-head' || m.from === null)),
  'summary: a delivery to no role of a track, or one that does not read, is in no track');
ok(JSON.stringify(sm.runSummary({ now: NOW })) === JSON.stringify(s), 'summary: two calls give the same bytes');

// ── the page: Live and the Summary as they render it ──
fs.writeFileSync(path.join(MD, 'journal.oak.jsonl'), J(core.now(), 'delivery', 'pine → web-dev: fresh.txt 3 B sha256 012345012345') + '\n');
{
  const port = await freePort();
  const srv = spawn('node', [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(port)], { env: { ...process.env, HUBD_DIR: MD, HUBD_TEAM_DIR: MD }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('mail server did not start')), 8000);
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
        localStorage: { getItem: (x) => (x === 'hubd-mode' ? mode : null), setItem() {} },
        location: { search: '', hash: '' },
        fetch: (u) => fetch(`http://127.0.0.1:${port}${u}`),
        setInterval: () => 0, clearInterval: () => {}, console,
      });
      vm.runInContext(script, ctx);
      for (let i = 0; i < 100 && !(els[id] && els[id].innerHTML); i++) await new Promise(r => setTimeout(r, 30));
      return els;
    };
    const live = await render('live', 'mail');
    const rows = live.mail.innerHTML.split('<div class="entry m">').slice(1);
    ok(rows.length === 20 && rows[0].includes('pine &rarr; web-dev</span><span class="e-text">fresh.txt</span>') && rows.some(r => r.includes('1.7 KB &middot; c38149fffd05')),
      'serve: Live has a Mail row, a line per delivery with its route, name, size and hash');
    ok(rows.some(r => r.includes('grid-column:2/-1">relay: relay lost the line</span>')), 'serve: a delivery that does not read is shown whole');
    ok(!/<img src=x/.test(live.mail.innerHTML) && live.mail.innerHTML.includes('&lt;img src=x'), 'serve: a delivery\'s text is text, never markup');
    ok(!live.activity.innerHTML.includes('<span class="e-kind">delivery</span>') && live.activity.innerHTML.includes('looked at the mail'),
      'serve: the Activity feed has no deliveries');
    const sum = (await render('summary', 'summary')).summary.innerHTML;
    ok(/<div class="sub-head">Mail \(\d+\)<\/div><div class="item"><div>pine &rarr; web-dev <span class="meta">[^<]*<\/span><\/div><div class="meta">fresh\.txt &middot; /.test(sum),
      'serve: a track on the Summary has a Mail block with the deliveries to its roles');
  } finally { srv.kill(); }
}
core.setHubBase(T0); core.ensureHubDirs();

done();
