/* recall.mjs — "what do we know about X": ranked, dated hits across cards, tasks and the journal. */

import {
  cardStamp, digestOf, escRe, isPlaceholder, journalTail, loadTasks, now, parseTs, projectCards, projectFilter,
  sectionBody, sectionsConfig, slugify,
} from './core.mjs';
import { entryReflect, isNoRule, splitReflect } from './reflect.mjs';

/* ── Recall: what do we know about X, and was it still true when we learned it ──
 * hub_search is exact and flat: every line that contains the substring, in file order, a decision
 * from June next to a passing note from yesterday. hub_get is the opposite failure — everything
 * about one project when the question spanned three. Neither answers "what do we know about X",
 * which is the question a returning session actually has.
 *
 * Ranking is deterministic and dependency-free on purpose (no embeddings, no index to rebuild, no
 * model in the loop): a hit scores on WHERE it lives (a decision outranks a digest, a digest
 * outranks a passing note), how many query terms it carries, and how recent it is. Anyone can
 * read the scoring and predict the order, which matters more here than cleverness.
 *
 * And every hit carries its own date plus a staleness verdict, because the failure mode of recall
 * is not missing a fact — it is handing over a two-month-old fact with the same confidence as
 * this morning's. A stale hit says so, in the words a reader needs: it was true THEN, check it. */
const RECALL_WEIGHT = { decision: 5, digest: 4, section: 3, rule: 3, task: 2, obstacle: 2, journal: 1 };

/* Words that carry no topic. "IMM not established attention overlap" returned eight hits and
 * none from the project the question was about: the first was scored on "not" and "overlap",
 * the next two on "not" and an "imm" found INSIDE "committing", and five more on "not" alone
 * (task maple-77). Coverage of a stop-word is not coverage, and a substring is not a word.
 * Both lists are small on purpose — a term that is not here still counts, and the response says
 * which ones were dropped so a query that "deflated" shows why. */
const RECALL_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'was', 'were', 'be',
  'not', 'no', 'it', 'its', 'this', 'that', 'these', 'those', 'with', 'by', 'as', 'from', 'but', 'if',
  'then', 'so', 'do', 'does', 'did', 'we', 'you', 'i', 'he', 'she', 'they', 'my', 'our', 'your', 'about',
  // Russian stop-words, written as \u escapes: the public repository is ASCII-only by its own gate
  // (tests/check_clean.sh), and the list is data, not prose.
  '\u0438', '\u043d\u0435', '\u0432', '\u043d\u0430', '\u0434\u043b\u044f', '\u0447\u0442\u043e', '\u043a\u0430\u043a', '\u044d\u0442\u043e', '\u0430', '\u043d\u043e', '\u0438\u043b\u0438', '\u0441', '\u043a', '\u043f\u043e', '\u0438\u0437', '\u0443', '\u043e',
  '\u043e\u0431', '\u043e\u0442', '\u0434\u043e', '\u0437\u0430', '\u0436\u0435', '\u043b\u0438', '\u0431\u044b', '\u0442\u043e', '\u0442\u0430\u043a', '\u0432\u043e\u0442', '\u043e\u043d', '\u043e\u043d\u0430', '\u043e\u043d\u0438', '\u043c\u044b', '\u0432\u044b', '\u044f',
  '\u043c\u043e\u0439', '\u043d\u0430\u0448', '\u0432\u0430\u0448', '\u0435\u0433\u043e', '\u0435\u0451', '\u0438\u0445', '\u0435\u0449\u0451', '\u0435\u0449\u0435', '\u0443\u0436\u0435', '\u043d\u0438', '\u0434\u0430', '\u043d\u0435\u0442', '\u043f\u0440\u0438', '\u043f\u0440\u043e',
]);
/* A term matches at the start of a word — "imm" matches "IMM", "IMM's" and "immediately", never
 * "committing". Prefix rather than whole-word because the hub is written in two inflecting
 * languages; infix never, because that is how "not" inside "note" counted as a hit. */
const termRe = (t) => new RegExp('(^|[^\\p{L}\\p{N}_])' + escRe(t), 'iu');

