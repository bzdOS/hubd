// test_logic.mjs — regression tests for the logical bugs fixed in the bug-hunt pass.
// Run: node tests/test_logic.mjs   (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
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
  'HYPO: acme in fundraising',
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
ok(/## Facts & hypotheses[\s\S]*hypothesis: acme in fundraising/.test(rc), 'report: HYPO → hypothesis');
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

// ── task #194: node-scoped ids eliminate cross-node collision AT MINT TIME ──
// (root-cause fix; #191's origin-keying stays as a symptom-patch for legacy
// bare-numeric ids, which are left completely alone here.)
const idRoot1 = mktmp();
core.setHubBase(idRoot1);
fs.writeFileSync(path.join(idRoot1, 'tasks.planck.events.jsonl'),
  JSON.stringify({ ts: '2026-01-01 09:00', node: 'planck', ev: 'add', id: 'planck-1', t: { id: 'planck-1', project: 'x', text: 'planck task A', status: 'open' } }) + '\n' +
  JSON.stringify({ ts: '2026-01-01 09:01', node: 'planck', ev: 'add', id: 'planck-2', t: { id: 'planck-2', project: 'x', text: 'planck task B', status: 'open' } }) + '\n');
const addA = core.runTaskAdd({ project: 'x', text: 'cowork task A', by: 'test' });
const addB = core.runTaskAdd({ project: 'x', text: 'cowork task B', by: 'test' });
ok(addA.task.id === 'cowork-1', `id-fix: first local add is node-scoped cowork-1 (got ${addA.task.id})`);
ok(addB.task.id === 'cowork-2', `id-fix: second local add increments to cowork-2 (got ${addB.task.id})`);
const foldedIds = core.foldTasks().tasks.map(t => t.id);
ok(new Set(foldedIds).size === foldedIds.length, `id-fix: no collisions even though both nodes started counting from 1 independently (ids: ${JSON.stringify(foldedIds)})`);
ok(foldedIds.includes('planck-1') && foldedIds.includes('planck-2'), 'id-fix: the offline peer\'s tasks are untouched, no remap needed');

const repDone = core.runReport({ project: 'x', by: 'test', text: `DONE: ${addA.task.id}` });
ok(repDone.done.includes(addA.task.id), `id-fix: report DONE: accepts a node-scoped id, not just parseInt-able numbers (got ${JSON.stringify(repDone.done)})`);
ok(core.runTaskList({ project: 'x', status: 'all' }).tasks.find(t => t.id === addA.task.id).status === 'done', 'id-fix: the node-scoped task is actually closed');

fs.writeFileSync(path.join(idRoot1, 'tasks.legacy.events.jsonl'),
  JSON.stringify({ ts: '2020-01-01 00:00', node: 'legacy', ev: 'add', id: 500, t: { id: 500, project: 'x', text: 'old numeric task', status: 'open' } }) + '\n');
core.runTaskUpdate({ id: 500, status: 'done', by: 'test' });
ok(core.runTaskList({ project: 'x', status: 'all' }).tasks.find(t => t.id === 500).status === 'done', 'id-fix: legacy bare-numeric ids still resolve end-to-end (backward compatible)');

const dependent = core.runTaskAdd({ project: 'x', text: 'blocked on cowork-2', by: 'test', depends_on: [addB.task.id] });
const kanban1 = core.runKanban();
const depRow1 = [...kanban1.queued, ...kanban1.inProgress].find(t => t.id === dependent.task.id);
ok(depRow1 && depRow1.blocked === true, `id-fix: depends_on a node-scoped id correctly flags blocked (got ${JSON.stringify(depRow1)})`);
core.runTaskUpdate({ id: addB.task.id, status: 'done', by: 'test' });
const kanban2 = core.runKanban();
const depRow2 = [...kanban2.queued, ...kanban2.inProgress].find(t => t.id === dependent.task.id);
ok(depRow2 && depRow2.blocked === false, 'id-fix: unblocks once the node-scoped dependency closes');
fs.rmSync(idRoot1, { recursive: true, force: true });
// ── errors must name what the caller got wrong ────────────────────────────────
// Each of these fired against the real hub and told the caller nothing actionable.
const TE = mktmp();
core.setHubBase(TE);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const mSyncNone = threw(() => core.runSync({ agent: 't' }));
ok(/path required/.test(mSyncNone || ''), `sync: omitted path says so, not "does not exist: undefined" (got ${mSyncNone})`);
const mSyncBad = threw(() => core.runSync({ path: path.join(TE, 'nope'), agent: 't' }));
ok(/does not exist/.test(mSyncBad || ''), `sync: a real-but-absent path still reports non-existence (got ${mSyncBad})`);

const mClaim = threw(() => core.runClaim({ project: 'p', agent: 'a' }));
ok(/area/.test(mClaim || '') && !/project/.test((mClaim || '').split('(')[0]),
  `claim: names only the missing field (got ${mClaim})`);

const mUpd = threw(() => core.runTaskUpdate({ status: 'done' }));
ok(/id required/.test(mUpd || ''), `task update: omitted id says so, not "no task #undefined" (got ${mUpd})`);
fs.rmSync(TE, { recursive: true, force: true });

// The queue long-poll default must stay under a typical MCP client's own tool-call
// timeout: every recorded call above ~60s was aborted by the client, and the old
// default of 170 was never usable. Guard the schema and the implementation together
// so the advertised number and the applied number cannot drift apart.
const idxSrc = fs.readFileSync(path.join(REPO, 'hub/index.mjs'), 'utf8');
ok(!/a\.timeout \|\| 170/.test(idxSrc), 'queue wait: implementation no longer defaults to the unusable 170s');
ok((idxSrc.match(/a\.timeout \|\| 45/g) || []).length === 2, 'queue wait: both wait tools default to 45s');
ok(!/default 170/.test(idxSrc), 'queue wait: schema no longer advertises 170s');

// importance was settable at add and then frozen: hub_task_update declared no such
// property and runTaskUpdate applied only status/text/deadline/cat/assignee, so the
// call returned ok and changed nothing.
const TI = mktmp();
core.setHubBase(TI);
const tImp = core.runTaskAdd({ project: 'p', text: 'reprioritise me', importance: 'normal', by: 't' });
ok(tImp.task.importance === 'normal', 'task add: importance recorded');
const upImp = core.runTaskUpdate({ id: tImp.task.id, importance: 'high', by: 't' });
ok(upImp.task.importance === 'high', `task update: importance is editable (got ${upImp.task.importance})`);
ok(core.runTaskList({ project: 'p', status: 'all' }).tasks[0].importance === 'high',
  'task update: the new importance survives the fold, not just the return value');
fs.rmSync(TI, { recursive: true, force: true });
// ── git diff metrics: "nothing new" must not be reported as movement ──────────
// Bug: an empty `hashAt..HEAD` range fell into the same fallback as "no prior
// sync", which substituted the last 10 commits — so a sync with zero new commits
// reported "since last sync: 10 commit(s)". sinceLastSync now separates
// "answered, and the answer is 0" from "no baseline to answer against".
const GD = mktmp();
core.setHubBase(mktmp());   // runSync below writes a card; give it a live hub base
// Commit dates are pinned and a minute apart: the baseline is a 1-second-resolution
// timestamp, so same-second commits would be indistinguishable from the baseline.
const gitc = (args, date) => execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`,
  { cwd: GD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
gitc('init -q');
fs.writeFileSync(path.join(GD, 'a.txt'), 'one\n');
gitc('add -A'); gitc('commit -qm first', '2026-01-01T10:00:00+0000');
const firstTs = gitc('log -1 --format=%ci').trim();
fs.writeFileSync(path.join(GD, 'a.txt'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(GD, 'b.txt'), 'new file\n');
gitc('add -A'); gitc('commit -qm second', '2026-01-01T10:01:00+0000');
const headTs = gitc('log -1 --format=%ci').trim();

const dNone = core.gitDiffSummary(GD, headTs);
ok(dNone.sinceLastSync === true, 'gitDiffSummary: HEAD as baseline is a real baseline');
ok(dNone.newCommits === 0, `gitDiffSummary: nothing new → 0 commits, not the last-10 fallback (got ${dNone.newCommits})`);
ok(dNone.commitLog.length === 0, `gitDiffSummary: nothing new → empty commitLog (got ${dNone.commitLog.length})`);

const dSome = core.gitDiffSummary(GD, firstTs);
ok(dSome.sinceLastSync === true && dSome.newCommits === 1, `gitDiffSummary: one commit since baseline (got ${dSome.newCommits})`);
ok(dSome.insertions === 3 && dSome.deletions === 0 && dSome.filesChanged === 2,
  `gitDiffSummary: shortstat parsed (+${dSome.insertions}/-${dSome.deletions}, ${dSome.filesChanged} files)`);

const dNoBase = core.gitDiffSummary(GD, null);
ok(dNoBase.sinceLastSync === false && dNoBase.newCommits === 0,
  'gitDiffSummary: no baseline → sinceLastSync false and 0 new commits');
ok(dNoBase.commitLog.length === 2, `gitDiffSummary: no baseline → recent commits as context (got ${dNoBase.commitLog.length})`);

// The baseline comes out of a user-editable card and is interpolated into a
// shell command: anything not shaped like git's %ci is refused, not run.
const pwned = path.join(GD, 'PWNED');
const dEvil = core.gitDiffSummary(GD, `x"; touch ${pwned}; #`);
ok(dEvil.sinceLastSync === false, 'gitDiffSummary: malformed baseline is refused, not trusted');
ok(!fs.existsSync(pwned), 'gitDiffSummary: malformed baseline does not reach the shell');
ok(core.gitDiffSummary(mktmp(), null) === null, 'gitDiffSummary: non-git dir → null');

// runSync must not claim movement on a re-sync with no new commits.
const syncCard = core.runSync({ path: GD, name: 'difftest', agent: 't', digest: 'first pass' });
ok(syncCard.newCommits === 0, 'runSync: first sync of an unseen project claims no new commits');
const resync = core.runSync({ path: GD, name: 'difftest', agent: 't', digest: 'second pass' });
ok(resync.newCommits === 0, `runSync: re-sync with no new commits reports 0 (got ${resync.newCommits})`);
ok(!/- since last sync:/.test(fs.readFileSync(syncCard.card, 'utf8')),
  'runSync: card omits the "since last sync" line when nothing moved');

// Bug: runSync read the baseline back with /- last commit: /, but it writes that
// value as "· last commit: " on the branch line — so the baseline never parsed and
// the diff was always the no-baseline fallback. Real movement must be detected.
fs.writeFileSync(path.join(GD, 'a.txt'), 'one\ntwo\nthree\nfour\n');
gitc('add -A'); gitc('commit -qm third', '2026-01-01T10:05:00+0000');
const moved = core.runSync({ path: GD, name: 'difftest', agent: 't', digest: 'third pass' });
ok(moved.newCommits === 1, `runSync: detects the commit made since the previous sync (got ${moved.newCommits})`);
const movedCard = fs.readFileSync(moved.card, 'utf8');
ok(/- since last sync: 1 commit\(s\), 1 file\(s\), \+1\/-0 lines/.test(movedCard),
  'runSync: card reports the real diff since last sync');

// projectMetrics reads the version out of package.json.
fs.writeFileSync(path.join(GD, 'package.json'), JSON.stringify({ name: 'difftest', version: '9.9.9' }));
const pm = core.projectMetrics(GD);
ok(pm && pm.version === '9.9.9', `projectMetrics: version from package.json (got ${pm && pm.version})`);
ok(core.projectMetrics(mktmp()) === null, 'projectMetrics: nothing detectable → null');
fs.rmSync(GD, { recursive: true, force: true });

// ── a cursor belongs to a subscriber, not to the node ─────────────────────────
// Bug: the offset lived at .qstate/<file>.offset, one per queue file shared by the
// whole node. Several sessions subscribing to one role therefore consumed from one
// cursor — whoever polled first took the message and the rest never saw it. That is
// right for competing workers and wrong for subscribers.
const { queueSend: qSend, queueWait: qWait } = await import(path.join(REPO, 'hub/lib/queue.mjs'));
const { sessionId, resetSessionId } = await import(path.join(REPO, 'hub/lib/session.mjs'));
const QR = mktmp();
fs.mkdirSync(path.join(QR, 'queues'), { recursive: true });
// Fan-out is a property of the ROLE, declared once — not something the transport turns
// on because the caller happens to be a long-lived server. Undeclared roles stay
// competing-worker queues, which is what task dispatch relies on.
fs.writeFileSync(path.join(QR, 'subscriber-roles.json'), JSON.stringify(['fanout']));
qSend('fanout', 'one message for everybody', { from: 'test', root: QR });

const subA = await qWait('fanout', { timeout: 1, root: QR, subscriber: 'sess-a' });
const subB = await qWait('fanout', { timeout: 1, root: QR, subscriber: 'sess-b' });
ok(subA.changed && /one message for everybody/.test(subA.text), 'cursor: first subscriber receives the message');
ok(subB.changed && /one message for everybody/.test(subB.text),
  `cursor: SECOND subscriber receives the same message (fan-out, got changed=${subB.changed})`);
const subAagain = await qWait('fanout', { timeout: 1, root: QR, subscriber: 'sess-a' });
ok(!subAagain.changed, 'cursor: a subscriber does not re-read what it already consumed');
ok(fs.existsSync(path.join(QR, '.qstate', 'sess-a')) && fs.existsSync(path.join(QR, '.qstate', 'sess-b')),
  'cursor: each subscriber gets its own .qstate namespace');

// An UNDECLARED role keeps at-most-once delivery even for two identified subscribers:
// otherwise every work queue silently became a broadcast the moment the caller was a
// long-lived MCP server, and two sessions would both do the task and both claim it.
qSend('worker', 'exactly one of you takes this', { from: 'test', root: QR });
const wk1 = await qWait('worker', { timeout: 1, root: QR, subscriber: 'sess-a' });
const wk2 = await qWait('worker', { timeout: 1, root: QR, subscriber: 'sess-b' });
ok(wk1.changed && !wk2.changed,
  `cursor: an undeclared role stays competing-worker even with subscribers (${wk1.changed}/${wk2.changed})`);
const strayWorker = fs.readdirSync(path.join(QR, '.qstate', 'sess-a')).filter(f => f.startsWith('worker.'));
ok(strayWorker.length === 0,
  `cursor: an undeclared role writes no per-subscriber offset (found ${strayWorker.join(',') || 'none'})`);

// No subscriber → the shared per-node cursor, i.e. today's behaviour untouched.
qSend('shared', 'for whoever gets there first', { from: 'test', root: QR });
const sh1 = await qWait('shared', { timeout: 1, root: QR });
const sh2 = await qWait('shared', { timeout: 1, root: QR });
ok(sh1.changed && !sh2.changed, `cursor: without a subscriber the node cursor is still shared (${sh1.changed}/${sh2.changed})`);
const sharedOffsets = fs.readdirSync(path.join(QR, '.qstate')).filter(f => f.startsWith('shared.') && f.endsWith('.offset'));
ok(sharedOffsets.length === 1,
  `cursor: shared offset stays a plain file in .qstate, so existing offsets keep working (found ${sharedOffsets.join(',') || 'none'})`);
fs.rmSync(QR, { recursive: true, force: true });

// A fanout role's depth is per-reader: subscribers advance their own cursors, nothing
// ever advances the shared one peekQueueDepth reads — so a byte count from it is a
// phantom backlog that only grows, and a fanout OWNER role would show "buttons
// waiting" forever. The brief must report the role as fanout, not a wrong number.
const FB = mktmp();
core.setHubBase(FB);
fs.mkdirSync(path.join(FB, 'queues'), { recursive: true });
fs.writeFileSync(path.join(FB, 'subscriber-roles.json'), JSON.stringify(['announce']));
fs.writeFileSync(path.join(FB, 'owner-roles.json'), JSON.stringify(['announce']));
qSend('announce', 'to everybody', { from: 'test', root: FB });
await qWait('announce', { timeout: 1, root: FB, subscriber: 'sess-a' });   // fully consumed by a subscriber
core.runHeartbeat({ agent: 'agent-a', role: 'announce' });
const fbRows = queueLib.queueSummaryForBrief({ root: FB });
const fbRow = fbRows.find(r => r.role === 'announce');
ok(fbRow && fbRow.fanout === true && fbRow.pending === null,
  `brief: a declared fanout role reports fanout:true, pending:null — not the shared cursor's phantom count (got ${JSON.stringify(fbRow)})`);
ok(queueLib.buttonsSummary(fbRows).count === 0,
  'brief: a fanout owner role never counts as buttons waiting — that count could never clear');
fs.rmSync(FB, { recursive: true, force: true });

// Delivery advances the cursor under a lock: two competing waiters seeing the same
// bytes in one poll window would otherwise both deliver them — "exactly one reader"
// held by timing luck. A held lock is a skip for this poll, never a failed wait.
const LK = mktmp();
fs.mkdirSync(path.join(LK, 'queues'), { recursive: true });
qSend('locked', 'contended message', { from: 'test', root: LK });
fs.mkdirSync(path.join(LK, '.qstate'), { recursive: true });
// core.JOURNAL_NODE, not a second copy of the hostname formula: queue filenames follow the
// SAME node identity as the journal and the task log (HUBD_NODE included), and this test
// duplicating the old formula is exactly how the two drifted apart in the first place.
const lkNode = core.JOURNAL_NODE;
const lkLock = path.join(LK, '.qstate', `locked.${lkNode}.queue.md.offset.lock`);
fs.writeFileSync(lkLock, '');   // someone else is mid-drain on this cursor
const lkBlocked = await qWait('locked', { timeout: 1, root: LK });
ok(lkBlocked.changed === false,
  `queue: a held cursor lock skips the poll instead of double-delivering or throwing (got ${JSON.stringify(lkBlocked)})`);
fs.unlinkSync(lkLock);
const lkAfter = await qWait('locked', { timeout: 3, root: LK });
ok(lkAfter.changed === true && /contended message/.test(lkAfter.text),
  'queue: releasing the lock delivers on the next poll — nothing was lost');
fs.rmSync(LK, { recursive: true, force: true });

// peekQueueDepth must count block HEADERS (the full "## <ts> · from" shape queueSend
// writes), not any line that starts with a timestamp heading: a message quoting a log
// line or a dated heading used to inflate the pending count. (A body replicating a
// FULL header verbatim stays indistinguishable — inherent to the flat format.)
const PK = mktmp();
fs.mkdirSync(path.join(PK, 'queues'), { recursive: true });
qSend('quoted', 'see my note from\n## 2026-01-01 00:00\nthat dated heading above', { from: 'test', root: PK });
ok(queueLib.peekQueueDepth('quoted', { root: PK }).pending === 1,
  `peek: a dated heading inside a message body is not a second message (got ${queueLib.peekQueueDepth('quoted', { root: PK }).pending})`);
fs.rmSync(PK, { recursive: true, force: true });

// DONE with an id that matches nothing used to vanish silently — the task stayed open
// and nothing said so (the protocol's DONE rule warns exactly about batch-copied ids).
const DM = mktmp();
core.setHubBase(DM);
const dmT = core.runTaskAdd({ project: 'p', text: 'real work', by: 'test' });
const dmR = core.runReport({ project: 'p', by: 'test', text: `DONE: ${dmT.task.id}, nope-99` });
ok(dmR.done.length === 1 && String(dmR.done[0]) === String(dmT.task.id),
  `report: the real id still closes (got ${JSON.stringify(dmR.done)})`);
ok(JSON.stringify(dmR.doneMissed) === JSON.stringify(['nope-99']),
  `report: an id that matches no task comes back as doneMissed, not swallowed (got ${JSON.stringify(dmR.doneMissed)})`);
ok(core.runTaskList({ status: 'all' }).tasks.find(t => t.id === dmT.task.id).status === 'done',
  'report: the miss does not block the hit');
fs.rmSync(DM, { recursive: true, force: true });

// A card made by hub_card_set has `- set:`, not `- synced:` — it used to show '?' in
// status and could never go stale in the brief, however long abandoned.
const SC = mktmp();
core.setHubBase(SC);
core.runCardSet({ project: 'harvested', digest: 'captured from a dialog', by: 'test' });
const scRow = core.runStatus().projects.find(p => p.project === 'harvested');
ok(scRow && /^\d{4}-/.test(scRow.synced), `status: a card-set card shows its set time, not '?' (got ${scRow && scRow.synced})`);
fs.writeFileSync(path.join(SC, 'projects', 'oldset.md'),
  '# oldset\n\n- slug: oldset\n- set: 2020-01-01 00:00 by test\n\n## Digest\n\nlong abandoned\n');
ok(core.runBrief({}).staleCards.some(c => c.project === 'oldset'),
  'brief: a card-set card goes stale by its set time');
fs.rmSync(SC, { recursive: true, force: true });

// sessionId must never depend on the model: explicit env wins, else the parent process
// (stable across a server respawn), else null so the caller keeps the node cursor.
const prevSess = process.env.HUBD_SESSION;
process.env.HUBD_SESSION = 'My Session/42';
resetSessionId();
ok(sessionId() === 's-my-session-42', `sessionId: HUBD_SESSION wins and is slugified (got ${sessionId()})`);
delete process.env.HUBD_SESSION;
resetSessionId();
const derived = sessionId();
ok(new RegExp(`^p-${process.ppid}(-.+)?$`).test(derived),
  `sessionId: falls back to the parent process (got ${derived})`);
// pids are recycled, so the pid alone is not an identity: a new client landing on a
// dead session's pid would inherit its cursor and resume at its offset, skipping every
// message in between. The parent's start time distinguishes them. Absent on a platform
// that exposes neither procfs nor ps — then the bare pid is the documented fallback.
ok(derived !== 'p-' + process.ppid,
  `sessionId: the parent's start time is part of the id, so a recycled pid gets a fresh cursor (got ${derived})`);
if (prevSess === undefined) delete process.env.HUBD_SESSION; else process.env.HUBD_SESSION = prevSess;
resetSessionId();

// whatsnew's checkpoint must key on the session, not on the agent label: the label
// names the function being performed and several functions share one trajectory, so
// keying on it made a relabelled caller lose its checkpoint and re-read everything.
const WN = mktmp();
core.setHubBase(WN);
core.journalAppend({ ts: core.now(), project: 'p', agent: 'dev', kind: 'note', text: 'first entry' });
const wn1 = core.runWhatsNew({ agent: 'dev', session: 'sess-x' });
ok(wn1.firstCheckin === true, 'whatsnew: first call for a session has no checkpoint');
const wn2 = core.runWhatsNew({ agent: 'reviewer', session: 'sess-x' });
ok(wn2.firstCheckin === false,
  `whatsnew: the SAME session under a new agent label keeps its checkpoint (got firstCheckin=${wn2.firstCheckin})`);
const wn3 = core.runWhatsNew({ agent: 'dev', session: 'sess-y' });
ok(wn3.firstCheckin === true, 'whatsnew: a different session gets its own checkpoint');
const wn4 = core.runWhatsNew({ agent: 'solo' });
ok(wn4.firstCheckin === true, 'whatsnew: with no session the agent label is still the key (CLI path unchanged)');
fs.rmSync(WN, { recursive: true, force: true });

// gc must reach BOTH places a subscriber cursor lives. A fleet tap's cursor sits under
// .qstate/__watchall__/<subscriber>/, so skipping that dir exempted the busiest kind
// from the sweep entirely — while a live-but-idle cursor must survive, or the session
// silently resumes at the tail.
const GC = mktmp();
const monthOld = new Date(Date.now() - 30 * 86400000);
for (const p of [['role-sub'], ['__watchall__', 'tap-sub'], ['fresh-sub']]) {
  const d = path.join(GC, '.qstate', ...p);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'x.queue.md.offset');
  fs.writeFileSync(f, '0');
  if (p[p.length - 1] !== 'fresh-sub') fs.utimesSync(f, monthOld, monthOld);
}
fs.writeFileSync(path.join(GC, '.qstate', 'shared.queue.md.offset'), '0');   // a shared cursor, must survive
const gcOut = run('gc', { HUBD_DIR: GC, HUBD_TEAM_DIR: GC });
ok(!fs.existsSync(path.join(GC, '.qstate', 'role-sub')), 'gc: sweeps a stale role-subscriber cursor');
ok(!fs.existsSync(path.join(GC, '.qstate', '__watchall__', 'tap-sub')),
  `gc: sweeps a stale fleet-tap cursor under __watchall__ too (out=${gcOut.out.trim().split('\n').pop()})`);
