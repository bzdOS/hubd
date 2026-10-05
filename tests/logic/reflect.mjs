// reflect.mjs — a turn's reflection as data: checked as a field, read from the text, counted by a digest
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, ok, core, recallLib, cli, done } from './_h.mjs';

const R = await import(path.join(REPO, 'hub/lib/reflect.mjs'));
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
const GOOD = { goal: 'build the package', result: 'partial', obstacle: 'permissions', obstacle_fact: 'read refused, 3 attempts',
  instead: 'check the path first', rule: 'keep build recipes inside the allowed paths' };

// ── the lists are the fragment's lists ──
{
  const frag = fs.readFileSync(path.join(REPO, 'prompts/meta/fragments/reflect.md'), 'utf8');
  const cls = (/strictly from the list `([^`]+)`/.exec(frag) || [])[1];
  const res = (/^result: ([a-z|]+)$/m.exec(frag) || [])[1];
  ok(cls && cls.split(' | ').join() === R.OBSTACLES.join(), `reflect: the obstacle classes are the fragment's list (${cls})`);
  ok(res && res.split('|').join() === R.RESULTS.join(), `reflect: the results are the fragment's list (${res})`);
}

// ── the field: checked ──
{
  const c = R.checkReflect({ ...GOOD, goal: '  build\n the package ' });
  ok(c.level === 'turn' && c.goal === 'build the package' && c.obstacle_fact === GOOD.obstacle_fact, 'reflect: a good field is kept, level turn by default, each value on one line');
  ok(throws(() => R.checkReflect({ ...GOOD, result: 'success' }), /result "success" is not one of done \| partial \| no/), 'reflect: a result off the list is an error naming the value and the list');
  ok(throws(() => R.checkReflect({ ...GOOD, obstacle: 'rights' }), /obstacle "rights" is not one of permissions/), 'reflect: an obstacle class off the list is an error');
  ok(throws(() => R.checkReflect({ ...GOOD, level: 'worker' }), /level "worker" is not one of turn \| head \| fleet/), 'reflect: a level off the list is an error');
  ok(throws(() => R.checkReflect({ ...GOOD, outcome: 'done' }), /unknown field outcome/), 'reflect: an unknown field is an error, so a misnamed one is not silently dropped');
  for (const k of ['goal', 'instead', 'rule']) {
    const { [k]: _, ...rest } = GOOD;
    ok(throws(() => R.checkReflect(rest), new RegExp(`${k} is required`)), `reflect: ${k} is required`);
  }
  ok(throws(() => R.checkReflect({ ...GOOD, obstacle: 'none' }), /"none" takes no obstacle_fact/), 'reflect: obstacle none with a fact is an error (the class none takes no fact)');
  ok(throws(() => R.checkReflect({ ...GOOD, obstacle_fact: ' ' }), /needs obstacle_fact/), 'reflect: an obstacle other than none needs its fact');
  ok(throws(() => R.checkReflect({ ...GOOD, goal: 7 }), /goal is a string/), 'reflect: a value that is not a string is an error');
  ok(throws(() => R.checkReflect({ ...GOOD, decisions: [] }), /belong to a head or fleet/), 'reflect: decisions on a turn reflection are an error');
  ok(throws(() => R.checkReflect({ ...GOOD, level: 'head', decisions: [{ rule: 'x', verdict: 'maybe' }] }), /verdict "maybe" is not one of accepted \| rejected \| needs-owner/),
    'reflect: a verdict off the list is an error');
  ok(throws(() => R.checkReflect({ ...GOOD, level: 'fleet', decisions: [{ verdict: 'accepted' }] }), /decisions\[0\]\.rule is required/), 'reflect: a decision names its rule');
  const h = R.checkReflect({ ...GOOD, level: 'fleet', decisions: [{ rule: 'one dispatch per turn', verdict: 'rejected', reason: 'no check' }] });
  ok(h.decisions.length === 1 && h.decisions[0].reason === 'no check', 'reflect: a fleet reflection carries its decisions');
}