export function runRecall(a = {}) {
  const raw = String(a.query || '').trim();
  if (!raw) throw new Error('query required: a word or phrase to recall');
  const tokens = [...new Set(raw.toLowerCase().split(/\s+/).filter(t => t.length > 1))];
  const dropped = tokens.filter(t => RECALL_STOP.has(t));
  const terms = tokens.filter(t => !RECALL_STOP.has(t));
  if (!terms.length) throw new Error(tokens.length
    ? `query is only stop-words (${dropped.join(', ')}) — add a word that names the thing you are asking about`
    : 'query too short');
  const res = Object.fromEntries(terms.map(t => [t, termRe(t)]));
  const only = projectFilter(a.project);
  const staleDays = a.staleDays ?? 30;
  const limit = a.limit ?? 20;
  const nowMs = Date.now();
  const hits = [];

  const score = (kind, text, ts) => {
    const low = String(text).toLowerCase();
    const matched = terms.filter(t => res[t].test(low));
    if (!matched.length) return null;
    // A whole-phrase hit is worth more than the same words scattered; recency decays slowly
    // (half a point per month) so an old DECISION still outranks a fresh passing note.
    const phrase = low.includes(raw.toLowerCase()) ? 3 : 0;
    const ageDays = ts ? Math.max(0, (nowMs - parseTs(ts).getTime()) / 86400000) : null;
    const recency = ageDays === null ? 0 : Math.max(0, 1.5 - (ageDays / 30) * 0.5);
    // Term coverage outweighs the field weight on purpose: a note matching BOTH words of a
    // two-word question answers it better than a decision matching one. With the field weight
    // leading (spread 1..5), "queue offset" surfaced decisions containing only "queue" and buried
    // the lines actually about offsets — the ranking was measuring prestige, not relevance.
    return { s: RECALL_WEIGHT[kind] + matched.length * 3 + phrase + recency, matched, ageDays };
  };
  const push = (kind, where, project, text, ts) => {
    if (only && !only.has(slugify(String(project || '')))) return;
    const r = score(kind, text, ts);
    if (!r) return;
    hits.push({ kind, where, project, text: String(text).trim().slice(0, 300), asOf: ts || null,
      ageDays: r.ageDays === null ? null : Math.round(r.ageDays),
      stale: r.ageDays !== null && r.ageDays >= staleDays,
      score: Math.round(r.s * 100) / 100, matched: r.matched });
  };

  for (const c of projectCards({ includeReserved: true })) {
    const touched = cardStamp(c.text).at;
    const dg = digestOf(c.text);
    if (dg) push('digest', `${c.slug} card / Digest`, c.slug, dg, touched);
    for (const s of sectionsConfig()) {
      const body = sectionBody(c.text, s.heading);
      if (isPlaceholder(body)) continue;
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        // A dated line carries its OWN date (that is what section writes stamp), which beats the
        // card's last-touched time: one line can be a year older than the card holding it.
        const own = (line.match(/(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)/) || [])[1] || touched;
        push(s.key === 'decisions' ? 'decision' : 'section', `${c.slug} card / ${s.heading}`, c.slug, line, own);
      }
    }
  }
  /* A reflection's rule and obstacle are hits of their own. They end the report, so inside the
   * journal hit they sat past the 300 characters a hit shows: a recall on a rule found the entry
   * and showed its first lines. The journal hit keeps the rest of the text, goal and instead
   * included, so no word stops being found. */
  for (const e of journalTail(null, 4000)) {
    const where = `journal ${e.ts} [${e.project || '?'}/${e.agent || '?'}]`;
    const rf = entryReflect(e);
    const text = !rf ? e.text || '' : [splitReflect(e.text).body, rf.goal && 'goal: ' + rf.goal, rf.instead && 'instead: ' + rf.instead,
      ...(rf.decisions || []).map(d => `${d.verdict}: ${d.rule}`)].filter(Boolean).join(' · ');
    if (text) push(e.kind === 'decision' ? 'decision' : 'journal', where, e.project || null, text, e.ts);
    if (rf && rf.rule && !isNoRule(rf.rule)) push('rule', where + ' rule', e.project || null, rf.rule, e.ts);
    if (rf && rf.obstacle_fact) push('obstacle', `${where} obstacle${rf.obstacle ? ' ' + rf.obstacle : ''}`, e.project || null, rf.obstacle_fact, e.ts);
  }
  for (const t of loadTasks().tasks) {
    push('task', `task #${t.id} (${t.status})`, t.project, t.text || '', t.done || t.created);
  }

  hits.sort((x, y) => y.score - x.score);
  const top = hits.slice(0, limit);
  const staleCount = top.filter(h => h.stale).length;
  return {
    query: raw, terms, ...(dropped.length ? { dropped } : {}), ...(only ? { project: [...only] } : {}),
    total: hits.length, hits: top,
    stale: staleCount,
    hint: staleCount
      ? `${staleCount} of ${top.length} hit(s) are older than ${staleDays}d — each says what it was true as of. Verify before acting on one, or re-state it as a fresh FACT.`
      : undefined,
    generated: now(),
  };
}
