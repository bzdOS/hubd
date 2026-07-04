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

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
