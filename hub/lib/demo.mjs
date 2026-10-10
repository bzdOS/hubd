/* demo.mjs — a hub to look at before any agent has written to one: `hub demo [dir]`.
 *
 * The board, the Summary, the owner's agenda and the law candidates are worth something only on a
 * hub a team has worked in for a week, so a newcomer met an empty board and was told to wait. This
 * writes that week instead: an invented team of two tracks with a head and workers each, a fleet
 * role above them, three machines. Every file is written as the agents, the fleet tools and the
 * mail relay leave it, with stamps counted back from the moment it is made, so what the board
 * shows is today, not a date in the past.
 *
 * The story it holds, so a reader of the docs can find each part:
 *   atlas  ranking v2 in progress, its 10% rollout blocked on it; a test fix accepted and closed
 *          today; the onboarding copy handed in and rejected; a law accepted two days ago, and a
 *          rule two roles keep proposing (a candidate);
 *   relay  backpressure accepted and closed today; webhook retries stalled on the staging key
 *          server, escalated to coord and waiting; the release blocked on it; a rule one role
 *          said three times this week (a candidate);
 *   infra  coord's own work; an escalation answered last night in the card's Owner decisions;
 *          the owner holds two buttons: a question from the atlas head, a disk to approve;
 *   nodes  fir with a disk at 93%, pine healthy, maple silent for 38 minutes with a failed relay.
 *
 * Nothing is read from any other hub, and every name is invented (atlas, relay, fir, pine, maple).
 * A folder already holding anything but an earlier demo is refused, not merged into. */
import fs from 'node:fs';
import path from 'node:path';
import { checkReflect, renderReflect, ruleId } from './reflect.mjs';

const MARKER = '.hubd-demo';
const MIN = 1, H = 60, D = 1440;

/** What `dir` holds, as far as writing a demo into it goes: 'missing', 'empty', 'demo' or 'other'. */
export function demoTarget(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'other'; }
  if (!names.length) return 'empty';
  return names.includes(MARKER) ? 'demo' : 'other';
}

/** Write the demo hub into `dir` (missing, empty, or an earlier demo, which is replaced).
 *  Returns what was written: { dir, files, projects, tracks, roles, nodes, tasks, entries }. */
