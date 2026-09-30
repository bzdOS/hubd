/* absorb.mjs — `hub absorb`: fold a hub base written in isolation into this one, as a new node. */
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJ, RESOURCES, HUB, escRe, journalAppend, now, rebuildTaskCache, requireAuthor, shareMode, VERSION,
} from './core.mjs';

/* ── Absorb: fold a hub base that was written in isolation into this one ──
 *
 * The case this exists for: a set of agents wrote to a directory that was NOT the shared hub for a
 * while — a misrouted env var, a private ~/.hubd, a laptop that never joined the mesh — and the
 * work in it (tasks, reports, queue traffic) must join the shared base without losing anything and
 * without touching a byte of the shared base's own append-only logs.
 *
 * Model. The shared hub already understands "another node's log": every log is per node
 * (tasks.<node>.events.jsonl, journal.<node>.jsonl, usage.<node>.jsonl) and the fold keys tasks by
 * (node, id). So the isolated base is absorbed AS A NEW NODE: its logs become <kind>.<label>.*
 * files here, which are new files (the mesh-sync guard checks removed lines, never new files) and
 * travel to every peer on the next sync. Nothing in the shared base is rewritten.
 *
 * Ids. The isolated base minted its own `<node>-<n>` ids, which collide with the shared base's ids
 * from the same hostname (pine-1..23 existed in both, naming different work). The fold would
 * remap the newcomers to bare numbers and every "see pine-4" in their reports would then point at
 * a stranger's task. So each absorbed id is renamed `<label>-<n>`, keeping its number, in every
 * field and in every text — events, journal, queue blocks, cards — of the COPIES only. The mapping
 * is printed and kept in the manifest; it is a rename of new files, not a rewrite of history.
 *
 * What is not absorbed, and why: presence and .qstate cursors are node-local and describe processes
 * that no longer exist; claims expire on their own; tasks.json is a cache; HUBD.md is generated.
 * Cards and resources whose slug already exists here are kept verbatim under absorbed/<label>/ —
 * two digests written a day apart by different agents are not a list to union, a human picks. Queue
 * files go to absorbed/<label>/queues/ with the delivered offset recorded per file: consumed history
 * is preserved for `grep`, and NOT re-delivered to a live waiter (a second delivery of a day's
 * orders is the incident this tool was written after). What was never read is listed so the
 * operator re-sends it on purpose.
 *
 * Refuses while a waiter pid recorded in the source is still alive (an agent is still writing
 * there — the copy would be stale the moment it lands), and when the source is itself a git repo
 * (that is a mesh node; sync it, do not absorb it). `force` overrides both. */
