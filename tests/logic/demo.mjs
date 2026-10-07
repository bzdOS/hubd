// demo.mjs — `hub demo` writes an invented week into a folder of its own, and the board, the
// Summary, the agenda and the law candidates all have something to show on it. The story it holds
// is the one the docs walk through, so each part of it is asserted here: a change to the engine
// that leaves a part of the demo empty fails this file, not a reader of the docs.
//
// And it never touches the hub it is run from: that hub is snapshotted before and after.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ok, mktmp, cli, core, T0, REPO, done } from './_h.mjs';

const lib = (f) => import(path.join(REPO, 'hub/lib', f));
const { writeDemo, demoTarget } = await lib('demo.mjs');
const sm = await lib('summary.mjs');

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f), rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { out[rel + '/'] = 'dir'; walk(p); }
      else out[rel] = st.size + ':' + st.mtimeMs + ':' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── the story, read through the engine ──────────────────────────────────────
// Stamps count back from the moment the demo is made; the week-long windows (promote, journal)
// count back from the clock, so the demo is made now.
const NOW = Math.floor(Date.now() / 60000) * 60000;
const D1 = path.join(mktmp(), 'demo');
const r = writeDemo(D1, { nowMs: NOW });
ok(r.dir === D1 && r.tracks.join() === 'atlas,relay' && r.nodes.join() === 'fir,pine,maple' && r.roles === 6,
  'writeDemo reports two tracks, six roles, three machines');
ok(demoTarget(D1) === 'demo', 'the folder it wrote is known as a demo');

core.setHubBase(D1);
process.env.HUBD_TEAM_DIR = D1;   // the queues: from the demo, as the printed commands say
const s = sm.runSummary({ now: NOW });
const track = (p) => s.tracks.find(t => t.project === p) || {};
const ids = (xs) => (xs || []).map(x => x.id).join();
const verdict = (xs, id) => ((xs || []).find(x => x.id === id)?.verdict || {}).verdict ?? null;
const atlas = track('atlas'), relay = track('relay');

ok(s.tracks.map(t => t.project).join() === 'atlas,relay', 'Summary: the two tracks are atlas and relay');
ok(atlas.heads?.join() === 'atlas-head' && atlas.roles?.join() === 'atlas-dev,atlas-qa', 'atlas: a head and two workers');
ok(atlas.goal?.from === 'goal' && relay.goal?.from === 'goal', 'each track shows the Goal of its card');
ok(ids(atlas.working) === 'fir-1,fir-4', 'atlas: ranking v2 and the onboarding copy are in work');
ok(verdict(atlas.working, 'fir-1') === null && verdict(atlas.working, 'fir-4') === 'reject', 'atlas: the copy carries its REJECT, ranking v2 no verdict');
ok(ids(atlas.blocked) === 'fir-2' && atlas.blocked[0].waitingOn.join() === 'fir-1', 'atlas: the rollout is blocked on ranking v2');
ok(ids(atlas.closed) === 'fir-3' && verdict(atlas.closed, 'fir-3') === 'accept', 'atlas: the test fix closed today, accepted');
ok(ids(relay.working) === 'pine-2', 'relay: webhook retries are in work');
ok(ids(relay.blocked) === 'pine-3' && relay.blocked[0].waitingOn.join() === 'pine-2', 'relay: the release is blocked on the retries');
ok(ids(relay.closed) === 'pine-1' && verdict(relay.closed, 'pine-1') === 'accept', 'relay: backpressure closed today, accepted');
ok(relay.stalled?.length === 1 && relay.stalled[0].role === 'relay-dev' && relay.stalled[0].task === 'pine-2', 'relay: relay-dev is stalled on pine-2');
ok(atlas.stalled?.length === 0, 'atlas: nobody stalled');
ok(atlas.mail?.length > 0 && relay.mail?.length > 0, 'both tracks have mail delivered');

