// prompts.mjs — a role's rules rendered from prompts/meta: one template, the specifics as variables
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { REPO, ok, mktmp, cli, done } from './_h.mjs';

const P = await import(path.join(REPO, 'hub/lib/prompts.mjs'));
const VARS = {
  role: 'w1', kind: 'worker', project: 'demo', cwd: '/work/demo', head: 'demo-head',
  allowed_paths: '  - `/work/demo/**`', track_goal: 'Ship 1.0.', track_facts: '- the build takes 4 min',
  owner_decisions: '- keep zero dependencies', base_ref: 'origin/main', private_patterns: 'internal-',
  private_check: 'sh tools/private-check.sh origin/main',
  plan_file: 'PLAN.md', verdict_cmd: 'hub sense demo-head verdict task/<slug> accept|reject "<what>"',
};
const T = mktmp();
const vf = path.join(T, 'vars.json');
fs.writeFileSync(vf, JSON.stringify(VARS));

// ── the shipped templates ──
ok(['head', 'orchestrator', 'worker'].every(t => P.templateNames().includes(t)), 'prompts: worker, head and orchestrator ship in prompts/meta');
for (const t of ['worker', 'head', 'orchestrator']) {
  const r = cli(['prompts', 'render', t, '--vars', vf]);
  ok(r.code === 0 && r.stdout.includes('`w1`') && r.stdout.includes('Ship 1.0.'), `prompts: hub prompts render ${t} renders with the fixture (exit ${r.code})`);
  ok(!/\{\{|<!--/.test(r.stdout), `prompts: the render of ${t} has no {{...}} or author comment left`);
  ok(/^## Turn/m.test(r.stdout) && /^## Reflection/m.test(r.stdout) && r.stdout.includes('PREEMPT'), `prompts: ${t} includes the shared fragments`);
}
ok(/^## The head's dispatch cycle/m.test(P.renderPrompt('head', VARS)) && !/dispatch cycle/.test(P.renderPrompt('worker', VARS)),
  'prompts: the head gets the dispatch cycle, the worker does not');
ok(/^## FLEET-REFLECT/m.test(P.renderPrompt('orchestrator', VARS)), 'prompts: the orchestrator gets the fleet reflection');
// The reflection is the last block of the turn's ONE report: a second hub_report late in a turn
// re-reads the whole turn. The prompt says so, and its own example is what hub sense splits.
{
  const w = P.renderPrompt('worker', VARS);
  ok(/last block of the turn's one hub_report, not a hub_report of its own/.test(w) && /one hub_report that ends with the reflection/.test(w) &&
    !/(a|the|one) (separate|second) hub_report/.test(w.replace(/not a hub_report of its own/, '')),
    'prompts: the worker is told to end its one report with the reflection, not to file it separately');
  const sense = await import(path.join(REPO, 'hub/lib/sense.mjs'));
  const example = (fs.readFileSync(path.join(REPO, 'prompts/meta/fragments/reflect.md'), 'utf8').split('Example, the end of a report')[1] || '').match(/```\n([\s\S]*?)```/);
  const sp = example ? sense.splitReflect(example[1]) : { body: '', reflect: '' };
  ok(/^NEXT: /m.test(sp.body) && /^REFLECT\ngoal: .*\nresult: partial\nobstacle: permissions — .*\ninstead: .*\nrule: .*$/.test(sp.reflect),
    'prompts: the fragment\'s own example report is split by hub sense into its body and a trailing reflection');
}
// A role does not push: its branch is handed over for review, as a bundle or a patch, and the
// private check runs before that. "push" as a step had workers pushing and heads waiting on one.
{
  const PROHIBIT = 'You never push to an external remote and never ask anyone to; publishing is not your step and never a blocker.';
  for (const t of ['worker', 'head', 'orchestrator']) {
    const s = P.renderPrompt(t, VARS);
    ok(s.includes('run `sh tools/private-check.sh origin/main`') && /Before you hand a branch over/.test(s),
      `prompts: ${t} runs the private check, given as a command, before handing a branch over`);
    ok(s.split('\n').filter(l => /\bpush/i.test(l)).every(l => l === '- ' + PROHIBIT) && s.includes(PROHIBIT),
      `prompts: in ${t}, push appears only in the line that forbids it`);
  }
  const src = fs.readdirSync(path.join(REPO, 'prompts/meta'), { recursive: true }).filter(f => f.endsWith('.md'))
    .flatMap(f => fs.readFileSync(path.join(REPO, 'prompts/meta', f), 'utf8').split('\n').filter(l => /\bpush/i.test(l)).map(l => f + ': ' + l));
  ok(src.length === 1 && src[0] === 'fragments/privacy.md: - ' + PROHIBIT, `prompts: grep -w push over prompts/meta finds the prohibition and nothing else (got ${JSON.stringify(src)})`);
  const { private_check, ...noCheck } = VARS;
  const r = cli(['prompts', 'render', 'worker', '--vars', JSON.stringify(noCheck)]);
  ok(r.code === 2 && /private_check/.test(r.stderr) && r.stdout === '', 'prompts: a render without private_check is an error that names it, and prints nothing');
}
// Nine lessons from a finished project, each where it is read. None has a check, so each is marked
// as a wish for authors; the mark never reaches the role.
{
  const LESSONS = [
    [1, 'head', 'head-cycle', 'is the first dispatch and is rerun after every step'],
    [2, 'head', 'head-cycle', 'A full pass waits\n   until the names and terms it depends on are fixed'],
    [3, 'head', 'head-cycle', 'Verification gets no less time than production'],
    [4, 'worker', 'turn', 'Exit code 0 is not a result'],
    [5, 'worker', 'turn', 'A claim about quality is a sample'],
    [6, 'worker', 'turn', 'not against a retelling of it'],
    [7, 'worker', 'report', 'is a FACT only once you observed it or its owner confirmed it'],
    [8, 'worker', 'boundaries', 'An owner decision outranks a pattern found in the history or the code'],
    [9, 'orchestrator', 'orch-reflect', 'a risk the owner has weighed is noise'],
  ];
  for (const [n, t, frag, phrase] of LESSONS)
    ok(P.renderPrompt(t, VARS).includes(phrase) && fs.readFileSync(path.join(REPO, 'prompts/meta/fragments', frag + '.md'), 'utf8').includes(phrase),
      `prompts: lesson ${n} sits in ${frag} and reaches the ${t}: "${phrase.replace(/\s+/g, ' ')}"`);
  ok(fs.readFileSync(path.join(REPO, 'prompts/protocol.md'), 'utf8').includes('check a label against state before you continue what it names'),
    'prompts: lesson 6 also sits in the protocol, where a session recovers after compaction');
  const wishes = fs.readdirSync(path.join(REPO, 'prompts/meta'), { recursive: true }).filter(f => f.endsWith('.md'))
    .flatMap(f => fs.readFileSync(path.join(REPO, 'prompts/meta', f), 'utf8').split('\n').filter(l => l.startsWith('<!-- wish:')).map(() => f.replace(/^fragments\/|\.md$/g, '')));
  const per = (f) => wishes.filter(w => w === f).length;
  // Reflect's three: a rule is not the block restated, partial with none only for a run not finished,
  // the values in the dispatch's language. No check can tell any of them.
  ok(wishes.length === 12 && per('head-cycle') === 3 && per('turn') === 3 && per('report') === 1 && per('boundaries') === 1 && per('orch-reflect') === 1 &&
    per('reflect') === 3, `prompts: each of the nine lessons is marked as a wish, on a line of its own, and reflect's three (got ${JSON.stringify(wishes)})`);
  // The lessons extend existing lines; a repeated line would cost every role on every step.
  for (const [t, n] of [['worker', 2], ['head', 2], ['orchestrator', 3]]) {
    const s = P.renderPrompt(t, VARS);
    ok(s.split('Do not claim what you have not measured').length - 1 === n && !s.includes('<!--'),
      `prompts: ${t} says "Do not claim what you have not measured" ${n} times, as before the lessons, and shows no wish mark`);
  }
}
// a value is inserted as it is: neither re-expanded nor stripped inside
const odd = P.renderPrompt('worker', { ...VARS, track_goal: '\n\nkeep {{role}} and {{> turn}} literal\n\n' });
ok(odd.includes('keep {{role}} and {{> turn}} literal\n'), 'prompts: a value is not expanded again, only its outer blank lines trimmed');
// the shipped files are public text: no fleet names (check_clean has the list), and English only
for (const f of fs.readdirSync(path.join(REPO, 'prompts/meta'), { recursive: true }).filter(f => f.endsWith('.md'))) {
  const s = fs.readFileSync(path.join(REPO, 'prompts/meta', f), 'utf8');
  ok(!/[\u0400-\u04FF]/.test(s), `prompts: prompts/meta/${f} is English`);
}

// ── variables ──
{
  const { track_goal, head, ...partial } = VARS;
  fs.writeFileSync(path.join(T, 'partial.json'), JSON.stringify({ ...partial, head: '  \n' }));
  const r = cli(['prompts', 'render', 'worker', '--vars', path.join(T, 'partial.json')]);
  ok(r.code === 2 && /track_goal/.test(r.stderr) && /\bhead\b/.test(r.stderr) && !r.stdout,
    `prompts: a missing and a blank variable fail with both names, nothing on stdout (exit ${r.code}: ${r.stderr.trim()})`);
}
{
  const r = cli(['prompts', 'render', 'worker', '--vars', JSON.stringify({ ...VARS, extra: 'x' })]);
  ok(r.code === 0, 'prompts: --vars takes inline JSON, and a variable the template does not declare is ignored');
  ok(cli(['prompts', 'render', 'worker', '--vars', JSON.stringify({ ...VARS, role: ['a'] })]).code === 2, 'prompts: a list as a value is an error');
  ok(cli(['prompts', 'render', 'worker', '--vars', '{not json']).code === 2, 'prompts: --vars that is not JSON is an error');
  ok(cli(['prompts', 'render', 'nosuch', '--vars', vf]).code === 2, 'prompts: an unknown template is an error');
  ok(cli(['prompts', 'render', '../package', '--vars', vf]).code === 2, 'prompts: a template name cannot leave prompts/meta');
}

// ── the engine on a fixture directory ──
const F = mktmp();
fs.mkdirSync(path.join(F, 'fragments'));
const put = (rel, s) => fs.writeFileSync(path.join(F, rel), s);
const err = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
put('fragments/a.md', 'A {{x}}\n{{> b}}\n');
put('fragments/b.md', 'B\n{{> a}}\n');
put('cyc.md', '<!-- vars: x -->\n{{> a}}\n');
ok(/include cycle: cyc > a > b > a/.test(err(() => P.renderPrompt('cyc', { x: '1' }, F))), 'prompts: an include cycle is an error naming the chain');
put('fragments/d1.md', '{{> d2}}\n'); put('fragments/d2.md', '{{> d3}}\n'); put('fragments/d3.md', '{{> d4}}\n'); put('fragments/d4.md', 'deep\n');
put('deep.md', '<!-- vars: -->\n{{> d1}}\n');
ok(/deeper than 3/.test(err(() => P.renderPrompt('deep', {}, F))), 'prompts: includes nested deeper than 3 are an error');
put('fragments/d3.md', 'three\n');
ok(P.renderPrompt('deep', {}, F) === 'three\n', 'prompts: 3 levels deep render, each fragment without its trailing newline');
put('unk.md', '<!-- vars: x -->\n{{x}}\n\n{{y}}\n');
ok(/unknown variable: y \(unk\.md:4\)/.test(err(() => P.renderPrompt('unk', { x: '1', y: '2' }, F))), 'prompts: a variable used but not declared is an error with file:line, even when passed');
put('unused.md', '<!-- vars: x, z -->\n{{x}}\n');
ok(/never used: z/.test(err(() => P.renderPrompt('unused', { x: '1', z: '2' }, F))), 'prompts: a variable declared but never used is an error');
put('nofrag.md', '<!-- vars: -->\n{{> gone}}\n');
ok(/no fragment "gone".*nofrag\.md:2/.test(err(() => P.renderPrompt('nofrag', {}, F))), 'prompts: a missing fragment is an error naming where it was included');
put('fragments/n.md', 'one\n<!-- wish: a rule\n     nothing checks -->\ntwo {{y}}\n');
put('note.md', '<!-- vars: x -->\n<!-- a note -->\n{{x}}\n{{> n}}\n');
ok(/unknown variable: y \(fragments\/n\.md:4\)/.test(err(() => P.renderPrompt('note', { x: '1' }, F))),
  'prompts: an error in a fragment names its line in the file, notes included');
put('fragments/n.md', 'one\n<!-- wish: a rule\n     nothing checks -->\ntwo\n');
ok(P.renderPrompt('note', { x: '1' }, F) === '1\none\ntwo\n', 'prompts: a note that starts a line is not rendered, in a fragment as in a template');
put('nodecl.md', '{{x}}\n');
ok(/declares no variables/.test(err(() => P.renderPrompt('nodecl', { x: '1' }, F))), 'prompts: a template without its vars line is an error');

// ── --out and --check ──
{
  const out = path.join(T, 'rules.md');
  ok(cli(['prompts', 'render', 'head', '--vars', vf, '--out', out]).code === 0 && fs.readFileSync(out, 'utf8') === P.renderPrompt('head', VARS),
    'prompts: --out writes exactly the render');
  const c0 = cli(['prompts', 'render', 'head', '--vars', vf, '--check', out]);
  ok(c0.code === 0, `prompts: --check passes on a fresh render (exit ${c0.code})`);
  fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('Ship 1.0.', 'Ship 2.0.'));
  const c1 = cli(['prompts', 'render', 'head', '--vars', vf, '--check', out]);
  ok(c1.code === 1 && /-\d+: Ship 2\.0\./.test(c1.stderr) && /\+\d+: Ship 1\.0\./.test(c1.stderr),
    `prompts: --check catches a hand edit: exit 1, the line diff on stderr (exit ${c1.code})`);
  ok(cli(['prompts', 'render', 'head', '--vars', vf, '--check', path.join(T, 'none.md')]).code === 1, 'prompts: --check on a missing file is drift, exit 1');
  ok(cli(['prompts', 'render', 'worker', '--check', out]).code === 2, 'prompts: --check with variables missing is exit 2, not drift');
  ok(cli(['prompts', 'render', 'head', '--vars', vf, '--out', out, '--check', out]).code === 2, 'prompts: --out and --check together are refused');
}
ok(JSON.stringify(P.lineDiff('a\nb\nc', 'a\nx\nc')) === JSON.stringify(['+2: x', '-2: b']), 'prompts: lineDiff numbers each side in its own text');

// ── over MCP: prompts/list and prompts/get, rendered by the same code ──
{
  const { private_check, ...noCheck } = VARS;
  const reqs = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { id: 2, method: 'prompts/list', params: {} },
    ...['worker', 'head', 'orchestrator'].map((t, i) => ({ id: 10 + i, method: 'prompts/get', params: { name: t, arguments: VARS } })),
    { id: 20, method: 'prompts/get', params: { name: 'worker', arguments: noCheck } },
    { id: 21, method: 'prompts/get', params: { name: 'worker' } },
    { id: 22, method: 'prompts/get', params: { name: 'nosuch', arguments: VARS } },
  ].map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n';
  let out = '';
  try { out = execSync(`node ${REPO}/hub/index.mjs`, { input: reqs, encoding: 'utf8', env: { ...process.env, HUBD_DIR: mktmp() }, timeout: 15000 }); }
  catch (e) { out = e.stdout || ''; }
  const res = {};
  for (const l of out.split('\n')) { try { const m = JSON.parse(l); if (m.id != null) res[m.id] = m; } catch {} }
  const list = res[2]?.result?.prompts || [];
  const byName = Object.fromEntries(list.map(p => [p.name, p]));
  ok(['harvest', 'worker', 'head', 'orchestrator'].every(n => byName[n]), `MCP: prompts/list has harvest and the three templates (got ${list.map(p => p.name).join(', ')})`);
  for (const t of ['worker', 'head', 'orchestrator']) {
    const a = byName[t]?.arguments || [];
    ok(a.map(x => x.name).join(',') === P.templateVars(t).join(',') && a.every(x => x.required === true),
      `MCP: ${t}'s arguments are its declared variables, all required`);
    ok(a.length && a.every(x => x.description), `MCP: every argument of ${t} carries its description from prompts/meta/README.md`);
    const cliOut = cli(['prompts', 'render', t, '--vars', vf]).stdout;
    const got = res[10 + ['worker', 'head', 'orchestrator'].indexOf(t)]?.result?.messages?.[0]?.content?.text;
    ok(got && got === cliOut, `MCP: prompts/get ${t} with every argument is byte for byte what hub prompts render prints`);
  }
  ok(/a worker: takes one dispatch per turn/.test(byName.worker?.description || ''), 'MCP: a template\'s description comes from the README table');
  ok(res[20]?.error?.code === -32602 && /private_check/.test(res[20].error.message) && !res[20].result,
    `MCP: a missing argument is an invalid-params error that names it (got ${JSON.stringify(res[20]?.error)})`);
  ok(res[21]?.error?.code === -32602 && /role/.test(res[21].error.message) && /private_check/.test(res[21].error.message),
    'MCP: with no arguments at all, the error names every one');
  ok(res[22]?.error?.code === -32602 && /unknown prompt/.test(res[22].error.message), 'MCP: an unknown prompt is still an error');
}
// A broken template, in a copy of the package: the list keeps harvest, the render is an internal error.
{
  const pkg = mktmp();
  for (const f of ['hub', 'prompts', 'package.json', 'HARVEST.md']) fs.cpSync(path.join(REPO, f), path.join(pkg, f), { recursive: true });
  const w = path.join(pkg, 'prompts/meta/worker.md');
  fs.writeFileSync(w, fs.readFileSync(w, 'utf8').split('\n').slice(1).join('\n'));
  const reqs = [{ id: 1, method: 'prompts/list', params: {} }, { id: 2, method: 'prompts/get', params: { name: 'worker', arguments: VARS } }]
    .map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n';
  const r = spawnSync('node', [path.join(pkg, 'hub/index.mjs')], { input: reqs, encoding: 'utf8', env: { ...process.env, HUBD_DIR: mktmp() }, timeout: 15000 });
  const res = {};
  for (const l of (r.stdout || '').split('\n')) { try { const m = JSON.parse(l); if (m.id != null) res[m.id] = m; } catch {} }
  const names = (res[1]?.result?.prompts || []).map(p => p.name);
  ok(names.includes('harvest') && !names.includes('worker'), `MCP: a broken template drops the role prompts from the list, not harvest (got ${names.join(', ')})`);
  ok(/prompts\/meta: .*worker/.test(r.stderr || ''), `MCP: and stderr says which template (got ${JSON.stringify((r.stderr || '').trim())})`);
  ok(res[2]?.error?.code === -32603, `MCP: prompts/get of a broken template is an internal error (got ${JSON.stringify(res[2]?.error)})`);
}
// One more template variable is one more row in the README: the MCP description is read there.
{
  const docs = P.promptDocs();
  const undocumented = P.templateNames().flatMap(t => P.templateVars(t)).filter(v => !docs.vars[v]);
  ok(!undocumented.length, `prompts: every declared variable has a row in prompts/meta/README.md (missing: ${[...new Set(undocumented)].join(', ') || 'none'})`);
  ok(P.templateNames().every(t => docs.templates[t]), 'prompts: and every template a row in its template table');
}

// ── the tarball ──
{
  const files = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].files.map(f => f.path);
  ok(['worker', 'head', 'orchestrator'].every(t => files.includes(`prompts/meta/${t}.md`)) &&
    files.filter(f => f.startsWith('prompts/meta/fragments/')).length === 8 && files.includes('hub/lib/prompts.mjs'),
    'prompts: npm pack ships prompts/meta, its 8 fragments and the renderer');
}
done();