// ── the text: read, not checked ──
{
  const frag = fs.readFileSync(path.join(REPO, 'prompts/meta/fragments/reflect.md'), 'utf8');
  const example = frag.split('Example, the end of a report:')[1].match(/```\n([\s\S]*?)```/)[1];
  const r = R.readReflect(example);
  ok(r && !r.problems.length && r.level === 'turn' && r.result === 'partial' && r.obstacle === 'permissions' &&
    /^read refused on a directory outside the list/.test(r.obstacle_fact) && /^keep build recipes/.test(r.rule),
    `reflect: the fragment's own example reads into the fields with no problems (${JSON.stringify(r && r.problems)})`);
  const joined = example.trim().split('\n').join(' · ');
  ok(JSON.stringify(R.readReflect(joined)) === JSON.stringify(r), 'reflect: the journal form, lines joined with " · ", reads the same');
  const listed = 'done it\nREFLECT\n- goal: g\n- result: done\n- obstacle: environment — exit 2\n- instead: i\n- rule: r';
  const l = R.readReflect(listed);
  ok(l.result === 'done' && l.obstacle === 'environment' && l.obstacle_fact === 'exit 2' && !l.problems.length, 'reflect: the lines may be list items');
  const off = R.readReflect('x · REFLECT · goal: g · result: success · obstacle: pre-push refused the first push · instead: i · rule: r');
  ok(off.result === null && off.obstacle === null && off.obstacle_fact === 'pre-push refused the first push' && off.problems.length === 2,
    `reflect: off-list values read as null with a problem each, the unclassed fact kept whole (${JSON.stringify(off.problems)})`);
  const cont = R.readReflect('REFLECT · goal: g · result: no · obstacle: model · refused twice · instead: i · rule: a · b');
  ok(cont.obstacle_fact === 'refused twice' && cont.rule === 'a · b', 'reflect: a segment with no known key continues the field before it');
  ok(R.readReflect('REFLECT · result: done · obstacle: none — all fine').problems.includes('obstacle "none" takes no fact'), 'reflect: none with a fact is read and named a problem');
  ok(R.readReflect('NOTE: REFLECT on this later') === null && R.readReflect('') === null, 'reflect: no block, no reflection');
  ok(R.readReflect('HEAD-REFLECT · goal: g · result: done · obstacle: none · instead: i · rule: r').level === 'head' &&
    R.readReflect('FLEET-REFLECT\ngoal: g\nresult: done\nobstacle: none\ninstead: i\nrule: r').level === 'fleet', 'reflect: HEAD- and FLEET-REFLECT read as their levels');
  for (const lv of R.LEVELS) {
    const c = R.checkReflect({ ...GOOD, level: lv, ...(lv === 'turn' ? {} : { decisions: [{ rule: 'r1', verdict: 'needs-owner' }, { rule: 'r2', verdict: 'rejected', reason: 'why' }] }) });
    const back = R.readReflect('body · ' + R.renderReflect(c).split('\n').join(' · '));
    const { problems, ...fields } = back;
    ok(!problems.length && JSON.stringify(fields) === JSON.stringify(c), `reflect: a rendered ${lv} block reads back into the same fields`);
  }
}

