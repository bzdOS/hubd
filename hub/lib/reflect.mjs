/* reflect.mjs — a turn's reflection as data: the fields prompts/meta/fragments/reflect.md asks for.
 *
 * Every role ends a turn with five lines: goal, result, obstacle, instead, rule. Read as text, a
 * head groups obstacles by regex over the journal, which is how "waits for a dispatch" was read
 * before heartbeat had fields for it, and broke the same way. So a report can carry the
 * reflection as a field, checked when it is written: a value off the list is an error the writer
 * sees, not a line a digest silently miscounts. The text block is still read, because the fleet
 * writes it today; read, not checked, since refusing a report an older rule asked for would
 * lose the report. Nothing here reads the hub: the caller passes the entries. */

export const RESULTS = ['done', 'partial', 'no'];
export const OBSTACLES = ['permissions', 'path', 'unclear-dispatch', 'environment', 'model', 'none'];
/* What a reflection is over, not who writes it: every role, a head and the orchestrator too,
 * ends its own turn with a `turn` one; `head` is a head's over its workers (HEAD-REFLECT),
 * `fleet` the orchestrator's over the heads (FLEET-REFLECT). */
export const LEVELS = ['turn', 'head', 'fleet'];
export const VERDICTS = ['accepted', 'rejected', 'needs-owner'];
/* The rule of the fragment's own example. On one hub, two roles put it in 86 of 2768 reflections:
 * 45 times alone, 40 of those with obstacle none, and 41 times after the fragment's own lines
 * restated. A model fills the field with the nearest text that fits. A rule that holds it is not
 * the turn's, so the field refuses it, the text names it a problem, and the digest counts it
 * apart from the rules. */
export const EXAMPLE_RULE = "keep build recipes only inside the role's allowed paths";
const MARK = { turn: 'REFLECT', head: 'HEAD-REFLECT', fleet: 'FLEET-REFLECT' };
const FIELDS = ['level', 'goal', 'result', 'obstacle', 'obstacle_fact', 'instead', 'rule', 'decisions'];
const TEXT_KEYS = new Set(['goal', 'result', 'obstacle', 'instead', 'rule', 'decision']);

/* A role's reflection ends its turn's one report (prompts/meta/fragments/reflect.md): a line that
 * is exactly REFLECT, then five `key: value` lines; the journal joins a report's lines with " · ".
 * It used to be a report of its own, which cost a role one more call at the point where a call
 * costs the most — the whole turn re-read. At the end of a long report it fell past the cut the
 * head's order makes, and it is the part the head is told to review. Both forms are read: a
 * reflection that starts the text is all of it. A REFLECT with neither `result:` nor `obstacle:`
 * after it is a word in prose, not a reflection; of several, the last one is the block. */
const REFLECT_AT = /(^|\n|\s·\s)[ \t#·]*((?:HEAD-|FLEET-)?REFLECT)\b/g;
export function splitReflect(text) {
  const s = String(text ?? '');
  let cut = null;
  for (const m of s.matchAll(REFLECT_AT)) {
    const at = m.index + m[0].length - m[2].length;
    if (/\b(?:result|obstacle)\s*:/i.test(s.slice(at))) cut = { body: m.index, at };   // the last one: the block ends the report
  }
  if (!cut) return { body: s, reflect: '' };
  return { body: s.slice(0, cut.body).replace(/[\s·]+$/, ''), reflect: s.slice(cut.at).trim() };
}

const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();
const oneOf = (what, v, list) => {
  if (!list.includes(v)) throw new Error(`reflect: ${what} ${JSON.stringify(v ?? null)} is not one of ${list.join(' | ')}`);
  return v;
};
const str = (r, k) => {
  if (r[k] == null) return '';
  if (typeof r[k] !== 'string') throw new Error(`reflect: ${k} is a string, not ${Array.isArray(r[k]) ? 'an array' : typeof r[k]}`);
  return oneLine(r[k]);
};

/** The reflection a report carries as a field, checked: the known fields only, each enum from its
 *  list, every text field present. Returns it with blank fields dropped and each value on one line,
 *  which is what lets the journal's " · " join keep it readable. Throws on the first defect. */
export function checkReflect(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('reflect: an object {goal, result, obstacle, obstacle_fact, instead, rule}');
  const unknown = Object.keys(r).filter(k => !FIELDS.includes(k));
  if (unknown.length) throw new Error(`reflect: unknown field ${unknown.join(', ')}; the fields are ${FIELDS.join(', ')}`);
  const level = oneOf('level', r.level ?? 'turn', LEVELS);
  const out = { level };
  for (const k of ['goal', 'result', 'obstacle', 'obstacle_fact', 'instead', 'rule']) out[k] = str(r, k);
  for (const k of ['goal', 'instead', 'rule'])
    if (!out[k]) throw new Error(`reflect: ${k} is required${k === 'rule' ? ' ("none" when the turn taught none)' : ''}`);
  if (isExampleRule(out.rule)) throw new Error(`reflect: rule holds the example's rule ("${EXAMPLE_RULE}"), not this turn's; write what this turn taught, or "none"`);
  oneOf('result', out.result || null, RESULTS);
  oneOf('obstacle', out.obstacle || null, OBSTACLES);
  if (out.obstacle === 'none' && out.obstacle_fact) throw new Error('reflect: obstacle "none" takes no obstacle_fact');
  if (out.obstacle !== 'none' && !out.obstacle_fact)
    throw new Error(`reflect: obstacle "${out.obstacle}" needs obstacle_fact: the fact with a number or a quote, or "not measured"`);
  if (!out.obstacle_fact) delete out.obstacle_fact;
  if (r.decisions != null) {
    if (level === 'turn') throw new Error('reflect: decisions belong to a head or fleet reflection (level "head" or "fleet"), not to a turn');
    if (!Array.isArray(r.decisions)) throw new Error('reflect: decisions is a list of {rule, verdict, reason}');
    out.decisions = r.decisions.map((d, i) => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`reflect: decisions[${i}] is an object {rule, verdict, reason}`);
      const extra = Object.keys(d).filter(k => !['rule', 'verdict', 'reason'].includes(k));
      if (extra.length) throw new Error(`reflect: decisions[${i}] has unknown field ${extra.join(', ')}; the fields are rule, verdict, reason`);
      const rule = str(d, 'rule'), reason = str(d, 'reason');
      if (!rule) throw new Error(`reflect: decisions[${i}].rule is required: the proposal the verdict is on`);
      return { rule, verdict: oneOf(`decisions[${i}].verdict`, str(d, 'verdict'), VERDICTS), ...(reason ? { reason } : {}) };
    });
  }
  return out;
}

