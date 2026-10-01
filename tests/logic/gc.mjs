// gc.mjs — hub gc: what it lists, what --apply removes, archives by moving
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, ok, mktmp, run, T0, core, done } from './_h.mjs';

// ── CLI: `hub gc` removes only the generated backup, never a user .bak ─────────
const T1 = mktmp();
fs.writeFileSync(path.join(T1, 'tasks.json.bak.20260101T000000Z'), 'old cache');
fs.writeFileSync(path.join(T1, 'mynote.bak.md'), 'a card the user backed up by hand');
const gcDryT1 = run('gc', { HUBD_DIR: T1 });
ok(fs.existsSync(path.join(T1, 'tasks.json.bak.20260101T000000Z')) && /task cache backup tasks\.json\.bak/.test(gcDryT1.out) && /dry run, nothing touched/.test(gcDryT1.out),
  'gc: without --apply the local litter is listed and nothing is removed');
const gcJsonT1 = run('gc --json', { HUBD_DIR: T1 });
let gcJsonOk = false; try { gcJsonOk = JSON.parse(gcJsonT1.out).local.backups.length === 1; } catch {}
ok(gcJsonOk, 'gc: --json prints JSON and nothing else');
run('gc --apply --by dev-t', { HUBD_DIR: T1 });
ok(!fs.existsSync(path.join(T1, 'tasks.json.bak.20260101T000000Z')), 'gc: --apply removes tasks.json.bak.*');
ok(fs.existsSync(path.join(T1, 'mynote.bak.md')), 'gc: keeps a user .bak file (precise matcher, no data loss)');
fs.rmSync(T1, { recursive: true, force: true });