const ABSORB_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export function runAbsorb(a = {}) {
  const from = a.from ? path.resolve(String(a.from)) : null;
  const label = a.as ? String(a.as) : null;
  if (!from) throw new Error('from required: the hub base to absorb (an absolute directory)');
  if (!label || !ABSORB_LABEL_RE.test(label)) throw new Error('as required: a node label for the absorbed logs, e.g. pine-agent (lowercase, digits, - and _)');
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw new Error('not a directory: ' + from);
  const hubReal = fs.realpathSync(HUB), fromReal = fs.realpathSync(from);
  if (hubReal === fromReal) throw new Error('source is this hub base itself');
  if (hubReal.startsWith(fromReal + path.sep) || fromReal.startsWith(hubReal + path.sep)) throw new Error('source and hub base nest: ' + from + ' vs ' + HUB);
  if (a.apply) requireAuthor(a.by, 'by');   // the absorb is journaled under that author

  const refusals = [];
  if (fs.existsSync(path.join(from, '.git'))) refusals.push('source is a git repository - a mesh node syncs, it is not absorbed');
  const liveWaiters = [];
  try {
    for (const f of fs.readdirSync(path.join(from, '.qstate')).filter(f => f.endsWith('.waiter'))) {
      let pid = 0;
      try { pid = JSON.parse(fs.readFileSync(path.join(from, '.qstate', f), 'utf8')).pid | 0; } catch {}
      if (!pid) continue;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
      if (alive) liveWaiters.push({ role: f.replace(/\.waiter$/, ''), pid });
    }
  } catch {}
  if (liveWaiters.length) refusals.push('live waiter(s) in the source: ' + liveWaiters.map(w => w.role + ' pid ' + w.pid).join(', ') + ' - stop them first, or the copy is stale the moment it lands');
  const taken = [];
  for (const f of [`tasks.${label}.events.jsonl`, `journal.${label}.jsonl`, `usage.${label}.jsonl`, path.join('absorbed', label)]) {
    if (fs.existsSync(path.join(HUB, f))) taken.push(f);
  }
  try { for (const f of fs.readdirSync(HUB)) if (new RegExp('^journal\\.' + escRe(label) + '-\\d{4}-\\d{2}').test(f)) taken.push(f); } catch {}
  if (taken.length) refusals.push('label already used here: ' + taken.join(', ') + ' - pick another, an absorb happens once');
  const hardRefusals = refusals.filter(r => !a.force || r.startsWith('label already used'));
  if (hardRefusals.length) throw new Error('refused: ' + hardRefusals.join('; '));

  const ls = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).sort(); } catch { return []; } };
  const readLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()); } catch { return []; } };
  const eventFiles = ls(from, /^tasks\..+\.events\.jsonl$/);
  const journalFilesSrc = ls(from, /^journal.*\.jsonl$/);
  const usageFilesSrc = ls(from, /^usage\..+\.jsonl$/);

  // ── id map: every id the source ADDED, renamed <label>-<n> with its own number when unique ──
  const idMap = new Map();
  const addIds = [];
  for (const f of eventFiles) for (const l of readLines(path.join(from, f))) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.ev === 'add' && e.id !== undefined && e.id !== null && !idMap.has(String(e.id))) { addIds.push(String(e.id)); idMap.set(String(e.id), null); }
  }
  const usedN = new Set();
  let maxN = 0;
  for (const id of addIds) { const m = /(\d+)$/.exec(id); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  for (const id of addIds) {
    const m = /(\d+)$/.exec(id);
    let n = m ? parseInt(m[1], 10) : ++maxN;
    if (usedN.has(n)) n = ++maxN;
    usedN.add(n);
    idMap.set(id, `${label}-${n}`);
  }
  // In prose only node-scoped ids are safe to rename: a bare "7" is a number before it is an id.
  const proseIds = [...idMap.keys()].filter(id => id.includes('-')).sort((x, y) => y.length - x.length);
  const proseRe = proseIds.length
    ? new RegExp('(?<![A-Za-z0-9_-])(' + proseIds.map(escRe).join('|') + ')(?![0-9])', 'g')
    : null;
  const renameText = (s) => (proseRe ? s.replace(proseRe, (m) => idMap.get(m)) : s);
  const renameValue = (v, key) => {
    if (typeof v === 'string') {
      if (idMap.has(v) && (key === 'id' || key === 'task' || key === 'task_id' || key === 'taskId' || key === 'depends_on' || key === 'done' || key === 'blocks')) return idMap.get(v);
      return renameText(v);
    }
    if (typeof v === 'number' && (key === 'id' || key === 'task_id' || key === 'depends_on') && idMap.has(String(v))) return idMap.get(String(v));
    if (Array.isArray(v)) return v.map(x => renameValue(x, key));
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = renameValue(x, k); return o; }
    return v;
  };

  // ── logs ──
  const outEvents = [], outJournal = [], outUsage = [];
  let malformed = 0;
  for (const f of eventFiles) for (const l of readLines(path.join(from, f))) {
    let e; try { e = JSON.parse(l); } catch { malformed++; continue; }
    const r = renameValue(e, '');
    r.node = label;                    // the file it lives in and the node it names agree: a plain final-id log
    outEvents.push(JSON.stringify(r));
  }
  for (const f of journalFilesSrc) for (const l of readLines(path.join(from, f))) {
    let e; try { e = JSON.parse(l); } catch { malformed++; continue; }
    outJournal.push(JSON.stringify(renameValue(e, '')));
  }
  for (const f of usageFilesSrc) for (const l of readLines(path.join(from, f))) {
    let e; try { e = JSON.parse(l); } catch { malformed++; continue; }
    outUsage.push(JSON.stringify(renameValue(e, '')));
  }

  // ── queues: kept, never re-delivered ──
  const queues = [];
  for (const f of ls(path.join(from, 'queues'), /\.queue\.md$/)) {
    const file = path.join(from, 'queues', f);
    let size = 0; try { size = fs.statSync(file).size; } catch {}
    let offset = 0; try { offset = parseInt(fs.readFileSync(path.join(from, '.qstate', f + '.offset'), 'utf8').trim(), 10) || 0; } catch {}
    const text = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
    const blocks = (text.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm) || []).length;
    const unreadText = Buffer.from(text, 'utf8').subarray(Math.min(offset, size)).toString('utf8');   // cursors are BYTE offsets
    const unreadBlocks = (unreadText.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm) || []).length;
    queues.push({ file: f, bytes: size, delivered: Math.min(offset, size), blocks, unreadBytes: Math.max(0, size - offset), unreadBlocks, cursor: offset > 0, text });
  }

  // ── cards and resources: new slugs join, existing slugs are kept aside verbatim ──
  const cards = [], resources = [];
  for (const f of ls(path.join(from, 'projects'), /\.md$/)) {
    const slug = f.replace(/\.md$/, '');
    cards.push({ slug, file: f, exists: fs.existsSync(path.join(PROJ, f)), text: fs.readFileSync(path.join(from, 'projects', f), 'utf8') });
  }
  for (const f of ls(path.join(from, 'resources'), /\.md$/)) {
    resources.push({ slug: f.replace(/\.md$/, ''), file: f, exists: fs.existsSync(path.join(RESOURCES, f)), text: fs.readFileSync(path.join(from, 'resources', f), 'utf8') });
  }
  const skipped = ['presence/', '.qstate/', 'claims.json', 'tasks.json', 'HUBD.md', '.checkins.json', '.env-state.json'].filter(f => fs.existsSync(path.join(from, f)));

  const plan = {
    from, as: label, apply: !!a.apply, warnings: a.force ? refusals : [],
    tasks: { files: eventFiles, events: outEvents.length, added: addIds.length, idMap: Object.fromEntries(idMap) },
    journal: { files: journalFilesSrc, entries: outJournal.length },
    usage: { files: usageFilesSrc, entries: outUsage.length },
    malformed,
    queues: queues.map(({ text, ...q }) => q),
    unread: queues.filter(q => q.unreadBlocks > 0).map(q => ({ file: q.file, blocks: q.unreadBlocks, bytes: q.unreadBytes, everRead: q.cursor })),
    cards: cards.map(c => ({ slug: c.slug, kept: c.exists ? `absorbed/${label}/projects/${c.file}` : `projects/${c.file}` })),
    resources: resources.map(r => ({ slug: r.slug, kept: r.exists ? `absorbed/${label}/resources/${r.file}` : `resources/${r.file}` })),
    skipped,
    writes: [],
  };
  if (outEvents.length) plan.writes.push(`tasks.${label}.events.jsonl`);
  if (outJournal.length) plan.writes.push(`journal.${label}.jsonl`);
  if (outUsage.length) plan.writes.push(`usage.${label}.jsonl`);
  for (const q of queues) plan.writes.push(`absorbed/${label}/queues/${q.file}`);
  for (const c of plan.cards) plan.writes.push(c.kept);
  for (const r of plan.resources) plan.writes.push(r.kept);
  plan.writes.push(`absorbed/${label}/manifest.json`);
  if (!a.apply) return plan;

  for (const w of plan.writes) if (fs.existsSync(path.join(HUB, w))) throw new Error('refused: would overwrite ' + w);
  // All or nothing. The first field run hit EACCES half-way: absorbed/ had arrived by a root git
  // pull without group write, the logs were already on disk, and the label counted as used while
  // the queues and manifest were missing. Every path that will be written is probed first; if a
  // write still fails, everything written so far is removed before the error surfaces.
  const written = [];
  const write = (rel, text) => {
    const p = path.join(HUB, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    written.push(p);
    shareMode(p);          // a card absorbed into projects/ is rewritten by other users afterwards
  };
  try {
    for (const dir of new Set(plan.writes.map(w => path.dirname(path.join(HUB, w))))) {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    }
    for (const q of queues) write(`absorbed/${label}/queues/${q.file}`, renameText(q.text));
    for (const c of cards) write(c.exists ? `absorbed/${label}/projects/${c.file}` : `projects/${c.file}`, renameText(c.text));
    for (const r of resources) write(r.exists ? `absorbed/${label}/resources/${r.file}` : `resources/${r.file}`, renameText(r.text));
    if (outEvents.length) write(`tasks.${label}.events.jsonl`, outEvents.join('\n') + '\n');
    if (outJournal.length) write(`journal.${label}.jsonl`, outJournal.join('\n') + '\n');
    if (outUsage.length) write(`usage.${label}.jsonl`, outUsage.join('\n') + '\n');
    const manifest = { ...plan, absorbedAt: now(), by: a.by, hubdVersion: VERSION };
    write(`absorbed/${label}/manifest.json`, JSON.stringify(manifest, null, 1) + '\n');
  } catch (e) {
    for (const p of written.reverse()) { try { fs.unlinkSync(p); } catch {} }
    try { fs.rmSync(path.join(HUB, 'absorbed', label), { recursive: true, force: true }); } catch {}
    throw new Error('absorb aborted, nothing kept: ' + (e && e.message ? e.message : e) + ' - fix the permission (the hub dir must be writable by you, including directories a git pull created) and run it again');
  }

  const db = rebuildTaskCache();
  plan.tasksVisible = db.tasks.filter(t => t._origin && t._origin.node === label).length;
  journalAppend({
    ts: now(), project: 'hub', agent: a.by, kind: 'note',
    text: `absorbed ${from} as node ${label}: ${addIds.length} task(s) (${plan.tasksVisible} visible after fold), ${outJournal.length} journal entr(y/ies), ${queues.length} queue file(s) kept under absorbed/${label}/ - ${plan.unread.length} with unread block(s)` +
      (cards.filter(c => c.exists).length ? `; ${cards.filter(c => c.exists).length} card(s) kept aside (slug exists)` : '') +
      (addIds.length ? `; ids renamed ${addIds[0]} -> ${idMap.get(addIds[0])} ...` : ''),
  });
  return plan;
}
