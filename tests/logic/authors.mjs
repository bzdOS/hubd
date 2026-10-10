// authors.mjs — who wrote it: presence, the author rule and its floor, environment checks, the HTTP transport, roles
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { REPO, ok, mktmp, run, freePort, T0, core, queueLib, done, reap } from './_h.mjs';

// ── presence: hub_heartbeat/hub_presence — TTL freshness like activeClaims ──

const presRoot1 = mktmp();
core.setHubBase(presRoot1); core.ensureHubDirs();
const hb1 = core.runHeartbeat({ agent: 'agent-a', role: 'hubd', status: 'working', task_id: 42, cwd: '/tmp/x' });
ok(hb1.ok === true && hb1.agent === 'agent-a', 'heartbeat: writes a presence record');
ok(fs.existsSync(core.presencePath('agent-a')), 'heartbeat: presence/<agent>.json exists');
const rec1 = core.readPresenceRecord('agent-a');
ok(rec1.role === 'hubd' && rec1.status === 'working' && rec1.task_id === 42 && rec1.cwd === '/tmp/x', `heartbeat: fields stored (got ${JSON.stringify(rec1)})`);
ok(typeof rec1.last_seen === 'string' && rec1.ttlMin === 15, 'heartbeat: last_seen stamped, default ttlMin=15');

core.runHeartbeat({ agent: 'agent-a', role: 'hubd', status: 'idle' });   // overwrite, not append
ok(core.loadPresence().filter(r => r.agent === 'agent-a').length === 1, 'heartbeat: second call overwrites, does not duplicate');
ok(core.readPresenceRecord('agent-a').status === 'idle', 'heartbeat: overwrite reflects the latest status');

fs.writeFileSync(core.presencePath('agent-stale'), JSON.stringify({ agent: 'agent-stale', role: 'hubd', last_seen: '2020-01-01 00:00', ttlMin: 15 }));
const presAll = core.runPresence({});
const fresh = presAll.agents.find(a => a.agent === 'agent-a');
const stale = presAll.agents.find(a => a.agent === 'agent-stale');
ok(fresh && fresh.alive === true, 'presence: recent heartbeat is alive');
ok(stale && stale.alive === false, 'presence: a 2020 last_seen with ttlMin=15 is stale');
ok(core.runPresence({ aliveOnly: true }).agents.every(a => a.alive), 'presence: aliveOnly drops stale records');
ok(core.runPresence({ role: 'hubd' }).agents.length === 2 && core.runPresence({ role: 'nope' }).agents.length === 0, 'presence: role filter');
let hbThrew = false;
try { core.runHeartbeat({}); } catch { hbThrew = true; }
ok(hbThrew, 'heartbeat: throws without agent');
fs.rmSync(presRoot1, { recursive: true, force: true });

// ensureProtocol: presence/ ignored EVEN when HUBD.md is already current (not just on write) —
// in .git/info/exclude, which never travels; the tracked .gitignore is hub init's alone
const presRoot2 = mktmp();
execSync('git init -q', { cwd: presRoot2, stdio: 'pipe' });
fs.writeFileSync(path.join(presRoot2, '.gitignore'), 'node_modules/\n');
core.setHubBase(presRoot2); core.ensureHubDirs();
const presEx = path.join(presRoot2, '.git', 'info', 'exclude');
core.ensureProtocol();
ok(/^presence\/$/m.test(fs.readFileSync(presEx, 'utf8')), 'ensureProtocol: presence/ ignored on first run');
ok(fs.readFileSync(path.join(presRoot2, '.gitignore'), 'utf8') === 'node_modules/\n', 'ensureProtocol: the tracked .gitignore is left byte for byte as it was');
fs.writeFileSync(presEx, '');                               // simulate an exclude file from before the entry existed
const eAgain = core.ensureProtocol();                       // same version -> would NOT rewrite HUBD.md
ok(eAgain.wrote === false, 'ensureProtocol: still idempotent on HUBD.md (no unnecessary rewrite)');
ok(/^presence\/$/m.test(fs.readFileSync(presEx, 'utf8')), 'ensureProtocol: re-adds presence/ even when HUBD.md was already current — mesh-sync\'s git-add-A would otherwise churn on every heartbeat');
/* The whatsnew checkpoints are per-node too, and runWhatsNew's comment had claimed for releases
 * that this file was gitignored while a real hub had it TRACKED — every node's checkpoint
 * travelling to every other and overwriting it, in plain JSON with no merge rule. */
ok(/^\.checkins\.json$/m.test(fs.readFileSync(presEx, 'utf8')),
  'ensureProtocol: .checkins.json is ignored — a per-agent checkpoint is this node\'s, not the mesh\'s');
/* The entry carries a trailing slash on purpose: gitignore matches the DIRECTORY only, so the
 * per-node snapshot beside it travels. Get this wrong and the fix below silently does nothing. */
ok(!/^presence(\.\*)?$/m.test(fs.readFileSync(presEx, 'utf8')),
  'ensureProtocol: ignores the presence DIRECTORY, not the presence.<node>.json beside it');
fs.rmSync(presRoot2, { recursive: true, force: true });

/* ── PS: the fleet as far as it can honestly be seen from here ──
 * One role read as 383 minutes since heartbeat on one node and 5.9 days on another. Nothing was
 * stale and nothing had diverged: `presence/` is node-local, the roles ran on one machine and the
 * orchestrators on another, so the orchestrator was reading a different machine's registry as the
 * fleet's. It escalated "worker is dead" four times across 92 hours while the worker worked. */
const psRoot = mktmp();
core.setHubBase(psRoot); core.ensureHubDirs();
core.runHeartbeat({ agent: 'local-worker', role: 'hubd', ttlMin: 15 });
const psSnap = core.presenceSnapshotPath();
ok(fs.existsSync(psSnap) && path.basename(psSnap) === 'presence.' + core.JOURNAL_NODE + '.json',
  `runHeartbeat: publishes this node's registry as one file named after the node (got ${path.basename(psSnap)})`);
// Read through a helper: a regression that stops writing the file should FAIL these, not throw and
// take every assertion after it down with it.
const psRead = () => { try { return JSON.parse(fs.readFileSync(psSnap, 'utf8')) || {}; } catch { return {}; } };
const psMtimeOf = () => { try { return fs.statSync(psSnap).mtimeMs; } catch { return null; } };
ok((psRead().agents || []).some(r => r.agent === 'local-worker'),
  'writePresenceSnapshot: the snapshot carries the records, not just a timestamp');