ok(fs.existsSync(path.join(GC, '.qstate', 'fresh-sub')), 'gc: leaves a recently-used cursor alone');
ok(fs.existsSync(path.join(GC, '.qstate', 'shared.queue.md.offset')), 'gc: never touches a shared cursor file');
fs.rmSync(GC, { recursive: true, force: true });
// ── a write must say who did it ────────────────────────────────────────────────
// The journal is append-only, so an unattributed write stays unattributable. The
// field was optional on exactly the tools that produced 173 'unknown' entries out of
// 1193, while the tools that already require it have 6 clean names out of 6.
const AU = mktmp();
core.setHubBase(AU);
const throwsA = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const noAuthor = throwsA(() => core.runTaskAdd({ project: 'p', text: 'x' }));
ok(/by required/.test(noAuthor || ''), `author: an omitted author is refused, not defaulted (got ${noAuthor})`);
ok(!/unknown/.test(noAuthor || ''), 'author: the error does not offer "unknown" as a way out');

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
ok(/from required/.test(throwsA(() => qSend('r', 'x', { root: AU })) || ''), 'author: queue send requires a sender');
ok(/names a model, a client or a placeholder/.test(throwsA(() => qSend('r', 'x', { from: 'mcp', root: AU })) || ''),
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
ok(flA && /^dev-hubd-/.test(flA.task.by), `floor: an omitted author becomes HUBD_AGENT, not an error (got ${flA && flA.task.by})`);
ok(flA && flB && flA.task.by !== flB.task.by,
  `floor: two sessions under one HUBD_AGENT are DIFFERENT authors (${flA && flA.task.by} vs ${flB && flB.task.by})`);
ok(floorCall('one', { project: 'p', text: 'again' }).task.by === flA.task.by,
  'floor: the same session keeps one author across calls');
// The consequence that matters: the soft lock still detects a second holder.
ok(floorCall('one', { project: 'p', area: 'shared' }, 'hub_claim').warning === undefined,
  'floor: first claim on an area is clean');
ok(/already claimed by/.test(floorCall('two', { project: 'p', area: 'shared' }, 'hub_claim').warning || ''),
  'floor: a second session claiming the same area IS warned — the lock still locks');
// An explicit author is never rewritten by the floor.
ok(floorCall('one', { project: 'p', text: 'mine', by: 'reviewer-hubd' }).task.by === 'reviewer-hubd',
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
fs.rmSync(FL, { recursive: true, force: true });

// ── environment checks: an upgrade can need something OUTSIDE the code ─────────
// Nothing used to say so, so an agent found out by having a call rejected, or never.
const EV = mktmp();
core.setHubBase(EV);
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
await qWait('busy', { timeout: 1, root: QC, subscriber: 'sess-a' });
ok(has(core.envChecks(), 'queue-fanout-undeclared'),
  'envChecks: two waiters on one cursor become an actionable item, not a stderr line nobody sees');
fs.writeFileSync(path.join(QC, 'subscriber-roles.json'), JSON.stringify(['busy']));
await qWait('busy', { timeout: 1, root: QC, subscriber: 'sess-a' });
ok(!has(core.envChecks(), 'queue-fanout-undeclared'),
  'envChecks: declaring the role clears it — no acknowledgement needed, the condition is gone');
fs.rmSync(QC, { recursive: true, force: true });

// gc sweeps session records by the same rule as cursor dirs.
const stG = JSON.parse(fs.readFileSync(esf, 'utf8'));
stG.sessions = { fresh: { protocolAcked: '9.9.9', at: new Date().toISOString() },
                 old: { protocolAcked: '9.9.9', at: new Date(Date.now() - 30 * 86400000).toISOString() } };
fs.writeFileSync(esf, JSON.stringify(stG, null, 1));
run('gc', { HUBD_DIR: EV, HUBD_TEAM_DIR: EV });
const stAfter = JSON.parse(fs.readFileSync(esf, 'utf8'));
ok(!stAfter.sessions.old && !!stAfter.sessions.fresh,
  `gc: sweeps a stale session record and keeps a fresh one (left ${Object.keys(stAfter.sessions)})`);

// ── over HTTP the floor and the session id describe the SERVER, not the caller ──
// One process serves many agents (or tenants): HUBD_AGENT is the server owner's env,
// and the process-derived session id is the server's own — one author and one whatsnew
// checkpoint for the whole team. Driven over the real HTTP transport.
const HT = mktmp();
const httpPort = 18700 + (process.pid % 200);
const srv = spawn('node', [path.join(REPO, 'hub/index.mjs'), '--http', String(httpPort)], {
  env: { ...process.env, HUBD_DIR: HT, HUBD_TEAM_DIR: HT, HUBD_TOKEN: 'secret-token-0123456789', HUBD_AGENT: 'dev-hubd' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
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
const htNew = await httpCall('hub_whatsnew', { agent: 'remote-dev' });
ok(htNew.isError === false && !/author-floor/.test(htNew.content[0].text),
  'http: whatsnew does not report the server\'s own HUBD_AGENT state to a remote caller');
const htNewB = await httpCall('hub_whatsnew', { agent: 'remote-reviewer' });
ok(/"firstCheckin": true/.test(htNewB.content[0].text),
  'http: whatsnew checkpoints are per caller, not one per server process');
srv.kill();
fs.rmSync(HT, { recursive: true, force: true });

if (prevFloorEnv === undefined) delete process.env.HUBD_AGENT; else process.env.HUBD_AGENT = prevFloorEnv;
fs.rmSync(EV, { recursive: true, force: true });
core.setHubBase(T0);

// ── the digest ends at the next heading, not at a literal "## Facts" ──
// A localised hub (sections.json) or any card whose next section simply is not "Facts"
// used to report its whole body as the digest — in hub_status, in hub_context, and as the
// baseline runSync compares against (so every sync "changed" the digest and archived the
// entire card into history).
const DG = mktmp();
core.setHubBase(DG);
fs.writeFileSync(path.join(DG, 'projects', 'loc.md'),
  '# loc\n\n- slug: loc\n- set: 2026-07-01 10:00 by dev-t\n\n## Digest\n\nthe one-line digest\n\n## Next step\n\n- do the thing\n\n## Gates\n\n- kill if X\n');
ok(core.digestOf(fs.readFileSync(path.join(DG, 'projects', 'loc.md'), 'utf8')) === 'the one-line digest',
  'digest: cut at the next ## heading, not at the word Facts');
const dgStatus = core.runStatus().projects.find(p => p.project === 'loc');
ok(dgStatus && dgStatus.digest === 'the one-line digest',
  `status: reports the digest, not the whole card (got ${JSON.stringify((dgStatus || {}).digest || '').slice(0, 60)})`);
ok(core.digestOf('# x\n\nno digest section here\n') === null, 'digest: a card without ## Digest yields null');

// ── a card that trails its own journal is flagged, a quiet project is not ──
const ymd = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(DG, 'projects', 'busy.md'), `# busy\n\n- slug: busy\n- set: ${ymd(40)} by dev-t\n\n## Digest\n\nold news\n`);
fs.writeFileSync(path.join(DG, 'projects', 'quiet.md'), `# quiet\n\n- slug: quiet\n- set: ${ymd(40)} by dev-t\n\n## Digest\n\nstill true\n`);
fs.writeFileSync(path.join(DG, 'journal.t.jsonl'),
  JSON.stringify({ ts: ymd(1), project: 'busy', agent: 'dev-t', kind: 'note', text: 'work kept happening' }) + '\n' +
  JSON.stringify({ ts: ymd(41), project: 'quiet', agent: 'dev-t', kind: 'note', text: 'last thing that ever happened' }) + '\n');
const lagged = core.runStatus().projects.find(p => p.project === 'busy');
const calm = core.runStatus().projects.find(p => p.project === 'quiet');
ok(lagged && lagged.digestStale && lagged.digestStale.daysBehind >= 38,
  `staleness: a card 39d behind its own journal is flagged (got ${JSON.stringify((lagged || {}).digestStale)})`);
ok(calm && !calm.digestStale, 'staleness: a dormant project whose journal stopped first is NOT flagged');
ok(core.runBrief().staleDigests.some(s => s.project === 'busy'), 'staleness: brief lists it under staleDigests');

// ── closing a closed task is a no-op, not a second close ──
const ID = mktmp();
core.setHubBase(ID);
const idT = core.runTaskAdd({ project: 'p', text: 'close me twice', by: 'dev-t' }).task;
const close1 = core.runTaskUpdate({ id: idT.id, status: 'done', by: 'dev-t' });
const close2 = core.runTaskUpdate({ id: idT.id, status: 'done', by: 'other-t' });
ok(!close1.noop && close2.noop === 'already-done', 'idempotent done: the second close reports itself as a no-op');
const idEvents = fs.readFileSync(path.join(ID, `tasks.${core.JOURNAL_NODE}.events.jsonl`), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l)).filter(e => e.patch && e.patch.status === 'done');
ok(idEvents.length === 1, `idempotent done: exactly one done event on disk (got ${idEvents.length})`);
ok(core.journalTail('p', 20).some(e => /already closed/.test(e.text)), 'idempotent done: the attempt is still journalled');
const close3 = core.runTaskUpdate({ id: idT.id, status: 'done', assignee: 'zed', by: 'dev-t' });
ok(close3.task.assignee === 'zed' && close3.task.done === close1.task.done,
  'idempotent done: a re-close carrying a real edit applies the edit and keeps the original close time');

// ── cat is a closed vocabulary; anything else survives as a tag ──
ok(core.normalizeCat('technical').cat === 'technical', 'cat: a canonical value passes through');
ok(core.normalizeCat('Chore ').cat === 'chore', 'cat: trimmed and lower-cased');
const offEnum = core.normalizeCat('jail', ['ci']);
ok(offEnum.cat === null && offEnum.tags.join(',') === 'ci,jail', `cat: an off-enum value becomes a tag (got ${JSON.stringify(offEnum)})`);
const catTask = core.runTaskAdd({ project: 'p', text: 'built in a jail', cat: 'jail', by: 'dev-t' }).task;
ok(catTask.cat === null && catTask.tags.includes('jail'), 'cat: task add routes an off-enum cat into tags');
// the migration is append-only: it writes set events, it does not rewrite the legacy log
fs.writeFileSync(path.join(ID, 'tasks.legacy.events.jsonl'),
  JSON.stringify({ ts: '2026-06-01 10:00', node: 'legacy', ev: 'add', id: 'legacy-1', t: { id: 'legacy-1', project: 'p', text: 'old', cat: 'semmarkup', status: 'open' } }) + '\n');
const legacyBefore = fs.readFileSync(path.join(ID, 'tasks.legacy.events.jsonl'), 'utf8');
ok(core.runTaskRetag({}).count === 1, 'retag: dry run finds the off-enum task and changes nothing');
ok(core.runTaskRetag({ apply: true, by: 'dev-t' }).moved === 1, 'retag: apply moves it');
ok(fs.readFileSync(path.join(ID, 'tasks.legacy.events.jsonl'), 'utf8') === legacyBefore,
  'retag: the legacy event log is untouched (append-only contract)');
const retagged = core.runTaskList({ status: 'all' }).tasks.find(t => String(t.id) === 'legacy-1');
ok(retagged.cat === null && retagged.tags.includes('semmarkup'), 'retag: the old category survives as a tag');

// ── paging beats a silent cap ──
for (let i = 0; i < 5; i++) core.runTaskAdd({ project: 'many', text: 'task ' + i, by: 'dev-t' });
const page = core.runTaskList({ project: 'many', limit: 2, offset: 1 });
ok(page.count === 2 && page.total === 5 && page.offset === 1,
  `task list: a page reports its own size AND the full total (got ${JSON.stringify({ c: page.count, t: page.total })})`);

// ── ghost queues: never consumed, never deleted ──
const QG = mktmp();
fs.mkdirSync(path.join(QG, 'queues'), { recursive: true });
fs.mkdirSync(path.join(QG, '.qstate'), { recursive: true });
fs.writeFileSync(path.join(QG, 'owner-roles.json'), '["boss"]');
const oldMsg = '\n## 2026-01-02 10:00 · from alice\nancient\n';
fs.writeFileSync(path.join(QG, 'queues', 'ghost.n1.queue.md'), oldMsg);
fs.writeFileSync(path.join(QG, 'queues', 'live.n1.queue.md'), oldMsg);
fs.writeFileSync(path.join(QG, '.qstate', 'live.n1.queue.md.offset'), '0');   // a registered consumer that has not drained yet
fs.writeFileSync(path.join(QG, 'queues', 'boss.n1.queue.md'), oldMsg);
fs.mkdirSync(path.join(QG, '.qstate', '__watchall__'), { recursive: true });
fs.writeFileSync(path.join(QG, '.qstate', '__watchall__', 'tapped.n1.queue.md.offset'), '5');
fs.writeFileSync(path.join(QG, 'queues', 'tapped.n1.queue.md'), oldMsg);
const q = await import(path.join(REPO, 'hub/lib/queue.mjs'));
core.setHubBase(QG);   // ownerRoles() reads HUB
const inv = q.queueInventory({ root: QG, days: 30 });
const byFile = Object.fromEntries(inv.map(x => [x.file, x]));
ok(byFile['ghost.n1.queue.md'].ghost === true, 'queue gc: a never-consumed old queue is a ghost');
ok(byFile['live.n1.queue.md'].ghost === false, 'queue gc: a queue with a cursor is spared');
ok(byFile['boss.n1.queue.md'].ghost === false, 'queue gc: a human owner queue is spared (a person reads it as a file)');
ok(byFile['tapped.n1.queue.md'].ghost === true, 'queue gc: a __watchall__ tap does not count as having consumed it');
const gcDry = q.runQueueGc({ root: QG, days: 30 });
ok(gcDry.apply === false && fs.existsSync(path.join(QG, 'queues', 'ghost.n1.queue.md')),
  'queue gc: the dry run moves nothing');
const gcRun = q.runQueueGc({ root: QG, days: 30, apply: true });
ok(gcRun.moved.length === 2 && !fs.existsSync(path.join(QG, 'queues', 'ghost.n1.queue.md')),
  `queue gc: apply archives the ghosts (moved ${gcRun.moved.length})`);
ok(fs.readFileSync(path.join(QG, 'queues', 'archive', 'ghost.n1.queue.md'), 'utf8') === oldMsg,
  'queue gc: archived content is byte-identical — moved, never deleted');
ok(fs.existsSync(path.join(QG, 'queues', 'live.n1.queue.md')) && fs.existsSync(path.join(QG, 'queues', 'boss.n1.queue.md')),
  'queue gc: live and owner queues stay put');
ok(q.queueSummaryForBrief({ root: QG }).find(r => r.role === 'live').neverRead === false,
  'brief: a consumed role is not flagged never-read');

// ── output budgets ──
const bigPayload = { journal: Array.from({ length: 200 }, (_, i) => ({ ts: '2026-07-01 10:00', text: 'x'.repeat(200) + i })),
              tasks: Array.from({ length: 80 }, (_, i) => ({ id: i, text: 'y'.repeat(100) })) };
const plan = [['journal', 30], ['tasks', 40]];
const capped = core.capOutput(bigPayload, plan, { maxChars: 20000 });
ok(capped.journal.length <= 30 && capped.tasks.length <= 40, 'budget: per-key top-N applies');
ok(JSON.stringify(capped, null, 1).length <= 20000,
  `budget: the payload really fits, measured the way the transport serialises it (got ${JSON.stringify(capped, null, 1).length})`);
ok(capped.truncated.journal.hidden === 200 - capped.journal.length && /hidden/.test(capped.hint),
  'budget: what was hidden is stated, never silently dropped');
// Order matters only once the governor actually has to cut: squeeze hard enough that the
// per-key top-N alone cannot fit the payload, then the journal must give way before the tasks.
const squeezed = core.capOutput(bigPayload, plan, { maxChars: 8000 });
ok(squeezed.journal.length < 30 && squeezed.tasks.length === 40,
  `budget: under pressure the journal gives way first and the tasks stay whole (journal ${squeezed.journal.length}, tasks ${squeezed.tasks.length})`);
ok(core.capOutput(bigPayload, plan, { maxChars: 20000, full: true }).journal.length === 200,
  'budget: full:true returns everything');
const tiny = core.capOutput(bigPayload, plan, { maxChars: 2000 });
ok(JSON.stringify(tiny, null, 1).length <= 2000 && tiny.tasks.length >= 1,
  `budget: an impossible budget empties the first list before gutting the last (tasks left ${tiny.tasks.length})`);
ok(core.capOutput({ tasks: [1, 2] }, plan).truncated === undefined, 'budget: a small payload is passed through untouched');

// ── writing one section of a card, without touching the rest ──
const SEC = mktmp();
core.setHubBase(SEC);
core.runCardSet({ project: 'demo', digest: 'the digest', by: 'dev-t' });
const secGates = core.runSectionAdd({ project: 'demo', section: 'gates', text: 'kill if no paying user by 2026-09-01', provenance: 'owner call', by: 'dev-t' });
core.runSectionAdd({ project: 'demo', section: 'metrics', text: '42 signups', by: 'dev-t' });
core.runSectionAdd({ project: 'demo', section: 'metrics', text: '58 signups', by: 'dev-t' });
const secCard = fs.readFileSync(path.join(SEC, 'projects', 'demo.md'), 'utf8');
ok(secGates.created === false, 'section add: a scaffolded section is written, not created anew');
ok(/## Gates\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}: kill if no paying user by 2026-09-01 · src: owner call/.test(secCard),
  'section add: the line is dated and carries its provenance');
ok((secCard.match(/signups/g) || []).length === 2, 'section add: append accumulates instead of replacing');
ok(/## Digest\n\nthe digest/.test(secCard) && /## Market/.test(secCard),
  'section add: the digest and every other section survive verbatim');
const secHand = core.runSectionAdd({ project: 'demo', section: 'Runbook', text: 'restart with make deploy', by: 'dev-t' });
ok(secHand.created === true && /## Runbook\n\n- /.test(fs.readFileSync(path.join(SEC, 'projects', 'demo.md'), 'utf8')),
  'section add: an unknown heading is created and REPORTED as created (a typo must not pass silently)');
core.runSectionAdd({ project: 'demo', section: 'next', text: 'ship 0.7', mode: 'set', by: 'dev-t' });
core.runSectionAdd({ project: 'demo', section: 'next', text: 'ship 0.7.1', mode: 'set', by: 'dev-t' });
const secNext = fs.readFileSync(path.join(SEC, 'projects', 'demo.md'), 'utf8');
ok((secNext.match(/ship 0\.7/g) || []).length === 1 && /ship 0\.7\.1/.test(secNext),
  'section add: mode=set replaces the section body (right for "the one next action")');
let secErr = ''; try { core.runSectionAdd({ project: 'demo', text: 'x', by: 'dev-t' }); } catch (e) { secErr = e.message; }
ok(/section required/.test(secErr) && /gates/.test(secErr), 'section add: a missing section names the vocabulary');

// ── one task by id, and a miss that points somewhere ──
const GT = mktmp();
core.setHubBase(GT);
const gtA = core.runTaskAdd({ project: 'p', text: 'the dependency', by: 'dev-t' }).task;
const gtB = core.runTaskAdd({ project: 'p', text: 'the dependent', depends_on: [gtA.id], by: 'dev-t' }).task;
const got = core.runTaskGet({ id: gtB.id });
ok(got.task.id === gtB.id && got.blockedBy.length === 1 && got.blockedBy[0].id === gtA.id,
  'task get: returns the task and what blocks it');
ok(core.runTaskGet({ id: gtA.id }).blocks[0].id === gtB.id, 'task get: and what it blocks, the other way round');
let gtErr = ''; try { core.runTaskGet({ id: 'no-such-9' }); } catch (e) { gtErr = e.message; }
ok(/hub_search/.test(gtErr), 'task get: a miss points at hub_search instead of dead-ending');
core.runResourceSet({ slug: 'api-core', type: 'service', status: 'planned', by: 'dev-t' });
let getErr = ''; try { core.runGet({ project: 'api-core' }); } catch (e) { getErr = e.message; }
ok(/IS a resource/.test(getErr) && /hub_resource_get/.test(getErr),
  'hub_get: a name that exists in the RESOURCE namespace is named as such, with the tool that reads it');
fs.writeFileSync(path.join(GT, 'projects', 'acme-io.md'), '# acme-io\n\n- slug: acme-io\n\n## Digest\n\nx\n');
let nearErr = ''; try { core.runGet({ project: 'acme' }); } catch (e) { nearErr = e.message; }
ok(/did you mean: acme-io/.test(nearErr), 'hub_get: a near-miss slug is suggested');

// ── closing a task does not silently leave its resources reading "planned" ──
const rhTask = core.runTaskAdd({ project: 'p', text: 'ship it', resources: ['api-core'], by: 'dev-t' }).task;
const rhDone = core.runTaskUpdate({ id: rhTask.id, status: 'done', by: 'dev-t' });
ok(/api-core \(planned\)/.test(rhDone.resourceHint || ''), 'close: a linked resource still marked planned is reported');
core.runResourceSet({ slug: 'api-core', status: 'live', by: 'dev-t' });
const rhTask2 = core.runTaskAdd({ project: 'p', text: 'ship again', resources: ['api-core'], by: 'dev-t' }).task;
ok(!core.runTaskUpdate({ id: rhTask2.id, status: 'done', by: 'dev-t' }).resourceHint,
  'close: a live resource produces no noise');

// ── a renamed project stops holding two separate backlogs ──
const AL = mktmp();
core.setHubBase(AL);
core.runTaskAdd({ project: 'acme', text: 'written under the old slug', by: 'dev-t' });
fs.writeFileSync(path.join(AL, 'project-aliases.json'), '{"acme": "acme-io"}');
const alNew = core.runTaskAdd({ project: 'acme', text: 'written after the alias', by: 'dev-t' }).task;
ok(core.canonProject('acme') === 'acme-io', 'alias: the canonical slug resolves');
ok(alNew.project === 'acme-io', 'alias: new work lands on the canonical slug, not the alias');
ok(core.runTaskList({ project: 'acme' }).count === 2 && core.runTaskList({ project: 'acme-io' }).count === 2,
  'alias: asking by EITHER name returns the whole project');
core.runCardSet({ project: 'acme-io', digest: 'canonical card', by: 'dev-t' });
ok(/acme-io/.test(core.runGet({ project: 'acme' }).card),
  'alias: hub_get by the old name finds the canonical card');
ok(new Set(core.runGet({ project: 'acme' }).journal.map(e => e.project)).size === 2,
  'alias: the journal trail spans both slugs');
fs.writeFileSync(path.join(AL, 'project-aliases.json'), '{"a": "b", "b": "a"}');
ok(core.canonProject('a') === 'b' || core.canonProject('a') === 'a', 'alias: a cycle terminates instead of hanging');

// ── a queue message can say which task it is about ──
const QT = mktmp();
fs.mkdirSync(path.join(QT, 'queues'), { recursive: true });
core.setHubBase(QT);
q.queueSend('worker', 'HOLD: waiting on the owner', { from: 'dev-t', root: QT, task: 'planck-3', node: 'n1' });
q.queueSend('worker', 'unrelated', { from: 'dev-t', root: QT, node: 'n1' });
const qtText = fs.readFileSync(path.join(QT, 'queues', 'worker.n1.queue.md'), 'utf8');
ok(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from dev-t · task #planck-3$/m.test(qtText),
  'queue task ref: stamped after the sender, so the header pattern every reader uses still matches');
ok(q.peekQueueDepth('worker', { root: QT }).pending === 2,
  'queue task ref: the existing depth reader is unaffected by the extra field');
ok(q.parseTaskRefs(qtText).join(',') === 'planck-3', 'queue task ref: parsed back out of delivered text');
const qtWait = await q.queueWait('worker', { timeout: 1, root: QT });
ok(qtWait.changed && qtWait.tasks && qtWait.tasks[0] === 'planck-3',
  'queue task ref: the consumer is told which task the message is about');

// ── delivered vs pending, across hosts, in one answer ──
const QL = mktmp();
fs.mkdirSync(path.join(QL, 'queues'), { recursive: true });
fs.mkdirSync(path.join(QL, '.qstate'), { recursive: true });
core.setHubBase(QL);
q.queueSend('w', 'one', { from: 'dev-t', root: QL, node: 'hostA' });
// multi-byte on purpose (— is 3 bytes, · is 2): a cursor counts BYTES, so slicing the file as
// a JS string instead of a Buffer would miscount delivered/pending on any non-ASCII message.
q.queueSend('w', 'two — a multi-byte dash · and a bullet', { from: 'dev-t', root: QL, node: 'hostA' });
q.queueSend('w', 'three', { from: 'dev-t', root: QL, node: 'hostB' });
const drained = await q.queueWait('w', { timeout: 1, root: QL });   // consumes hostA + hostB
ok(drained.changed, 'ledger: setup consumed the queue');
q.queueSend('w', 'four, arrived after the read', { from: 'dev-t', root: QL, node: 'hostA' });
const led = q.queueLedger({ root: QL }).roles.find(x => x.role === 'w');
ok(led.total === 4 && led.delivered === 3 && led.pending === 1,
  `ledger: totals are aggregated across hosts (${JSON.stringify({ t: led.total, d: led.delivered, p: led.pending })})`);
ok(led.files.length >= 2 && led.files.every(f => f.total === f.delivered + f.pending),
  'ledger: every per-host file reconciles on its own too');

// ── rules: a check, or an admitted wish ──
const RL = mktmp();
core.setHubBase(RL);
fs.writeFileSync(path.join(RL, 'projects', 'shop.md'),
  '# shop\n\n- slug: shop\n- set: 2026-08-09 10:00 by dev-t\n\nMODE: active — selling\n\n## Digest\n\nx\n\n## Gates\n\n- 100 paying users, or stop\n');
fs.writeFileSync(path.join(RL, 'projects', 'craft.md'),
  '# craft\n\n- slug: craft\n- set: 2026-08-09 10:00 by dev-t\n\n## Digest\n\ny\n\n## Gates\n\n- not a money bet, no date on purpose\n');
const lintQuiet = core.runLint({});
ok(!lintQuiet.findings.some(f => f.id === 'gate-without-date') && lintQuiet.notes.some(n => /no money bets are declared/.test(n)),
  'lint: with no money bet declared the gate rule checks nothing AND says so (silence is reported, not implied)');
fs.writeFileSync(path.join(RL, 'rules.json'), JSON.stringify({
  money: ['shop'],
  strict: { 'gate-without-date': true, rejectNoteOnlyReport: true },
  laws: { 'gate-without-date': { text: 'A money bet without a dated gate goes to background', since: '2026-07-04' } },
}));
const lintOn = core.runLint({});
const gwd = lintOn.findings.filter(f => f.id === 'gate-without-date');
ok(gwd.length === 1 && gwd[0].project === 'shop',
  `lint: only the DECLARED money bet is held to the gate rule (got ${gwd.map(f => f.project).join(',') || 'none'})`);
ok(gwd[0].enforced === true && gwd[0].lawDeclared === true && gwd[0].lawSince === '2026-07-04',
  'lint: the finding quotes the local law with its date and says it is enforced');
core.runTaskAdd({ project: 'shop', text: 'ask the owner to post it', cat: 'communicative', by: 'dev-t' });
const humanTask = core.runTaskAdd({ project: 'shop', text: 'owner posts it', cat: 'communicative', by: 'dev-t' }).task;
core.runTaskUpdate({ id: humanTask.id, by: 'dev-t', tags: [] });   // no-op edit, keeps shape
fs.appendFileSync(path.join(RL, `tasks.${core.JOURNAL_NODE}.events.jsonl`),
  JSON.stringify({ ts: core.now(), node: core.JOURNAL_NODE, ev: 'set', id: humanTask._origin ? humanTask._origin.id : humanTask.id, patch: { owner_kind: 'human' } }) + '\n');
const lintBtn = core.runLint({}).findings.filter(f => f.id === 'button-without-prep');
ok(lintBtn.length === 1 && String(lintBtn[0].task) === String(humanTask.id),
  `lint: a human-owned communicative task with no prep is flagged (got ${lintBtn.length})`);
core.runTaskUpdate({ id: humanTask.id, depends_on: [1], by: 'dev-t' });
ok(!core.runLint({}).findings.some(f => f.id === 'button-without-prep'),
  'lint: giving it a prep it depends on clears the finding');

// strict: prose-only reports are refused ONLY when the instance opted in, and an explicit
// NOTE: is a deliberate aside, not the thing being refused
let strictErr = '';
try { core.runReport({ project: 'shop', by: 'dev-t', text: 'just working on it' }); } catch (e) { strictErr = e.message; }
ok(/strict/.test(strictErr) && /hub claim/.test(strictErr), 'strict: a prose-only report is refused with the alternative named');
ok(core.runReport({ project: 'shop', by: 'dev-t', text: 'NOTE: a real aside' }).note === true,
  'strict: an explicit NOTE: still lands — the message promises that, so it must be true');
ok(core.runReport({ project: 'shop', by: 'dev-t', text: 'FACT: three paying users' }).facts === 1,
  'strict: a structured report is untouched');
fs.writeFileSync(path.join(RL, 'rules.json'), '{}');
ok(core.runReport({ project: 'shop', by: 'dev-t', text: 'prose again' }).note === true,
  'strict: off by default — an upgrade never starts refusing writes uninvited');

// ── audit: declarations vs behaviour, filed as incidents that quote the owner ──
const AUD = mktmp();
core.setHubBase(AUD);
fs.writeFileSync(path.join(AUD, 'rules.json'), JSON.stringify({
  money: ['shop'],
  laws: { 'gate-expired': { text: 'An expired gate means background until a DECIDE sets a new date', since: '2026-07-04' } },
}));
fs.writeFileSync(path.join(AUD, 'projects', 'shop.md'),
  '# shop\n\n- slug: shop\n- set: 2026-08-09 10:00 by dev-t\n\nMODE: active — selling\n\n## Digest\n\nx\n\n## Gates\n\n- 100 paying users by 2026-07-01, or stop\n');
fs.writeFileSync(path.join(AUD, 'projects', 'hobby.md'),
  '# hobby\n\n- slug: hobby\n- set: 2026-08-09 10:00 by dev-t\n\nMODE: background — for fun\n\n## Digest\n\ny\n');
const auRows = [];
for (let i = 0; i < 9; i++) auRows.push({ ts: `2026-08-09 10:0${i}`, project: 'hobby', agent: 'dev-t', kind: 'note', text: 'tinkering' });
auRows.push({ ts: '2026-08-09 11:00', project: 'shop', agent: 'dev-t', kind: 'note', text: 'one shop thing' });
fs.writeFileSync(path.join(AUD, 'journal.t.jsonl'), auRows.map(r => JSON.stringify(r)).join('\n') + '\n');
const au = core.runAudit({ days: 3650 });
const auGate = au.findings.find(f => f.id === 'gate-expired');
const auAttn = au.findings.find(f => f.id === 'attention-vs-mode');
ok(auGate && auGate.project === 'shop' && /2026-07-01/.test(auGate.what),
  'audit: a money bet whose gate date passed with no decision since is a finding');
ok(auGate.lawDeclared && auGate.lawSince === '2026-07-04',
  'audit: the incident quotes the owner\'s own rule and the date it was written');
ok(auAttn && auAttn.project === 'hobby' && /90%/.test(auAttn.what),
  `audit: a background project taking most of the attention is a finding (got ${auAttn && auAttn.what})`);
ok(au.numbers && au.numbers.attentionShare && !au.findings.some(f => f.id === 'done-rate'),
  'audit: close rates are numbers in the report, never filed as violations');
ok(au.apply === false && core.runTaskList({ status: 'all' }).count === 0, 'audit: read-only unless asked');
const applied = core.runAudit({ days: 3650, apply: true, by: 'auditor-t' });
ok(applied.filed.length === applied.findings.length && applied.filed.length >= 2,
  `audit: apply files one incident per finding (${applied.filed.length}/${applied.findings.length})`);
const incident = core.runTaskList({ status: 'open' }).tasks.find(t => /AUDIT gate-expired/.test(t.text));
ok(incident && /Rule: An expired gate/.test(incident.text) && /\[audit:gate-expired:shop:2026-07-01\]/.test(incident.text),
  'audit: the incident carries the quoted rule and a stable key');
const twice = core.runAudit({ days: 3650, apply: true, by: 'auditor-t' });
ok(twice.filed.length === 0 && twice.skipped.length === applied.filed.length,
  `audit: a second pass files nothing — keyed dedup, so a weekly run cannot pile up (${twice.filed.length} filed)`);
// The keys are not the only way a weekly pass could grow its own backlog: filing an incident
// writes a journal line FOR that project, which once made the project's card look 17 days behind
// its journal on the next run — an incident generated by the act of filing an incident. Bookkeeping
// kinds are excluded from the freshness signal; a third pass is the proof it converged.
const thrice = core.runAudit({ days: 3650, apply: true, by: 'auditor-t' });
ok(thrice.filed.length === 0,
  `audit: it does not generate findings out of its own bookkeeping (${thrice.filed.length} filed on the third pass)`);
ok(!core.runAudit({ days: 3650 }).findings.some(f => f.id === 'card-behind-journal'),
  'audit: a card is behind when WORK it does not reflect happened, not when the tracker took notes');
core.runReport({ project: 'shop', by: 'dev-t', text: 'DECIDE: shop stays active, new gate 2026-12-01 | two paying users appeared' });
ok(!core.runAudit({ days: 3650 }).findings.some(f => f.id === 'gate-expired'),
  'audit: a DECIDE recorded after the gate date clears the finding — the verdict is what was missing');
ok(core.runAudit({ days: 3650 }).notes.some(n => /buttons not checked/.test(n)),
  'audit: with no queue rows passed in, the button check says it was skipped instead of reporting all-clear');

// ── one next thing, and the day split by who can act ──
const NX = mktmp();
core.setHubBase(NX);
fs.writeFileSync(path.join(NX, 'owner-roles.json'), '["alice"]');
const nxDep = core.runTaskAdd({ project: 'p', text: 'the prep', by: 'dev-t' }).task;
const nxBlocked = core.runTaskAdd({ project: 'p', text: 'loud but blocked', importance: 'high', depends_on: [nxDep.id], by: 'dev-t' }).task;
const nxOwner = core.runTaskAdd({ project: 'p', text: 'owner decides', assignee: 'alice', by: 'dev-t' }).task;
const nx = core.runNext({});
ok(String(nx.task.id) === String(nxDep.id),
  `next: a blocked high-importance task never wins over a ready one (${nx.task && nx.task.id})`);
ok(nx.blockedCount === 1 && nx.eligible === 2, `next: reports what was eligible and what was blocked (${nx.eligible}/${nx.blockedCount})`);
core.runTaskUpdate({ id: nxDep.id, status: 'done', by: 'dev-t' });
const nx2 = core.runNext({});
ok(String(nx2.task.id) === String(nxBlocked.id) && /importance high/.test(nx2.why),
  'next: closing the dependency unblocks it, and the reason is stated');
const ag = core.runAgenda({});
ok(ag.ownerButtons.length === 1 && String(ag.ownerButtons[0].id) === String(nxOwner.id),
  'agenda: a task assigned to a DECLARED owner role is a button, not agent work');
ok(!ag.agentReady.some(t => String(t.id) === String(nxOwner.id)),
  'agenda: and it is kept out of "agent work, ready now" — a list whose point is that you can start everything in it');
const nxAll = core.runTaskList({ status: 'open' }).count;
ok(ag.counts.agentReady + ag.counts.ownerButtons + ag.counts.blocked === nxAll,
  `agenda: every open task lands in exactly one column (${ag.counts.agentReady}+${ag.counts.ownerButtons}+${ag.counts.blocked} vs ${nxAll})`);

// ── recall: ranked, and honest about age ──
const RC = mktmp();
core.setHubBase(RC);
const old = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(RC, 'projects', 'p.md'),
  `# p\n\n- slug: p\n- set: ${old} by dev-t\n\n## Digest\n\nthe widget pipeline runs nightly\n\n## Decisions\n\n- ${old}: chose the widget queue over polling\n\n## Metrics\n\n- ${old}: widget throughput 40/s\n`);
fs.writeFileSync(path.join(RC, 'journal.t.jsonl'),
  JSON.stringify({ ts: core.now(), project: 'p', agent: 'dev-t', kind: 'note', text: 'touched the widget config today' }) + '\n');
const rcl = core.runRecall({ query: 'widget queue', staleDays: 30 });
ok(rcl.hits.length >= 3 && rcl.hits.every(h => h.asOf !== null), 'recall: every hit carries the date it was true as of');
ok(/widget queue/i.test(rcl.hits[0].text),
  `recall: a hit matching BOTH terms outranks one matching a single term (top: ${rcl.hits[0].text.slice(0, 50)})`);
ok(rcl.hits.some(h => h.stale === true) && /verify/i.test(rcl.hint || ''),
  'recall: an old hit is flagged stale and the answer says to verify before acting');
ok(rcl.hits.some(h => h.stale === false), 'recall: a fresh hit is not flagged');
let rcErr = ''; try { core.runRecall({ query: '  ' }); } catch (e) { rcErr = e.message; }
ok(/query required/.test(rcErr), 'recall: an empty query is refused, not answered with everything');

// ── usage: measured and supplied never mix ──
const US = mktmp();
core.setHubBase(US);
let usErr = ''; try { core.runUsageAdd({ agent: 'dev-t', project: 'p' }); } catch (e) { usErr = e.message; }
ok(/nothing to record/.test(usErr),
  'usage: an entry with no numbers is refused — an absent value must not become a recorded zero');
core.runUsageAdd({ agent: 'dev-t', project: 'p', seconds: 900, tokensIn: 120000, tokensOut: 8000, costUsd: 1.85, model: 'm' });
core.runUsageAdd({ agent: 'other-t', project: 'q', costUsd: 0.15 });
const usTask = core.runTaskAdd({ project: 'p', text: 'closed one', by: 'dev-t' }).task;
core.runTaskUpdate({ id: usTask.id, status: 'done', by: 'dev-t' });
const us = core.runUsage({ days: 7 });
ok(us.supplied.calls === 2 && us.supplied.costUsd === 2 && us.supplied.tokensIn === 120000,
  `usage: supplied numbers aggregate (${JSON.stringify({ c: us.supplied.calls, $: us.supplied.costUsd })})`);
ok(us.supplied.byProject.p.seconds === 900 && us.supplied.byAgent['other-t'].costUsd === 0.15,
  'usage: split by project and by agent');
ok(us.measured.tasksClosed === 1 && /SUPPLIED/.test(us.note) && /MEASURED/.test(us.note),
  'usage: the measured half is the hub\'s own arithmetic, and the answer says which half is which');
ok(core.runUsage({ days: 7, project: 'q' }).supplied.calls === 1, 'usage: filters by project');

// ── scope layers: the operator, the private braid, the rules ──
const SL = mktmp();
core.setHubBase(SL);
const opMissing = core.runOperatorGet();
ok(opMissing.exists === false && /hub_card_set/.test(opMissing.hint) && /Boundaries/.test(opMissing.scaffold),
  'operator: absent card returns how to make one, not an error');
core.runCardSet({ project: 'operator', digest: 'the one human', by: 'dev-t' });
core.runSectionAdd({ project: 'operator', section: 'Boundaries', text: 'health is never collected', by: 'dev-t' });
core.runCardSet({ project: 'realproject', digest: 'a real one', by: 'dev-t' });
ok(core.runOperatorGet().exists === true, 'operator: reads back');
ok(!core.runStatus().projects.some(p => p.project === 'operator') &&
   core.runStatus().projects.some(p => p.project === 'realproject'),
  'operator: it is a card but NOT a project — it never appears in the project table');
ok(core.runRecall({ query: 'health collected' }).hits.some(h => /never collected/.test(h.text)),
  'operator: recall reaches it on purpose — person-level facts are exactly what recall is for');

const priv = core.runReport({ project: 'personal', by: 'dev-t', text: 'energy was low', private: true });
ok(priv.private === true && fs.existsSync(path.join(SL, 'journal.life.jsonl')),
  'private: prose goes to the local-only life braid');
ok(!fs.readFileSync(path.join(SL, `journal.${core.JOURNAL_NODE}.jsonl`), 'utf8').includes('energy was low'),
  'private: and NOT into the mesh-synced journal');
ok(JSON.parse(fs.readFileSync(path.join(SL, 'journal.life.jsonl'), 'utf8').trim()).private === true,
  'private: the entry is stamped, so anything copying text can tell what it is holding');
ok(fs.readFileSync(path.join(SL, '.gitignore'), 'utf8').includes('journal.life.jsonl'),
  'private: the braid is gitignored — never mesh-synced');
let privErr = '';
try { core.runReport({ project: 'personal', by: 'dev-t', text: 'FACT: public thing', private: true }); } catch (e) { privErr = e.message; }
ok(/only prose lines can be private/.test(privErr),
  'private: mixing a structured prefix with private is refused instead of quietly publishing it');

fs.writeFileSync(path.join(SL, 'AGENTS.md'), '# rules\n\nThe first rule.\n');
ok(/The first rule/.test(core.runRules({}).text), 'rules: readable over the tool');
const amended = core.runRules({ append: 'gates need dates', by: 'cto-t' });
const rulesText = fs.readFileSync(path.join(SL, 'AGENTS.md'), 'utf8');
ok(/## Amendments/.test(rulesText) && /gates need dates/.test(rulesText) && /The first rule/.test(rulesText),
  'rules: an amendment is appended under one heading and the original text is untouched');
ok(/cto-t/.test(amended.appended) && /\d{4}-\d{2}-\d{2}/.test(amended.appended),
  'rules: the amendment is dated and attributed — an incident has to be able to quote it');
core.runRules({ append: 'and a second one', by: 'cto-t' });
ok((fs.readFileSync(path.join(SL, 'AGENTS.md'), 'utf8').match(/## Amendments/g) || []).length === 1,
  'rules: a second amendment joins the same heading instead of starting another');

// ── the journal says WHAT changed on a task, not merely that something did ──
// "~ task #N → edited" made the most useful event in a coordination log (somebody took this
// task) indistinguishable from a typo fix in its text. Found while filming the kanban: the live
// activity line for an assignment read "edited".
const JW = mktmp();
core.setHubBase(JW);
const jwT = core.runTaskAdd({ project: 'p', text: 'the work', by: 'dev-t' }).task;
core.runTaskUpdate({ id: jwT.id, assignee: 'dev-atlas', by: 'lead-t' });
core.runTaskUpdate({ id: jwT.id, importance: 'high', deadline: '2026-12-01', by: 'lead-t' });
core.runTaskUpdate({ id: jwT.id, status: 'done', by: 'dev-atlas' });
const jwLines = core.journalTail('p', 20).filter(e => e.kind === 'task').map(e => e.text);
ok(jwLines.some(l => /@dev-atlas/.test(l)), `journal: an assignment names the new owner (got ${JSON.stringify(jwLines)})`);
ok(jwLines.some(l => /importance high/.test(l) && /due 2026-12-01/.test(l)),
  'journal: a priority and deadline change name both');
ok(jwLines.some(l => /→ done$/.test(l)), 'journal: a close still reads as done');
ok(!jwLines.some(l => /→ edited$/.test(l)), 'journal: nothing falls back to the useless word');
fs.rmSync(JW, { recursive: true, force: true });
core.setHubBase(T0);

// ── init does not scaffold a team into somebody's source checkout ──
// Found by healthchecking 0.9.0: `hub init` with no argument took the cwd, and run from a code
// repo it dropped AGENTS.md / INBOX.md / queues/ / specs/ in there, ready to be committed by
// accident. This repo's own .gitignore carries /queues/ and /INBOX.md — the scar of the same
// misroute, papered over rather than fixed.
const IN = mktmp();
execSync('git init -q .', { cwd: IN });
// cwd matters here and run() inherits the test process's own — which IS a checkout, so using it
// would have re-run the very misroute this test is about, in this repo.
const inCwd = (a) => {
  try { return { code: 0, out: execSync(`${CLI} ${a}`, { cwd: IN, env: { ...process.env, HUBD_DIR: path.join(IN, 'hubbase') }, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
};
const initRepo = inCwd('init');
ok(initRepo.code === 1 && /source checkout/.test(initRepo.out),
  `init: refuses a bare init inside a checkout (code ${initRepo.code})`);
ok(!fs.existsSync(path.join(IN, 'AGENTS.md')) && !fs.existsSync(path.join(IN, 'specs')),
  'init: and writes nothing at all when it refuses');
const initTarget = path.join(IN, 'team');
fs.mkdirSync(initTarget);
inCwd(`init ${initTarget}`);
ok(fs.existsSync(path.join(initTarget, 'AGENTS.md')) && fs.existsSync(path.join(initTarget, 'queues', 'README.md')),
  'init: an explicit folder still scaffolds');
inCwd('init --here');
ok(fs.existsSync(path.join(IN, 'AGENTS.md')),
  'init: --here overrides the guard, so a deliberate scaffold-in-place is one flag away');
fs.rmSync(IN, { recursive: true, force: true });

// ── machine-readable output survives a pipe ──
// A pipe buffers 64KB and Node writes to it asynchronously, so process.exit() right after a
// large console.log used to drop the rest: `hub task list --json` came back cut mid-token,
// valid-looking and short, with nothing saying it had been truncated. execSync reads through
// a pipe, so this test sees exactly what `| jq` would.
const PIPE = mktmp();
fs.writeFileSync(path.join(PIPE, 'tasks.pipe.events.jsonl'),
  Array.from({ length: 140 }, (_, i) => JSON.stringify({
    ts: '2026-06-01 10:00', node: 'pipe', ev: 'add', id: `pipe-${i}`,
    t: { id: `pipe-${i}`, project: 'p', text: 'x'.repeat(700), status: 'open', importance: 'normal', created: '2026-06-01 10:00', by: 'dev-t' },
  })).join('\n') + '\n');
// The reader has to be SLOW to start, or this test is a coin flip: whether the truncation
// shows at all depends on whether the reader drains the pipe before the child exits, and a
// fast reader (execSync's own capture, a prompt `| cat`) usually wins that race. A reader
// that sleeps first guarantees the 64KB buffer fills while the writer is still going —
// which is precisely the case a real consumer hits (`| jq`, an agent parsing the output).
const piped = run('task list --json --status all | { sleep 0.4; cat; }', { HUBD_DIR: PIPE, HUBD_NODE: 'pipe' });
ok(piped.out.length > 65536, `pipe: the payload really is bigger than a pipe buffer (${piped.out.length}B)`);
let pipedJson = null; try { pipedJson = JSON.parse(piped.out); } catch {}
ok(pipedJson && pipedJson.tasks.length === 140,
  `pipe: a >64KB --json payload arrives whole and parses (${pipedJson ? pipedJson.tasks.length + ' tasks' : 'TRUNCATED at ' + piped.out.length + 'B'})`);
fs.rmSync(PIPE, { recursive: true, force: true });

for (const d of [DG, ID, QG, SEC, GT, AL, QT, QL, RL, AUD, NX, RC, US, SL]) fs.rmSync(d, { recursive: true, force: true });
core.setHubBase(T0);

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
