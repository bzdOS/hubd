/* reflect.mjs — a turn's reflection as data: the fields prompts/meta/fragments/reflect.md asks for.
 *
 * Every role ends a turn with five lines: goal, result, obstacle, instead, rule. Read as text, a
 * head groups obstacles by regex over the journal, which is how "waits for a dispatch" was read
 * before heartbeat had fields for it, and broke the same way. So a report can carry the
 * reflection as a field, checked when it is written: a value off the list is an error the writer
 * sees, not a line a digest silently miscounts. The text block is still read, because the fleet
 * writes it today; read, not checked, since refusing a report an older rule asked for would
 * lose the report. Nothing here reads the hub: the caller passes the entries. */
import { createHash } from 'node:crypto';

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

/* A marker on a line of its own is a block meant, even when no line after it holds a key this reads:
 * keys in the dispatch's language, or misspelt. Dropped as prose, such a turn went uncounted and its
 * writer heard nothing; read, it is a reflection with nothing in it and one problem that says why. */
const MARK_LINE = /(?:^|\n|\s·\s)[ \t#·]*((?:HEAD-|FLEET-)?REFLECT)[ \t]*:?[ \t]*(?=\n|\s·\s|$)/;
/* A turn that found no work is not a step and takes no reflection: its report is this one line
 * (prompts/meta/worker.md), so the loop can tell it from a step that skipped the block. */
const WAITING = /^\s*(?:NOTE\s*:\s*)?["'`]?waiting for a dispatch\b/i;
/** The report's text, without its reflection, is the waiting line alone. */
export const isWaitingTurn = (body) => {
  const lines = String(body ?? '').split(/\n|\s·\s/).filter(l => l.trim());
  return lines.length === 1 && WAITING.test(lines[0]);
};
/* What the block's own rules refuse beyond the lists, in the words both forms use: the field throws
 * the first, the text names them all. */
const manyRules = (rule) => String(rule || '').replace(/`[^`]*`/g, '').includes(';');
function shapeProblems({ result, obstacle, instead, rule }) {
  const out = [];
  if (result === 'no' && obstacle === 'none')
    out.push(`result "no" with obstacle "none": a turn that delivered nothing names what held it up, one of ${OBSTACLES.filter(o => o !== 'none').join(' | ')}`);
  if (instead && isNothing(instead) && !(result === 'done' && obstacle === 'none'))
    out.push(`instead ${JSON.stringify(instead)} only with result "done" and obstacle "none"; say what you would do differently` +
      (result === 'partial' && obstacle === 'none' ? ', or, for a run not finished yet, what it waits for' : ''));
  if (manyRules(rule)) out.push('rule holds more than one rule (";" outside backticks); send the one this turn taught most');
  return out;
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
 *  list, every text field present, and the block's own rules (shapeProblems). Returns it with blank fields dropped and each value on one line,
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
  const shape = shapeProblems(out);
  if (shape.length) throw new Error('reflect: ' + shape[0]);
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
  const { body, reflect } = splitReflect(text);
  if (!reflect) {
    const m = MARK_LINE.exec(String(text ?? ''));
    if (!m) return null;
    return { level: m[1] === 'HEAD-REFLECT' ? 'head' : m[1] === 'FLEET-REFLECT' ? 'fleet' : 'turn', goal: '', result: null, obstacle: null,
      instead: '', rule: '', problems: [`${m[1]} is followed by no result: or obstacle: line, so nothing in it was read; ` +
        'the keys are goal, result, obstacle, instead, rule, in English, whatever the language of the values'] };
  }
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
  problems.push(...shapeProblems(r));
  if (isWaitingTurn(body)) problems.push('a turn that only waits for a dispatch takes no reflection; the waiting line alone is its report');
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

/* Compared as keys: "n/a" is "n a" and "-" is "" once ruleKey has dropped the punctuation. */
const NOTHING = new Set(['none', 'nothing', 'n a', '']);
/** A rule as compared for repeats: case, punctuation and spacing are not what a rule says. */
export const ruleKey = (s) => String(s || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const isNothing = (s) => NOTHING.has(ruleKey(s));
export const isNoRule = isNothing;
/** A rule that holds the example's, alone or with other lines around it; "only", "the" and "a"
 *  dropped, since the copies drop them too. */
const exampleKey = (s) => ruleKey(s).replace(/\b(?:only|the|an?)\b/g, ' ').replace(/\s+/g, ' ').trim();
export const isExampleRule = (s) => exampleKey(s).includes(exampleKey(EXAMPLE_RULE));

/* One rule in other words. A role restates its rule from turn to turn ("one line and end of turn",
 * "a line, then the turn ends"), and counted by exact wording one rule said ten times read as three
 * rules said four, three and three times: below any line a head draws. Two wordings are one rule
 * when at least SAME_RULE of their words are shared (shared over all the words of both). A word is
 * its first five letters, so the endings a language inflects do not tell two words apart; a word
 * under three letters (of, to, a, and their counterparts) carries no rule unless it holds a digit,
 * since "64 hex" and "6 hex" are not one rule. A wording joins the group whose first, most repeated
 * wording is the closest, never a chain: two rules that each resemble a third stay two. On one
 * hub's 553 rules of two days, 0.3 put "until the owner's word: one line, end of turn" with "no task:
 * one line, end of turn"; 0.4 kept them apart and still joined a rule its writer had reordered. */
export const SAME_RULE = 0.4;
const ruleWords = (s) => new Set(ruleKey(s).split(' ')
  .filter(w => [...w].length >= 3 || /\d/.test(w)).map(w => [...w].slice(0, 5).join('')));
const shared = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / ((a.size + b.size - n) || 1); };
/** How much of two wordings is the same rule, 0 to 1; SAME_RULE and above is one rule. */
export const ruleSimilarity = (a, b) => shared(ruleWords(a), ruleWords(b));
/** A rule's id, as hub reflect --promote lists a candidate: its wording as ruleKey compares it, hashed. */
export const ruleId = (s) => createHash('sha1').update(ruleKey(s)).digest('hex').slice(0, 6);

/* `said`: every rule a reflection proposed, `{rule, role, ts}`, in time order, "none" and the
 * example's rule already left out. One group per rule however it was worded, its wordings most
 * repeated first; `at` is every time it was said. */
function groupRules(said) {
  const byKey = new Map();
  said.forEach((s, i) => {
    const k = ruleKey(s.rule);
    const w = byKey.get(k) || { words: ruleWords(s.rule), at: [] };
    w.rule = s.rule;   // the latest of one wording's spellings
    w.at.push({ ...s, i });
    byKey.set(k, w);
  });
  const groups = [];
  for (const w of [...byKey.values()].sort((a, b) => b.at.length - a.at.length || b.at.at(-1).i - a.at.at(-1).i)) {
    let best = null, most = 0;
    for (const g of groups) { const n = shared(w.words, g.words); if (n > most) { most = n; best = g; } }
    if (best && most >= SAME_RULE) best.wordings.push(w);
    else groups.push({ words: w.words, wordings: [w] });
  }
  return groups.map(g => ({ rule: g.wordings[0].rule, wordings: g.wordings,
    at: g.wordings.flatMap(w => w.at).sort((a, b) => a.i - b.i) }));
}
const rolesOf = (at) => { const by = {}; for (const a of at) by[a.role] = (by[a.role] || 0) + 1; return by; };
const byCount = (a, b) => b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0);

/* A candidate for the project's laws (hub reflect --promote): a rule said PROMOTE.oneRole times by
 * one role, or by PROMOTE.roles roles, in the window. A rule its writer keeps saying is one the
 * rules it runs by do not hold yet; one that two roles arrived at apart is one the track teaches.
 * The head accepts it into the project's laws or rejects it, by its id. */
export const PROMOTE = { oneRole: 3, roles: 2 };
/** The candidates among `said` (as groupRules takes it, each with `ms`, its time). A rule that is one
 *  of `laws` (wordings) is a law already and no candidate. One that was rejected (`{rule, ms}`)
 *  counts only what was said after the rejection: the head said no to what it had seen, and a rule
 *  still said a week on is news. Each: id, rule, count, by (role → count), last, variants (the other
 *  wordings, with their counts), and `rejected`, the time of the last rejection it outlived. */
export function promoteCandidates(said, { laws = [], rejected = [] } = {}) {
  const lawWords = laws.map(ruleWords);
  const noWords = rejected.map(r => ({ ...r, words: ruleWords(r.rule) }));
  const out = [];
  for (const g of groupRules(said)) {
    const near = (words) => g.wordings.some(w => shared(w.words, words) >= SAME_RULE);
    if (lawWords.some(near)) continue;
    const no = noWords.filter(r => near(r.words)).sort((a, b) => a.ms - b.ms).at(-1);
    const at = no ? g.at.filter(a => a.ms > no.ms) : g.at;
    const by = rolesOf(at);
    if (!at.length || (Math.max(...Object.values(by)) < PROMOTE.oneRole && Object.keys(by).length < PROMOTE.roles)) continue;
    out.push({ id: ruleId(g.rule), rule: g.rule, count: at.length, by, last: at.at(-1).ts,
      variants: g.wordings.slice(1).map(w => ({ rule: w.rule, count: w.at.length })), ...(no ? { rejected: no.ts } : {}) });
  }
  return out.sort(byCount);
}

/** The digest a head reads instead of the reports (prompts/meta/fragments/head-cycle.md): per role,
 *  how turns ended and what got in the way; per obstacle class, how often and the latest facts;
 *  the rules proposed more than once, a rule's other wordings counted with it (`variants`); how
 *  many rules held the example's (`exampleRule`, never among the rules); the verdicts given.
 *  `entries` are journal entries in time order, already narrowed to the project and the window. Every count lists every value of its
 *  enum, zeros included, plus the bucket for what was off the list, so the shape never depends
 *  on the data: `other` for a result, `unclassified` for an obstacle class. */
export function reflectDigest(entries, { level = null, facts = 3 } = {}) {
  const zero = (list, extra) => Object.fromEntries([...list, extra].map(k => [k, 0]));
  const roles = {}, obstacles = {}, said = [], decisions = [], exampleRule = { count: 0, roles: [] };
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
    } else if (!isNoRule(r.rule)) said.push({ rule: r.rule, role, ts: e.ts });
    for (const d of r.decisions || []) decisions.push({ ts: e.ts, role, level: r.level, ...d });
  }
  for (const o of Object.values(obstacles)) o.facts = o.facts.slice(-facts).reverse();   // newest first
  return {
    level: level || null,
    reflections: total,
    roles,
    obstacles,
    rules: groupRules(said).filter(g => g.at.length > 1).map(g => ({ rule: g.rule, count: g.at.length,
      roles: Object.keys(rolesOf(g.at)), last: g.at.at(-1).ts,
      variants: g.wordings.slice(1).map(w => ({ rule: w.rule, count: w.at.length })) })).sort(byCount),
    exampleRule,
    decisions: decisions.reverse(),
  };
}