// ── written by a report ──
const P = 'rfdemo';
const tail = () => core.journalTail(P, 1000);
{
  const r = core.runReport({ project: P, agent: 'dev-a', text: 'built it: exit 0', reflect: GOOD });
  const e = tail().at(-1);
  ok(r.reflect && r.reflect.source === 'field' && e.reflect && e.reflect.rule === GOOD.rule, 'report: the field is stored on the report\'s entry');
  ok(/^built it: exit 0 · REFLECT · goal: build the package · result: partial · obstacle: permissions — read refused/.test(e.text),
    `report: and written into its text as the block (${e.text.slice(0, 80)})`);
  const r2 = core.runReport({ project: P, agent: 'dev-a', text: '', reflect: { ...GOOD, obstacle: 'none', obstacle_fact: '' } });
  ok(r2.note && tail().at(-1).reflect.obstacle === 'none' && !('obstacle_fact' in tail().at(-1).reflect), 'report: a reflection alone is a report');
  const task = core.runTaskAdd({ project: P, text: 'a task to close', by: 'dev-a' }).task.id;
  const before = tail().length;
  ok(throws(() => core.runReport({ project: P, agent: 'dev-a', text: `DONE: ${task}\nFACT: a fact`, reflect: { ...GOOD, result: 'great' } }), /result "great"/),
    'report: a bad field refuses the report');
  ok(tail().length === before && core.loadTasks().tasks.find(t => String(t.id) === String(task)).status !== 'done' && !/a fact/.test(core.readCard(P) || ''),
    'report: and nothing of it is written: no entry, the task still open, the card untouched');
  ok(throws(() => core.runReport({ project: P, agent: 'dev-a', text: 'x\nREFLECT\nresult: done\nobstacle: none', reflect: GOOD }), /given twice/),
    'report: a field and a block in one report is an error');
  const t = core.runReport({ project: P, agent: 'dev-b', text: 'x\nREFLECT\ngoal: g\nresult: success\nobstacle: none\ninstead: i\nrule: none' });
  ok(t.reflect && t.reflect.source === 'text' && t.reflect.problems.length === 1 && /success/.test(t.reflect.problems[0]) && !tail().at(-1).reflect,
    'report: a block in the text is filed, read, its problems in the reply, and no field invented for it');
  const c = cli(['report', '-p', P, '--agent', 'dev-b', '-m', 'did it', '--reflect', JSON.stringify(GOOD)]);
  ok(c.code === 0 && /reflection \(turn\)/.test(c.stdout) && tail().at(-1).reflect, 'CLI: hub report --reflect <json> files the field');
  const bad = cli(['report', '-p', P, '--agent', 'dev-b', '--reflect', '{"goal":"g"}']);
  ok(bad.code !== 0 && /result null is not one of|instead is required/.test(bad.stderr), `CLI: and a bad one is refused (${bad.stderr.trim().slice(0, 80)})`);
}