// ── hub gc: list by class, archive by moving, one commit mesh-sync accepts ──
const HG = mktmp();
core.setHubBase(HG); core.ensureHubDirs();
{
  const gc = await import(path.join(REPO, 'hub/lib/gc.mjs'));
  const sh0 = (c, cwd) => execSync(c, { cwd, stdio: 'pipe' }).toString();
  const q = path.join(HG, 'queues'), st = path.join(HG, '.qstate');
  fs.mkdirSync(q, { recursive: true }); fs.mkdirSync(st, { recursive: true });
  const none = gc.hubGcPlan({ root: HG });
  ok(!none.queues.length && none.notes.some(n => /no roles are declared/.test(n)), 'gc: with no registry nothing is judged by name, and it says so');
  core.runResourceSet({ slug: 'live-w', type: 'role', attrs: { rank: 'worker', project: 'p' }, by: 'dev-t' });
  core.runResourceSet({ slug: 'old-w', type: 'role', status: 'off', attrs: { rank: 'worker', project: 'p' }, by: 'dev-t' });
  fs.writeFileSync(path.join(HG, 'owner-roles.json'), '["boss"]');
  const old = '\n## 2026-01-01 00:00 · from x\nold order\n';
  // the tests run as node "cedar": .cedar. files are this node's shards, .n2. another node's
  for (const f of ['ghost.cedar.queue.md', 'old-w.cedar.queue.md', 'live-w.cedar.queue.md', 'boss.cedar.queue.md', 'ghost.n2.queue.md', 'remote-w.cedar.queue.md',
    'ghost.gone.queue.md', 'legacy.queue.md']) fs.writeFileSync(path.join(q, f), old);
  fs.writeFileSync(path.join(q, 'fresh.cedar.queue.md'), `\n## ${core.now()} · from x\nnew\n`);
  fs.writeFileSync(path.join(q, 'hollow.cedar.queue.md'), '');
  const longAgo = new Date(Date.now() - 60 * 86400000);
  fs.utimesSync(path.join(q, 'hollow.cedar.queue.md'), longAgo, longAgo);
  fs.writeFileSync(path.join(st, 'ghost.cedar.queue.md.offset'), '10');
  // alive on another node, as that node published it: not a role, but not gone either
  fs.writeFileSync(path.join(HG, 'presence.n2.json'), JSON.stringify({ node: 'n2', written: core.now(), agents: [{ agent: 'remote-w', last_seen: core.now(), ttlMin: 15, node: 'n2' }] }));
  fs.writeFileSync(path.join(HG, 'tasks.json.bak.1'), 'cache backup');
  fs.writeFileSync(path.join(st, 'gone.waiter'), JSON.stringify({ pid: 999999, since: '2020-01-01' }));
  fs.mkdirSync(path.join(HG, 'presence'), { recursive: true });
  fs.writeFileSync(path.join(HG, 'presence', 'stranger.json'), JSON.stringify({ agent: 'stranger', last_seen: '2026-01-01 00:00', ttlMin: 15 }));
  core.recordEnvObservation('cursor-conflict', 'ghost');
  core.runTaskAdd({ project: 'p', text: 'on an off role', assignee: 'old-w', by: 'dev-t' });
  sh0('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m seed', HG);
  const plan = gc.hubGcPlan({ root: HG });
  ok(plan.queues.map(x => x.file).sort().join(',') === 'ghost.cedar.queue.md,ghost.gone.queue.md,legacy.queue.md,old-w.cedar.queue.md',
    `gc: queues of a name that is no role and of a role switched off are listed — this node's, a gone node's, a node-less one; live, owner, fresh and alive-elsewhere ones are not (${plan.queues.map(x => x.file)})`);
  ok(plan.skipped.some(x => x.file === 'ghost.n2.queue.md' && /shard of node n2, which still writes/.test(x.why)) && plan.skipped.some(x => x.file === 'hollow.cedar.queue.md' && /no message/.test(x.why)),
    'gc: a live node\'s shard and an empty file are left where they are, each with its reason');
  ok(plan.local.backups.join() === 'tasks.json.bak.1' && fs.existsSync(path.join(HG, 'tasks.json.bak.1')), 'gc: this node\'s litter is listed by the dry run and left in place');
  ok(plan.waiters.length === 1 && plan.presence.map(p => p.agent).join() === 'stranger' && plan.env.some(e => e.value === 'ghost'),
    'gc: dead waiter markers, stale presence of non-roles and notices whose cause is gone are listed');
  ok(plan.tasks.length === 1 && plan.tasks[0].assignee === 'old-w' && plan.tasks[0].reason === 'role is off', 'gc: open tasks on a role that is off are listed for the head to decide');
  ok(fs.existsSync(path.join(q, 'ghost.cedar.queue.md')), 'gc: the dry run moves nothing');
  let eb = null; try { gc.runHubGc({ root: HG, apply: true }); } catch (e) { eb = e.message; }
  ok(/by required/.test(eb || ''), 'gc: --apply needs an author');
  const res = gc.runHubGc({ root: HG, apply: true, by: 'dev-t' });
  ok(res.moved.length === 4 && fs.readFileSync(path.join(q, 'archive', 'ghost.cedar.queue.md'), 'utf8') === old && !fs.existsSync(path.join(q, 'ghost.cedar.queue.md')),
    'gc: --apply moves the queue into queues/archive/ with its bytes intact');
  ok(fs.existsSync(path.join(q, 'ghost.n2.queue.md')) && fs.existsSync(path.join(q, 'hollow.cedar.queue.md')), 'gc: --apply leaves another node\'s shard and the empty file alone');
  ok(fs.existsSync(path.join(st, '_archive', 'ghost.cedar.queue.md.offset')) && !fs.existsSync(path.join(st, 'gone.waiter')) &&
    fs.existsSync(path.join(HG, 'presence', '_archive', 'stranger.json')), 'gc: its cursor goes along, the dead marker goes, the stale presence is archived');
  ok(!fs.existsSync(path.join(HG, 'tasks.json.bak.1')) && res.localRemoved.removed >= 1, 'gc: --apply clears this node\'s litter');
  ok(core.loadTasks().tasks.find(t => t.assignee === 'old-w').status === 'open', 'gc: tasks are never touched');
  ok(!!res.commit && sh0('git log -1 --format=%s', HG).trim() === 'hub gc: archived 4 queue file(s) by dev-t', 'gc: the move is one commit that says what it was');
  // mesh-sync's guard, run against the same move left uncommitted
  sh0('git reset -q --soft HEAD~1 && git reset -q', HG);
  let rc = 0; try { execSync(`sh ${REPO}/scripts/mesh-sync.sh`, { env: { ...process.env, HUBD_DIR: HG }, stdio: 'pipe' }); } catch (e) { rc = e.status; }
  ok(rc === 0, `gc: mesh-sync accepts an archived queue even uncommitted — the bytes are in the archive (got ${rc})`);
  fs.rmSync(path.join(q, 'live-w.cedar.queue.md'));
  rc = 0; try { execSync(`sh ${REPO}/scripts/mesh-sync.sh`, { env: { ...process.env, HUBD_DIR: HG }, stdio: 'pipe' }); } catch (e) { rc = e.status; }
  ok(rc === 4, `gc: while an rm of a queue is still refused (got ${rc})`);
}
core.setHubBase(T0); core.ensureHubDirs();

done();