// Throttled by the file's own mtime: no counter to lose across a restart, and one small write per
// node per interval whatever the heartbeat rate.
const psMtime = psMtimeOf();
core.runHeartbeat({ agent: 'local-worker', role: 'hubd', ttlMin: 15 });
ok(psMtime !== null && psMtimeOf() === psMtime, 'writePresenceSnapshot: a second heartbeat inside the window does not rewrite it');
ok(core.writePresenceSnapshot({ force: true }) === psSnap && (psMtimeOf() ?? -1) >= psMtime,
  'writePresenceSnapshot: force overrides the throttle');
ok(core.PRESENCE_SNAPSHOT_MS / 60000 < 15,
  `the throttle must be SHORTER than the default 15min ttlMin, or a live agent reads as expired from another node (got ${core.PRESENCE_SNAPSHOT_MS / 60000}min)`);

// A neighbour's snapshot is merged in, and every row says which node observed it.
const psFresh = new Date(Date.now() - 60000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(psRoot, 'presence.faraway.json'), JSON.stringify({
  node: 'faraway', written: psFresh,
  agents: [{ agent: 'remote-worker', role: 'hv', node: 'faraway', last_seen: psFresh, ttlMin: 15 }],
}));
const ps1 = core.runPresence({});
const psRemote = ps1.agents.find(r => r.agent === 'remote-worker');
ok(psRemote && psRemote.observedOn === 'faraway' && psRemote.alive === true,
  `runPresence: a neighbour's published record is visible and alive, with the node that saw it (got ${JSON.stringify(psRemote && { o: psRemote.observedOn, a: psRemote.alive })})`);
ok(ps1.agents.find(r => r.agent === 'local-worker').live === true,
  'runPresence: this node\'s own rows are marked live — read from the directory, not from a snapshot of it');

/* The part that was missing entirely: a role nobody reports is indistinguishable from a dead one,
 * so absence has to be attributable to a node that is not reporting. */
const psCov = Object.fromEntries(ps1.coverage.map(c => [c.node, c]));
ok(psCov[core.JOURNAL_NODE] && psCov[core.JOURNAL_NODE].self === true && psCov[core.JOURNAL_NODE].snapshot === 'live',
  'runPresence: coverage names this node as the live one');
ok(psCov.faraway && psCov.faraway.snapshot === psFresh && psCov.faraway.stale === false,
  `runPresence: coverage ages each neighbour's snapshot (got ${JSON.stringify(psCov.faraway)})`);
ok(!ps1.blindTo, 'runPresence: nothing is blind when every member is reporting');
// Membership includes anyone whose snapshot we are reading, whatever their journal says here:
// otherwise a row names an observedOn that coverage never mentions — the same unattributable
// absence one level along. `faraway` has published a registry and no journal.
ok(!fs.existsSync(path.join(psRoot, 'journal.faraway.jsonl')) && !!psCov.faraway,
  'runPresence: a node whose registry we read is a member even with no journal here');

// A member that publishes nothing is the blind spot, and it is named.
fs.writeFileSync(path.join(psRoot, 'journal.silentnode.jsonl'),
  JSON.stringify({ ts: new Date().toISOString().slice(0, 16).replace('T', ' '), project: 'p', agent: 'a', kind: 'note', text: 'x', v: core.VERSION }) + '\n');
const ps2 = core.runPresence({});
ok((ps2.blindTo || []).includes('silentnode') && /NOT the same as dead/.test(ps2.note || ''),
  `runPresence: a member with no registry is named as a blind spot, in those words (got ${JSON.stringify(ps2.blindTo)})`);

/* TWO different gaps, reported as one in the first cut of this and caught only by running it
 * against the real mesh: a node that published NOTHING is invisible; a node whose registry is here
 * and old is not. An idle node refreshes on heartbeat, so an old snapshot is exactly what a quiet
 * machine looks like — flagging that as a blind spot puts the warning back to meaning two things. */
fs.writeFileSync(path.join(psRoot, 'presence.sleepy.json'), JSON.stringify({
  node: 'sleepy', written: new Date(Date.now() - 60 * 60000).toISOString().slice(0, 16).replace('T', ' '),
  agents: [{ agent: 'dozing', role: 'hv', node: 'sleepy', last_seen: psFresh, ttlMin: 15 }],
}));
const ps3 = core.runPresence({});
ok(!(ps3.blindTo || []).includes('sleepy') && (ps3.laggingBehind || []).some(l => l.node === 'sleepy'),
  `runPresence: an old registry is lagging, not blindness (blind=${JSON.stringify(ps3.blindTo)} lag=${JSON.stringify((ps3.laggingBehind||[]).map(l=>l.node))})`);
ok(/only heartbeats made SINCE are missing/.test(ps3.lagNote || ''),
  'runPresence: and says what an old registry actually costs the reader');
ok(ps3.agents.find(r => r.agent === 'dozing')?.alive === true,
  'runPresence: a row from a lagging node is still judged by its OWN last_seen and ttl, not by the snapshot age');

/* Membership is not "ever wrote a journal": that set never shrinks, and a warning about retired
 * machines is one a reader learns to skip. */
fs.writeFileSync(path.join(psRoot, 'journal.retired.jsonl'),
  JSON.stringify({ ts: '2024-01-01 10:00', project: 'p', agent: 'a', kind: 'note', text: 'ancient' }) + '\n');
ok(!core.runPresence({}).coverage.some(c => c.node === 'retired'),
  'runPresence: a node that has not written in memberDays is not a blind spot, it is retired');
ok(core.runPresence({ memberDays: 20000 }).coverage.some(c => c.node === 'retired'),
  'runPresence: ...and memberDays is the knob, not a hardcoded verdict');

// An unstamped writer is still a member: lastAt can only see stamped entries, and a node running
// a pre-0.9.4 hubd would otherwise read as one that never wrote at all.
ok(core.writerVersions().find(g => g.node === 'retired').lastWrite === '2024-01-01 10:00',
  'writerVersions: lastWrite sees entries with no version stamp, unlike lastAt');

const psDoc = run('doctor', { HUBD_DIR: psRoot, HUBD_TEAM_DIR: psRoot });
ok(/fleet: .*silentnode SILENT/.test(psDoc.out) && /invisible here, which is NOT the same as dead/.test(psDoc.out),
  'doctor: reports the fleet blind spot next to the writers block, and says what it does not mean');
fs.rmSync(psRoot, { recursive: true, force: true });