// ── the digest ──
{
  const D = 'rfdigest';
  const add = (agent, ts, rf, text = 'turn report') => core.journalAppend({ ts, project: D, agent, kind: 'done', text: text + ' · ' + R.renderReflect(rf).split('\n').join(' · '), reflect: rf });
  const env = (n, fact) => R.checkReflect({ ...GOOD, obstacle: 'environment', obstacle_fact: fact, rule: n });
  add('dev-a', '2026-10-01 10:00', env('Measure the disk first.', 'disk full, 0 bytes free'));
  add('dev-b', '2026-10-01 11:00', env('measure the disk first', 'exit 28 on write'));
  add('dev-a', '2026-10-01 12:00', env('MEASURE the disk, first!', 'df: 100%'));
  add('dev-a', '2026-10-01 13:00', env('none', 'no space left on device'));
  add('dev-b', '2026-10-01 14:00', R.checkReflect({ ...GOOD, result: 'done', obstacle: 'none', obstacle_fact: '', rule: 'none' }));
  core.journalAppend({ ts: '2026-10-01 15:00', project: D, agent: 'dev-c', kind: 'note',
    text: 'old form · REFLECT · goal: g · result: complete · obstacle: hook refused · instead: i · rule: r' });
  add('head-a', '2026-10-01 16:00', R.checkReflect({ ...GOOD, level: 'head', obstacle: 'none', obstacle_fact: '', rule: 'none',
    decisions: [{ rule: 'measure the disk first', verdict: 'accepted' }] }));
  core.journalAppend({ ts: '2026-09-01 10:00', project: D, agent: 'dev-a', kind: 'done', text: 'before the window', reflect: env('old', 'old fact') });
  core.journalAppend({ ts: '2026-10-01 10:30', project: 'elsewhere', agent: 'dev-a', kind: 'done', text: 'other project', reflect: env('x', 'y') });

  const d = core.runReflect({ project: D, since: '2026-09-30' });
  ok(d.reflections === 7, `digest: every reflection of the project in the window, field and text alike (${d.reflections})`);
  ok(d.obstacles.environment.count === 4 && d.obstacles.environment.facts.length === 3 &&
    d.obstacles.environment.facts.map(f => f.fact).join('|') === 'no space left on device|df: 100%|exit 28 on write',
    `digest: four of one class count 4, with the last three facts, newest first (${JSON.stringify(d.obstacles.environment.facts.map(f => f.fact))})`);
  ok(d.roles['dev-a'].reflections === 3 && d.roles['dev-a'].obstacle.environment === 3 && d.roles['dev-a'].result.partial === 3 &&
    d.roles['dev-b'].result.done === 1 && d.roles['dev-b'].obstacle.none === 1, 'digest: results and obstacle classes are counted per role');
  ok(d.roles['dev-c'].result.other === 1 && d.roles['dev-c'].obstacle.unclassified === 1 && d.obstacles.unclassified.facts[0].fact === 'hook refused',
    'digest: an off-list value counts as other / unclassified, and its fact is kept');
  ok(d.rules.length === 1 && d.rules[0].count === 3 && d.rules[0].roles.join() === 'dev-a,dev-b' && d.rules[0].rule === 'MEASURE the disk, first!',
    `digest: one rule written three ways is one rule proposed three times, "none" is no rule (${JSON.stringify(d.rules)})`);
  ok(d.decisions.length === 1 && d.decisions[0].role === 'head-a' && d.decisions[0].verdict === 'accepted' && d.decisions[0].level === 'head', 'digest: the verdicts given are listed');
  const h = core.runReflect({ project: D, since: '2026-09-30', level: 'head' });
  ok(h.reflections === 1 && Object.keys(h.roles).join() === 'head-a', 'digest: --level keeps one level');
  ok(core.runReflect({ project: D, since: '2026-08-01' }).reflections === 8, 'digest: --since moves the window');
  ok(Math.abs(core.parseTs(core.runReflect({ project: D }).since).getTime() - (Date.now() - 7 * 86400000)) < 120000, 'digest: the default window is the last 7 days');
  ok(throws(() => core.runReflect({ project: D, level: 'worker' }), /level "worker" is not one of/) && throws(() => core.runReflect({}), /project required/),
    'digest: a level off the list, or no project, is an error');

  // --json keeps one shape, whatever the data holds
  const shape = (o) => Array.isArray(o) ? (o.length ? [shape(o[0])] : []) : o && typeof o === 'object'
    ? Object.fromEntries(Object.keys(o).sort().map(k => [k, shape(o[k])])) : typeof o;
  const j = JSON.parse(cli(['reflect', '--project', D, '--since', '2026-09-30', '--json']).stdout);
  const empty = JSON.parse(cli(['reflect', '--project', 'nothing-here', '--json']).stdout);
  ok(JSON.stringify(Object.keys(j)) === JSON.stringify(['project', 'since', 'level', 'reflections', 'roles', 'obstacles', 'rules', 'decisions']) &&
    JSON.stringify(Object.keys(empty)) === JSON.stringify(Object.keys(j)), 'CLI: hub reflect --json has the same keys, empty or full');
  ok(JSON.stringify(shape(empty.obstacles)) === JSON.stringify(shape(Object.fromEntries(Object.entries(j.obstacles).map(([k, v]) => [k, { ...v, facts: [] }])))),
    'CLI: every obstacle class is there with no data');
  const role = Object.values(j.roles)[0];
  ok(JSON.stringify(Object.keys(role.result)) === JSON.stringify([...R.RESULTS, 'other']) &&
    JSON.stringify(Object.keys(role.obstacle)) === JSON.stringify([...R.OBSTACLES, 'unclassified']) &&
    Object.values(j.roles).every(p => JSON.stringify(shape(p)) === JSON.stringify(shape(role))), 'CLI: every role carries every result and every class, zeros included');
  ok(JSON.stringify(shape(j.rules[0])) === JSON.stringify({ count: 'number', last: 'string', roles: ['string'], rule: 'string' }) &&
    JSON.stringify(shape(j.decisions[0])) === JSON.stringify({ level: 'string', role: 'string', rule: 'string', ts: 'string', verdict: 'string' }) &&
    JSON.stringify(shape(j.obstacles.environment.facts[0])) === JSON.stringify({ fact: 'string', role: 'string', ts: 'string' }),
    'CLI: a rule, a decision and a fact have their fields');
  const txt = cli(['reflect', '--project', D, '--since', '2026-09-30']);
  ok(txt.code === 0 && /rfdigest: 7 reflection\(s\)/.test(txt.stdout) && /environment 4/.test(txt.stdout) && /×3 MEASURE the disk/.test(txt.stdout),
    'CLI: hub reflect prints the same digest for a person');
  ok(cli(['reflect', '--project', D, '--since', 'yesterday']).code !== 0 && cli(['reflect']).code !== 0, 'CLI: a bad --since, or no --project, exits non-zero');
}
ok(core.sinceToMs('2d', 1e12) === 1e12 - 2 * 86400000 && core.sinceToMs('3h', 1e12) === 1e12 - 3 * 3600000 &&
  core.sinceToMs('2026-10-01') === Date.UTC(2026, 9, 1) && core.sinceToMs('2026-10-01 14:00') === Date.UTC(2026, 9, 1, 14) &&
  core.sinceToMs('2026-10-01T14:00:00Z') === Date.UTC(2026, 9, 1, 14) && throws(() => core.sinceToMs('soon'), /neither a duration/),
  'since: a duration or a time, nothing else');

