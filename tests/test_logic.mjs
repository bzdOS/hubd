// test_logic.mjs — regression tests for the logical bugs fixed in the bug-hunt pass.
// Run: node tests/test_logic.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = `node ${REPO}/hub/cli.mjs`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hubd-t-'));
// run the CLI, never throw — capture non-zero exits (doctor exits 1 on warnings)
function run(args, env) {
  try { return { code: 0, out: execSync(`${CLI} ${args}`, { env: { ...process.env, ...env }, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

// ── unit (import core against a temp hub) ─────────────────────────────────────
const T0 = mktmp();
process.env.HUBD_DIR = T0;
process.env.HUBD_NODE = 'cowork';
const core = await import(path.join(REPO, 'hub/lib/core.mjs'));

// Bug: a deleted id must not be reused by another node and then corrupted by the
// original node's later `set` (set-after-del lands on the wrong task).
fs.writeFileSync(path.join(T0, 'tasks.aaa.events.jsonl'),
  JSON.stringify({ ts: '2026-01-01 10:00', node: 'aaa', ev: 'add', id: 5, t: { id: 5, text: 'A-task', status: 'open' } }) + '\n' +
  JSON.stringify({ ts: '2026-01-01 10:01', node: 'aaa', ev: 'del', id: 5 }) + '\n' +
  JSON.stringify({ ts: '2026-01-01 10:03', node: 'aaa', ev: 'set', id: 5, patch: { text: 'A-modified' } }) + '\n');
fs.writeFileSync(path.join(T0, 'tasks.bbb.events.jsonl'),
  JSON.stringify({ ts: '2026-01-01 10:02', node: 'bbb', ev: 'add', id: 5, t: { id: 5, text: 'B-task', status: 'open' } }) + '\n');
const db = core.foldTasks();
ok(db.tasks.length === 1, `fold/reuse: exactly one task survives (got ${db.tasks.length})`);
ok(db.tasks[0] && db.tasks[0].text === 'B-task', `fold/reuse: B's task intact, not corrupted by A's set (text=${db.tasks[0] && db.tasks[0].text})`);
fs.rmSync(path.join(T0, 'tasks.aaa.events.jsonl')); fs.rmSync(path.join(T0, 'tasks.bbb.events.jsonl'));

// Bug: journal rotation must not overwrite an existing same-month archive (data loss).
const big = 'x'.repeat(2 * 1024 * 1024 + 16) + '\n';
fs.writeFileSync(core.JOURNAL, '{"m":"first"}\n' + big);
core.journalAppend({ m: 'after1' });
fs.writeFileSync(core.JOURNAL, '{"m":"second"}\n' + big);
core.journalAppend({ m: 'after2' });
const arch = fs.readdirSync(T0).filter(f => /^journal\.cowork-\d{4}-\d{2}/.test(f));
ok(arch.length === 2, `journal rotation: two distinct archives kept (got ${arch.length}: ${arch.join(',')})`);
const ac = arch.map(f => fs.readFileSync(path.join(T0, f), 'utf8'));
ok(ac.some(c => c.includes('"first"')) && ac.some(c => c.includes('"second"')), 'journal rotation: both archives preserved (no overwrite)');

// Bug (latent): core.mjs must stay synchronous — setHubBase repoints a module-level
// base per HTTP request; one `await` inside a tool would let tenants interleave.
const src = fs.readFileSync(path.join(REPO, 'hub/lib/core.mjs'), 'utf8');
const codeOnly = src.split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
ok(!/\basync\b|\bawait\b/.test(codeOnly), 'core.mjs code (sans comments) has no async/await (keeps the synchronous setHubBase invariant)');
fs.rmSync(T0, { recursive: true, force: true });

// ── CLI: `hub gc` removes only the generated backup, never a user .bak ─────────
const T1 = mktmp();
fs.writeFileSync(path.join(T1, 'tasks.json.bak.20260101T000000Z'), 'old cache');
fs.writeFileSync(path.join(T1, 'mynote.bak.md'), 'a card the user backed up by hand');
run('gc', { HUBD_DIR: T1 });
ok(!fs.existsSync(path.join(T1, 'tasks.json.bak.20260101T000000Z')), 'gc: removes tasks.json.bak.*');
ok(fs.existsSync(path.join(T1, 'mynote.bak.md')), 'gc: keeps a user .bak file (precise matcher, no data loss)');
fs.rmSync(T1, { recursive: true, force: true });

// ── CLI: doctor catches a LARGE destructive rewrite (numstat, no maxBuffer blind spot) ──
const T2 = mktmp();
const ev = path.join(T2, 'tasks.cowork.events.jsonl');
let lines = '';
for (let i = 1; i <= 8000; i++) lines += JSON.stringify({ ts: '2026-01-01 10:00', node: 'cowork', ev: 'add', id: i, t: { id: i, text: 'task ' + 'y'.repeat(220) } }) + '\n';
fs.writeFileSync(ev, lines);   // ~2 MB → a full git-diff would blow execSync's 1 MB buffer
execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: T2 });
fs.writeFileSync(ev, lines.split('\n').slice(5000).join('\n'));   // drop 5000 lines → >1 MB diff
const d = run('doctor', { HUBD_DIR: T2, HUBD_TEAM_DIR: T2 });
ok(/append-only|removed\/changed/i.test(d.out), 'doctor: flags a large non-append-only rewrite (numstat survives big diffs)');
ok(d.code !== 0, 'doctor: exits non-zero on the append-only warning');
fs.rmSync(T2, { recursive: true, force: true });

// ── CLI: rules source = HUB wins over team-root; no hardcoded ~/.hubd shadow ──
const HUBD = mktmp(), TEAM = mktmp();
fs.writeFileSync(path.join(HUBD, 'AGENTS.md'), '# HUB rules');
fs.writeFileSync(path.join(TEAM, 'AGENTS.md'), '# TEAM rules');
const r = run('doctor', { HUBD_DIR: HUBD, HUBD_TEAM_DIR: TEAM });
ok(r.out.includes(path.join(HUBD, 'AGENTS.md')), 'rules source: HUB/AGENTS.md wins over team-root');
ok(!r.out.includes(path.join(TEAM, 'AGENTS.md')), 'rules source: team-root not chosen when HUB has its own');
fs.rmSync(HUBD, { recursive: true, force: true }); fs.rmSync(TEAM, { recursive: true, force: true });

// ── CLI: hub brief must not crash on a journal entry missing fields (malformed/old/mesh) ──
const T4 = mktmp();
const recentTs = new Date(Date.now() - 3600000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(T4, 'journal.cowork.jsonl'),
  JSON.stringify({ ts: recentTs, project: 'x', agent: 'a', kind: 'note' }) + '\n');   // no `text` field
const b = run('brief', { HUBD_DIR: T4, HUBD_TEAM_DIR: T4 });
ok(b.code === 0, `hub brief: no crash on a journal entry missing 'text' (exit ${b.code})`);
ok(/JOURNAL/.test(b.out), 'hub brief: still renders the JOURNAL section');
fs.rmSync(T4, { recursive: true, force: true });

// ── core: card-set / sync must preserve ALL owner sections, not just "## Facts" ──
// regression: the writer used to keep only "## Facts" and silently drop any other
// hand section (roadmap/gates/decisions) — card data loss on every rewrite.
const TC = mktmp();
core.setHubBase(TC);            // creates projects/ + projects/history/
fs.writeFileSync(path.join(TC, 'projects', 'demo.md'),
  '---\nslug: demo\nowner_kind: mixed\n---\n# demo\n\n- slug: demo\n\n' +
  '## Digest\n\nold digest\n\n' +
  '## Facts\n\n- hand fact\n\n' +
  '## Roadmap\n\n- ship it\n\n' +
  '## Decisions\n\n- chose files-first\n');
core.runCardSet({ project: 'demo', digest: 'fresh digest v6', by: 'test' });
const cs = core.readCard('demo');
ok(/fresh digest v6/.test(cs), 'card-set: digest updated');
ok(/## Facts[\s\S]*hand fact/.test(cs), 'card-set: hand "## Facts" preserved');
ok(/## Roadmap[\s\S]*ship it/.test(cs), 'card-set: custom "## Roadmap" preserved (no data loss)');
ok(/## Decisions[\s\S]*files-first/.test(cs), 'card-set: custom "## Decisions" preserved');
ok(/owner_kind: mixed/.test(cs), 'card-set: frontmatter preserved');
ok(!/## Next step/.test(cs), 'card-set: existing card NOT re-scaffolded with the template');
ok(fs.existsSync(path.join(TC, 'projects', 'history', 'demo.md')), 'card-set: old digest archived to history');
core.runSync({ path: TC, name: 'demo', digest: 'synced digest', agent: 'test' });
const sy = core.readCard('demo');
ok(/## Roadmap[\s\S]*ship it/.test(sy), 'sync: custom "## Roadmap" preserved');
ok(/## Decisions[\s\S]*files-first/.test(sy), 'sync: custom "## Decisions" preserved');
ok(/## Facts \(auto\)/.test(sy), 'sync: regenerates its own "## Facts (auto)"');
fs.rmSync(TC, { recursive: true, force: true });

// ── core: a NEW card is scaffolded from the card template; HUB/card-template.md overrides ──
const TN = mktmp();
core.setHubBase(TN);
core.runCardSet({ project: 'fresh', digest: 'kickoff', by: 'test' });
const nc = core.readCard('fresh');
ok(/kickoff/.test(nc), 'new card: digest set');
ok(/## Next step/.test(nc), 'new card: scaffolds "## Next step"');
ok(/## Gates/.test(nc), 'new card: scaffolds "## Gates"');
ok(/## Decisions/.test(nc), 'new card: scaffolds "## Decisions"');
ok(/## Communication/.test(nc), 'new card: scaffolds "## Communication"');
fs.writeFileSync(path.join(TN, 'card-template.md'), '## Custom Section\n\noverride body\n');
core.runCardSet({ project: 'fresh2', digest: 'd2', by: 'test' });
const oc = core.readCard('fresh2');
ok(/## Custom Section[\s\S]*override body/.test(oc), 'new card: HUB/card-template.md override is used');
ok(!/## Gates/.test(oc), 'new card: override replaces the built-in template');
fs.rmSync(TN, { recursive: true, force: true });

// ── core: sync of a NEW project scaffolds the template + auto "open tasks" in Facts (auto) ──
const TG = mktmp();
core.setHubBase(TG);
const proj = path.join(TG, 'proj');
fs.mkdirSync(proj, { recursive: true });
core.runSync({ path: proj, name: 'proj', digest: 'first', agent: 'test' });
const gc = core.readCard('proj');
ok(/## Next step/.test(gc) && /## Communication/.test(gc), 'sync new card: template scaffolded');
ok(/## Facts \(auto\)[\s\S]*open tasks: 0/.test(gc), 'sync: Facts (auto) carries the auto open-tasks count');
fs.rmSync(TG, { recursive: true, force: true });

// ── resources: card with structured attrs + typed edges, the graph, and task↔resource ──
const TR = mktmp();
core.setHubBase(TR);
core.runResourceSet({ slug: 'myvm', type: 'host', address: '10.0.0.1', status: 'live', by: 'test' });
core.runResourceSet({ slug: 'myvm', edges: { runs_on: ['hubd'] }, by: 'test' });   // 2nd set: add edge, keep attrs
const rcard = core.readResource('myvm');
ok(/kind: resource/.test(rcard), 'resource: kind in frontmatter');
ok(/type: host/.test(rcard) && /address: 10\.0\.0\.1/.test(rcard), 'resource: structured attrs in frontmatter');
ok(/status: live/.test(rcard), 'resource: attrs survive a 2nd set (merge, no clobber)');
ok(/runs_on: \[\[hubd\]\]/.test(rcard), 'resource: typed edge written to frontmatter');
ok(core.runResourceList().count === 1, 'resource list: counts the card');
const g = core.runGraph();
ok(g.edges.some(e => e.from === 'myvm' && e.rel === 'runs_on' && e.to === 'hubd'), 'graph: myvm —runs_on→ hubd');
ok(g.dangling.some(d => d.to === 'hubd'), 'graph: dangling [[hubd]] flagged (no card yet)');
fs.writeFileSync(path.join(TR, 'projects', 'hubd.md'), '---\nslug: hubd\nruns_on: [[myvm]]\n---\n# hubd\n\n## Digest\n\nx\n');
const g2 = core.runGraph();
ok(!g2.dangling.some(d => d.to === 'hubd'), 'graph: link resolves once the card exists');
ok(g2.edges.some(e => e.from === 'hubd' && e.rel === 'runs_on' && e.to === 'myvm'), 'graph: project→resource edge read from project frontmatter');
const tk = core.runTaskAdd({ project: 'hubd', text: 'patch the box', resources: ['myvm'], by: 'test' });
ok(Array.isArray(tk.task.resources) && tk.task.resources[0] === 'myvm', 'task: resources field stored on add');
ok(core.runTaskList({ project: 'hubd' }).tasks[0].resources[0] === 'myvm', 'task list: resources survive the event fold');
fs.rmSync(TR, { recursive: true, force: true });

// ── structured report: prefix batch → card sections + task events + note ──
const TRP = mktmp();
core.setHubBase(TRP);
const seed = core.runTaskAdd({ project: 'proj', text: 'old task', by: 'test' }).task.id;
const batch = [
  'DECIDE: ship docs in release | npm README drifted',
  'DECISION: register 0.1.8 | mcpservers approved',   // synonym → decide
  'FACT: registry JWT expires in minutes',
  'GOTCHA: pkg ABI is FreeBSD-15-aarch64',            // synonym → fact
  'HYPO: kolkhoz in fundraising',
  'COMM: 0.1.8 live on mcpservers',
  'NEXT: redeploy myvm',
  'DONE: ' + seed,
  'TASK: write the changelog',
  'NOTE: distribution session',
  'an unprefixed trailing thought',                   // → note
].join('\n');
const rep = core.runReport({ project: 'proj', by: 'test', text: batch });
const rc = core.readCard('proj');
ok(rep.decisions === 2, `report: 2 decisions incl. DECISION synonym (got ${rep.decisions})`);
ok(/## Decisions[\s\S]*ship docs in release — npm README drifted/.test(rc), 'report: decision+why → ## Decisions');
ok(/## Decisions[\s\S]*register 0\.1\.8 — mcpservers approved/.test(rc), 'report: 2nd decision present (multiplicity)');
ok(/## Facts & hypotheses[\s\S]*fact: registry JWT expires/.test(rc), 'report: FACT → Facts & hypotheses');
ok(/## Facts & hypotheses[\s\S]*fact: pkg ABI is FreeBSD-15-aarch64/.test(rc), 'report: GOTCHA synonym → fact');
ok(/## Facts & hypotheses[\s\S]*hypothesis: kolkhoz in fundraising/.test(rc), 'report: HYPO → hypothesis');
ok(/## Communication[\s\S]*0\.1\.8 live on mcpservers/.test(rc), 'report: COMM → ## Communication');
const nextBody = rc.split('## Next step')[1].split(/\n## /)[0];
ok(/redeploy myvm/.test(nextBody) && !/<the one next action/.test(nextBody), 'report: NEXT set ## Next step (replaced placeholder)');
ok(core.runTaskList({ project: 'proj', status: 'done' }).tasks.some(t => t.id === seed), 'report: DONE closed the seeded task');
ok(core.runTaskList({ project: 'proj', status: 'open' }).tasks.some(t => /changelog/.test(t.text)), 'report: TASK opened a new task');
const jp = core.journalTail('proj', 50);
ok(jp.filter(e => e.kind === 'decision').length === 2, 'report: decisions emit kind:decision journal events');
ok(jp.some(e => e.kind === 'note' && /distribution session/.test(e.text) && /unprefixed trailing/.test(e.text)), 'report: NOTE + unprefixed → one note entry');
fs.rmSync(TRP, { recursive: true, force: true });

// ── sections.json: ONE i18n source drives BOTH the scaffold AND report routing (0.2.0) ──
const TRO = mktmp();
core.setHubBase(TRO);
fs.writeFileSync(path.join(TRO, 'sections.json'), JSON.stringify({ decisions: 'Verdicts', next: { heading: 'Up next', hint: 'do this' } }));
core.runCardSet({ project: 'p2', digest: 'kick', by: 'test' });            // new card → scaffolded from sections.json
const p2 = core.readCard('p2');
ok(/## Verdicts/.test(p2) && !/## Decisions/.test(p2), 'sections.json: scaffold uses the overridden heading');
ok(/## Up next[\s\S]*do this/.test(p2), 'sections.json: {heading,hint} override applies to the scaffold');
core.runReport({ project: 'p2', by: 'test', text: 'DECIDE: do X | because Y' });
ok(/## Verdicts[\s\S]*do X — because Y/.test(core.readCard('p2')), 'sections.json: report routes into the SAME heading as scaffold (no drift)');
ok(core.sectionsConfig().find(s => s.key === 'decisions').heading === 'Verdicts', 'sectionsConfig: merge-by-key override');
fs.rmSync(TRO, { recursive: true, force: true });

// ── report-sections.json still honoured as a deprecated alias ──
const TRA = mktmp();
core.setHubBase(TRA);
fs.writeFileSync(path.join(TRA, 'report-sections.json'), JSON.stringify({ communication: 'Outbound' }));
core.runReport({ project: 'p3', by: 'test', text: 'COMM: shipped X' });
ok(/## Outbound[\s\S]*shipped X/.test(core.readCard('p3')), 'report-sections.json: deprecated alias still routes');
fs.rmSync(TRA, { recursive: true, force: true });

// ── protocol: ensureProtocol materialises HUBD.md (versioned, gitignored, per-node) ──
const TP = mktmp();
core.setHubBase(TP);
const e1 = core.ensureProtocol();
ok(e1.wrote === true && e1.version === core.VERSION, 'ensureProtocol: writes HUBD.md stamped with the installed version');
const hubmd = fs.readFileSync(path.join(TP, 'HUBD.md'), 'utf8');
ok(new RegExp('hubd-protocol v' + core.VERSION.replace(/\./g, '\\.')).test(hubmd), 'protocol: HUBD.md carries the version stamp');
ok(/hub claim/.test(hubmd) && /hub report/.test(hubmd) && /play-by-play/.test(hubmd), 'protocol: HUBD.md teaches claim-vs-report');
ok(core.ensureProtocol().wrote === false, 'ensureProtocol: idempotent when current (no rewrite)');
ok(core.ensureProtocol(true).wrote === true, 'ensureProtocol: force rewrites');
ok(/^HUBD\.md$/m.test(fs.readFileSync(path.join(TP, '.gitignore'), 'utf8')), 'protocol: HUBD.md is gitignored (per-node, not mesh-synced)');
fs.rmSync(TP, { recursive: true, force: true });

// ── harvest: package-shipped prompt via core + MCP (not fetched from the repo) ──
const hp = core.harvestPrompt();
ok(hp && /Harvest this dialog/.test(hp), 'harvestPrompt: returns the paste-able Harvest Protocol prompt');
ok(/DECIDE:/.test(hp) && !/hub report "<decisions/.test(hp), 'harvestPrompt: OUTPUT uses the structured report, not the old prose blob');
const idxReqs = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'harvest' } }),
].join('\n') + '\n';
let mcpOut = '';
try { mcpOut = execSync(`node ${REPO}/hub/index.mjs`, { input: idxReqs, encoding: 'utf8', env: { ...process.env, HUBD_DIR: mktmp() }, timeout: 15000 }); }
catch (e) { mcpOut = (e.stdout || ''); }
ok(/"prompts"\s*:\s*\{/.test(mcpOut), 'MCP: initialize advertises the prompts capability');
ok(/"name"\s*:\s*"harvest"/.test(mcpOut), 'MCP: prompts/list advertises harvest');
ok(/Harvest this dialog/.test(mcpOut), 'MCP: prompts/get returns the harvest prompt text');

// ── resolveContext/runContext: cwd → project bootstrap (memory series #164) ──
// marker file wins; then a card's recorded sync path; then a folder-name guess
// ONLY if that exact card already exists; else null with a hint. Never crosses
// above the nearest .git root while looking for a marker.
const ctxRoot1 = mktmp();
core.setHubBase(ctxRoot1);
const ctxOuterDir = path.join(ctxRoot1, 'outer');
const ctxRepoDir = path.join(ctxOuterDir, 'repo');
const ctxNestedDir = path.join(ctxRepoDir, 'src', 'deep');
fs.mkdirSync(ctxNestedDir, { recursive: true });
fs.mkdirSync(path.join(ctxRepoDir, '.git'));
fs.writeFileSync(path.join(ctxOuterDir, '.hubd'), 'wrong-project\n');   // above the .git root — must be ignored
fs.writeFileSync(path.join(ctxRepoDir, '.hubd'), 'Right Project\n');    // at the repo root — must win
const ctxA = core.resolveContext(ctxNestedDir);
ok(ctxA.project === 'right-project', `context marker: slugified, found by walking up from a nested dir (got ${ctxA.project})`);
ok(ctxA.via === 'marker' && ctxA.guessed === false && ctxA.root === ctxRepoDir, 'context marker: via=marker, root=repo, not guessed');
fs.rmSync(ctxRoot1, { recursive: true, force: true });

const ctxRoot1b = mktmp();
core.setHubBase(ctxRoot1b);
const ctxOuterDir2 = path.join(ctxRoot1b, 'outer2');
const ctxRepoDirB = path.join(ctxOuterDir2, 'repoB');
fs.mkdirSync(ctxRepoDirB, { recursive: true });
fs.mkdirSync(path.join(ctxRepoDirB, '.git'));
fs.writeFileSync(path.join(ctxOuterDir2, '.hubd'), 'should-not-be-used\n');   // above the repo root
const ctxB = core.resolveContext(ctxRepoDirB);
ok(ctxB.project === null && ctxB.via === 'none', `context marker: never searches above the .git root (got project=${ctxB.project}, via=${ctxB.via})`);
fs.rmSync(ctxRoot1b, { recursive: true, force: true });

const ctxRoot2 = mktmp();
core.setHubBase(ctxRoot2);
const ctxSyncedDir = path.join(ctxRoot2, 'somefolder');
fs.mkdirSync(ctxSyncedDir, { recursive: true });
core.runSync({ path: ctxSyncedDir, name: 'Custom Name', digest: 'd1', agent: 'test' });   // slug custom-name != folder name
const ctxC = core.resolveContext(ctxSyncedDir);
ok(ctxC.project === 'custom-name', `context path-match: resolves via the card's recorded sync path (got ${ctxC.project})`);
ok(ctxC.via === 'path' && ctxC.guessed === false, 'context path-match: via=path, not guessed');
const ctxSyncedSub = path.join(ctxSyncedDir, 'sub');
fs.mkdirSync(ctxSyncedSub, { recursive: true });
const ctxD = core.resolveContext(ctxSyncedSub);
ok(ctxD.project === 'custom-name', `context path-match: also resolves from a subdirectory of the synced path (got ${JSON.stringify(ctxD)})`);
fs.rmSync(ctxRoot2, { recursive: true, force: true });

const ctxRoot3 = mktmp();
core.setHubBase(ctxRoot3);
core.runCardSet({ project: 'myapp', digest: 'kickoff', by: 'test' });   // harvested card, no recorded path
const ctxGuessDir = path.join(ctxRoot3, 'work', 'myapp');
fs.mkdirSync(ctxGuessDir, { recursive: true });
const ctxE = core.resolveContext(ctxGuessDir);
ok(ctxE.project === 'myapp' && ctxE.via === 'guess' && ctxE.guessed === true, `context basename-guess: matches an existing card by folder name, flagged guessed (got ${JSON.stringify(ctxE)})`);
fs.rmSync(ctxRoot3, { recursive: true, force: true });

const ctxRoot4 = mktmp();
core.setHubBase(ctxRoot4);
const ctxUnknownDir = path.join(ctxRoot4, 'totally-unknown-folder-xyz');
fs.mkdirSync(ctxUnknownDir, { recursive: true });
const ctxF = core.resolveContext(ctxUnknownDir);
ok(ctxF.project === null && ctxF.via === 'none', `context no-match: project null, via=none (got ${JSON.stringify(ctxF)})`);
ok(typeof ctxF.hint === 'string' && ctxF.hint.length > 0, 'context no-match: hint present to guide the caller');
fs.rmSync(ctxRoot4, { recursive: true, force: true });

const ctxRoot5 = mktmp();
core.setHubBase(ctxRoot5);
const ctxFullDir = path.join(ctxRoot5, 'proj5');
fs.mkdirSync(ctxFullDir, { recursive: true });
fs.writeFileSync(path.join(ctxFullDir, '.hubd'), 'proj5\n');
core.runCardSet({ project: 'proj5', digest: 'the digest text', by: 'test' });
core.runTaskAdd({ project: 'proj5', text: 'do the thing', by: 'test' });
core.runClaim({ project: 'proj5', area: 'app', agent: 'tester' });
const ctxFull = core.runContext({ cwd: ctxFullDir });
ok(ctxFull.project === 'proj5' && ctxFull.via === 'marker', 'runContext: resolves project via marker');
ok(/the digest text/.test(ctxFull.digest || ''), `runContext: digest extracted from the card (got ${ctxFull.digest})`);
ok(Array.isArray(ctxFull.openTasks) && ctxFull.openTasks.some(t => /do the thing/.test(t.text)), 'runContext: openTasks includes the seeded task');
ok(Array.isArray(ctxFull.activeClaims) && ctxFull.activeClaims.some(c => c.area === 'app'), 'runContext: activeClaims includes the seeded claim');
let ctxThrew = false;
try { core.runContext({}); } catch { ctxThrew = true; }
ok(ctxThrew, "runContext: throws without cwd (never silently falls back to the server's own cwd)");
fs.rmSync(ctxRoot5, { recursive: true, force: true });

// ── presence: hub_heartbeat/hub_presence — TTL freshness like activeClaims (task #191) ──
const queueLib = await import(path.join(REPO, 'hub/lib/queue.mjs'));

const presRoot1 = mktmp();
core.setHubBase(presRoot1);
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

// ensureProtocol: presence/ gitignored EVEN when HUBD.md is already current (not just on write)
const presRoot2 = mktmp();
core.setHubBase(presRoot2);
core.ensureProtocol();
ok(/^presence\/$/m.test(fs.readFileSync(path.join(presRoot2, '.gitignore'), 'utf8')), 'ensureProtocol: presence/ gitignored on first run');
fs.writeFileSync(path.join(presRoot2, '.gitignore'), '');   // simulate an older .gitignore missing the entry
const eAgain = core.ensureProtocol();                       // same version -> would NOT rewrite HUBD.md
ok(eAgain.wrote === false, 'ensureProtocol: still idempotent on HUBD.md (no unnecessary rewrite)');
ok(/^presence\/$/m.test(fs.readFileSync(path.join(presRoot2, '.gitignore'), 'utf8')), 'ensureProtocol: re-adds presence/ to .gitignore even when HUBD.md was already current — mesh-sync\'s git-add-A would otherwise churn on every heartbeat');
fs.rmSync(presRoot2, { recursive: true, force: true });

// ── queue-depth peek: non-consuming, mesh-safe (task #191) ──
const qRoot1 = mktmp();
const qdir1 = path.join(qRoot1, 'queues'), stateDir1 = path.join(qRoot1, '.qstate');
fs.mkdirSync(qdir1, { recursive: true }); fs.mkdirSync(stateDir1, { recursive: true });
const qfile1 = path.join(qdir1, 'hubd.testnode.queue.md');
const msg1 = '\n## 2026-01-01 10:00 · from orchestrator\nfirst message\n';
fs.writeFileSync(qfile1, msg1);
fs.writeFileSync(path.join(stateDir1, 'hubd.testnode.queue.md.offset'), String(Buffer.byteLength(msg1)));   // first message already consumed
const msg2 = '\n## 2026-01-01 11:00 · from orchestrator\nsecond message\n';
fs.appendFileSync(qfile1, msg2);
const depth1 = queueLib.peekQueueDepth('hubd', { root: qRoot1 });
ok(depth1.pending === 1, `peekQueueDepth: counts only the unread message (got ${depth1.pending})`);
ok(depth1.oldestWaiting === '2026-01-01 11:00', `peekQueueDepth: oldestWaiting is the unread one's timestamp (got ${depth1.oldestWaiting})`);
const offsetBefore = fs.readFileSync(path.join(stateDir1, 'hubd.testnode.queue.md.offset'), 'utf8');
queueLib.peekQueueDepth('hubd', { root: qRoot1 });   // call again
ok(fs.readFileSync(path.join(stateDir1, 'hubd.testnode.queue.md.offset'), 'utf8') === offsetBefore, 'peekQueueDepth: never advances the offset (non-consuming, does not steal from the real consumer)');
fs.rmSync(qRoot1, { recursive: true, force: true });

// ── queueSummaryForBrief: cross-references presence, drops idle/unknown roles ──
const qRoot2 = mktmp();
core.setHubBase(qRoot2);
fs.mkdirSync(path.join(qRoot2, 'queues'), { recursive: true });
fs.writeFileSync(path.join(qRoot2, 'queues', 'busyrole.node1.queue.md'), '\n## 2026-02-02 09:00 · from orchestrator\nsomething\n');
fs.writeFileSync(path.join(qRoot2, 'queues', 'idlerole.node1.queue.md'), '');   // exists, nothing pending, no presence -> dropped
core.runHeartbeat({ agent: 'agent-busy', role: 'busyrole' });
const summary = queueLib.queueSummaryForBrief({ root: qRoot2 });
ok(summary.length === 1 && summary[0].role === 'busyrole', `queueSummaryForBrief: only the role with pending or presence shows up (got ${JSON.stringify(summary)})`);
ok(summary[0].pending === 1 && summary[0].lastSeen === core.readPresenceRecord('agent-busy').last_seen, 'queueSummaryForBrief: pending count + presence last-seen cross-referenced by role');
fs.rmSync(qRoot2, { recursive: true, force: true });

// ── buttons: owner-roles.json + queue-depth isButton/ageDays + buttonsSummary (task #159) ──
const btnRoot1 = mktmp();
core.setHubBase(btnRoot1);
ok(core.ownerRoles().length === 0, 'ownerRoles: empty by default (no owner-roles.json)');
fs.writeFileSync(path.join(btnRoot1, 'owner-roles.json'), JSON.stringify(['alice', 42, '', 'boss']));
ok(JSON.stringify(core.ownerRoles()) === JSON.stringify(['alice', 'boss']), `ownerRoles: reads the file, drops non-string/empty entries (got ${JSON.stringify(core.ownerRoles())})`);

fs.mkdirSync(path.join(btnRoot1, 'queues'), { recursive: true });
const oldTs = '2020-01-01 00:00';
fs.writeFileSync(path.join(btnRoot1, 'queues', 'alice.node1.queue.md'), `\n## ${oldTs} · from agent\nsign this contract\n`);
fs.writeFileSync(path.join(btnRoot1, 'queues', 'dev.node1.queue.md'), '\n## 2026-01-01 00:00 · from orchestrator\nfix the bug\n');
const rows1 = queueLib.queueSummaryForBrief({ root: btnRoot1 });
const aliceRow = rows1.find(r => r.role === 'alice');
const devRow = rows1.find(r => r.role === 'dev');
ok(aliceRow && aliceRow.isButton === true, 'queueSummaryForBrief: owner role flagged isButton');
ok(devRow && devRow.isButton === false, 'queueSummaryForBrief: non-owner role is not a button');
ok(aliceRow.ageDays >= 2000, `queueSummaryForBrief: ageDays computed from a 2020 timestamp (got ${aliceRow.ageDays})`);

const btnSum1 = queueLib.buttonsSummary(rows1);
ok(btnSum1.count === 1 && btnSum1.items.length === 1 && btnSum1.items[0].role === 'alice', `buttonsSummary: counts only button rows with pending>0 (got ${JSON.stringify(btnSum1)})`);
ok(btnSum1.oldestDays === aliceRow.ageDays, 'buttonsSummary: oldestDays matches the button row age');

// a button role with nothing pending contributes nothing
fs.writeFileSync(path.join(btnRoot1, 'queues', 'boss.node1.queue.md'), '');
const rows2 = queueLib.queueSummaryForBrief({ root: btnRoot1 });
const btnSum2 = queueLib.buttonsSummary(rows2);
ok(btnSum2.count === 1, `buttonsSummary: an empty owner queue does not inflate the count (got ${btnSum2.count})`);
fs.rmSync(btnRoot1, { recursive: true, force: true });

// ── regression: cross-node task-id collision must not mis-close the wrong task ──
// Bug: `hub task done N` keyed its `set` event on (writing-node, N) — if the WRITING
// node had itself once collided on local id N (remapped to a different fid), that old
// remap hijacked the lookup and closed the writer's own unrelated task instead of the
// canonical #N. Fix keys `set` on the task's own _origin (node,id it was ADDED under),
// stamped by foldTasks on every fold — so any node closing #N resolves to the same
// canonical task regardless of its own numbering history. HUBD_NODE is fixed to
// 'cowork' for this whole file (set before core.mjs was imported, top of file).
const originRoot = mktmp();
core.setHubBase(originRoot);
const originTs1 = '2026-01-01 10:00', originTs2 = '2026-01-01 10:01';
fs.writeFileSync(path.join(originRoot, 'tasks.peer.events.jsonl'),
  JSON.stringify({ ts: originTs1, node: 'peer', ev: 'add', id: 7, t: { id: 7, project: 'x', text: 'peer task', status: 'open' } }) + '\n');
fs.writeFileSync(path.join(originRoot, 'tasks.cowork.events.jsonl'),
  JSON.stringify({ ts: originTs2, node: 'cowork', ev: 'add', id: 7, t: { id: 7, project: 'x', text: 'cowork task', status: 'open' } }) + '\n');
const foldedOrigin = core.foldTasks();
ok(foldedOrigin.tasks.find(t => t.id === 7 && t.text === 'peer task'), 'origin fix: peer keeps canonical id 7 (added first)');
ok(foldedOrigin.tasks.find(t => t.id === 8 && t.text === 'cowork task'), 'origin fix: cowork remapped to 8 on collision (got ' + JSON.stringify(foldedOrigin.tasks.map(t => t.id)) + ')');
core.rebuildTaskCache();   // runTaskUpdate reads via loadTasks() -> must see the fresh fold, not a stale cache
core.runTaskUpdate({ id: 7, status: 'done', by: 'test' });   // "cowork" node closing canonical #7 (peer's task)
const afterOrigin = core.runTaskList({ status: 'all' }).tasks;
ok(afterOrigin.find(t => t.id === 7).status === 'done', 'origin fix: closing #7 marks the CANONICAL (peer) task done');
ok(afterOrigin.find(t => t.id === 8).status === 'open', 'origin fix: cowork\'s own remapped task #8 is untouched — the historical mis-close this fix prevents');
fs.rmSync(originRoot, { recursive: true, force: true });

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