// ── a write must say who did it ────────────────────────────────────────────────
// The journal is append-only, so an unattributed write stays unattributable. The
// field was optional on exactly the tools that produced 173 'unknown' entries out of
// 1193, while the tools that already require it have 6 clean names out of 6.
const AU = mktmp();
core.setHubBase(AU); core.ensureHubDirs();
const throwsA = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const noAuthor = throwsA(() => core.runTaskAdd({ project: 'p', text: 'x' }));
ok(/by required/.test(noAuthor || ''), `author: an omitted author is refused, not defaulted (got ${noAuthor})`);
ok(!/unknown/.test(noAuthor || ''), 'author: the error does not offer "unknown" as a way out');
ok(/Set HUBD_AGENT/.test(noAuthor || '') && !/Over HTTP/.test(noAuthor || ''), 'author: on the CLI and over stdio the remedy is HUBD_AGENT');
// The refusal of a model name names a function, as its own rule says; it used to suggest
// "claude-<project>", a model name with a suffix.
{
  const m = throwsA(() => core.runSync({ path: AU, agent: 'claude' })) || '';
  ok(/"dev-<project>"/.test(m) && !/claude-</.test(m), `author: the refusal of "claude" suggests a function, not the model again (got ${m.slice(0, 200)})`);
}

// A bare model or client family says nothing about WHO acted — many sessions share it.
for (const bad of ['claude', 'Claude', 'opencode', 'gpt', 'cursor', 'unknown', 'cli', 'root']) {
  const m = throwsA(() => core.runTaskAdd({ project: 'p', text: 'x', by: bad }));
  ok(/names a model, a client or a placeholder/.test(m || ''), `author: "${bad}" is refused`);
}
// A function name is fine — one session is behind it.
for (const good of ['claude-hubd', 'orchestrator', 'dev-bsdos', 'sonnet-sec']) {
  const t = core.runTaskAdd({ project: 'p', text: 'x', by: good });
  ok(t.ok && t.task.by === good, `author: "${good}" is accepted`);
}
// Every write path, not just task add.
ok(/agent required/.test(throwsA(() => core.runSync({ path: AU })) || ''), 'author: sync requires it');
ok(/by required/.test(throwsA(() => core.runCardSet({ project: 'p', digest: 'd' })) || ''), 'author: card-set requires it');
ok(/by required/.test(throwsA(() => core.runReport({ project: 'p', text: 'note x' })) || ''), 'author: report requires it');
ok(/agent required/.test(throwsA(() => core.runWhatsNew({})) || ''), 'author: whatsnew requires it');
// The queue was the one durable write channel that skipped the rule: `from` defaulted
// to 'unknown' (CLI) / 'mcp' (server) — the very placeholders refused everywhere else.
ok(/from required/.test(throwsA(() => queueLib.queueSend('r', 'x', { root: AU })) || ''), 'author: queue send requires a sender');
ok(/names a model, a client or a placeholder/.test(throwsA(() => queueLib.queueSend('r', 'x', { from: 'mcp', root: AU })) || ''),
  'author: "mcp" (the old server default) is refused as a sender');

// Releasing a lock is selected BY agent, not attributed to one — it must stay optional
// or the "release by id" form becomes uncallable.
core.runClaim({ project: 'p', area: 'a', agent: 'dev-hubd' });
ok(core.runRelease({ project: 'p', area: 'a', agent: 'dev-hubd' }).removed === 1,
  'author: release is unaffected — its agent is a selector, not an author');
fs.rmSync(AU, { recursive: true, force: true });

// ── the floor must not make two sessions one author ───────────────────────────
// HUBD_AGENT lives in a server's config, so it is per MACHINE. Used verbatim it would
// give every session on a host one name — the same "one label, many sessions" flaw the
// refusal list exists to prevent, and worse than cosmetic: runClaim reads an equal name
// as the same holder and reports NO conflict, so the soft lock would stop locking.
// Driven over the real transport, because the floor only exists there.
const floorCall = (sess, args, tool = 'hub_task_add') => {
  const reqs = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
  ].join('\n') + '\n';
  const env = { ...process.env, HUBD_DIR: FL, HUBD_TEAM_DIR: FL, HUBD_AGENT: 'dev-hubd', HUBD_SESSION: sess };
  let out = '';
  try { out = execSync(`node ${REPO}/hub/index.mjs`, { input: reqs, encoding: 'utf8', env, timeout: 15000 }); }
  catch (e) { out = (e.stdout || ''); }
  for (const l of out.split('\n')) {
    try { const m = JSON.parse(l); if (m.id === 2) return JSON.parse(m.result.content[0].text); } catch {}
  }
  return null;
};
const FL = mktmp();
const flA = floorCall('one', { project: 'p', text: 'from session one' });
const flB = floorCall('two', { project: 'p', text: 'from session two' });
ok(flA && /^dev-hubd-/.test(flA.by), `floor: an omitted author becomes HUBD_AGENT, not an error (got ${flA && flA.by})`);
ok(flA && flB && flA.by !== flB.by,
  `floor: two sessions under one HUBD_AGENT are DIFFERENT authors (${flA && flA.by} vs ${flB && flB.by})`);
ok(floorCall('one', { project: 'p', text: 'again' }).by === flA.by,
  'floor: the same session keeps one author across calls');
// The consequence that matters: the soft lock still detects a second holder.
ok(floorCall('one', { project: 'p', area: 'shared' }, 'hub_claim').warning === undefined,
  'floor: first claim on an area is clean');
ok(/already claimed by/.test(floorCall('two', { project: 'p', area: 'shared' }, 'hub_claim').warning || ''),
  'floor: a second session claiming the same area IS warned — the lock still locks');
// An explicit author is never rewritten by the floor.
ok(floorCall('one', { project: 'p', text: 'mine', by: 'reviewer-hubd' }).by === 'reviewer-hubd',
  'floor: an explicit author wins over the floor untouched');
// The floor reaches the queue too: hub_queue_send's `from` is an author like any other.
const flQ = floorCall('one', { role: 'flr', text: 'queued by the floor' }, 'hub_queue_send');
const flQText = flQ && flQ.file ? fs.readFileSync(flQ.file, 'utf8') : '';
ok(/· from dev-hubd-/.test(flQText),
  `floor: an omitted queue sender becomes the floor, not "mcp" (got ${(flQText.match(/from [^\n]+/) || ['nothing'])[0]})`);

// A floor is held to the same rule as an argument: with a per-session suffix appended,
// HUBD_AGENT=claude would arrive as "claude-<session>" and sail through the check while
// still naming a model. A misconfigured floor is no floor.
const badFloor = (() => {
  const reqs = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hub_task_add', arguments: { project: 'p', text: 'x' } } }),
  ].join('\n') + '\n';
  const env = { ...process.env, HUBD_DIR: FL, HUBD_TEAM_DIR: FL, HUBD_AGENT: 'claude', HUBD_SESSION: 'three' };
  try { return execSync(`node ${REPO}/hub/index.mjs`, { input: reqs, encoding: 'utf8', env, timeout: 15000 }); }
  catch (e) { return (e.stdout || ''); }
})();
ok(/by required/.test(badFloor),
  'floor: a refused name as HUBD_AGENT is not laundered by the session suffix');