export function writeDemo(dir, { nowMs = Date.now(), version = '' } = {}) {
  const target = demoTarget(dir);
  if (target === 'other') throw new Error(`${dir} holds files that are not a demo hub; hub demo writes only into a new or empty folder, or over an earlier demo`);
  if (target === 'demo') fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const at = (min) => new Date(nowMs - min * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const iso = (min) => new Date(nowMs - min * 60000).toISOString().slice(0, 19) + 'Z';
  let files = 0;
  const put = (rel, body) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 1) + '\n');
    files++;
  };

  /* ── roles and machines: resource cards, as `hub resource set` writes them ── */
  const resource = (slug, attrs, digest, set) => [
    '---', 'kind: resource', ...Object.entries(attrs).map(([k, v]) => `${k}: ${v}`), '---',
    `# ${slug}`, '', `- slug: ${slug}`, `- set: ${at(set)} by owner`, '', '## Digest', '', digest, '',
  ].join('\n');
  const ROLES = [
    ['atlas-head', { type: 'role', rank: 'head', project: 'atlas' }, 'Runs the atlas track: dispatches the work, reads every hand-in, accepts or rejects it.'],
    ['atlas-dev', { type: 'role', rank: 'worker', project: 'atlas', head: '[[atlas-head]]' }, 'Builds atlas features; hands each one in with its numbers and screenshots.'],
    ['atlas-qa', { type: 'role', rank: 'worker', project: 'atlas', head: '[[atlas-head]]' }, 'Owns the atlas test suites and the flaky ones.'],
    ['relay-head', { type: 'role', rank: 'head', project: 'relay' }, 'Runs the relay track and cuts its releases.'],
    ['relay-dev', { type: 'role', rank: 'worker', project: 'relay', head: '[[relay-head]]' }, 'Builds the relay: ingest, webhooks, the public API.'],
    ['coord', { type: 'role', rank: 'fleet', project: 'infra' }, 'Watches the machines and the heads; takes what a head cannot decide to the owner.'],
  ];
  for (const [slug, attrs, digest] of ROLES) put(`resources/${slug}.md`, resource(slug, attrs, digest, 8 * D));
  const MACHINES = [
    ['fir', { type: 'host', os: 'macOS 15', address: '192.0.2.11', status: 'up' }, "The owner's workstation; runs the atlas roles."],
    ['pine', { type: 'host', os: 'FreeBSD 15.0', address: '192.0.2.12', status: 'up' }, 'The build box; runs the relay roles and the mail relay.'],
    ['maple', { type: 'host', os: 'Debian 13', address: '192.0.2.13', status: 'up' }, 'Holds the backups; runs coord.'],
    ['relay-api', { type: 'service', address: 'https://relay.example.com', status: 'up', runs_on: '[[pine]]', part_of: '[[relay]]' }, 'The public relay API.'],
  ];
  for (const [slug, attrs, digest] of MACHINES) put(`resources/${slug}.md`, resource(slug, attrs, digest, 8 * D));
  put('owner-roles.json', ['owner']);

  /* ── tasks: each node's event log, as the engine appends it ── */
  const TASKS = [
    // id, project, text, by, created, assignee, more
    ['fir-6', 'atlas', 'Split the settings page into tabs', 'atlas-head', 7 * D, 'atlas-dev', { done: [5 * D, 'atlas-head'] }],
    ['fir-5', 'atlas', 'Audit third-party scripts on the landing page', 'atlas-head', 6 * D, null, {}],
    ['fir-1', 'atlas', 'Ship search ranking v2', 'atlas-head', 4 * D + 5 * H, 'atlas-dev', { importance: 'high' }],
    ['fir-2', 'atlas', 'Turn ranking v2 on for 10% of traffic', 'atlas-head', 4 * D + 5 * H, 'atlas-head', { depends_on: ['fir-1'] }],
    ['fir-3', 'atlas', 'Fix the flaky login test', 'atlas-head', 3 * D + H, 'atlas-qa', { done: [5 * H, 'atlas-head'] }],
    ['fir-4', 'atlas', 'Rewrite the onboarding copy', 'atlas-head', 2 * D + 2 * H, 'atlas-dev', {}],
    ['pine-1', 'relay', 'Backpressure on the ingest queue', 'relay-head', 5 * D + 3 * H, 'relay-dev', { done: [3 * H, 'relay-head'] }],
    ['pine-4', 'relay', 'Rate-limit headers on the public API', 'relay-head', 4 * D, null, {}],
    ['pine-2', 'relay', 'Retry webhook delivery with backoff', 'relay-head', 2 * D + 5 * H, 'relay-dev', { importance: 'high' }],
    ['pine-3', 'relay', 'Cut release 2.4.1', 'relay-head', 2 * D + 5 * H, 'relay-head', { depends_on: ['pine-2'] }],
    ['maple-1', 'infra', 'Move the nightly backups to the new disk', 'coord', 2 * D, 'coord', {}],
    ['maple-2', 'infra', 'Renew the TLS cert for atlas.example.com', 'coord', 20 * H, 'owner', { done: [19 * H, 'owner'] }],
    ['maple-3', 'infra', 'Free space on fir: / is at 93%', 'coord', 45 * MIN, 'coord', {}],
    ['maple-4', 'infra', 'Approve a 2 TB disk for the build cache on fir', 'coord', 39 * MIN, 'owner', {}],
  ];
  const events = new Map();   // node -> lines
  const journal = [];         // { node, min, entry }
  const say = (node, min, project, agent, kind, text, extra = {}) =>
    journal.push({ node, min, entry: { ts: at(min), project, agent, kind, text, ...extra, ...(version ? { v: version } : {}) } });
  const nodeOf = (id) => id.split('-')[0];
  for (const [id, project, text, by, created, assignee, more] of TASKS) {
    const node = nodeOf(id);
    if (!events.has(node)) events.set(node, []);
    const t = { id, project, text, importance: more.importance || 'normal', deadline: null, cat: null, tags: [], assignee,
      status: 'open', created: at(created), by, depends_on: more.depends_on || [], resources: [] };
    events.get(node).push({ min: created, line: { ts: at(created), node, ev: 'add', id, t } });
    say(node, created, project, by, 'task', `+ task #${id}: ${text}`);
    if (more.done) {
      const [when, who] = more.done;
      events.get(node).push({ min: when, line: { ts: at(when), node, ev: 'set', id, keyed: 'origin', patch: { status: 'done', done: at(when) } } });
      say(node, when, project, who, 'done', `#${id} ${text}`);
    }
  }
  for (const [node, list] of events) put(`tasks.${node}.events.jsonl`, list.sort((x, y) => y.min - x.min).map(x => JSON.stringify(x.line)).join('\n') + '\n');

  /* ── the week, as the journal holds it: hand-ins, verdicts, reflections, a block, the mail ── */
  const report = (node, min, project, agent, lines, reflect) => {
    const r = checkReflect(reflect);
    say(node, min, project, agent, 'note', [...lines, ...renderReflect(r).split('\n')].join(' · '), { reflect: r });
  };
  const SCREENSHOT = 'attach a screenshot to every UI task you hand in';
  const SMOKE = 'run the smoke test before every deploy';

  say('fir', 6 * D + 3 * H, 'atlas', 'atlas-head', 'note', 'Dispatched fir-6 to atlas-dev; fir-5 waits for a free hand.');
  report('fir', 6 * D + H, 'atlas', 'atlas-dev', ['fir-6: first pass, two tabs of three'],
    { goal: 'split the settings page', result: 'partial', obstacle: 'unclear-dispatch', obstacle_fact: 'the dispatch named two tabs, the mock shows three',
      instead: 'compare the dispatch with the mock before starting', rule: 'attach a screenshot to every UI task' });
  report('fir', 5 * D + 20 * H, 'atlas', 'atlas-qa', ['checked fir-6 against the mock'],
    { goal: 'review the settings tabs', result: 'done', obstacle: 'none', instead: 'nothing', rule: 'attach a screenshot to each UI task you hand in' });
  say('fir', 5 * D + 2 * H, 'atlas', 'atlas-dev', 'done', 'fir-6: settings split into Profile, Billing and Team; e2e 41/41, screenshots attached');
  say('fir', 5 * D + H, 'atlas', 'atlas-head', 'note', 'ACCEPT #fir-6: three tabs, e2e 41/41, the screenshots match the mock');
  report('fir', 4 * D + 4 * H, 'atlas', 'atlas-dev', ['fir-1: the new index builds; the deploy to staging failed once'],
    { goal: 'ship the ranking v2 index to staging', result: 'partial', obstacle: 'environment', obstacle_fact: 'the staging database was down for 20 minutes during the deploy',
      instead: 'check the database before the deploy', rule: SMOKE });
  say('fir', 2 * D + 6 * H, 'atlas', 'atlas-head', 'decision', `law accepted: ${SCREENSHOT}`,
    { law: { verdict: 'accepted', id: ruleId(SCREENSHOT), rule: SCREENSHOT, count: 2, roles: ['atlas-dev', 'atlas-qa'] } });
  report('fir', 2 * D, 'atlas', 'atlas-qa', ['fir-3: the flake reproduces 7 times in 50 runs'],
    { goal: 'find why the login test flakes', result: 'partial', obstacle: 'environment', obstacle_fact: 'the CI runner reuses one browser profile between jobs',
      instead: 'start every run from a clean profile', rule: SMOKE });
  say('fir', D + 3 * H, 'atlas', 'atlas-dev', 'done', 'fir-4: onboarding copy rewritten on all 4 screens; screenshots attached');
  report('fir', D + 2 * H, 'atlas', 'atlas-dev', ['handed in fir-4'],
    { goal: 'rewrite the onboarding copy', result: 'done', obstacle: 'none', instead: 'nothing', rule: 'none' });
  say('fir', 6 * H, 'atlas', 'atlas-head', 'note', 'REJECT #fir-4: the hero still says "beta", and the Team screen has no screenshot; redo both');
  say('fir', 5 * H + 10, 'atlas', 'atlas-qa', 'done', 'fir-3: the test waited on a fixed 2 s timer; it now waits for the session cookie. 50 runs, 0 failures (was 7 of 50)');
  say('fir', 5 * H + 5, 'atlas', 'atlas-head', 'note', 'ACCEPT #fir-3: 50 runs, 0 failures, the diff touches only the test');
  say('fir', 3 * H, 'atlas', 'atlas-dev', 'note', 'fir-1: index rebuilt with the new weights; p95 query 84 ms on staging (was 140 ms). Next: the relevance check on 200 saved queries');
  say('fir', 19 * H, 'infra', 'owner', 'decision', `answered ${at(20 * H)} · from atlas-head · id fir-41: renewed the cert; renew a week ahead from now on`);

  report('pine', 4 * D + 20 * H, 'relay', 'relay-dev', ['pine-1: backpressure in; the load test stopped at 20k connections'],
    { goal: 'hold the ingest queue under load', result: 'partial', obstacle: 'environment', obstacle_fact: 'the load generator ran out of file descriptors at 20k connections',
      instead: 'raise the limit in the harness first', rule: 'raise the open-file limit before a load test' });
  report('pine', 2 * D + 3 * H, 'relay', 'relay-dev', ['pine-1: 50k msg/s on the second run'],
    { goal: 'measure the ingest queue at 50k msg/s', result: 'partial', obstacle: 'environment', obstacle_fact: 'the new load box came up with the default limit of 1024',
      instead: 'put the limit in the box image', rule: 'raise the open file limit before every load test' });
  report('pine', 20 * H, 'relay', 'relay-dev', ['pine-1: 3 restart runs under load'],
    { goal: 'prove no message is lost on a restart', result: 'done', obstacle: 'none', instead: 'nothing', rule: 'raise the file limit before load tests' });
  say('pine', 3 * H + 20, 'relay', 'relay-dev', 'done', 'pine-1: the ingest queue holds 50k msg/s with backpressure; 0 lost in 3 restart runs (was 1.2% lost)');
  say('pine', 3 * H + 5, 'relay', 'relay-head', 'note', 'ACCEPT #pine-1: 0 lost over 3 restarts, the bench is attached');
  say('pine', 70, 'relay', 'relay-dev', 'blocked', 'pine-2: the staging key server rejects the new signing key (401 on every request since the rotation); the delivery test cannot run');
  report('pine', 65, 'relay', 'relay-dev', ['pine-2: retries with backoff written, not yet tested'],
    { goal: 'retry webhook delivery with backoff', result: 'no', obstacle: 'environment', obstacle_fact: 'the key server answers 401 to the new key',
      instead: 'test the key before starting the run', rule: 'check the signing key before a delivery test' });
  say('pine', 52, 'relay', 'relay-head', 'note', 'pine-2 is blocked on the staging key server; escalated to coord, pine-3 waits for it');
  const mail = [
    [3 * H + 18, 'pine → relay-head: ingest-bench.txt 18342 B sha256 3f9a1c0d2e7b'],
    [5 * H + 8, 'fir → atlas-head: login-flake-runs.log 52011 B sha256 9b0e44a1c7d2'],
    [2 * H + 50, 'fir → atlas-head: ranking-v2-p95.csv 4410 B sha256 51c2aa07e9f3'],
    [64, 'pine → relay-head: key-server-401.log 2317 B sha256 c1d2e3f4a5b6'],
  ];
  for (const [min, text] of mail) say('pine', min, 'mail', 'mail-relay', 'delivery', text);

  say('maple', 2 * D - 30, 'infra', 'coord', 'note', 'maple-1: the new 4 TB disk is mounted on maple at /backup2; the first copy runs tonight');
  say('maple', 40, 'infra', 'coord', 'note', 'fir: / at 93%, the build cache holds 61 GB; filed maple-3');

  for (const node of ['fir', 'pine', 'maple']) {
    const lines = journal.filter(j => j.node === node).sort((x, y) => y.min - x.min).map(j => JSON.stringify(j.entry));
    put(`journal.${node}.jsonl`, lines.join('\n') + '\n');
  }

  /* ── the cards ── */
  put('projects/atlas.md', [
    '# atlas', '', '- slug: atlas', `- set: ${at(2 * H)} by atlas-head`, '',
    '## Digest', '', 'Public web app: search, onboarding, accounts. Ranking v2 is on staging (p95 84 ms); the onboarding copy went back for a second pass.', '',
    '## Goal', '', 'Search that finds the right page on the first screen: ranking v2 on for all traffic by Friday.', '',
    '## Next step', '', `- atlas-dev: the relevance check on 200 saved queries, then fir-2 — set ${at(3 * H)} by atlas-head`, '',
    '## Facts & hypotheses', '', '- fact: p95 query 84 ms on staging with the v2 weights (was 140 ms)', '',
    '## Decisions', '', `- ${at(5 * D + H)}: settings split into three tabs — billing questions were a third of support`, '',
    '## Laws', '', `- ${at(2 * D + 6 * H)} (atlas-head): ${SCREENSHOT}`, '',
  ].join('\n'));
  put('projects/relay.md', [
    '# relay', '', '- slug: relay', `- set: ${at(50)} by relay-head`, '',
    '## Digest', '', 'Message relay service: ingest, webhooks, the public API. Backpressure is in; webhook retries wait on the staging key server.', '',
    '## Goal', '', 'Release 2.4.1 with webhook retries, and no message lost on a restart.', '',
    '## Next step', '', `- relay-dev: pine-2 once the key server takes the new key — set ${at(52)} by relay-head`, '',
    '## Facts & hypotheses', '', '- fact: 0 messages lost in 3 restart runs at 50k msg/s (was 1.2%)', '',
  ].join('\n'));
  put('projects/infra.md', [
    '# infra', '', '- slug: infra', `- set: ${at(39)} by coord`, '',
    '## Digest', '', 'The machines the team runs on: fir, pine and maple, and the backups. The backups move to the new disk on maple; / on fir is at 93%.', '',
    '## Owner decisions', '',
    `- ${at(19 * H)}: answered ${at(20 * H)} · from atlas-head · id fir-41 — renewed the cert; renew a week ahead from now on`, '',
  ].join('\n'));

  /* ── queues: what waits for coord and for the owner ── */
  const block = (min, from, id, body, task) => `\n## ${at(min)} · from ${from} · id ${id}${task ? ' · task #' + task : ''}\n${body}\n`;
  const certAsk = block(20 * H, 'atlas-head', 'fir-41',
    'The TLS cert for atlas.example.com expires tomorrow, and renewing it needs the DNS account only the owner holds.');
  put('queues/coord.fir.queue.md', certAsk);
  // coord read that one before maple went quiet; its reader publishes how far it got
  put('queues/read/coord.maple.json', { files: { 'coord.fir.queue.md': { mark: certAsk.split('\n')[1], off: Buffer.byteLength(certAsk), at: at(20 * H - 2) } } });
  put('queues/coord.pine.queue.md', block(50, 'relay-head', 'pine-17',
    'The staging key server rejects the new webhook signing key: 401 on every request since the rotation. Rotate it again, or let relay-dev test pine-2 with the old key?', 'pine-2'));
  put('queues/owner.fir.queue.md', block(30, 'atlas-head', 'fir-44',
    'Ranking v2 can go to 10% of traffic once fir-1 is in. Turn it on Tuesday, or wait for the Thursday release?'));

  /* ── the machines: each node's snapshot and presence, as the fleet tool and the heartbeats leave them ── */
  const session = (role, state, hub, motion) => ({ session: role, role, state, hub_age_min: hub, motion_min: motion });
  put('snapshot.fir.json', { v: 1, node: 'fir', ts: iso(1), load: 2.4,
    sessions: [session('atlas-head', 'WORKING', 0, 1), session('atlas-dev', 'WORKING', 0, 0), session('atlas-qa', 'IDLE', 4, 31)],
    disks: [{ mount: '/', used_pct: 93, free_gb: 17 }, { mount: '/data', used_pct: 41, free_gb: 220 }],
    relays: [{ pair: 'pine→fir', active: true, failed: false, last_ok: iso(1) }] });
  put('snapshot.pine.json', { v: 1, node: 'pine', ts: iso(2), load: 0.8,
    sessions: [session('relay-head', 'WORKING', 1, 2), session('relay-dev', 'IDLE', 3, 64)],
    disks: [{ mount: '/', used_pct: 58, free_gb: 160 }],
    relays: [{ pair: 'fir→pine', active: true, failed: false, last_ok: iso(2) }] });
  put('snapshot.maple.json', { v: 1, node: 'maple', ts: iso(38), load: 0.3,
    sessions: [session('coord', 'WORKING', 38, 38)],
    disks: [{ mount: '/', used_pct: 22, free_gb: 410 }, { mount: '/backup2', used_pct: 71, free_gb: 1160 }],
    relays: [{ pair: 'maple→pine', active: true, failed: true, last_ok: iso(41) }] });
  const agent = (node, a, o) => ({ agent: a, role: a, status: null, task_id: null, cwd: null, node, last_seen: at(1), ttlMin: 15, ...o });
  const presence = (node, min, agents) => put(`presence.${node}.json`, { node, written: at(min), v: version || null, agents });
  presence('fir', 1, [
    agent('fir', 'atlas-head', { state: 'waiting', empty_count: 0, state_since: at(5) }),
    agent('fir', 'atlas-dev', { status: 'ranking v2 relevance check', task_id: 'fir-1', state: 'turn', turn: 31, turn_started: at(12), state_since: at(12) }),
    agent('fir', 'atlas-qa', { last_seen: at(4), state: 'waiting', empty_count: 6, state_since: at(5 * H) }),
  ]);
  presence('pine', 2, [
    agent('pine', 'relay-head', { last_seen: at(2), state: 'turn', turn: 18, turn_started: at(9), state_since: at(9) }),
    agent('pine', 'relay-dev', { last_seen: at(3), status: 'blocked on the staging key server', task_id: 'pine-2', state: 'waiting', empty_count: 1, state_since: at(64) }),
  ]);
  presence('maple', 38, [agent('maple', 'coord', { last_seen: at(38), state: 'turn', turn: 207, turn_started: at(41), state_since: at(41) })]);

  /* ── the rules, and the mark that lets the next `hub demo` replace this folder ── */
  put('AGENTS.md', [
    '# Rules of the demo team', '',
    'This hub was made by `hub demo`. The team, the machines and the week are invented; nothing here is anyone\'s real work.', '',
    '1. Every write names its author: a role, never a model.',
    '2. A worker hands work in with its evidence: the numbers, the path, the screenshot.',
    '3. A head answers every hand-in in the journal, `ACCEPT #<id>` or `REJECT #<id>`, and says why.',
    '4. What a head cannot decide goes to coord; what coord cannot decide goes to the owner, who answers in the infra card\'s Owner decisions.',
    '5. Every turn ends with a reflection. A rule the team keeps proposing goes to the head, who makes it a law or rejects it.', '',
  ].join('\n'));
  put('INBOX.md', '# INBOX — notes between people\n\nNewest on top: prepend yours. Agents report to the hub, not here.\n');
  put(MARKER, `made by hub demo at ${at(0)}; running hub demo here again replaces this folder\n`);

  return { dir, files, projects: ['atlas', 'relay', 'infra'], tracks: ['atlas', 'relay'], roles: ROLES.length, nodes: ['fir', 'pine', 'maple'],
    tasks: TASKS.length, entries: journal.length };
}