/** A checked reflection as the block the fragment shows, one line per field, so a reader of the
 *  journal's text, the head's order among them, sees what the field holds. */
export function renderReflect(r) {
  return [
    MARK[r.level || 'turn'],
    `goal: ${r.goal}`,
    `result: ${r.result}`,
    `obstacle: ${r.obstacle}${r.obstacle_fact ? ' — ' + r.obstacle_fact : ''}`,
    `instead: ${r.instead}`,
    `rule: ${r.rule}`,
    ...(r.decisions || []).map(d => `decision: ${d.verdict}${d.reason ? ' (' + d.reason + ')' : ''} — ${d.rule}`),
  ].join('\n');
}

/** The reflection block at the end of a report's text, read into the same fields, or null when the
 *  text has none. Lenient, as the text is what roles already write: a value off the list becomes
 *  null and a line in `problems`, never an error. A segment with no known key continues the field
 *  before it, since the journal joins lines, and a value's own " · ", with the same separator. */
export function readReflect(text) {
  const { reflect } = splitReflect(text);
  if (!reflect) return null;
  const head = /^((?:HEAD-|FLEET-)?REFLECT)\b[:\s·]*/.exec(reflect);
  const level = head[1] === 'HEAD-REFLECT' ? 'head' : head[1] === 'FLEET-REFLECT' ? 'fleet' : 'turn';
  const raw = {}, said = [];
  let key = null;
  for (const seg of reflect.slice(head[0].length).split(/\s·\s|\n/)) {
    const m = /^\s*(?:[-*]\s+)?([a-z]+)\s*:\s*(.*)$/i.exec(seg);
    if (m && TEXT_KEYS.has(m[1].toLowerCase())) {
      key = m[1].toLowerCase();
      if (key === 'decision') said.push(m[2].trim());
      else raw[key] = raw[key] == null ? m[2].trim() : raw[key] + ' · ' + m[2].trim();
    } else if (key === 'decision' && seg.trim()) said[said.length - 1] += ' · ' + seg.trim();
    else if (key && seg.trim()) raw[key] += ' · ' + seg.trim();
  }
  const problems = [];
  for (const k of ['goal', 'instead', 'rule']) if (!raw[k]) problems.push(`no ${k}`);
  if (isExampleRule(raw.rule)) problems.push("rule holds the example's rule, not this turn's");
  const res = (/^[a-z-]+/i.exec(raw.result || '') || [''])[0].toLowerCase();
  if (!RESULTS.includes(res)) problems.push(raw.result == null ? 'no result' : `result ${JSON.stringify(raw.result)} is not one of ${RESULTS.join(' | ')}`);
  const ob = raw.obstacle;
  const cls = (/^[a-z-]+/i.exec(ob || '') || [''])[0].toLowerCase();
  let fact = '';
  if (OBSTACLES.includes(cls)) {
    fact = ob.slice(cls.length).replace(/^\s*[—–:,·-]?\s*/, '').trim();
    if (cls === 'none' && fact) problems.push('obstacle "none" takes no fact');
    if (cls !== 'none' && !fact) problems.push(`obstacle "${cls}" has no fact`);
  } else if (ob == null) problems.push('no obstacle');
  else {
    fact = ob.trim();
    problems.push(`obstacle class ${JSON.stringify(cls || ob.slice(0, 40))} is not one of ${OBSTACLES.join(' | ')}`);
  }
  // The field's own order (checkReflect), so the two forms of one reflection compare equal.
  const r = { level, goal: raw.goal || '', result: RESULTS.includes(res) ? res : null, obstacle: OBSTACLES.includes(cls) ? cls : null,
    ...(fact ? { obstacle_fact: fact } : {}), instead: raw.instead || '', rule: raw.rule || '' };
  if (said.length) {
    r.decisions = [];
    for (const d of said) {
      const m = /^(accepted|rejected|needs-owner)\b(?:\s*\(([^)]*)\))?\s*[—–:-]\s*(.+)$/i.exec(d);
      if (m) r.decisions.push({ rule: m[3].trim(), verdict: m[1].toLowerCase(), ...(m[2] ? { reason: m[2].trim() } : {}) });
      else problems.push(`decision ${JSON.stringify(d.slice(0, 60))} is not "<${VERDICTS.join('|')}> — <rule>"`);
    }
  }
  r.problems = problems;
  return r;
}

