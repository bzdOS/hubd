// repair.mjs — what a dead reader leaves behind, and one message said many times: hub queue repair, hub queue dedupe
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ok, mktmp, cli, queueLib, done } from './_h.mjs';

const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;   // exited by the time it returns
const headers = (t) => (String(t).match(/^## \d{4}-\d\d-\d\d \d\d:\d\d · from .*$/gm) || []);

// ── queue repair: a dead marker and a dead process's namespace, judged by the kernel, never by age ──
// A fleet cleared stuck waiter markers itself by parsing them in shell, and once took a date's
// digits for the pid: every live marker then looked dead.
{
  const R = mktmp(), env = { HUBD_DIR: R, HUBD_TEAM_DIR: R };
  const st = path.join(R, '.qstate');
  fs.mkdirSync(path.join(R, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(st, '__watchall__'), { recursive: true });
  const dead = deadPid(), since = new Date().toISOString();
  const marker = (p, pid) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify({ pid, since })); };
  marker(path.join(st, 'worker.waiter'), dead);
  marker(path.join(st, 'live.waiter'), process.pid);                       // this test is alive, the CLI is another process
  fs.writeFileSync(path.join(st, 'odd.waiter'), '2026-10-08');              // a date where the pid goes
  fs.mkdirSync(path.join(st, `p-${dead}-77`));
  fs.writeFileSync(path.join(st, `p-${dead}-77`, 'news.cedar.queue.md.offset'), '0');
  fs.mkdirSync(path.join(st, `p-${process.pid}-1`));
  fs.mkdirSync(path.join(st, 'sess-a'));
  marker(path.join(st, '__watchall__', `p-${dead}-9`, 'waiter'), dead);

  const dry = cli(['queue', 'repair'], { env });
  ok(dry.code === 0 && /waiter \.qstate\/worker\.waiter\s+pid \d+ is gone/.test(dry.out) && /waiter \.qstate\/__watchall__\/p-\d+-9\/waiter/.test(dry.out) &&
    /reader p-\d+-77\s+pid \d+ is gone/.test(dry.out) && /reader __watchall__\/p-\d+-9/.test(dry.out) && /odd\.waiter\s+names no pid: left alone/.test(dry.out) &&
    /Nothing changed: --apply/.test(dry.out), `queue repair: the dead markers and namespaces, the unreadable marker named and left (${dry.out})`);
  ok(!/live\.waiter|p-\d+-1\b|sess-a/.test(dry.out), 'queue repair: a live marker, a live process\'s namespace and a named subscriber are not listed');
  ok(fs.existsSync(path.join(st, 'worker.waiter')) && fs.existsSync(path.join(st, `p-${dead}-77`)), 'queue repair: the dry run changes nothing');
  let j = null; try { j = JSON.parse(cli(['queue', 'repair', '--json'], { env }).stdout); } catch {}
  ok(j && j.apply === false && j.waiters.length === 2 && j.waiters.every(w => w.pid === dead && w.since === since) &&
    j.namespaces.map(n => `${n.tap}:${n.name}`).sort().join(',') === `false:p-${dead}-77,true:p-${dead}-9` && j.unreadable.length === 1 && !j.stalls.length,
    'queue repair --json: waiters, namespaces, unreadable, stalls');

  const ap = cli(['queue', 'repair', '--apply'], { env });
  ok(ap.code === 0 && !fs.existsSync(path.join(st, 'worker.waiter')) && fs.existsSync(path.join(st, 'live.waiter')) && fs.existsSync(path.join(st, 'odd.waiter')),
    `queue repair --apply: the dead marker removed, the live and the unreadable one left (${ap.code})`);
  ok(fs.existsSync(path.join(st, '_archive', `p-${dead}-77`, 'news.cedar.queue.md.offset')) && fs.existsSync(path.join(st, '_archive', '__watchall__', `p-${dead}-9`)) &&
    !fs.existsSync(path.join(st, `p-${dead}-77`)) && fs.existsSync(path.join(st, `p-${process.pid}-1`)) && fs.existsSync(path.join(st, 'sess-a')),
    'queue repair --apply: a dead process\'s namespaces moved to .qstate/_archive/, cursor and all; the others stay');
  const again = cli(['queue', 'repair'], { env });
  ok(again.code === 0 && /Nothing to repair/.test(again.out) && /odd\.waiter/.test(again.out), 'queue repair: run again, nothing left to repair');

  if (process.getuid && process.getuid() !== 0) {
    queueLib.queueSend('worker', 'one order', { from: 'boss', root: R });
    await queueLib.queueWait('worker', { timeout: 0, root: R });
    const off = path.join(st, 'worker.cedar.queue.md.offset');
    fs.chmodSync(off, 0o444);
    const sj = cli(['queue', 'repair'], { env });
    ok(sj.code === 1 && /cursor \.qstate\/worker\.cedar\.queue\.md\.offset\s+cannot be written here \(EACCES\)/.test(sj.out),
      `queue repair: a cursor this node cannot write is named with the remedy, and exits 1 (${sj.code})`);
    fs.chmodSync(off, 0o644);
  }
}

// ── queue dedupe: one message said many times, folded where the cursors are ──
// Measured on a fleet node: two workers' queues at 4478 and 5197 blocks, 197 of the last 200 one
// nudge from a shell loop. The fleet folded it from outside, and its split took a message's own
// "## <date>" line for a block: real orders went out of delivery with the copies.
{
  const Q = mktmp(), env = { HUBD_DIR: Q, HUBD_TEAM_DIR: Q };
  const qf = path.join(Q, 'queues', 'worker.cedar.queue.md');
  const shared = path.join(Q, '.qstate', 'worker.cedar.queue.md.offset');
  const send = (text, task) => queueLib.queueSend('worker', text, { from: 'looper', root: Q, ...(task ? { task } : {}) });
  const NUDGE = 'any news on the build?';
  send(NUDGE); send(NUDGE); send(NUDGE);
  await queueLib.queueWait('worker', { timeout: 0, root: Q });                  // the shared cursor's watermark: the third copy
  send('real order one\n## 2026-01-01 00:00 a heading inside the order\nstill the order'); send(NUDGE);
  await queueLib.queueWaitAll({ timeout: 0, root: Q, subscriber: 'tap1' });     // a tap's: the fourth
  send(NUDGE); send(NUDGE, 'x-1'); send(NUDGE); send(NUDGE, 'x-1');
  send('ack?'); send('ack?'); send('ack?');
  send(NUDGE); send('real order two');
  const before = fs.readFileSync(qf, 'utf8'), offBefore = fs.readFileSync(shared, 'utf8');
  const hs = headers(before);
  ok(hs.length === 14, `dedupe: the fixture holds 14 blocks (${hs.length})`);

  const dry = cli(['queue', 'dedupe', 'worker'], { env });
  ok(dry.code === 0 && /worker\.cedar\.queue\.md: 14 block\(s\), 5 unique, 1 flood group\(s\) \(7 repeats\)/.test(dry.out) &&
    /x7\s+## .* · from looper .*"any news on the build\?"/.test(dry.out) &&
    /-> would drop 4 block\(s\), keeps the newest of each and 2 a reader's watermark stands on/.test(dry.out) && /Nothing changed: --apply folds every flood of 5\+ copies/.test(dry.out),
    `queue dedupe: the flood counted, one text about another task and one said three times are not floods (${dry.out})`);
  ok(fs.readFileSync(qf, 'utf8') === before && fs.readFileSync(shared, 'utf8') === offBefore && !fs.existsSync(path.join(Q, 'queues', 'archive')),
    'queue dedupe: the dry run changes nothing');
  let dj = null; try { dj = JSON.parse(cli(['queue', 'dedupe', 'worker', '--json'], { env }).stdout); } catch {}
  ok(dj && dj.role === 'worker' && dj.min === 5 && dj.files.length === 1 && dj.files[0].drop === 4 && dj.files[0].anchored === 2 && dj.files[0].held === null,
    'queue dedupe --json: the same counts as data');
  let d2 = null; try { d2 = JSON.parse(cli(['queue', 'dedupe', 'worker', '--min', '3', '--json'], { env }).stdout); } catch {}
  ok(d2 && d2.files[0].floods === 2 && d2.files[0].drop === 6, '--min lowers the bar: three copies are a flood at --min 3');

  const ap = cli(['queue', 'dedupe', 'worker', '--apply'], { env });
  const after = fs.readFileSync(qf, 'utf8'), ha = headers(after);
  ok(ap.code === 0 && /-> dropped 4 block\(s\), \d+B -> \d+B/.test(ap.out) && /2 cursor\(s\) here moved with their watermark/.test(ap.out),
    `queue dedupe --apply: four copies dropped, both cursors moved (${ap.out})`);
  ok(ha.join('\n') === [2, 3, 4, 6, 8, 9, 10, 11, 12, 13].map(i => hs[i]).join('\n'),
    'queue dedupe --apply: the two watermarked copies and the newest kept, the copies about task x-1 and every other block too, in their order');
  ok(after.includes('## 2026-01-01 00:00 a heading inside the order\nstill the order'), 'queue dedupe --apply: a heading inside an order stays inside it');
  const arch = fs.readdirSync(path.join(Q, 'queues', 'archive')).filter(f => /^worker\.cedar\.folded-\d{8}-\d{4}\.md$/.test(f));
  ok(arch.length === 1 && headers(fs.readFileSync(path.join(Q, 'queues', 'archive', arch[0]), 'utf8')).join('\n') === [0, 1, 5, 7].map(i => hs[i]).join('\n'),
    `queue dedupe --apply: the dropped copies are in queues/archive/, under a name no reader takes for a queue (${arch})`);

  const next = await queueLib.queueWait('worker', { timeout: 0, root: Q });
  ok(next.changed && headers(next.text).join('\n') === [3, 4, 6, 8, 9, 10, 11, 12, 13].map(i => hs[i]).join('\n'),
    `queue dedupe: the reader goes on after its watermark, nothing handed out twice and nothing skipped (${headers(next.text).length})`);
  const tap = await queueLib.queueWaitAll({ timeout: 0, root: Q, subscriber: 'tap1' });
  const tapText = tap.changed ? tap.events.map(e => e.text).join('\n') : '';
  ok(headers(tapText).join('\n') === [6, 8, 9, 10, 11, 12, 13].map(i => hs[i]).join('\n'), 'queue dedupe: and so does the tap, from its own');
  const re = cli(['queue', 'dedupe', 'worker'], { env });
  ok(/10 block\(s\), 5 unique, 0 flood group\(s\)/.test(re.out) && /-> no flood, left alone/.test(re.out), 'queue dedupe: folded once, there is no flood left');
}

// ── what dedupe leaves alone ──
{
  // A shard another node still writes: only that node rewrites it.
  const H = mktmp(), env = { HUBD_DIR: H, HUBD_TEAM_DIR: H };
  execSync('git init -q .', { cwd: H });
  for (let i = 0; i < 6; i++) queueLib.queueSend('worker', 'again', { from: 'looper', root: H, node: 'oak' });
  const before = fs.readFileSync(path.join(H, 'queues', 'worker.oak.queue.md'), 'utf8');
  const out = cli(['queue', 'dedupe', 'worker', '--apply'], { env });
  ok(/-> left: a shard of node oak, which still writes to the mesh: only that node rewrites it \(hub queue dedupe there\)/.test(out.out) &&
    fs.readFileSync(path.join(H, 'queues', 'worker.oak.queue.md'), 'utf8') === before, `queue dedupe: a live node's shard is left to that node (${out.out})`);

  // A cursor with no watermark has nothing to find its place by in a shorter file.
  const W = mktmp(), wenv = { HUBD_DIR: W, HUBD_TEAM_DIR: W };
  for (let i = 0; i < 6; i++) queueLib.queueSend('worker', 'again', { from: 'looper', root: W });
  fs.mkdirSync(path.join(W, '.qstate'), { recursive: true });
  fs.writeFileSync(path.join(W, '.qstate', 'worker.cedar.queue.md.offset'), '120');
  const wb = fs.readFileSync(path.join(W, 'queues', 'worker.cedar.queue.md'), 'utf8');
  const wo = cli(['queue', 'dedupe', 'worker', '--apply'], { env: wenv });
  ok(/-> left: a cursor here has no watermark/.test(wo.out) && fs.readFileSync(path.join(W, 'queues', 'worker.cedar.queue.md'), 'utf8') === wb,
    'queue dedupe: a cursor without a watermark holds the shard as it is');

  ok(cli(['queue', 'dedupe', 'worker', '--min', '1'], { env: wenv }).code === 1 && cli(['queue', 'dedupe', 'worker', '--min', 'x'], { env: wenv }).code === 1 &&
    cli(['queue', 'dedupe'], { env: wenv }).code === 1 && cli(['queue', 'dedupe', '../x'], { env: wenv }).code === 1,
    'queue dedupe: --min under 2 or not a number, no role, a role that is not a name: refused');
  ok(/No queue files for role nobody/.test(cli(['queue', 'dedupe', 'nobody'], { env: wenv }).out), 'queue dedupe: a role without a queue says so');
}

done();