// ── recall finds a rule and an obstacle as hits of their own ──
{
  const q = recallLib.runRecall({ query: 'disk first', project: 'rfdigest' });
  const rule = q.hits.find(h => h.kind === 'rule');
  ok(rule && /^MEASURE the disk, first!$|^measure the disk first$|^Measure the disk first\.$/.test(rule.text) && / rule$/.test(rule.where),
    `recall: a rule is a hit of its own, the rule as its text (${rule && rule.text})`);
  ok(!q.hits.some(h => h.kind === 'journal' && /dev-[ab]\]/.test(h.where) && /disk first/i.test(h.text)), 'recall: and the journal hit for the same entry no longer repeats it');
  const ob = recallLib.runRecall({ query: 'exit 28', project: 'rfdigest' }).hits.find(h => h.kind === 'obstacle');
  ok(ob && ob.text === 'exit 28 on write' && / obstacle environment$/.test(ob.where), 'recall: an obstacle fact is a hit, its class in where');
  ok(recallLib.runRecall({ query: 'check the path first', project: 'rfdigest' }).hits.some(h => h.kind === 'journal' && /instead: check the path first/.test(h.text)),
    'recall: goal and instead are still found, in the journal hit');
}

// ── over MCP ──
{
  const reqs = [
    { id: 1, method: 'tools/list', params: {} },
    { id: 2, method: 'tools/call', params: { name: 'hub_report', arguments: { project: 'rfmcp', agent: 'dev-m', text: 'over mcp', reflect: GOOD } } },
    { id: 3, method: 'tools/call', params: { name: 'hub_report', arguments: { project: 'rfmcp', agent: 'dev-m', text: 'over mcp', reflect: { ...GOOD, obstacle: 'luck' } } } },
  ].map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n';
  let out = '';
  try { out = execSync(`node ${REPO}/hub/index.mjs`, { input: reqs, encoding: 'utf8', env: { ...process.env }, timeout: 15000 }); } catch (e) { out = e.stdout || ''; }
  const res = {};
  for (const l of out.split('\n')) { try { const m = JSON.parse(l); if (m.id != null) res[m.id] = m; } catch {} }
  const s = (res[1]?.result?.tools || []).find(t => t.name === 'hub_report')?.inputSchema?.properties?.reflect;
  ok(s && s.properties.result.enum.join() === R.RESULTS.join() && s.properties.obstacle.enum.join() === R.OBSTACLES.join() &&
    s.properties.level.enum.join() === R.LEVELS.join() && s.required.join() === 'goal,result,obstacle,instead,rule', 'MCP: hub_report declares the reflect field with the same lists');
  ok(res[2]?.result && !res[2].result.isError && /"source":\s*"field"/.test(res[2].result.content[0].text), 'MCP: a report with the field is filed');
  ok(res[3]?.result?.isError && /obstacle "luck" is not one of/.test(res[3].result.content[0].text), 'MCP: an off-list value is refused with the list');
}

done();