/** An entry's reflection: the checked field when the report carried one, else the text block read. */
export function entryReflect(e) {
  if (e && e.reflect && typeof e.reflect === 'object' && !Array.isArray(e.reflect)) return { ...e.reflect, level: e.reflect.level || 'turn' };
  return e ? readReflect(e.text) : null;
}

const NO_RULE = new Set(['none', 'n/a', '-', '']);
/** A rule as compared for repeats: case, punctuation and spacing are not what a rule says. */
export const ruleKey = (s) => String(s || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export const isNoRule = (s) => NO_RULE.has(ruleKey(s));
/** A rule that holds the example's, alone or with other lines around it; "only", "the" and "a"
 *  dropped, since the copies drop them too. */
const exampleKey = (s) => ruleKey(s).replace(/\b(?:only|the|an?)\b/g, ' ').replace(/\s+/g, ' ').trim();
export const isExampleRule = (s) => exampleKey(s).includes(exampleKey(EXAMPLE_RULE));

/** The digest a head reads instead of the reports (prompts/meta/fragments/head-cycle.md): per role,
 *  how turns ended and what got in the way; per obstacle class, how often and the latest facts;
 *  the rules proposed more than once; how many rules held the example's (`exampleRule`, never
 *  among the rules); the verdicts given. `entries` are journal entries in time
 *  order, already narrowed to the project and the window. Every count lists every value of its
 *  enum, zeros included, plus the bucket for what was off the list, so the shape never depends
 *  on the data: `other` for a result, `unclassified` for an obstacle class. */
export function reflectDigest(entries, { level = null, facts = 3 } = {}) {
  const zero = (list, extra) => Object.fromEntries([...list, extra].map(k => [k, 0]));
  const roles = {}, obstacles = {}, rules = new Map(), decisions = [], exampleRule = { count: 0, roles: [] };
  for (const k of [...OBSTACLES, 'unclassified']) obstacles[k] = { count: 0, facts: [] };
  let total = 0;
  for (const e of entries) {
    const r = entryReflect(e);
    if (!r || (level && r.level !== level)) continue;
    total++;
    const role = e.agent || '?';
    const p = roles[role] || (roles[role] = { reflections: 0, result: zero(RESULTS, 'other'), obstacle: zero(OBSTACLES, 'unclassified') });
    p.reflections++;
    p.result[RESULTS.includes(r.result) ? r.result : 'other']++;
    const cls = OBSTACLES.includes(r.obstacle) ? r.obstacle : 'unclassified';
    p.obstacle[cls]++;
    obstacles[cls].count++;
    if (cls !== 'none' && r.obstacle_fact) obstacles[cls].facts.push({ ts: e.ts, role, fact: r.obstacle_fact });
    if (isExampleRule(r.rule)) {
      exampleRule.count++;
      if (!exampleRule.roles.includes(role)) exampleRule.roles.push(role);
    } else if (!isNoRule(r.rule)) {
      const k = ruleKey(r.rule);
      const g = rules.get(k) || { rule: r.rule, count: 0, roles: [], last: e.ts };
      g.count++; g.rule = r.rule; g.last = e.ts;
      if (!g.roles.includes(role)) g.roles.push(role);
      rules.set(k, g);
    }
    for (const d of r.decisions || []) decisions.push({ ts: e.ts, role, level: r.level, ...d });
  }
  for (const o of Object.values(obstacles)) o.facts = o.facts.slice(-facts).reverse();   // newest first
  return {
    level: level || null,
    reflections: total,
    roles,
    obstacles,
    rules: [...rules.values()].filter(g => g.count > 1).sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1)),
    exampleRule,
    decisions: decisions.reverse(),
  };
}
