/* cards.mjs — whole-hub card maintenance: bring over-long sections under the cap, fold a section a
 * card holds twice, merge two cards for one project. Each is a dry run unless asked to apply. */
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJ, appendHistory, readJson, atomicWrite, cardLimits, cardPath, CONFLICT_RE, editSection, HUB, isPlaceholder,
  journalAppend, liveHeading, MOVED_MARK, NO_ROTATE, now, projectAliases, readCard, requireAuthor,
  rotateCardOverflow, sectionBody, sectionHeadings, sectionsConfig, slugify,
} from './core.mjs';

/** Bring every existing card under the cap — the one-off for a hub that grew before the cap
 *  existed. Dry by default: the plan says which section of which card loses how much, and where
 *  it goes. Cards already inside the limit are untouched and unlisted. */
export function runCardsCompact(a = {}) {
  if (a.apply) requireAuthor(a.by, 'by');   // the move is journaled, and history records who moved it
  const lim = cardLimits();
  const cards = [];
  let files = [];
  try { files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md')); } catch {}
  for (const f of files.sort()) {
    const slug = f.replace(/\.md$/, '');
    let text = '';
    try { text = fs.readFileSync(path.join(PROJ, f), 'utf8'); } catch { continue; }
    const before = Buffer.byteLength(text, 'utf8');
    if (CONFLICT_RE.test(text)) { cards.push({ slug, before, skipped: 'conflict markers — resolve it first (hub card resolve)' }); continue; }
    // Dry run must not write history, so the plan is measured on a copy and only re-run for real
    // when applying. rotateCardOverflow appends to history as it goes, which is right for a live
    // write and wrong for a preview.
    const planned = [];
    for (const part of text.split(/(?=^## )/m)) {
      const m = /^## (.+?)[ \t]*$/m.exec(part);
      if (!m || NO_ROTATE.has(m[1].trim())) continue;
      const body = part.slice(m.index + m[0].length);
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > lim.sectionBytes) planned.push({ section: m[1].trim(), bytes, over: bytes - lim.sectionBytes });
    }
    if (!planned.length) continue;
    if (!a.apply) { cards.push({ slug, before, sections: planned }); continue; }
    const rot = rotateCardOverflow(text, slug, a.by || 'hubd', lim);
    if (!rot.moved.length) continue;
    atomicWrite(path.join(PROJ, f), rot.text);
    cards.push({ slug, before, after: Buffer.byteLength(rot.text, 'utf8'), moved: rot.moved });
  }
  if (a.apply && cards.length) {
    journalAppend({ ts: now(), project: 'hub', agent: a.by || 'hubd', kind: 'note',
      text: `cards compacted: ${cards.length} card(s) over ${lim.sectionBytes}B per section; the overflow is in projects/history/<slug>.md` });
  }
  return { ok: true, apply: !!a.apply, limits: lim, cards };
}

/* ── One card, two sections that mean the same thing ──
 *
 * editSection writes into the FIRST heading that matches, so every later section of the same name
 * is dead: nothing can append to it, and hub_get still hands it to a reader, who then sees two
 * "Next step"s with different contents and no way to tell which is live. One hub had three
 * "## Handoff barechat-linux" in one card, and "## Next step" beside its localised heading in two
 * (task maple-112). Two shapes, both found here:
 *   - the same heading more than once (a merge resolved by hand, a heading typed twice);
 *   - one section KEY under two of its headings (the English default and the sections.json one) —
 *     a card written before the hub was localised, or on a node with another locale.
 * A heading that only resembles a key is NOT folded in: "## Facts" beside the localised facts heading is
 * a hand-written section on the cards it appears on, and merging it would let rotation move the
 * curated facts to history. Declare it an alias in sections.json if it really is the same. */
function sectionGroupId(heading) {
  const h = heading.trim().toLowerCase();
  for (const s of sectionsConfig()) if (sectionHeadings(s.key).some(x => x.toLowerCase() === h)) return 'key:' + s.key;
  return 'h:' + h;
}

/** What is doubled in a card: same-heading repeats and one key under several headings. */
export function cardSectionIssues(text) {
  const groups = new Map();
  for (const m of String(text || '').matchAll(/^## (.+?)[ \t]*$/gm)) {
    const id = sectionGroupId(m[1]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(m[1].trim());
  }
  const out = [];
  for (const [id, heads] of groups) {
    if (heads.length < 2) continue;
    out.push(id.startsWith('key:')
      ? { key: id.slice(4), headings: heads, kind: new Set(heads.map(h => h.toLowerCase())).size > 1 ? 'locales' : 'repeated' }
      : { heading: heads[0], count: heads.length, kind: 'repeated' });
  }
  return out;
}

/** Fold every doubled section into one. Lists concatenate in file order at the position of the
 *  live section (the one writers reach); for "next", which is SET rather than appended, the live
 *  step stays and the dead variants go to history — two current steps is the defect, not a fix. */
export function mergeCardSections(text, slug, by) {
  const merged = [];
  if (!text || CONFLICT_RE.test(text)) return { text, merged };
  const parts = String(text).split(/(?=^## )/m).map(p => {
    const m = /^## (.+?)[ \t]*$/m.exec(p);
    return m && m.index === 0 ? { heading: m[1].trim(), body: p.slice(m[0].length), id: sectionGroupId(m[1]) } : { raw: p };
  });
  const byId = new Map();
  parts.forEach((p, i) => { if (p.id) { if (!byId.has(p.id)) byId.set(p.id, []); byId.get(p.id).push(i); } });
  const drop = new Set();
  for (const [id, idx] of byId) {
    if (idx.length < 2) continue;
    const key = id.startsWith('key:') ? id.slice(4) : null;
    const live = key ? liveHeading(text, key).toLowerCase() : null;
    const target = key ? (idx.find(i => parts[i].heading.toLowerCase() === live) ?? idx[0]) : idx[0];
    const bodyOf = (i) => parts[i].body.replace(/^\n+/, '').replace(/\s+$/, '');
    const others = idx.filter(i => i !== target);
    if (key === 'next') {
      for (const i of others) {
        const b = bodyOf(i);
        if (b && !isPlaceholder(b)) appendHistory(slug, `\n---\n### until ${now()} (## ${parts[i].heading} — a second next-step section, superseded by ## ${parts[target].heading}; merged by ${by || 'hubd'})\n${b}\n`);
      }
    } else {
      let movedMark = null;
      const lines = [];
      for (const i of idx) {
        const b = bodyOf(i);
        if (!b || isPlaceholder(b)) continue;
        for (const l of b.split('\n')) {
          if (l.startsWith(MOVED_MARK)) { movedMark = movedMark || l; continue; }
          lines.push(l);
        }
      }
      parts[target].body = '\n\n' + [movedMark, ...lines].filter(x => x != null).join('\n') + '\n\n';
    }
    for (const i of others) drop.add(i);
    merged.push({ section: parts[target].heading, from: others.map(i => parts[i].heading), mode: key === 'next' ? 'kept live step, others to history' : 'concatenated' });
  }
  if (!merged.length) return { text, merged };
  const out = parts.filter((_, i) => !drop.has(i)).map(p => p.raw != null ? p.raw : `## ${p.heading}${p.body}`).join('');
  return { text: out.replace(/\n{3,}/g, '\n\n'), merged };
}

/** Run the merge over every card. Dry by default; --apply writes, rotates and journals once. */
export function runCardsMergeSections(a = {}) {
  const by = a.apply ? requireAuthor(a.by, 'by') : (a.by || null);
  const cards = [];
  let files = [];
  try { files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md')).sort(); } catch {}
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    let text; try { text = fs.readFileSync(path.join(PROJ, f), 'utf8'); } catch { continue; }
    const issues = cardSectionIssues(text);
    if (!issues.length) continue;
    if (CONFLICT_RE.test(text)) { cards.push({ slug, issues, skipped: 'conflict markers — resolve it first (hub card resolve)' }); continue; }
    if (!a.apply) { cards.push({ slug, issues }); continue; }
    const r = mergeCardSections(text, slug, by);
    const rot = rotateCardOverflow(r.text, slug, by);
    atomicWrite(path.join(PROJ, f), rot.text);
    cards.push({ slug, issues, merged: r.merged, ...(rot.moved.length ? { rotated: rot.moved } : {}) });
  }
  if (a.apply && cards.some(c => c.merged)) {
    journalAppend({ ts: now(), project: 'hub', agent: by, kind: 'note',
      text: `card sections merged: ${cards.filter(c => c.merged).map(c => c.slug).join(', ')} — doubled headings folded into the live one` });
  }
  return { ok: true, apply: !!a.apply, cards };
}

/** Merge two project cards that describe the same project under different slugs.
 *  Creates an alias from → into in project-aliases.json; moves from.md to projects/history/.
 *  The journal entries are untouched (they belong to the old slug via the alias system).
 *  Non-empty sections from the duplicate card are appended to the canonical card.
 *  Dry by default; --apply writes and journals. */
export function runCardsMerge(a = {}) {
  const from = slugify(a.from);
  const into = slugify(a.into);
  const by = a.apply ? requireAuthor(a.by, 'by') : (a.by || null);
  if (from === into) throw new Error('cannot merge a card into itself');
  const fromCard = readCard(from);
  if (!fromCard) throw new Error(`no card: ${from}.md`);
  const intoCard = readCard(into);
  if (!intoCard) throw new Error(`no card: ${into}.md`);

  // Collect non-empty sections from the duplicate
  const sections = [];
  const headings = fromCard.match(/^## .+$/gm) || [];
  for (const h of headings) {
    const body = sectionBody(fromCard, h.replace(/^## /, ''));
    if (body && !isPlaceholder(body)) {
      sections.push({ heading: h.replace(/^## /, ''), count: body.split('\n').filter(Boolean).length });
    }
  }

  if (!a.apply) {
    return { ok: true, from, into, sections, aliasExisted: !!projectAliases()[from], applied: false };
  }

  // Create alias
  const af = path.join(HUB, 'project-aliases.json');
  const aliases = readJson(af, {});
  const aliasExisted = !!aliases[from];
  if (!aliasExisted) aliases[from] = into;
  fs.writeFileSync(af, JSON.stringify(aliases, null, 1));

  // Append sections from duplicate to canonical
  let text = intoCard;
  for (const s of sections) {
    const body = sectionBody(fromCard, s.heading);
    text = editSection(text, s.heading, body, 'append');
  }

  // Move duplicate to history
  const histDir = path.join(PROJ, 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const histFile = path.join(histDir, `${from}.md`);
  let n = 1;
  while (fs.existsSync(histFile + (n > 1 ? `.${n}` : ''))) n++;
  fs.renameSync(cardPath(from), n > 1 ? histFile + '.' + n : histFile);

  // Write updated canonical card
  const rot = rotateCardOverflow(text, into, by);
  atomicWrite(cardPath(into), rot.text);

  journalAppend({ ts: now(), project: into, agent: by, kind: 'note',
    text: `cards merged: ${from} → ${into}${sections.length ? ' (' + sections.length + ' section(s) moved)' : ''}` });

  return { ok: true, from, into, sections, aliasExisted, applied: true, moved: rot.moved };
}