// ── a tool's required arguments are checked before the engine runs ──
// hub_task_add with `title` instead of `text` filed "+ task #oak-6: undefined": nothing read the
// schema's `required`. The floor still fills the author, so only the real gap is named.
{
  const rawCall = (tool, args) => {
    const reqs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
    ].join('\n') + '\n';
    const env = { ...process.env, HUBD_DIR: FL, HUBD_TEAM_DIR: FL, HUBD_AGENT: 'dev-hubd', HUBD_SESSION: 'req' };
    let out = '';
    try { out = execSync(`node ${REPO}/hub/index.mjs`, { input: reqs, encoding: 'utf8', env, timeout: 15000 }); }
    catch (e) { out = (e.stdout || ''); }
    for (const l of out.split('\n')) { try { const m = JSON.parse(l); if (m.id === 2) return m.result; } catch {} }
    return null;
  };
  const tasksIn = () => { try { return fs.readFileSync(path.join(FL, 'tasks.json'), 'utf8'); } catch { return ''; } };
  const before = tasksIn();
  const misspelt = rawCall('hub_task_add', { project: 'p', title: 'the field is text' });
  ok(misspelt.isError && /^Error: text required: what the task is/.test(misspelt.content[0].text) && /got title, which hub_task_add does not take/.test(misspelt.content[0].text),
    `required: hub_task_add with title instead of text is refused and names the stray field (got ${misspelt.content[0].text})`);
  const blank = rawCall('hub_task_add', { project: 'p', text: '   ' });
  ok(blank.isError && /text required/.test(blank.content[0].text), 'required: a blank text is as missing as an absent one');
  ok(tasksIn() === before && !/undefined/.test(tasksIn()), 'required: and no task was filed');
  const two = rawCall('hub_section_add', { by: 'dev-hubd' });
  ok(two.isError && /^Error: missing required: project, section, text$/.test(two.content[0].text), `required: several gaps are listed together (got ${two.content[0].text})`);
  const rep = rawCall('hub_report', { text: 'FACT: lands nowhere' });
  ok(rep.isError && /^Error: project required: the project slug/.test(rep.content[0].text), `required: hub_report without a project is refused, not filed under "general" (got ${rep.content[0].text})`);
  const fine = rawCall('hub_task_add', { project: 'p', text: 'a real task' });
  ok(fine.isError === false && /"textPreview": "a real task"/.test(fine.content[0].text), 'required: a complete call is untouched, its author still from the floor');
}
fs.rmSync(FL, { recursive: true, force: true });

// ── environment checks: an upgrade can need something OUTSIDE the code ─────────
// Nothing used to say so, so an agent found out by having a call rejected, or never.
const EV = mktmp();
core.setHubBase(EV); core.ensureHubDirs();
const prevFloorEnv = process.env.HUBD_AGENT;

// Sections, not "the file changed": an upgrade names what moved so the agent can
// decide whether it cares. Bodies are trimmed, or a reflowed blank line would count.
const secA = core.sectionHashes('## One\n\nbody one\n\n### Two\n\nbody two\n');
const secB = core.sectionHashes('## One\n\nbody one\n\n\n### Two\n\nbody two CHANGED\n');
ok(Object.keys(secA).join(',') === 'One,Two', `sectionHashes: headings become keys (got ${Object.keys(secA)})`);
ok(secA.One === secB.One, 'sectionHashes: an extra blank line is not a change');
ok(secA.Two !== secB.Two, 'sectionHashes: a changed body is a change');
ok(!('(preamble)' in core.sectionHashes('stamp line\n\n## One\n\nbody\n')),
  'sectionHashes: text before the first heading is excluded — a version stamp is not a change');

// A first-ever run announces nothing: with no baseline there is no change, and
// "everything is new" on a fresh hub is noise.
ok(core.protocolChanges() === null, 'protocolChanges: no baseline → nothing to announce');
const esf = path.join(EV, '.env-state.json');
const seedBaseline = (mutateTitle, version) => {
  const real = core.sectionHashes(fs.readFileSync(path.join(REPO, 'prompts/protocol.md'), 'utf8'));
  real[mutateTitle] = 'stale00000';
  fs.writeFileSync(esf, JSON.stringify({ protocol: { version, sections: real, changed: [], changedFrom: null } }, null, 1));
};
const firstTitle = Object.keys(core.sectionHashes(fs.readFileSync(path.join(REPO, 'prompts/protocol.md'), 'utf8')))[0];
seedBaseline(firstTitle, '0.0.1');
const pc1 = core.protocolChanges();
ok(pc1 && pc1.titles.length === 1 && pc1.titles[0] === firstTitle,
  `protocolChanges: names the section that moved (got ${pc1 && JSON.stringify(pc1.titles)})`);
ok(pc1.from === '0.0.1', `protocolChanges: reports the version it moved from (got ${pc1.from})`);
// Recomputed from stored state, not from the file on disk — so a later session still
// hears it even though ensureProtocol already rewrote HUBD.md.
ok(JSON.stringify(core.protocolChanges()) === JSON.stringify(pc1), 'protocolChanges: stable once stored, not recomputed away');
// Nobody acknowledged it, so a second upgrade carries the earlier titles forward.
const st1 = JSON.parse(fs.readFileSync(esf, 'utf8'));
st1.protocol.version = '0.0.2';
st1.protocol.sections[Object.keys(st1.protocol.sections)[1]] = 'stale11111';
fs.writeFileSync(esf, JSON.stringify(st1, null, 1));
const pc2 = core.protocolChanges();
ok(pc2.titles.length === 2 && pc2.titles.includes(firstTitle),
  `protocolChanges: an unacknowledged announcement is carried forward, not replaced (got ${JSON.stringify(pc2.titles)})`);
ok(pc2.from === '0.0.1', `protocolChanges: "from" stays at the oldest unheard version (got ${pc2.from})`);

// Told once per session — and the OTHER session on this host still hears it.
const has = (r, id) => r.items.some(i => i.id === id);
ok(has(core.envChecks({ session: 's1' }), 'protocol-changed'), 'envChecks: a session is told about the protocol change');
core.ackEnvNotices('s1');
ok(!has(core.envChecks({ session: 's1' }), 'protocol-changed'), 'envChecks: and not told twice');
ok(has(core.envChecks({ session: 's2' }), 'protocol-changed'), 'envChecks: a second session on the same host is still told');

