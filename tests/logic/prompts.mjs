// prompts.mjs — a role's rules rendered from prompts/meta: one template, the specifics as variables
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
  const example = (fs.readFileSync(path.join(REPO, 'prompts/meta/fragments/reflect.md'), 'utf8').split('Example, the end of a report:')[1] || '').match(/```\n([\s\S]*?)```/);
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

// ── the tarball ──
{
  const files = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].files.map(f => f.path);
  ok(['worker', 'head', 'orchestrator'].every(t => files.includes(`prompts/meta/${t}.md`)) &&
    files.filter(f => f.startsWith('prompts/meta/fragments/')).length === 8 && files.includes('hub/lib/prompts.mjs'),
    'prompts: npm pack ships prompts/meta, its 8 fragments and the renderer');
}
done();
