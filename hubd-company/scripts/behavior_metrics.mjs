#!/usr/bin/env node
// behavior_metrics.mjs — psychometrics from behavior, not self-report.
// Your hub is a longitudinal behavioral corpus: typed tasks, timestamped
// journals. This script turns it into numbers no questionnaire can give you.
// Feeds the "Numbers" section of recipes/chronicle.md.
//
//   node scripts/behavior_metrics.mjs                          # whole history
//   node scripts/behavior_metrics.mjs --since 2026-07-13       # a week
//   node scripts/behavior_metrics.mjs --focus proj-a,proj-b    # divergence index
//   flags: --until YYYY-MM-DD · --dir <hub folder> · --json
//
// Reads journal.*.jsonl + tasks.*.events.jsonl (written by hubd). If your
// folder has none yet, connect hubd and come back in a week.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const DIR = opt('--dir') || process.env.HUBD_DIR || process.cwd();
const FOCUS = (opt('--focus') || process.env.HUBD_FOCUS || '').split(',').filter(Boolean);
const EPISODE_GAP_MIN = 120;
const since = opt('--since'), until = opt('--until'), asJson = args.includes('--json');

const inRange = (ts) => (!since || ts >= since) && (!until || ts < until);
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);
const files = (prefix, suffix) => {
  try { return readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith(suffix)); }
  catch { return []; }
};

// ---- journals ----
const journal = files('journal.', '.jsonl').flatMap((f) => lines(join(DIR, f)))
  .filter((e) => e.ts && inRange(e.ts)).sort((a, b) => a.ts.localeCompare(b.ts));
if (!journal.length) {
  console.error(`behavior_metrics: no journal.*.jsonl entries found in ${DIR} (use --dir, or let hubd run for a while)`);
  process.exit(1);
}

const count = (arr, key) => arr.reduce((m, e) => { const k = key(e) ?? '?'; m[k] = (m[k] || 0) + 1; return m; }, {});
const byProject = count(journal, (e) => e.project);
const byKind = count(journal, (e) => e.kind);
const stateNotes = journal.filter((e) => e.kind === 'note' && /^(mood|energy|checkin|checkout|session):/.test(e.text || ''));

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const byDow = count(journal, (e) => DOW[new Date(e.ts.replace(' ', 'T')).getDay()]);
const byHour = count(journal, (e) => e.ts.slice(11, 13));

// episodes: event clusters with gaps < EPISODE_GAP_MIN across all journals
const episodes = [];
for (const e of journal) {
  const t = new Date(e.ts.replace(' ', 'T')).getTime();
  const cur = episodes[episodes.length - 1];
  if (cur && t - cur.end <= EPISODE_GAP_MIN * 60000) { cur.end = t; cur.n++; }
  else episodes.push({ start: t, end: t, n: 1 });
}
const epStats = {
  count: episodes.length,
  activeDays: new Set(journal.map((e) => e.ts.slice(0, 10))).size,
  medianMinutes: [...episodes].map((e) => (e.end - e.start) / 60000).sort((a, b) => a - b)[Math.floor(episodes.length / 2)],
};

// divergence index: attention share of the declared-priority (focus) projects
const focusShare = FOCUS.length
  ? Math.round(FOCUS.reduce((s, p) => s + (byProject[p] || 0), 0) / journal.length * 100) + '%'
  : null;

// ---- tasks: replay events → conversion / half-life ----
const events = files('tasks.', '.events.jsonl').flatMap((f) => lines(join(DIR, f)))
  .filter((e) => e.ts).sort((a, b) => a.ts.localeCompare(b.ts));
const tasks = new Map();
// Key by (node, id): legacy bare-numeric ids were minted per node and can collide
// across nodes — keyed by id alone, two colliding adds merged into one task and a
// close on either "closed both" in these numbers. Post-0.4.8 set/del events carry the
// task's ORIGIN coordinates (matching its add), so they resolve here; a legacy set
// keyed to a remapped id may still miss — metrics-grade, not the engine's fold.
const evKey = (e) => `${e.node || '?'}::${e.id}`;
for (const e of events) {
  if (e.ev === 'add' && e.t) tasks.set(evKey(e), { ...e.t, _created: e.ts });
  else if (e.ev === 'set' && tasks.has(evKey(e))) {
    const t = tasks.get(evKey(e));
    if (e.patch?.status === 'done' && t.status !== 'done') t._done = e.ts;
    Object.assign(t, e.patch);
  } else if (e.ev === 'del') tasks.delete(evKey(e));
}
const all = [...tasks.values()].filter((t) => !since || t._created >= since || (t._done && inRange(t._done)));
const days = (a, b) => Math.round((new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 864e5 * 10) / 10;
const median = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
const byCat = {};
for (const t of all) {
  const c = t.cat || t.kind || '?';
  byCat[c] ??= { total: 0, done: 0, lifespans: [], openAges: [] };
  byCat[c].total++;
  if (t.status === 'done') { byCat[c].done++; if (t._done && t._created) byCat[c].lifespans.push(days(t._created, t._done)); }
  else if (t._created) byCat[c].openAges.push(days(t._created, new Date().toISOString().replace('T', ' ')));
}
const catRows = Object.entries(byCat).map(([cat, v]) => ({
  cat, total: v.total, done: v.done, conv: Math.round((v.done / v.total) * 100) + '%',
  medianDaysToDone: median(v.lifespans), medianOpenAgeDays: median(v.openAges),
}));
const byAssignee = {};
for (const t of all) {
  const a = t.assignee || '—';
  byAssignee[a] ??= { total: 0, done: 0 };
  byAssignee[a].total++; if (t.status === 'done') byAssignee[a].done++;
}

const out = {
  range: { since: since || 'all history', until: until || 'now' },
  journal: { events: journal.length, byProject, byKind, byDow, byHour, stateNotes: stateNotes.length },
  episodes: epStats,
  divergence: FOCUS.length ? { focusProjects: FOCUS, focusShare } : null,
  tasks: { tracked: all.length, byCat: catRows, byAssignee },
};

if (asJson) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
const top = (o, n = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(' · ');
console.log(`# behavior_metrics · ${out.range.since} → ${out.range.until}`);
console.log(`journal: ${journal.length} events · state-notes: ${stateNotes.length}`);
console.log(`attention by project: ${top(byProject)}`);
console.log(`kinds: ${top(byKind)}`);
console.log(`weekdays: ${DOW.slice(1).concat('Sun').map((d) => `${d}:${byDow[d] || 0}`).join(' · ')}`);
console.log(`episodes: ${epStats.count} over ${epStats.activeDays} active days · median ${epStats.medianMinutes} min`);
if (focusShare) console.log(`DIVERGENCE INDEX: focus projects (${FOCUS.join(',')}) get ${focusShare} of attention`);
else console.log(`(pass --focus proj-a,proj-b to compute the divergence index: attention share of declared priorities)`);
console.log(`tasks (${all.length}):`);
for (const r of catRows) console.log(`  ${r.cat}: ${r.done}/${r.total} = ${r.conv} · to done ~${r.medianDaysToDone ?? '—'}d · open age ~${r.medianOpenAgeDays ?? '—'}d`);
console.log(`by assignee: ${Object.entries(byAssignee).map(([a, v]) => `${a} ${v.done}/${v.total}`).join(' · ')}`);