// Over HTTP one server answers every caller, so the line every result carries asks as nobody,
// and it said this on every call for a whole release. hub_whatsnew knows its caller: each agent
// is told once there.
ok(!has(core.envChecks({ transport: 'http' }), 'protocol-changed'), 'envChecks: over HTTP the line on every result leaves it out');
const httpWn = (agent) => (core.runWhatsNew({ agent, transport: 'http' }).environment || []).some(i => i.id === 'protocol-changed');
ok(httpWn('dev-alpha'), 'whatsnew over HTTP: an agent is told about the protocol change');
ok(!httpWn('dev-alpha'), 'whatsnew over HTTP: and not told twice');
ok(httpWn('dev-beta'), 'whatsnew over HTTP: another agent on the same server is still told');

// One long-lived stdio server as one session: ask(method, params) and the footer of a plain call.
function mcpSession(env) {
  const child = reap(spawn('node', [path.join(REPO, 'hub/index.mjs')], {
    env: { ...process.env, HUBD_DIR: EV, HUBD_TEAM_DIR: EV, HUBD_AGENT: 'dev-hubd', ...env },
    stdio: ['pipe', 'pipe', 'ignore'] }));
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch {}
    }
  });
  let nextId = 1;
  const ask = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => rej(new Error('no answer to ' + method)), 15000);
    waiting.set(id, m => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const footer = async () => (await ask('tools/call', { name: 'hub_presence', arguments: {} }))
    .result.content.slice(1).map(c => c.text).join('\n');
  return { ask, footer, kill: () => child.kill() };
}
// The same, through the line every MCP result carries. It asked as nobody, so a session told by
// hub_whatsnew was told again on every result until the next release. One long-lived server, call
// by call, because the line is also cached for minutes.
{
  const { ask, footer, kill } = mcpSession({ HUBD_SESSION: 'footer' });
  await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const before = await footer();
  ok(/protocol-changed/.test(before), `footer: a session not yet told sees the protocol change (got ${before})`);
  await ask('tools/call', { name: 'hub_whatsnew', arguments: { agent: 'dev-hubd' } });
  const after = await footer();
  ok(!/protocol-changed/.test(after), `footer: once hub_whatsnew told it, the session is not told again (got ${after})`);
  kill();
}
// A session whose tools leave hub_whatsnew out has nothing to acknowledge with, and was told on
// every result until the next release. The line itself is the telling there: once.
{
  const { ask, footer, kill } = mcpSession({ HUBD_SESSION: 'footer-bare', HUBD_TOOLS: 'hub_presence' });
  await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const first = await footer();
  ok(/protocol-changed/.test(first) && /hub doctor/.test(first), `footer without hub_whatsnew: told, and pointed at hub doctor (got ${first})`);
  const second = await footer();
  ok(!/protocol-changed/.test(second), `footer without hub_whatsnew: told once, not on every result (got ${second})`);
  kill();
}

// The floor check reads the environment it actually runs in.
delete process.env.HUBD_AGENT;
ok(has(core.envChecks(), 'author-floor'), 'envChecks: an unset HUBD_AGENT is reported');
process.env.HUBD_AGENT = 'claude';
ok(has(core.envChecks(), 'author-floor-refused'), 'envChecks: a refused HUBD_AGENT is reported as such');
process.env.HUBD_AGENT = 'dev-test';
ok(!has(core.envChecks(), 'author-floor') && !has(core.envChecks(), 'author-floor-refused'),
  'envChecks: a usable floor reports nothing — a condition gates itself');
// Actor is the axis that keeps this from nagging about what the agent cannot touch.
delete process.env.HUBD_AGENT;
ok(core.envChecks().items.find(i => i.id === 'author-floor').actor === 'agent+restart',
  'envChecks: every item says who can fix it');
ok(core.envChecks().items.every(i => i.what && i.remedy), 'envChecks: every item carries a remedy, not just a complaint');
ok(core.envChecks().items.length <= 3, 'envChecks: capped — a list nobody finishes is a list nobody reads');
// Over HTTP the server's env is nobody's environment: one process serves many agents
// (or tenants), so an unset HUBD_AGENT there is not a finding — and the remedy ("edit
// the client config") would point at the wrong machine.
ok(!has(core.envChecks({ transport: 'http' }), 'author-floor'),
  'envChecks: the floor is not a finding over HTTP — the server env is not the caller\'s');

// The queue conflict: stderr is invisible to an MCP client, so the warning used to be
// unread. It is recorded, surfaces as a check, and clears itself once the role is
// declared. Driven for real — a live competing waiter is this process's parent.
const QC = mktmp();
fs.mkdirSync(path.join(QC, 'queues'), { recursive: true });
fs.mkdirSync(path.join(QC, '.qstate'), { recursive: true });
fs.writeFileSync(path.join(QC, '.qstate', 'busy.waiter'),
  JSON.stringify({ pid: process.ppid, since: new Date().toISOString() }));
await queueLib.queueWait('busy', { timeout: 0, root: QC, subscriber: 'sess-a' });
ok(has(core.envChecks(), 'queue-fanout-undeclared'),
  'envChecks: two waiters on one cursor become an actionable item, not a stderr line nobody sees');
// A work queue back to a single waiter clears it too: the competitor is gone, so is the finding.
fs.rmSync(path.join(QC, '.qstate', 'busy.waiter'), { force: true });
await queueLib.queueWait('busy', { timeout: 0, root: QC, subscriber: 'sess-a' });
ok(!has(core.envChecks(), 'queue-fanout-undeclared'),
  'envChecks: one waiter again clears the conflict — a notice must not outlive its cause');
fs.writeFileSync(path.join(QC, '.qstate', 'busy.waiter'),
  JSON.stringify({ pid: process.ppid, since: new Date().toISOString() }));
await queueLib.queueWait('busy', { timeout: 0, root: QC, subscriber: 'sess-a' });
fs.writeFileSync(path.join(QC, 'subscriber-roles.json'), JSON.stringify(['busy']));
await queueLib.queueWait('busy', { timeout: 0, root: QC, subscriber: 'sess-a' });
ok(!has(core.envChecks(), 'queue-fanout-undeclared'),
  'envChecks: declaring the role clears it — no acknowledgement needed, the condition is gone');
fs.rmSync(QC, { recursive: true, force: true });

// gc sweeps session records by the same rule as cursor dirs.
const stG = JSON.parse(fs.readFileSync(esf, 'utf8'));
stG.sessions = { fresh: { protocolAcked: '9.9.9', at: new Date().toISOString() },
                 old: { protocolAcked: '9.9.9', at: new Date(Date.now() - 30 * 86400000).toISOString() } };
