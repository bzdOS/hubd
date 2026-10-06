/* escalations.mjs — what was escalated to the fleet, and whether the owner has answered it.
 *
 * An ESCALATION is a block with an id in the queue of a role of rank `fleet`:
 *   ## 2026-10-05 10:32 · from web-head · id pine-32
 * and its KEY is that header line without the "## ": "2026-10-05 10:32 · from web-head · id pine-32".
 * A block from before 0.9.54 has a bare number for its id, "· id 32", and is keyed the same way.
 * Every such block counts, whoever wrote it: the queue a block sits in says it was escalated.
 *
 * An ANSWER is an entry of the Owner decisions section (key `owner-decisions`, under whatever heading
 * the hub's sections.json gives it) of the card of a fleet role's project, that quotes the key:
 *   - 2026-10-05 10:48: answered 2026-10-05 10:32 · from web-head · id pine-32 — restart it, then report
 * An entry starts at a list item that begins with a "YYYY-MM-DD HH:MM" stamp, the time it was written
 * (what `hub section add` puts there), and runs to the next one. Each key it quotes is answered by
 * it, at its stamp; "id pine-3" is not "id pine-32". A section over the card's cap moves its older entries to
 * the project's history file, often within hours on a busy fleet, so the overflow blocks of that
 * section are read there too: an answer does not stop being one when it is moved. With two answers
 * to one key, the later one stands.
 *
 * Nothing here guesses: an escalation is answered when its key is quoted, and waiting otherwise.
 * Answers are read from the card of every fleet role that has a project; with none, all of it waits.
 *
 * Every waiting escalation is listed, however old — "waiting" is the point — and an answered one
 * for a day after its answer. Kept out of core.mjs because it reads queues, and queue.mjs imports core.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HISTORY, parseTs, slugify, readCard, sectionBody, sectionHeadings, liveHeading, hasHeading, roleRegistry } from './core.mjs';
import { recentBlocks, idCompare } from './queue.mjs';

export const ANSWERED_HOURS = 24;

const KEY_RE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · from ([^\n·]+?) · id ((?:[a-z0-9_-]+-)?\d+)(?![\w-])/g;
const ENTRY_RE = /^[-*+] (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?::|\s·)\s/;
const HISTORY_BLOCK_RE = /\n---\n(?=### until )/;

export const escalationKey = (b) => `${b.ts} · from ${b.from} · id ${b.id}`;

/** The entries of a section body: { ts, text } each, in the order written. */
function entriesOf(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    const m = ENTRY_RE.exec(line);
    if (m) out.push({ ts: m[1], lines: [line] });
    else if (out.length) out[out.length - 1].lines.push(line);
  }
  return out.map(e => ({ ts: e.ts, text: e.lines.join('\n').trim() }));
}

/** The bodies of the overflow blocks a project's history holds for the section, oldest first. */
function overflowBodies(slug, headings) {
  let text;
  try { text = fs.readFileSync(path.join(HISTORY, slug + '.md'), 'utf8'); } catch { return []; }
  const names = headings.map(h => h.toLowerCase());
  const out = [];
  for (const chunk of text.split(HISTORY_BLOCK_RE)) {
    const nl = chunk.indexOf('\n');
    const m = /^### until [^(]*\((?:## )?(.+?) — overflow past /.exec(nl < 0 ? chunk : chunk.slice(0, nl));
    if (m && names.includes(m[1].trim().toLowerCase())) out.push(chunk.slice(nl + 1));
  }
  return out;
}

/** Every answer quoted in a project's Owner decisions, history first: key → { ts, text }, the later one per key. */
function answersFor(project) {
  const slug = slugify(project);
  const card = readCard(slug);
  const bodies = overflowBodies(slug, sectionHeadings('owner-decisions'));
  if (card) {
    const h = liveHeading(card, 'owner-decisions');
    if (hasHeading(card, h)) bodies.push(sectionBody(card, h));
  }
  const answers = new Map();
  for (const body of bodies) {
    for (const e of entriesOf(body)) {
      for (const m of e.text.matchAll(KEY_RE)) {
        const key = `${m[1]} · from ${m[2].trim()} · id ${m[3]}`;
        const had = answers.get(key);
        if (!had || had.ts <= e.ts) answers.set(key, { ts: e.ts, text: e.text });
      }
    }
  }
  return answers;
}

/** The escalations to the fleet: { fleet, waiting, answered }, each list oldest first.
 *  A row: { key, to, node, from, id, task, ts, waitedMin, subject, text, answer: null | { ts, text } };
 *  waitedMin runs to now while it waits, to the answer once answered. `textChars` cuts the
 *  escalation's text and the answer's; by default both are whole. */
export function escalationState({ roles = roleRegistry(), root, nowMs = Date.now(), textChars = Infinity } = {}) {
  const fleetRoles = [...roles.values()].filter(r => r.rank === 'fleet').sort((x, y) => (x.role < y.role ? -1 : 1));
  const fleet = fleetRoles.map(r => r.role);
  if (!fleet.length) return { fleet, waiting: [], answered: [] };
  const cut = (s) => (s.length > textChars ? s.slice(0, textChars) + '…' : s);
  const minutes = (from, toMs) => { const d = toMs - parseTs(from).getTime(); return Number.isFinite(d) ? Math.max(0, Math.round(d / 60000)) : null; };

  const answers = new Map();
  for (const p of [...new Set(fleetRoles.map(r => r.project).filter(Boolean).map(slugify))].sort()) {
    for (const [k, v] of answersFor(p)) { const had = answers.get(k); if (!had || had.ts <= v.ts) answers.set(k, v); }
  }

  // whole files: "every waiting escalation" cannot stop at a tail
  const blocks = recentBlocks({ root, to: fleet, tailBytes: Infinity, textChars: Infinity, subjectChars: 160 })
    .filter(b => b.id != null)
    .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.role < y.role ? -1 : x.role > y.role ? 1
      : String(x.node || '') < String(y.node || '') ? -1 : String(x.node || '') > String(y.node || '') ? 1 : idCompare(x.id, y.id)));
  const since = nowMs - ANSWERED_HOURS * 3600000;
  const seen = new Set(), waiting = [], answered = [];
  for (const b of blocks) {
    const key = escalationKey(b);
    if (seen.has(key)) continue;   // the key is all an answer can name; one row per key
    seen.add(key);
    const a = answers.get(key) || null;
    const row = { key, to: b.role, node: b.node, from: b.from, id: b.id, task: b.task || null, ts: b.ts,
      waitedMin: minutes(b.ts, a ? parseTs(a.ts).getTime() : nowMs), subject: b.subject, text: cut(b.text),
      answer: a ? { ts: a.ts, text: cut(a.text) } : null };
    if (!a) waiting.push(row);
    else if (parseTs(a.ts).getTime() >= since) answered.push(row);
  }
  return { fleet, waiting, answered };
}
