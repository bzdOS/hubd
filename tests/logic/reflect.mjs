// reflect.mjs — a turn's reflection as data: checked as a field, read from the text, counted by a digest
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, T0, ok, core, recallLib, cli, mktmp, done } from './_h.mjs';

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
  // The copies the fleet wrote: the rule alone, without "only", after the fragment's lines restated.
  for (const rule of [R.EXAMPLE_RULE, "Keep build recipes inside the role's allowed paths.",
    'do not claim what you have not measured; done only with a named artifact; keep build recipes inside role\'s allowed paths per head'])
    ok(throws(() => R.checkReflect({ ...GOOD, rule }), /rule holds the example's rule .* write what this turn taught, or "none"/),
      `reflect: a rule that holds the example's is refused (${rule.slice(0, 50)})`);
  ok(R.checkReflect({ ...GOOD, rule: 'keep build recipes inside the allowed paths' }).rule && !R.isExampleRule('keep recipes in the tree'),
    'reflect: a rule near it but not holding it is kept');
}

// ── the text: read, not checked ──
{
  const frag = fs.readFileSync(path.join(REPO, 'prompts/meta/fragments/reflect.md'), 'utf8');
  const example = frag.split('Example, the end of a report')[1].match(/```\n([\s\S]*?)```/)[1];
  const r = R.readReflect(example);
  ok(r && r.level === 'turn' && r.result === 'partial' && r.obstacle === 'permissions' &&
    /^read refused on a directory outside the list/.test(r.obstacle_fact) && /^keep build recipes/.test(r.rule),
    'reflect: the fragment\'s own example reads into the fields');
  ok(r.rule === R.EXAMPLE_RULE && JSON.stringify(r.problems) === JSON.stringify(["rule holds the example's rule, not this turn's"]),
    `reflect: its rule is EXAMPLE_RULE, and the only problem in it (${JSON.stringify(r.problems)})`);
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

// ── the block's own rules, beyond the lists: both forms ──
{
  // The values off the lists: the field refuses with the list, the text names it.
  ok(throws(() => R.checkReflect({ ...GOOD, result: 'maybe' }), /result "maybe" is not one of done \| partial \| no/), 'shape: result "maybe" is refused with the list');
  ok(throws(() => R.checkReflect({ ...GOOD, obstacle: '', obstacle_fact: '' }), /obstacle null is not one of permissions \| path/), 'shape: partial with no class is refused with the list');
  ok(R.readReflect('REFLECT\ngoal: g\nresult: maybe\nobstacle: none\ninstead: i\nrule: none').problems.some(p => /result "maybe" is not one of done \| partial \| no/.test(p)),
    'shape: and in the text, result "maybe" is a problem with the list');
  // Russian for "hinder: weather", escaped: the public tree stays ASCII.
  const hinder = '\u043c\u0435\u0448\u0430\u043b\u043e: \u043f\u043e\u0433\u043e\u0434\u0430';
  const weather = R.readReflect(`x\nREFLECT\ngoal: g\nresult: done\n${hinder}\ninstead: i\nrule: none`);
  ok(weather && weather.obstacle === null && weather.problems.includes('no obstacle'), `shape: an obstacle under a key not read is "no obstacle", not a silent class (${JSON.stringify(weather.problems)})`);
  const cls = R.readReflect('REFLECT\ngoal: g\nresult: partial\nobstacle: \u043f\u043e\u0433\u043e\u0434\u0430\ninstead: i\nrule: none');
  ok(cls.obstacle === null && cls.problems.some(p => /obstacle class "\u043f\u043e\u0433\u043e\u0434\u0430" is not one of permissions/.test(p)), 'shape: a class off the list in another language is a problem with the list');
  // Every key in another language: the marker alone, on its own line, is still a block meant.
  const keys = ['\u0446\u0435\u043b\u044c: g', '\u0438\u0442\u043e\u0433: done', hinder, '\u0432\u043c\u0435\u0441\u0442\u043e: i', '\u043f\u0440\u0430\u0432\u0438\u043b\u043e: none'];
  for (const text of [`did it\nREFLECT\n${keys.join('\n')}`, `did it · REFLECT · ${keys.join(' · ')}`, `did it\nREFLECT:\n${keys.join('\n')}`]) {
    const r = R.readReflect(text);
    ok(r && r.level === 'turn' && r.result === null && r.obstacle === null && r.problems.length === 1 && /REFLECT is followed by no result: or obstacle: line.*the keys are goal, result, obstacle, instead, rule, in English/.test(r.problems[0]),
      `shape: REFLECT with no key read is read as empty, with the one problem that says why (${JSON.stringify(text.slice(0, 20))})`);
  }
  ok(R.readReflect('NOTE: REFLECT on this later') === null && R.readReflect('we should REFLECT more\non it') === null, 'shape: the word in prose is still no block');
  // instead "none": only with done and none.
  ok(R.checkReflect({ ...GOOD, result: 'done', obstacle: 'none', obstacle_fact: '', instead: 'none' }).instead === 'none', 'shape: instead "none" with done and none is kept');
  for (const instead of ['none', 'nothing', 'N/A', '-'])
    ok(throws(() => R.checkReflect({ ...GOOD, instead }), /instead ".*" only with result "done" and obstacle "none"; say what you would do differently$/), `shape: instead ${JSON.stringify(instead)} with partial and a class is refused`);
  ok(throws(() => R.checkReflect({ ...GOOD, obstacle: 'none', obstacle_fact: '', instead: 'nothing' }), /or, for a run not finished yet, what it waits for/),
    'shape: with partial and none the refusal says what instead is for');
  ok(R.checkReflect({ ...GOOD, obstacle: 'none', obstacle_fact: '', instead: 'waiting for the test run, tests.log' }).result === 'partial', 'shape: partial with none and what it waits for is kept');
  // `no` names what held it up.
  ok(throws(() => R.checkReflect({ ...GOOD, result: 'no', obstacle: 'none', obstacle_fact: '' }), /result "no" with obstacle "none": .* one of permissions \| path \| unclear-dispatch \| environment \| model$/),
    'shape: no with none is refused, the classes listed');
  // One rule.
  ok(throws(() => R.checkReflect({ ...GOOD, rule: 'measure first; name the artifact; ask once' }), /rule holds more than one rule/), 'shape: three rules joined with ";" are refused');
  ok(R.checkReflect({ ...GOOD, rule: 'run `make clean; make` before a build' }).rule, 'shape: a ";" inside backticks is a command, not a second rule');
  const text = R.readReflect('x · REFLECT · goal: g · result: partial · obstacle: none · instead: none · rule: a; b');
  ok(text.problems.length === 2 && /instead "none" only with/.test(text.problems[0]) && /more than one rule/.test(text.problems[1]),
    `shape: the text names every one of them (${JSON.stringify(text.problems)})`);
  ok(/result "no" with obstacle "none"/.test(R.readReflect('REFLECT · goal: g · result: no · obstacle: none · instead: i · rule: none').problems.join()), 'shape: and no with none');
}

// ── a turn that found no work: the waiting line, no block ──
{
  ok(R.isWaitingTurn('waiting for a dispatch from head-a') && R.isWaitingTurn('NOTE: "waiting for a dispatch"') && !R.isWaitingTurn('waiting for a dispatch\nNEXT: x') &&
    !R.isWaitingTurn('built it'), 'waiting: the line alone is a waiting turn, with anything else it is not');
  const w = core.runReport({ project: P, agent: 'dev-w', text: 'waiting for a dispatch from head-a' });
  ok(w.note && !w.reflect && !tail().at(-1).reflect, 'waiting: the line alone is filed, and no reflection is asked of it');
  const wb = core.runReport({ project: P, agent: 'dev-w', text: 'waiting for a dispatch\nREFLECT\ngoal: g\nresult: done\nobstacle: none\ninstead: none\nrule: none' });
  ok(wb.reflect && wb.reflect.problems.length === 1 && /only waits for a dispatch takes no reflection/.test(wb.reflect.problems[0]), `waiting: with a block, the block is the problem (${JSON.stringify(wb.reflect.problems)})`);
  const before = tail().length;
  ok(throws(() => core.runReport({ project: P, agent: 'dev-w', text: 'waiting for a dispatch', reflect: { ...GOOD, result: 'done', obstacle: 'none', obstacle_fact: '', instead: 'none' } }),
    /only waits for a dispatch takes no reflection/) && tail().length === before, 'waiting: with the field, the report is refused and nothing written');
  const ru = core.runReport({ project: P, agent: 'dev-w', text: 'did it\nREFLECT\n\u0446\u0435\u043b\u044c: g\n\u0438\u0442\u043e\u0433: done' });
  ok(ru.reflect && ru.reflect.problems && /is followed by no result: or obstacle: line/.test(ru.reflect.problems[0]), 'report: a block with no key read is in the reply, not silent');
  const c = cli(['report', '-p', P, '--agent', 'dev-w', '-m', 'did it\nREFLECT\n\u0446\u0435\u043b\u044c: g']);
  ok(c.code === 0 && /reflection filed, off the rules: REFLECT is followed by no result/.test(c.stderr), `CLI: and on stderr (${c.stderr.trim().slice(0, 90)})`);
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
  ok(JSON.stringify(Object.keys(j)) === JSON.stringify(['project', 'since', 'level', 'reflections', 'roles', 'obstacles', 'rules', 'exampleRule', 'decisions']) &&
    JSON.stringify(Object.keys(empty)) === JSON.stringify(Object.keys(j)), 'CLI: hub reflect --json has the same keys, empty or full');
  ok(JSON.stringify(shape(empty.obstacles)) === JSON.stringify(shape(Object.fromEntries(Object.entries(j.obstacles).map(([k, v]) => [k, { ...v, facts: [] }])))),
    'CLI: every obstacle class is there with no data');
  const role = Object.values(j.roles)[0];
  ok(JSON.stringify(Object.keys(role.result)) === JSON.stringify([...R.RESULTS, 'other']) &&
    JSON.stringify(Object.keys(role.obstacle)) === JSON.stringify([...R.OBSTACLES, 'unclassified']) &&
    Object.values(j.roles).every(p => JSON.stringify(shape(p)) === JSON.stringify(shape(role))), 'CLI: every role carries every result and every class, zeros included');
  ok(JSON.stringify(shape(j.rules[0])) === JSON.stringify({ count: 'number', last: 'string', roles: ['string'], rule: 'string', variants: [] }) &&
    JSON.stringify(shape(j.decisions[0])) === JSON.stringify({ level: 'string', role: 'string', rule: 'string', ts: 'string', verdict: 'string' }) &&
    JSON.stringify(shape(j.obstacles.environment.facts[0])) === JSON.stringify({ fact: 'string', role: 'string', ts: 'string' }) &&
    JSON.stringify(empty.exampleRule) === '{"count":0,"roles":[]}',
    'CLI: a rule, a decision, a fact and the example count have their fields');
  const txt = cli(['reflect', '--project', D, '--since', '2026-09-30']);
  ok(txt.code === 0 && /rfdigest: 7 reflection\(s\)/.test(txt.stdout) && /environment 4/.test(txt.stdout) && /×3 MEASURE the disk/.test(txt.stdout),
    'CLI: hub reflect prints the same digest for a person');
  ok(cli(['reflect', '--project', D, '--since', 'yesterday']).code !== 0 && cli(['reflect']).code !== 0, 'CLI: a bad --since, or no --project, exits non-zero');
}
// ── the example's rule, counted apart from the rules ──
{
  const X = 'rfexample';
  const ex = (agent, ts, rule) => core.journalAppend({ ts, project: X, agent, kind: 'done',
    text: `turn · REFLECT · goal: g · result: done · obstacle: none · instead: i · rule: ${rule}` });
  ex('dev-a', '2026-10-02 10:00', R.EXAMPLE_RULE);
  ex('dev-a', '2026-10-02 11:00', R.EXAMPLE_RULE);
  ex('dev-b', '2026-10-02 12:00', 'report obstacles with a number; ' + R.EXAMPLE_RULE);
  ex('dev-b', '2026-10-02 13:00', 'pin the toolchain');
  ex('dev-a', '2026-10-02 14:00', 'pin the toolchain');
  const d = core.runReflect({ project: X, since: '2026-10-01' });
  ok(d.reflections === 5 && d.exampleRule.count === 3 && d.exampleRule.roles.join() === 'dev-a,dev-b',
    `digest: three rules that hold the example's are counted, with their roles (${JSON.stringify(d.exampleRule)})`);
  ok(d.rules.length === 1 && d.rules[0].rule === 'pin the toolchain', 'digest: and none of them is a rule proposed more than once');
  const txt = cli(['reflect', '--project', X, '--since', '2026-10-01']);
  ok(/the example's rule, not counted as a rule: ×3 {2}\(dev-a, dev-b\)/.test(txt.stdout), `CLI: hub reflect says how many held it (${txt.stdout.trim().split('\n').at(-1)})`);
  ok(!recallLib.runRecall({ query: 'build recipes', project: X }).hits.some(h => h.kind === 'rule') &&
    recallLib.runRecall({ query: 'toolchain', project: X }).hits.some(h => h.kind === 'rule'), 'recall: a rule that holds the example is no hit, another rule is');
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

// ── one rule in other words ──
{
  const S = R.ruleSimilarity;
  ok(S('run the tests before the push', 'before the push, run the tests') === 1, 'rules: a reordered wording is the same rule');
  ok(S('verify checksums before deploying', 'verified the checksum before deployment') >= R.SAME_RULE &&
    S('\u043f\u0440\u043e\u0432\u0435\u0440\u044f\u0442\u044c \u043a\u043e\u043d\u0442\u0440\u043e\u043b\u044c\u043d\u044b\u0435', '\u043f\u0440\u043e\u0432\u0435\u0440\u0438\u043b \u043a\u043e\u043d\u0442\u0440\u043e\u043b\u044c\u043d\u0443\u044e') === 1,
    'rules: a word is its first five letters, so an inflected one is the same word, in any script');
  ok(S('64 hex', '6 hex') < R.SAME_RULE && S('64 hex', '64 HEX!') === 1, 'rules: a number is a word of its own, so 64 is not 6');
  ok(S('alpha bravo charlie delta', 'alpha bravo echo') === R.SAME_RULE && S('alpha bravo charlie delta', 'alpha bravo echo foxtrot') < R.SAME_RULE,
    `rules: two words of five shared is one rule, two of six is not (SAME_RULE ${R.SAME_RULE})`);

  const at = (rule, role, h) => ({ rule, role, ts: `2026-10-03 ${String(h).padStart(2, '0')}:00`, ms: Date.UTC(2026, 9, 3, h) });
  const A = 'alpha bravo charlie delta', B = 'alpha bravo charlie echo', C = 'bravo charlie echo foxtrot';
  const g = R.promoteCandidates([at(A, 'dev-a', 1), at(A, 'dev-a', 2), at(C, 'dev-b', 3), at(C, 'dev-c', 4), at(A, 'dev-a', 5), at(B, 'dev-a', 6), at(B, 'dev-a', 7)]);
  ok(g.length === 2 && g[0].rule === A && g[0].count === 5 && g[0].by['dev-a'] === 5 && g[0].last === '2026-10-03 07:00' &&
    JSON.stringify(g[0].variants) === JSON.stringify([{ rule: B, count: 2 }]) && g[0].id === R.ruleId(A),
    `promote: a wording joins the most repeated one it resembles, counted with it as a variant (${JSON.stringify(g[0])})`);
  ok(g[1] && g[1].rule === C && g[1].count === 2 && Object.keys(g[1].by).join() === 'dev-b,dev-c',
    'promote: one that resembles the variant but not the rule stays a rule of its own, never a chain');

  const X = 'keep the build log beside the package';
  ok(R.promoteCandidates([at(X, 'dev-a', 1), at(X, 'dev-a', 2)]).length === 0, 'promote: twice by one role is no candidate');
  ok(R.promoteCandidates([at(X, 'dev-a', 1), at(X, 'dev-a', 2), at(X, 'dev-a', 3)]).length === 1, 'promote: three times by one role is');
  ok(R.promoteCandidates([at(X, 'dev-a', 1), at('the package, and beside it the build log, kept', 'dev-b', 2)])[0]?.count === 2, 'promote: and so is once each by two roles, worded apart');
  ok(R.promoteCandidates([at(X, 'dev-a', 1), at(X, 'dev-b', 2)], { laws: ['the build log is kept beside the package'] }).length === 0,
    'promote: a rule that is a law already, in whatever words, is no candidate');
  const no = { rule: X, ...at(X, 'dev-h', 2) };
  ok(R.promoteCandidates([at(X, 'dev-a', 1), at(X, 'dev-a', 2), at(X, 'dev-a', 3), at(X, 'dev-a', 4)], { rejected: [no] }).length === 0,
    'promote: a rejected one counts only what was said after the rejection');
  const back = R.promoteCandidates([at(X, 'dev-a', 1), at(X, 'dev-a', 2), at(X, 'dev-a', 3), at(X, 'dev-a', 4), at(X, 'dev-a', 5)], { rejected: [no] });
  ok(back.length === 1 && back[0].count === 3 && back[0].rejected === '2026-10-03 02:00', 'promote: said three times since, it is back, with the rejection it outlived');
}

// ── a project's laws: the candidates, the head's verdict, the card ──
{
  const P = 'rflaw';
  const say = (project, agent, ts, rule) => core.journalAppend({ ts, project, agent, kind: 'done', text: 'turn', reflect: R.checkReflect({ ...GOOD, rule }) });
  const sayText = (project, agent, ts, rule) => core.journalAppend({ ts, project, agent, kind: 'done', text: `turn · REFLECT · goal: g · result: done · obstacle: none · instead: i · rule: ${rule}` });
  const L1 = 'pin the toolchain version before a build', L1b = 'before a build, pin the version of the toolchain';
  const L2 = 'ask the head before touching the schema', L3 = 'name the file in every report';
  say(P, 'dev-a', '2026-10-02 10:00', L1); say(P, 'dev-b', '2026-10-02 10:10', L1); say(P, 'dev-a', '2026-10-02 10:20', L1b);
  say(P, 'dev-a', '2026-10-02 10:30', L1); say(P, 'dev-a', '2026-10-02 10:40', L2); say(P, 'dev-b', '2026-10-02 10:50', L2);
  say(P, 'dev-a', '2026-10-02 11:00', L3); say(P, 'dev-a', '2026-10-02 11:10', L3);
  say(P, 'dev-a', '2026-10-02 11:20', 'none'); sayText(P, 'dev-a', '2026-10-02 11:30', R.EXAMPLE_RULE); sayText(P, 'dev-b', '2026-10-02 11:40', R.EXAMPLE_RULE);
  say('elsewhere', 'dev-a', '2026-10-02 11:50', L3);

  const p = core.runPromote({ project: P, since: '2026-10-01' });
  ok(p.project === P && p.since === '2026-10-01 00:00' && p.laws.length === 0 && p.candidates.map(c => c.rule).join('|') === `${L1}|${L2}`,
    `law: the candidates of the project in the window, most said first, none of "none", the example or another project (${p.candidates.map(c => c.rule).join(' | ')})`);
  ok(p.candidates[0].count === 4 && p.candidates[0].variants[0]?.rule === L1b && p.candidates[0].by['dev-a'] === 3, 'law: a reworded one counts with its rule');
  ok(Math.abs(core.parseTs(core.runPromote({ project: P }).since).getTime() - (Date.now() - 7 * 86400000)) < 120000, 'law: the default window is the last 7 days');

  const id2 = p.candidates[1].id;
  ok(throws(() => core.runLaw({ project: P, id: 'abcdef', verdict: 'accept', by: 'dev-h', since: '2026-10-01' }), /no candidate abcdef for rflaw since 2026-10-01 00:00; hub reflect --promote --project rflaw lists them/) &&
    throws(() => core.runLaw({ project: P, id: id2, verdict: 'maybe', by: 'dev-h' }), /verdict "maybe" is not one of accept \| reject/) &&
    throws(() => core.runLaw({ project: P, verdict: 'accept', by: 'dev-h' }), /id required/) &&
    throws(() => core.runLaw({ project: P, id: id2, verdict: 'accept' }), /by required/), 'law: an unknown id, a verdict off the list, no id or nobody signing is an error');

  const a = core.runLaw({ project: P, id: R.ruleId(L1b), verdict: 'accept', by: 'dev-h', since: '2026-10-01' });
  const card = fs.readFileSync(core.cardPath(P), 'utf8');
  ok(a.ok && a.verdict === 'accepted' && a.rule === L1 && a.section === 'Laws' && new RegExp(`## Laws\\n\\n- \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d \\(dev-h\\): ${L1}\\n`).test(card),
    `law: accepted by a variant's id, the rule is a line of the card's Laws section (${a.section})`);
  const law = core.projectLaws(P);
  ok(law.length === 1 && law[0].rule === L1 && law[0].by === 'dev-h' && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(law[0].since), 'law: projectLaws reads it back, who and when');
  const je = core.journalTail(P, 1)[0];
  ok(je && je.kind === 'decision' && je.agent === 'dev-h' && je.law.verdict === 'accepted' && je.law.rule === L1 && je.law.count === 4 && je.law.roles['dev-b'] === 1,
    `law: and a decision in the journal, with the count and the roles (${JSON.stringify(je && je.law)})`);
  const p2 = core.runPromote({ project: P, since: '2026-10-01' });
  ok(p2.laws.length === 1 && p2.candidates.map(c => c.rule).join() === L2, 'law: a law is no candidate any more');

  const r = core.runLaw({ project: P, id: id2, verdict: 'reject', by: 'dev-h', reason: ' the schema\n has an owner ', since: '2026-10-01' });
  const jr = core.journalTail(P, 1)[0];
  ok(r.verdict === 'rejected' && !r.section && jr.law.verdict === 'rejected' && jr.law.reason === 'the schema has an owner' && core.projectLaws(P).length === 1,
    'law: a rejection is a journal decision with its reason, and no law');
  ok(core.runPromote({ project: P, since: '2026-10-01' }).candidates.length === 0, 'law: a rejected one is off the list');

  const Q = 'rflaw-again';
  say(Q, 'dev-a', '2026-10-02 10:00', L2); say(Q, 'dev-b', '2026-10-02 10:10', L2);
  core.journalAppend({ ts: '2026-10-02 11:00', project: Q, agent: 'dev-h', kind: 'decision', text: 'law candidate rejected', law: { verdict: 'rejected', id: R.ruleId(L2), rule: L2 } });
  ok(core.runPromote({ project: Q, since: '2026-10-01' }).candidates.length === 0, 'law: rejected, a rule said before stays off');
  say(Q, 'dev-a', '2026-10-02 12:00', L2); say(Q, 'dev-b', '2026-10-02 12:10', 'ask the head before touching the schema!');
  const again = core.runPromote({ project: Q, since: '2026-10-01' }).candidates;
  ok(again.length === 1 && again[0].count === 2 && again[0].rejected === '2026-10-02 11:00', 'law: said again by two roles after it, it is back');

  const ctxDir = mktmp(); fs.writeFileSync(path.join(ctxDir, '.hubd'), P + '\n');
  ok(JSON.stringify(core.runContext({ cwd: ctxDir }).laws) === JSON.stringify([L1]) && JSON.stringify(core.runContext({ cwd: mktmp() }).laws) === '[]',
    'context: hub_context gives every role the project\'s laws, none outside a project');

  // a project with a head on record is the head's to rule on, or a fleet role's
  const H = 'rflaw-head', made = ['rfl-head', 'rfl-dev', 'rfl-fleet'];
  core.runResourceSet({ slug: 'rfl-head', type: 'role', attrs: { rank: 'head', project: H }, by: 'dev-t' });
  core.runResourceSet({ slug: 'rfl-dev', type: 'role', attrs: { rank: 'worker', project: H }, edges: { head: ['rfl-head'] }, by: 'dev-t' });
  core.runResourceSet({ slug: 'rfl-fleet', type: 'role', attrs: { rank: 'fleet', project: 'fleet' }, by: 'dev-t' });
  const L4 = 'write the plan before the code', L5 = 'one commit per task';
  for (const h of [10, 11, 12]) { say(H, 'rfl-dev', `2026-10-02 ${h}:00`, L4); say(H, 'rfl-dev', `2026-10-02 ${h}:30`, L5); }
  const hp = core.runPromote({ project: H, since: '2026-10-01' });
  const [i4, i5] = [L4, L5].map(l => hp.candidates.find(c => c.rule === l)?.id);
  ok(throws(() => core.runLaw({ project: H, id: i4, verdict: 'accept', by: 'rfl-dev', since: '2026-10-01' }), /a law of rflaw-head is its head's to rule on \(rfl-head\) or a fleet role's; rfl-dev is of rank worker/) &&
    throws(() => core.runLaw({ project: H, id: i4, verdict: 'accept', by: 'dev-x', since: '2026-10-01' }), /dev-x is no role on record/),
    'law: a worker of the project, or a name with no role card, may not rule on it');
  ok(core.runLaw({ project: H, id: i5, verdict: 'reject', by: 'rfl-fleet', since: '2026-10-01' }).verdict === 'rejected' &&
    core.runLaw({ project: H, id: i4, verdict: 'accept', by: 'rfl-head', since: '2026-10-01' }).verdict === 'accepted' &&
    core.projectLaws(H).map(l => `${l.by}: ${l.rule}`).join() === `rfl-head: ${L4}`, 'law: its head may, and so may a fleet role');
  for (const m of made) fs.rmSync(path.join(T0, 'resources', m + '.md'), { force: true });

  // the CLI
  const Z = 'rflaw-cli', Z1 = 'say the exit code in the report', Z1b = 'the report says the exit code';
  say(Z, 'dev-a', '2026-10-02 10:00', Z1); say(Z, 'dev-b', '2026-10-02 10:10', Z1b);
  const pr = cli(['reflect', '--promote', '--project', Z, '--since', '2026-10-01']);
  const zid = core.runPromote({ project: Z, since: '2026-10-01' }).candidates[0]?.id;
  ok(pr.code === 0 && /^rflaw-cli: 1 candidate\(s\) for the project's laws since 2026-10-01 00:00 \(a rule said 3 times by one role, or by 2 roles\), 0 law\(s\) already$/m.test(pr.stdout) &&
    new RegExp(`^ {2}${zid} {2}×2 {2}dev-a 1, dev-b 1; last 2026-10-02 10:10$`, 'm').test(pr.stdout) && pr.stdout.includes(`    ~ ×1 `) &&
    /accept: hub reflect --accept <id> --project rflaw-cli --by <head>/.test(pr.stdout), `CLI: hub reflect --promote lists the candidates and how to rule on them (${pr.stdout.split('\n').slice(2, 3)})`);
  ok(JSON.parse(cli(['reflect', '--promote', '--project', Z, '--since', '2026-10-01', '--json']).stdout).candidates[0].id === zid, 'CLI: and --json');
  const both = cli(['reflect', '--accept', zid, '--reject', zid, '--project', Z, '--by', 'dev-h']);
  const none = cli(['reflect', '--accept', 'abcdef', '--project', Z, '--by', 'dev-h', '--since', '2026-10-01']);
  ok(both.code !== 0 && /--accept or --reject, not both/.test(both.stderr) && none.code !== 0 && /no candidate abcdef/.test(none.stderr),
    'CLI: --accept with --reject, or an unknown id, exits non-zero and says why');
  const acc = cli(['reflect', '--accept', zid, '--project', Z, '--by', 'dev-h', '--since', '2026-10-01']);
  ok(acc.code === 0 && acc.stdout.startsWith("law of rflaw-cli, in its card's Laws section: "), `CLI: hub reflect --accept makes it a law (${acc.stdout.trim()})`);
  const lw = cli(['reflect', '--laws', '--project', Z]);
  const lj = JSON.parse(cli(['reflect', '--laws', '--project', Z, '--json']).stdout);
  ok(lw.code === 0 && /^- (say the exit code in the report|the report says the exit code)\n$/.test(lw.stdout) && lj.length === 1 && lj[0].by === 'dev-h',
    'CLI: hub reflect --laws lists the laws, --json with who and when');
}

// ── over MCP ──
const MCP_RULE = 'quote the error line in the report';
for (const h of [10, 11, 12]) core.journalAppend({ ts: `2026-10-02 ${h}:00`, project: 'rflaw-mcp', agent: 'dev-m', kind: 'done', text: 'turn', reflect: R.checkReflect({ ...GOOD, rule: MCP_RULE }) });
{
  const reqs = [
    { id: 1, method: 'tools/list', params: {} },
    { id: 2, method: 'tools/call', params: { name: 'hub_report', arguments: { project: 'rfmcp', agent: 'dev-m', text: 'over mcp', reflect: GOOD } } },
    { id: 3, method: 'tools/call', params: { name: 'hub_report', arguments: { project: 'rfmcp', agent: 'dev-m', text: 'over mcp', reflect: { ...GOOD, obstacle: 'luck' } } } },
    { id: 4, method: 'tools/call', params: { name: 'hub_reflect', arguments: { project: 'rfdigest', since: '2026-09-30' } } },
    { id: 5, method: 'tools/call', params: { name: 'hub_reflect', arguments: { project: 'rfdigest', level: 'worker' } } },
    { id: 6, method: 'tools/call', params: { name: 'hub_report', arguments: { project: 'rfmcp', agent: 'dev-m', text: 'over mcp', reflect: { ...GOOD, rule: R.EXAMPLE_RULE } } } },
    { id: 7, method: 'tools/call', params: { name: 'hub_reflect', arguments: { project: 'rflaw', since: '2026-10-01', promote: true } } },
    { id: 8, method: 'tools/call', params: { name: 'hub_law', arguments: { project: 'rflaw-mcp', id: R.ruleId(MCP_RULE), verdict: 'accept', by: 'dev-h', since: '2026-10-01' } } },
    { id: 9, method: 'tools/call', params: { name: 'hub_law', arguments: { project: 'rflaw-mcp', id: 'abcdef', verdict: 'reject', by: 'dev-h' } } },
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
  ok(res[6]?.result?.isError && /rule holds the example's rule/.test(res[6].result.content[0].text), 'MCP: and so is the example\'s rule');
  const t = (res[1]?.result?.tools || []).find(t => t.name === 'hub_reflect');
  ok(t && t.inputSchema.required.join() === 'project' && t.inputSchema.properties.level.enum.join() === R.LEVELS.join(),
    'MCP: hub_reflect is listed, project required, the levels as its enum');
  const via = res[4]?.result && !res[4].result.isError ? JSON.parse(res[4].result.content[0].text) : null;
  ok(via && JSON.stringify(via) === JSON.stringify(core.runReflect({ project: 'rfdigest', since: '2026-09-30' })),
    `MCP: hub_reflect answers what hub reflect --json does (${JSON.stringify(via).slice(0, 80)})`);
  ok(res[5]?.result?.isError && /level "worker" is not one of/.test(res[5].result.content[0].text), 'MCP: a level off the list is refused');
  const pv = res[7]?.result && !res[7].result.isError ? JSON.parse(res[7].result.content[0].text) : null;
  ok(pv && JSON.stringify(pv) === JSON.stringify(core.runPromote({ project: 'rflaw', since: '2026-10-01' })), 'MCP: hub_reflect with promote answers what hub reflect --promote --json does');
  const lt = (res[1]?.result?.tools || []).find(t => t.name === 'hub_law');
  ok(lt && lt.inputSchema.required.join() === 'project,id,verdict,by' && lt.inputSchema.properties.verdict.enum.join() === 'accept,reject', 'MCP: hub_law is listed, the verdicts as its enum');
  ok(res[8]?.result && !res[8].result.isError && JSON.parse(res[8].result.content[0].text).verdict === 'accepted' && core.projectLaws('rflaw-mcp')[0]?.rule === MCP_RULE,
    'MCP: hub_law accepts a candidate into the project\'s laws');
  ok(res[9]?.result?.isError && /no candidate abcdef/.test(res[9].result.content[0].text), 'MCP: and refuses an id that is no candidate');
}

done();