fs.writeFileSync(esf, JSON.stringify(stG, null, 1));
run('gc --apply --by dev-t', { HUBD_DIR: EV, HUBD_TEAM_DIR: EV });
const stAfter = JSON.parse(fs.readFileSync(esf, 'utf8'));
ok(!stAfter.sessions.old && !!stAfter.sessions.fresh,
  `gc: sweeps a stale session record and keeps a fresh one (left ${Object.keys(stAfter.sessions)})`);

// ── over HTTP the floor and the session id describe the SERVER, not the caller ──
// One process serves many agents (or tenants): HUBD_AGENT is the server owner's env,
// and the process-derived session id is the server's own — one author and one whatsnew
// checkpoint for the whole team. Driven over the real HTTP transport.
const HT = mktmp();
const httpPort = await freePort();
const srv = reap(spawn('node', [path.join(REPO, 'hub/index.mjs'), '--http', String(httpPort)], {
  env: { ...process.env, HUBD_DIR: HT, HUBD_TEAM_DIR: HT, HUBD_TOKEN: 'secret-token-0123456789', HUBD_AGENT: 'dev-hubd' },
  stdio: ['ignore', 'ignore', 'pipe'],
}));
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('http server did not start')), 8000);
  srv.stderr.on('data', (d) => { if (String(d).includes('serving MCP over HTTP')) { clearTimeout(to); resolve(); } });
});
const httpCall = async (name, args) => {
  const resp = await fetch(`http://127.0.0.1:${httpPort}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token-0123456789' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await resp.json()).result;
};
const htAdd = await httpCall('hub_task_add', { project: 'p', text: 'no author given' });
ok(htAdd.isError === true && /by required/.test(htAdd.content[0].text),
  `http: no author floor — an omitted author is an error, not the server owner's name (got ${htAdd.content[0].text.slice(0, 60)})`);
// The remedy is per transport: HUBD_AGENT is the server owner's variable, a caller cannot set it.
ok(/Over HTTP every call names its own author/.test(htAdd.content[0].text) && !/Set HUBD_AGENT/.test(htAdd.content[0].text),
  `http: the missing-author error does not send a remote caller to HUBD_AGENT (got ${htAdd.content[0].text})`);
const htNoText = await httpCall('hub_task_add', { project: 'p', title: 'misspelt', by: 'remote-dev' });
ok(htNoText.isError === true && /text required/.test(htNoText.content[0].text), 'http: a task with no text is refused over HTTP too');
// A remote sender gets the queue's depth, not a path on the server's disk or a verdict about "this node".
await httpCall('hub_queue_send', { role: 'rq', text: 'first', from: 'remote-dev' });
const htQ = await httpCall('hub_queue_send', { role: 'rq', text: 'second', from: 'remote-dev' });
const htQr = htQ.isError ? {} : JSON.parse(htQ.content[0].text);
ok(htQ.isError === false && htQr.pending === 2 && !('file' in htQr) && !('consumedHere' in htQr) && !htQ.content[0].text.includes(HT),
  `http: hub_queue_send returns no server path and no consumedHere (got ${JSON.stringify(htQr).slice(0, 200)})`);
ok(/the server/.test(htQr.note || '') && !/this node/i.test(htQr.note || ''), `http: its note speaks of the server's node, not "this node" (got ${htQr.note})`);
const htNew = await httpCall('hub_whatsnew', { agent: 'remote-dev' });
ok(htNew.isError === false && !/author-floor/.test(htNew.content[0].text),
  'http: whatsnew does not report the server\'s own HUBD_AGENT state to a remote caller');
const htNewB = await httpCall('hub_whatsnew', { agent: 'remote-reviewer' });
ok(/"firstCheckin": true/.test(htNewB.content[0].text),
  'http: whatsnew checkpoints are per caller, not one per server process');
// A role is a path component. "../../x" used to write x.<node>.queue.md two directories above the
// hub — over HTTP, anywhere the server user can write, from any tenant.
const htEsc = await httpCall('hub_queue_send', { role: '../../escaped-role', text: 'hi', from: 'remote-dev' });
ok(htEsc.isError === true && /invalid role/.test(htEsc.content[0].text), `http: a role with a path in it is refused (got ${htEsc.content[0].text.slice(0, 60)})`);
// queues/../../ is the directory holding the hub, which is where the old code put the file.
ok(!fs.readdirSync(path.dirname(HT)).some(f => f.startsWith('escaped-role')), 'http: and nothing was written outside the hub');
// The cwd a remote caller passes is a path on ITS machine. Resolving it here walked the server's
// disk: a .hubd marker anywhere on it named the project, and claimsTouched listed fresh files.
const HTM = mktmp();
fs.writeFileSync(path.join(HTM, '.hubd'), 'server-side-secret-slug\n');
const htCtx = await httpCall('hub_context', { cwd: HTM });
ok(htCtx.isError === false && !/server-side-secret-slug/.test(htCtx.content[0].text) && /"via": "none"/.test(htCtx.content[0].text),
  'http: hub_context does not read a marker file on the server\'s disk');
const htCtxForced = await httpCall('hub_context', { cwd: HTM, local: true });
ok(!/server-side-secret-slug/.test(htCtxForced.content[0].text), 'http: a caller cannot pass local:true to get the walk back');
// With a card of that name the project resolves from hub data alone — and claimsTouched, which
// needs the checkout's disk, says it did not look instead of answering "nobody".
fs.writeFileSync(path.join(HT, 'projects', core.slugify(path.basename(HTM)) + '.md'), '# x\n\n## Digest\n\nd\n');
const htCtx2 = await httpCall('hub_context', { cwd: HTM });
ok(/"via": "guess"/.test(htCtx2.content[0].text) && /not checked: this server cannot see your checkout/.test(htCtx2.content[0].text),
  'http: a resolved project reports claimsTouched as not checked on a remote server');
const htCc = await httpCall('hub_claim_check', { path: path.join(HTM, 'x.txt') });
ok(htCc.isError === true && /project required on a remote server/.test(htCc.content[0].text), 'http: claim check without a project is refused instead of resolving a server path');
fs.rmSync(HTM, { recursive: true, force: true });
srv.kill();
fs.rmSync(HT, { recursive: true, force: true });

// ── the multi-tenant board shows a tenant its own rules, never the operator's ──
{
  const SB = mktmp();
  fs.writeFileSync(path.join(SB, 'AGENTS.md'), '# operator rules — not for tenants\n');
  const tid = 'a'.repeat(40);
  fs.mkdirSync(path.join(SB, 'tenants', tid, 'projects'), { recursive: true });
  const boardPort = await freePort();
  const board = reap(spawn('node', [path.join(REPO, 'hub/cli.mjs'), 'serve', '-p', String(boardPort)], {
    env: { ...process.env, HUBD_DIR: SB, HUBD_TEAM_DIR: SB, HUBD_MULTITENANT: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('board did not start')), 8000);
    board.stdout.on('data', (d) => { if (String(d).includes('hubd kanban')) { clearTimeout(to); resolve(); } });
  });
  const rules = await (await fetch(`http://127.0.0.1:${boardPort}/api/rules?t=${tid}`)).json();
  ok(!/operator rules/.test(rules.text || ''), `board: a tenant without AGENTS.md does not see the operator's (got ${String(rules.text).slice(0, 50)})`);
  fs.writeFileSync(path.join(SB, 'tenants', tid, 'AGENTS.md'), '# tenant rules\n');
  const rules2 = await (await fetch(`http://127.0.0.1:${boardPort}/api/rules?t=${tid}`)).json();
  ok(/tenant rules/.test(rules2.text || ''), 'board: a tenant with its own AGENTS.md sees exactly that');
  board.kill();
  fs.rmSync(SB, { recursive: true, force: true });
}

if (prevFloorEnv === undefined) delete process.env.HUBD_AGENT; else process.env.HUBD_AGENT = prevFloorEnv;
fs.rmSync(EV, { recursive: true, force: true });
core.setHubBase(T0); core.ensureHubDirs();

// ── the one human in the fleet exists in presence too ──
// Agents heartbeat because the protocol tells them to; nobody tells the owner anything, so a
// board could show buttons waiting twelve days with no way to tell "away" from "here and not
// answering". Nothing new is asked of the human: a write authored by a declared owner role IS
// the evidence that a person acted.
const OP = mktmp();
fs.mkdirSync(path.join(OP, 'queues'), { recursive: true });
fs.writeFileSync(path.join(OP, 'owner-roles.json'), '["boss"]');
core.setHubBase(OP); core.ensureHubDirs();
core.runReport({ project: 'p', by: 'dev-t', text: 'FACT: an agent wrote this' });
ok(core.runPresence().agents.length === 0, 'owner presence: an agent write records nothing new');
core.runReport({ project: 'p', by: 'boss', text: 'FACT: a card-only write, which never touches the journal' });
const opAfter = core.runPresence().agents;
ok(opAfter.length === 1 && opAfter[0].agent === 'boss' && opAfter[0].alive,
  `owner presence: a declared owner's write puts the human on the roster (got ${JSON.stringify(opAfter.map(a => a.agent))})`);
const opFirst = opAfter[0].last_seen;
queueLib.queueSend('worker', 'go ahead', { from: 'boss', root: OP, node: 'n1' });
ok(core.runPresence().agents.find(a => a.agent === 'boss'),
  'owner presence: answering a button counts too — a queue reply is the one write that never journals');
ok(core.runPresence().agents[0].ttlMin > 15,
  'owner presence: a person who answered an hour ago is still around in a way a polling loop is not');
fs.rmSync(OP, { recursive: true, force: true });
core.setHubBase(T0); core.ensureHubDirs();

// ── a heartbeat says which hub it was written into ──
// Two roles on one machine writing to two hubs was invisible for a day twice:
// everything kept working, into a directory nobody else read.
{
  const HB = mktmp();
  core.setHubBase(HB); core.ensureHubDirs();
  core.runHeartbeat({ agent: 'role-a', role: 'w', status: 'working' });
  const recPath = fs.readdirSync(path.join(HB, 'presence')).map(f => path.join(HB, 'presence', f))[0];
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  ok(rec.hub === fs.realpathSync(HB), `heartbeat: the record names the hub it was written into (got ${rec.hub})`);
  ok(!core.runPresence().agents.find(a => a.agent === 'role-a').elsewhere,
    'presence: a role writing into THIS hub is not flagged');
  fs.writeFileSync(recPath, JSON.stringify({ ...rec, hub: '/home/agent/.hubd' }));
  const split = core.runPresence().agents.find(a => a.agent === 'role-a');
  ok(split.elsewhere === '/home/agent/.hubd', `presence: a role on this node writing elsewhere is flagged (got ${split.elsewhere})`);
  fs.writeFileSync(recPath, JSON.stringify({ ...rec, hub: '/srv/other', node: 'someone-else' }));
  ok(!core.runPresence().agents.find(a => a.agent === 'role-a').elsewhere,
    'presence: a record from ANOTHER node is not flagged — every node legitimately has its own path');
  fs.writeFileSync(recPath, JSON.stringify({ ...rec, hub: undefined }));
  ok(!core.runPresence().agents.find(a => a.agent === 'role-a').elsewhere,
    'presence: a pre-0.9.20 record with no path is silent rather than guessed about');
  // A hub this process cannot write reads as healthy and keeps nothing.
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(path.join(HB, 'projects'), 0o555);
    const env = core.envChecks({ transport: 'stdio' });
    const item = env.items.find(i => i.id === 'hub-not-writable');
    ok(item && item.severity === 'high' && /projects/.test(item.what), 'envChecks: an unwritable hub directory is a high-severity finding');
    ok(item && /chmod -R g\+rwX/.test(item.remedy), 'envChecks: with the command that fixes a shared fleet hub');
    fs.chmodSync(path.join(HB, 'projects'), 0o755);
    ok(!core.envChecks({ transport: 'stdio' }).items.find(i => i.id === 'hub-not-writable'), 'envChecks: and it clears itself');
  }
  fs.rmSync(HB, { recursive: true, force: true });
}

// ── roles as cards, and a heartbeat a supervisor reads without parsing ──
const RG = mktmp();
core.setHubBase(RG); core.ensureHubDirs();
{
  core.runResourceSet({ slug: 'api-head', type: 'role', attrs: { rank: 'head', project: 'api', repo: '/x/canon.git', base: 'main' }, by: 'dev-t' });
  core.runResourceSet({ slug: 'api-dev', type: 'role', attrs: { rank: 'worker', project: 'api', idle_min: '40' }, edges: { head: ['api-head'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'api-old', type: 'role', status: 'off', attrs: { rank: 'worker', project: 'api' }, edges: { head: ['api-head'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'db-host', type: 'host', by: 'dev-t' });
  const reg = core.roleRegistry();
  ok(reg.size === 3 && !reg.has('db-host'), 'roles: the registry is the resource cards of type role, nothing else');
  const hc = core.headConf('api-head');
  ok(hc && hc.workers.map(w => w.role).join(',') === 'api-dev,api-old' && hc.attrs.repo === '/x/canon.git',
    'roles: a head lists the roles whose head link points at it, with its own attributes');
  ok(reg.get('api-dev').idleMin === 40 && reg.get('api-old').status === 'off', 'roles: idle_min is a number, a switched-off worker keeps its status');
  core.runResourceSet({ slug: 'api-dev', attrs: { idle_min: '' }, by: 'dev-t' });
  ok(!/idle_min/.test(fs.readFileSync(path.join(RG, 'resources', 'api-dev.md'), 'utf8')), 'roles: an empty attribute value removes the key');
  let ea = null; try { core.runResourceSet({ slug: 'api-dev', attrs: { kind: 'x' }, by: 'dev-t' }); } catch (e) { ea = e.message; }
  let eb = null; try { core.runResourceSet({ slug: 'api-dev', attrs: { note: 'a\nkind: project' }, by: 'dev-t' }); } catch (e) { eb = e.message; }
  ok(/not "kind"/.test(ea || '') && /one line/.test(eb || ''), 'roles: an attribute cannot overwrite the card class or smuggle a second line into the frontmatter');

  core.runHeartbeat({ agent: 'api-dev', state: 'waiting', empty_count: 1 });
  const p1 = core.readPresenceRecord('api-dev');
  const back = '2026-01-01 08:00';
  fs.writeFileSync(core.presencePath('api-dev'), JSON.stringify({ ...p1, state_since: back }));
  core.runHeartbeat({ agent: 'api-dev', state: 'waiting', empty_count: 0 });
  ok(core.readPresenceRecord('api-dev').state_since === back, 'heartbeat: repeating a state keeps when it began, even when the loop restarted its own counter');
  core.runHeartbeat({ agent: 'api-dev', state: 'turn', turn: 7, turn_started: '2026-01-01 09:00' });
  core.runHeartbeat({ agent: 'api-dev', state: 'turn', turn: 7 });
  const p2 = core.readPresenceRecord('api-dev');
  ok(p2.turn_started === '2026-01-01 09:00' && p2.state_since !== back, 'heartbeat: a turn keeps its start across heartbeats; a new state restarts state_since');
  core.runHeartbeat({ agent: 'api-dev', state: 'turn', turn: 8 });
  ok(!core.readPresenceRecord('api-dev').turn_started, 'heartbeat: a new turn number does not inherit the previous turn\'s start');
  core.runHeartbeat({ agent: 'api-dev', status: 'plain text only' });
  const p3 = core.readPresenceRecord('api-dev');
  ok(!('state' in p3) && !('empty_count' in p3) && p3.status === 'plain text only', 'heartbeat: an old loop that sends only status keeps the old record shape');
  let eh = null; try { core.runHeartbeat({ agent: 'api-dev', state: 'Two Words' }); } catch (e) { eh = e.message; }
  let ec = null; try { core.runHeartbeat({ agent: 'api-dev', empty_count: -1 }); } catch (e) { ec = e.message; }
  ok(/lowercase word/.test(eh || '') && /non-negative/.test(ec || ''), 'heartbeat: a malformed state or count is refused, not stored');

  core.runTaskAdd({ project: 'api', text: 'on a real role', assignee: 'api-dev', by: 'dev-t' });
  core.runTaskAdd({ project: 'api', text: 'on a ghost', assignee: 'ghost-role', by: 'dev-t' });
  fs.writeFileSync(path.join(RG, 'owner-roles.json'), '["boss"]');
  core.runTaskAdd({ project: 'api', text: 'for the owner', assignee: 'boss', by: 'dev-t' });
  const lf = core.runLint({}).findings.filter(f => f.id === 'assignee-outside-roster');
  ok(lf.length === 1 && /ghost-role/.test(lf[0].what) && lf[0].tasks.length === 1, 'lint: an open task on a name the registry does not know is a finding; roles and owners are not');
  const RG2 = mktmp(); core.setHubBase(RG2); core.ensureHubDirs();
  core.runTaskAdd({ project: 'api', text: 'x', assignee: 'anyone', by: 'dev-t' });
  const l2 = core.runLint({});
  ok(!l2.findings.some(f => f.id === 'assignee-outside-roster') && l2.notes.some(n => /no roles are declared/.test(n)),
    'lint: with no registry the check says it checked nothing instead of calling everyone unknown');
  core.recordEnvObservation('cursor-conflict', 'work-q');
  ok(core.runLint({}).findings.some(f => f.id === 'two-readers-one-queue' && f.role === 'work-q'), 'lint: two live readers on one work queue are a finding while it is true');
  core.clearEnvObservation('cursor-conflict', 'work-q');
  ok(!core.runLint({}).findings.some(f => f.id === 'two-readers-one-queue'), 'lint: and gone once one reader is left');
  fs.rmSync(RG2, { recursive: true, force: true });
}
core.setHubBase(T0); core.ensureHubDirs();

/* ── PS: a node whose sessions never heartbeat still says it is up ──
 * The snapshot was written on heartbeat only. A node used by people at a terminal kept the one it
 * wrote weeks before, and every other node read it as silent for 24 days while it wrote to the mesh
 * every minute. Any MCP tool call now refreshes it, on the same throttle, where one exists. */
{
  const mcpCall = (dir, name) => execSync(`node ${REPO}/hub/index.mjs`, {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) + '\n',
    encoding: 'utf8', env: { ...process.env, HUBD_DIR: dir, HUBD_TEAM_DIR: dir }, timeout: 15000 });
  const old = mktmp();
  const snap = path.join(old, 'presence.' + core.JOURNAL_NODE + '.json');
  fs.writeFileSync(snap, JSON.stringify({ node: core.JOURNAL_NODE, written: '2026-09-11 14:42', v: '0.9.30', agents: [] }));
  const weeks = new Date(Date.now() - 24 * 86400000);
  fs.utimesSync(snap, weeks, weeks);
  mcpCall(old, 'hub_presence');
  const after = JSON.parse(fs.readFileSync(snap, 'utf8'));
  ok(after.written !== '2026-09-11 14:42' && fs.statSync(snap).mtimeMs > weeks.getTime() + 86400000,
    `refreshPresenceSnapshot: a tool call that only reads refreshes a snapshot weeks old (written ${after.written})`);
  const at = fs.statSync(snap).mtimeMs;
  mcpCall(old, 'hub_presence');
  ok(fs.statSync(snap).mtimeMs === at, 'refreshPresenceSnapshot: and the next call inside the window leaves it as it is');
  const none = mktmp();
  mcpCall(none, 'hub_presence');
  ok(!fs.readdirSync(none).some(f => /^presence\..+\.json$/.test(f)), 'refreshPresenceSnapshot: a hub that never published one gets none');
}

done();