const esc = s.escalations;
ok(esc.fleet.join() === 'coord', 'escalations go to coord');
ok(esc.waiting.map(x => x.id).join() === 'pine-17' && esc.waiting[0].task === 'pine-2', 'the retries escalation waits');
ok(esc.answered.map(x => x.id).join() === 'fir-41' && !!esc.answered[0].answer, 'the cert escalation is answered in the card');

const node = (n) => s.nodes.find(x => x.node === n) || {};
ok(s.nodes.map(x => x.node).join() === 'fir,maple,pine', 'Summary: three machines');
ok(node('fir').stale === false && node('fir').disks.some(d => d.full), 'fir: fresh, a disk flagged full');
ok(node('pine').stale === false && !node('pine').disks.some(d => d.full), 'pine: healthy');
ok(node('maple').stale === true && node('maple').relays.some(x => x.down), 'maple: silent, its relay down');

const pa = core.runPromote({ project: 'atlas' }), pr = core.runPromote({ project: 'relay' });
ok(pa.laws.length === 1 && pa.candidates.length === 1 && Object.keys(pa.candidates[0].by).length === 2, 'atlas: one law, one candidate from two roles');
ok(pr.laws.length === 0 && pr.candidates.length === 1 && pr.candidates[0].count === 3, 'relay: one candidate said three times');

const shown = fs.readFileSync(path.join(D1, 'snapshot.fir.json'), 'utf8') + fs.readFileSync(path.join(D1, 'projects', 'atlas.md'), 'utf8');
ok(/"v":\s*1/.test(shown) && /## Laws/.test(shown), 'the files are the ones the tools write');

// ── the command ─────────────────────────────────────────────────────────────
const hubBefore = snapshot(T0);
const env = { HUBD_DIR: T0, HUBD_TEAM_DIR: T0, HUBD_NODE: 'cedar' };
const D2 = path.join(mktmp(), 'fresh');
let c = cli(['demo', D2], { env });
ok(c.code === 0 && demoTarget(D2) === 'demo' && c.out.includes(`HUBD_DIR=${D2} HUBD_TEAM_DIR=${D2} hub board`), 'hub demo <new dir>: written, and the commands to look at it printed');
ok(/hub board/.test(c.out) && /hub serve/.test(c.out), 'it names the board and serve');

fs.writeFileSync(path.join(D2, 'mine.txt'), 'left behind\n');
c = cli(['demo', D2], { env });
ok(c.code === 0 && !fs.existsSync(path.join(D2, 'mine.txt')) && demoTarget(D2) === 'demo', 'run again over a demo: a fresh one replaces it');

const OTHER = mktmp();
fs.writeFileSync(path.join(OTHER, 'notes.md'), '# mine\n');
const otherBefore = snapshot(OTHER);
c = cli(['demo', OTHER], { env });
ok(c.code !== 0 && /not empty/.test(c.out) && same(snapshot(OTHER), otherBefore), 'a folder holding anything else is refused, untouched');

c = cli(['demo', T0], { env });
ok(c.code !== 0 && /is this hub/.test(c.out), 'the hub itself is refused');
c = cli(['demo', path.join(T0, 'demo')], { env });
ok(c.code !== 0 && /is inside this hub/.test(c.out) && !fs.existsSync(path.join(T0, 'demo')), 'a folder inside the hub is refused: it would sync as real work');
const TEAM = mktmp();
c = cli(['demo', path.join(TEAM, 'sub', 'demo')], { env: { ...env, HUBD_TEAM_DIR: TEAM } });
ok(c.code !== 0 && /inside the team folder/.test(c.out) && !fs.existsSync(path.join(TEAM, 'sub')), 'and one inside the team folder');
ok(same(snapshot(T0), hubBefore), 'the hub it ran from: not one byte changed');

const denv = { HUBD_DIR: D2, HUBD_TEAM_DIR: D2, HUBD_NODE: 'oak' };
c = cli(['board'], { env: denv });
ok(c.code === 0 && /atlas/.test(c.out) && /relay/.test(c.out), 'hub board on the demo shows both tracks');
c = cli(['agenda'], { env: denv });
ok(c.code === 0 && /maple-4/.test(c.out), 'hub agenda on the demo holds the owner\'s button');

done();
