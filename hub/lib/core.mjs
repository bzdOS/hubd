import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// Installed hubd version (stamps the generated HUBD.md so each node can tell if its
// materialised protocol matches the code actually running there).
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0'; }
})();

// resolveHub:start
//   purpose: choose the hub base dir — the SINGLE source of truth for where data lives.
//   output: absolute path. Order: HUBD_DIR | PROJECT_HUB_DIR (env) wins; else ~/.hubd; else the
//     legacy ~/.project-hub if it exists and ~/.hubd does not (graceful rebrand — never orphan an old base).
//   INVARIANT: this is the ONLY place the hub location is decided. `os.homedir()` + '.hubd'/'.project-hub'
//     may appear ONLY inside this function. Every other reference to hub paths goes through the exported
//     HUB / PROJ / HISTORY / JOURNAL / TASKS / CLAIMS / TASK_EVENTS (set by setHubBase) — never rebuild a
//     hub path from os.homedir() or a literal '~/.hubd' anywhere else.
//   why: HUBD_DIR override, the multi-tenant per-request setHubBase(tenant) repoint, and the legacy base
//     each break the instant a path is hardcoded — a stray ~/.hubd then SHADOWS the real hub. This is the
//     exact bug that was in `hub doctor` / `hub serve` (a hardcoded ~/.hubd/AGENTS.md candidate); fixed.
function resolveHub() {
  const env = process.env.HUBD_DIR || process.env.PROJECT_HUB_DIR;
  if (env) return env;
  const fresh = path.join(os.homedir(), '.hubd');
  const legacy = path.join(os.homedir(), '.project-hub');
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) return legacy;
  return fresh;
}
// resolveHub:end
// Per-host journal: each machine appends to journal.<node>.jsonl so that several
// machines syncing the same hub never conflict on one append-only file. node id
// defaults to the hostname (override with HUBD_NODE). journalFiles() merges all
// journal*.jsonl on read, so legacy single-file journal.jsonl is still picked up.
export const JOURNAL_NODE = (process.env.HUBD_NODE || os.hostname() || 'node')
  .split('.')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';

// Hub paths derive from a base dir. setHubBase() repoints them — the HTTP transport
// calls it per request to serve a per-tenant directory (tenants/<hash>); stdio and
// the CLI just use the one default base. Safe ONLY because every run* tool is fully
// synchronous: never add `await` inside a tool implementation, or a concurrent HTTP
// request could swap the base mid-call.
export let HUB, PROJ, HISTORY, JOURNAL, TASKS, CLAIMS, TASK_EVENTS, RESOURCES, PRESENCE;
export function setHubBase(dir) {
  HUB = dir;
  PROJ = path.join(HUB, 'projects');
  HISTORY = path.join(PROJ, 'history');
  RESOURCES = path.join(HUB, 'resources');
  PRESENCE = path.join(HUB, 'presence');
  JOURNAL = path.join(HUB, `journal.${JOURNAL_NODE}.jsonl`);
  TASKS = path.join(HUB, 'tasks.json');
  CLAIMS = path.join(HUB, 'claims.json');
  TASK_EVENTS = path.join(HUB, `tasks.${JOURNAL_NODE}.events.jsonl`);
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(HISTORY, { recursive: true });
  fs.mkdirSync(RESOURCES, { recursive: true });
  fs.mkdirSync(PRESENCE, { recursive: true });
}
setHubBase(resolveHub());

export const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
// Parse a stored "YYYY-MM-DD HH:MM" timestamp as UTC (the format now() writes).
// Without the trailing 'Z', JS Date() treats the string as local time — wrong.
export const parseTs = (s) => {
  const t = String(s).replace(' ', 'T');
  // now() writes "YYYY-MM-DD HH:MM" (no zone) — treat as UTC. But some entries
  // already carry a zone (e.g. ISO "...Z"); don't double-append and break them.
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z');
};
// Unicode-aware: keeps letters/numbers of any script (no literal non-ASCII in source).
export const slugify = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';

/* ── Who did this ──
 * The journal is append-only, so a write with no author is unattributable forever.
 * The field used to default to 'unknown' on exactly the tools where it was optional
 * (sync, card-set, resource-set, task add/update) — and those produced 173 'unknown'
 * entries out of 1193 in this hub. The tools that already REQUIRE it (report, claim,
 * heartbeat) have clean names, all 6 of them. Discipline follows the requirement, so
 * the fallbacks are gone and the field is required.
 *
 * What the field names is the session or function doing the work — NOT which model is
 * running. Which model it is is a fact recorded in the client's own transcript and
 * picked up from there; repeating it here says nothing about WHO acted, because many
 * sessions share one model. Hence a bare model or client family name is refused the
 * same way a placeholder is: 'claude' alone accounted for 167 of those 1193 entries.
 * Names that denote a function ('orchestrator', 'devops') are fine — one session is
 * behind them. */
const AUTHOR_REFUSED = new Set([
  'unknown', 'none', 'null', 'nil', 'n/a', 'na', 'agent', 'assistant', 'bot', 'model',
  'user', 'root', 'cli', 'mcp', 'me', 'you', 'someone', 'anon', 'anonymous',
  'claude', 'sonnet', 'opus', 'haiku', 'gpt', 'chatgpt', 'codex', 'gemini', 'glm',
  'llama', 'mistral', 'qwen', 'deepseek', 'grok',
  'opencode', 'cursor', 'copilot', 'windsurf', 'antigravity', 'aider',
]);

export function requireAuthor(value, field = 'agent') {
  const v = String(value ?? '').trim();
  if (!v) throw new Error(
    `${field} required: the function you are performing, e.g. "dev-hubd" or "reviewer-bsdos". ` +
    `Set HUBD_AGENT to give every call a default.`);
  if (AUTHOR_REFUSED.has(v.toLowerCase())) throw new Error(
    `${field} "${v}" names a model, a client or a placeholder, not a session — many sessions ` +
    `share it, so nothing can tell them apart later. Say what you are working on: "${v.toLowerCase()}-<project>". ` +
    `Which model you are is read from the transcript, not from here.`);
  return v;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(file) {
  const lock = file + '.lock';
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.closeSync(fd);
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Check for stale lock: if mtime > 30s old, treat as abandoned and steal it.
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 30000) {
          try { fs.unlinkSync(lock); } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
          }
          continue; // retry immediately
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        // Lock vanished between our open attempt and the stat — retry.
        continue;
      }
      sleepMs(50);
    }
  }
  throw new Error('hub busy, retry');
}

function releaseLock(lock) {
  try { fs.unlinkSync(lock); } catch {}
}

export function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export function withLock(file, fn) {
  const lock = acquireLock(file);
  try { return fn(); } finally { releaseLock(lock); }
}

export function sh(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim(); }
  catch { return ''; }
}

export function gitFacts(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  return {
    branch: sh('git rev-parse --abbrev-ref HEAD', dir),
    last10: sh('git log --oneline -10', dir),
    dirty: sh('git status --short', dir).split('\n').filter(Boolean).length,
    lastCommitAt: sh('git log -1 --format=%ci', dir),
  };
}

// gitDiffSummary: compute what changed since the last sync, from git.
// Returns null if git is unavailable.
// Uses the card's stored lastCommitAt (the commit timestamp from the previous
// sync) to find the divergence point. `sinceLastSync` tells the caller which
// question was answered: true → the counts really are "since the last sync"
// (newCommits may legitimately be 0); false → no usable baseline, so commitLog
// is just the last 10 commits as context and the counts mean nothing.
export function gitDiffSummary(dir, prevLastCommitAt) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  // Resolve the baseline: the last commit the previous sync saw. --before is
  // inclusive, so at the stored timestamp this returns that very commit.
  // Only trust a git-shaped timestamp ("%ci" → 2026-07-09 21:57:11 +0100) —
  // the card is user-editable, and this value is interpolated into a shell command.
  let hashAt = '';
  if (prevLastCommitAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(prevLastCommitAt.trim())) {
    hashAt = sh(`git log -1 --before="${prevLastCommitAt.trim()}" --format=%H`, dir);
  }
  if (!hashAt) {
    // No prior sync (or the baseline commit is gone): show last 10 as context,
    // and flag that these are NOT new commits.
    const recent = sh('git log --oneline -10', dir).split('\n').filter(Boolean);
    return {
      sinceLastSync: false,
      newCommits: 0,
      insertions: null, deletions: null, filesChanged: null,
      commitLog: recent,
    };
  }
  const commitsNew = sh(`git log --oneline ${hashAt}..HEAD`, dir).split('\n').filter(Boolean);
  const statSummary = commitsNew.length ? sh(`git diff --shortstat ${hashAt}..HEAD`, dir) : '';
  // Parse --shortstat output like " 5 files changed, 120 insertions(+), 30 deletions(-)".
  // git omits a clause entirely when its count is zero, so once we have a stat line
  // a missing clause means 0 — null is reserved for "no diff was measured at all".
  const num = (re) => { const m = statSummary.match(re); return m ? parseInt(m[1], 10) : (statSummary ? 0 : null); };
  return {
    sinceLastSync: true,
    newCommits: commitsNew.length,
    insertions: num(/(\d+) insertion/),
    deletions: num(/(\d+) deletion/),
    filesChanged: num(/(\d+) file/),
    commitLog: commitsNew.slice(0, 10),  // cap at 10 for the card
  };
}

// projectMetrics: auto-detect common project health metrics from files.
// Scans for package.json, pyproject.toml, VERSION, Makefile, etc. and
// extracts version, test count where discoverable. Returns {} if nothing found.
export function projectMetrics(dir) {
  const m = {};
  // Version detection
  try {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const o = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (o.version) m.version = o.version;
      if (o.name) m.packageName = o.name;
    }
  } catch {}
  try {
    const pp = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pp)) {
      const text = fs.readFileSync(pp, 'utf8');
      const vm = text.match(/^version\s*=\s*["']([^"']+)["']/m);
      if (vm) m.version = vm[1];
    }
  } catch {}
  try {
    const vf = path.join(dir, 'VERSION');
    if (fs.existsSync(vf) && !m.version) m.version = fs.readFileSync(vf, 'utf8').trim();
  } catch {}
  // Test count: scan for pytest-style test files or count tests in common patterns.
  // Best-effort, never blocks — wrong/missing is fine.
  try {
    let testCount = 0;
    // Python: count "def test_" in test files
    for (const d of ['tests', 'test', '.']) {
      const td = path.join(dir, d);
      if (!fs.existsSync(td)) continue;
      for (const f of fs.readdirSync(td).slice(0, 500)) {
        if (!f.endsWith('.py') || !f.startsWith('test_')) continue;
        try {
          const text = fs.readFileSync(path.join(td, f), 'utf8');
          testCount += (text.match(/^def test_/gm) || []).length;
        } catch {}
      }
      if (testCount > 0) break;
    }
    // JS/TS: count "test(" or "it(" in test files
    if (testCount === 0) {
      for (const d of ['tests', 'test', '__tests__']) {
        const td = path.join(dir, d);
        if (!fs.existsSync(td)) continue;
        for (const f of fs.readdirSync(td).slice(0, 500)) {
          if (!/\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/.test(f)) continue;
          try {
            const text = fs.readFileSync(path.join(td, f), 'utf8');
            testCount += (text.match(/\b(?:it|test)\s*\(/g) || []).length;
          } catch {}
        }
        if (testCount > 0) break;
      }
    }
    if (testCount > 0) m.tests = testCount;
  } catch {}
  return Object.keys(m).length ? m : null;
}

export function markerFiles(dir) {
  const candidates = ['README.md', 'tasks.md', 'TODO.md', 'PLAN.md'];
  try {
    for (const f of fs.readdirSync(dir).slice(0, 200)) {
      if (/master-plan|roadmap|plan/i.test(f) && f.endsWith('.md')) candidates.push(f);
    }
  } catch {}
  return candidates.filter(f => fs.existsSync(path.join(dir, f)));
}

export function cardPath(name) { return path.join(PROJ, slugify(name) + '.md'); }
export function readCard(name) {
  const p = cardPath(name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/* ── Tasks (event-sourced) ──
 * Truth lives in append-only per-host logs tasks.<node>.events.jsonl (like the
 * journal): each machine appends only to its own file, so several machines
 * syncing one hub never collide on tasks. tasks.json is a GENERATED CACHE,
 * rebuilt by folding all event files; it is gitignored (runtime, never synced).
 * Events: {ts,node,ev:'add',id,t} · {ts,node,ev:'set',id,patch} · {ts,node,ev:'del',id}.
 * The fold is a deterministic reducer (order by ts,node,line) and resolves the
 * one residual hazard — two offline machines minting the same numeric id — by
 * keeping the first and remapping the later add to a fresh id.
 * APPEND-ONLY CONTRACT: these logs only grow. A migration/upgrade MUST append
 * set/backfill events — never rewrite a file or drop fields. The data is
 * intentionally richer than the engine schema (harvest captures fields the tools
 * don't yet surface); an unrecognized field is meaning, not cruft. `hub doctor`
 * flags a non-append-only rewrite. */
// TASK_EVENTS is defined per-base in setHubBase() above.

export function taskEventFiles() {
  try {
    return fs.readdirSync(HUB).filter(f => /^tasks\..+\.events\.jsonl$/.test(f)).sort().map(f => path.join(HUB, f));
  } catch { return []; }
}

function readTaskEvents() {
  const evs = [];
  for (const f of taskEventFiles()) {
    const node = (path.basename(f).match(/^tasks\.(.+)\.events\.jsonl$/) || [])[1] || 'node';
    let idx = 0;
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const e = JSON.parse(l); e._node = e.node || node; e._idx = idx++; evs.push(e); } catch {}
      }
    } catch {}
  }
  evs.sort((a, b) => {
    const ta = String(a.ts || ''), tb = String(b.ts || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (a._node !== b._node) return a._node < b._node ? -1 : 1;
    return a._idx - b._idx;
  });
  return evs;
}

export function foldTasks() {
  const evs = readTaskEvents();
  const tasks = new Map();   // finalId -> task (insertion order preserved)
  const remap = new Map();   // `${node}::${origId}` -> finalId
  const seen = new Set();    // every finalId ever assigned (incl. since-deleted) — never reuse across nodes
  let maxNum = 0;
  const numeric = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  for (const e of evs) {
    const key = `${e._node}::${e.id}`;
    if (e.ev === 'add') {
      let fid = e.id;
      if ((tasks.has(fid) || seen.has(fid)) && remap.get(key) !== fid) fid = maxNum + 1; // id taken (even if since-deleted) → remap later add
      // _origin = the (node,id) this task was ADDED under. Invariant: remap[origin.node::
      // origin.id] === fid. Lets the write-path key set/del to origin so an UNCHANGED reducer
      // resolves them to THIS canonical task from any node — even a node that historically
      // collided on fid (the cross-node mis-close bug). Derived every fold; NOT an event →
      // lazy migration, zero history rewrite.
      const t = { ...(e.t || {}), id: fid, _origin: { node: e._node, id: e.id } };
      tasks.set(fid, t);
      seen.add(fid);
      remap.set(key, fid);
      maxNum = Math.max(maxNum, numeric(fid));
    } else if (e.ev === 'set') {
      const fid = remap.get(key) ?? e.id;
      const t = tasks.get(fid);
      if (t) Object.assign(t, e.patch || {});
    } else if (e.ev === 'del') {
      const fid = remap.get(key) ?? e.id;
      tasks.delete(fid);
    }
  }
  return { seq: maxNum, tasks: [...tasks.values()] };
}

function newestEventMtime() {
  let m = 0;
  for (const f of taskEventFiles()) { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch {} }
  return m;
}

export function rebuildTaskCache() {
  const db = foldTasks();
  atomicWrite(TASKS, db);
  return db;
}

// Read tasks. If event logs exist they are the truth: rebuild the tasks.json
// cache whenever it is missing or older than the newest event file (e.g. a
// mesh pull just brought new events). No events yet → legacy single-file read.
export function loadTasks() {
  if (taskEventFiles().length) {
    let cacheMtime = 0;
    try { cacheMtime = fs.statSync(TASKS).mtimeMs; } catch {}
    if (cacheMtime < newestEventMtime()) return rebuildTaskCache();
    try { return JSON.parse(fs.readFileSync(TASKS, 'utf8')); } catch { return rebuildTaskCache(); }
  }
  try { return JSON.parse(fs.readFileSync(TASKS, 'utf8')); } catch { return { seq: 0, tasks: [] }; }
}

/* ── Claims ── */
export function loadClaims() {
  try { return JSON.parse(fs.readFileSync(CLAIMS, 'utf8')); } catch { return { claims: [] }; }
}

export function activeClaims(claims) {
  const nowMs = Date.now();
  return claims.filter(c => {
    const ttl = c.ttlMin ?? 240;
    if (ttl === 0) return false;
    return nowMs < parseTs(c.since).getTime() + ttl * 60000;
  });
}

/* ── Journal ── */
export function journalFiles() {
  try {
    return fs.readdirSync(HUB)
      .filter(f => /^journal.*\.jsonl$/.test(f))
      .sort()
      .map(f => path.join(HUB, f));
  } catch { return []; }
}

export function journalAppend(entry) {
  withLock(JOURNAL, () => {
    try {
      if (fs.existsSync(JOURNAL) && fs.statSync(JOURNAL).size > 2 * 1024 * 1024) {
        const ym = new Date().toISOString().slice(0, 7);
        let archive = path.join(HUB, `journal.${JOURNAL_NODE}-${ym}.jsonl`);
        for (let n = 2; fs.existsSync(archive); n++) archive = path.join(HUB, `journal.${JOURNAL_NODE}-${ym}.${n}.jsonl`);
        fs.renameSync(JOURNAL, archive);   // unique name — never overwrite an existing month-archive (was silent data loss)
      }
    } catch {}
    fs.appendFileSync(JOURNAL, JSON.stringify(entry) + '\n');
  });
}

export function journalTail(project, n = 12) {
  const all = [];
  for (const f of journalFiles()) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
        try { all.push(JSON.parse(l)); } catch {}
      }
    } catch {}
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // merge multiple per-host files by time
  const filtered = project ? all.filter(e => e.project === slugify(project)) : all;
  return filtered.slice(-n);
}

export function journalSince(hours) {
  const cutoff = Date.now() - hours * 3600000;
  const all = [];
  for (const f of journalFiles()) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(l);
          if (parseTs(e.ts).getTime() >= cutoff) all.push(e);
        } catch {}
      }
    } catch {}
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // merge per-host files by time
  return all.reverse(); // newest first
}

/* ── Tool implementations ── */

// Sync owns only the meta block, ## Digest and ## Facts (auto). Everything an
// owner wrote by hand — YAML frontmatter (harvest cards: status/parent/related/
// owner_kind) and a plain "## Facts" section — must survive a rewrite verbatim.
function cardFrontmatter(text) {
  if (!text || !text.startsWith('---\n')) return '';
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) return lines.slice(0, i + 1).join('\n') + '\n';
  }
  return '';
}

// The writer regenerates ONLY the meta block, ## Digest and (on sync) ## Facts (auto).
// EVERY other section the owner wrote — the plain "## Facts" plus any hand sections
// (roadmap, gates, market, decisions, ...) — must survive a rewrite verbatim, in order.
// why: an earlier version kept only "## Facts" and silently dropped the rest, deleting
// curated card content on every sync/card-set. Cards only grow unless the owner edits
// them by hand; a tool rewrite must never strip a section it does not own.
function cardPreservedSections(text, owned) {
  if (!text) return '';
  const heads = [];
  const re = /^## .+$/gm;
  let m;
  while ((m = re.exec(text))) heads.push({ i: m.index, h: m[0].replace(/[ \t]+$/, '') });
  const keep = [];
  for (let k = 0; k < heads.length; k++) {
    const end = k + 1 < heads.length ? heads[k + 1].i : text.length;
    if (!owned.has(heads[k].h)) keep.push(text.slice(heads[k].i, end).trimEnd());
  }
  return keep.length ? keep.join('\n\n') + '\n' : '';
}

// The canonical card sections — the SINGLE i18n source for BOTH the new-card scaffold
// AND the structured-report router, so the two can never drift (the whole point of 0.2.0).
// The engine owns ## Digest and ## Facts (auto); these are the owner sections. Default
// headings/hints are English (public code stays ASCII). An instance localises ALL of them
// in ONE file, HUB/sections.json: { "<key>": "<heading>" | {"heading":..,"hint":..} },
// merged by key. (card-template.md is a deprecated freeform escape hatch; report-sections.json
// is a deprecated alias of sections.json — both still honoured for back-compat.)
const SECTIONS_DEFAULT = [
  { key: 'next',          heading: 'Next step',          hint: 'the one next action — who, by when' },
  { key: 'gates',         heading: 'Gates',              hint: 'kill / scale criteria — name the honest metric to judge by, not vanity' },
  { key: 'metrics',       heading: 'Metrics',            hint: 'current honest readings' },
  { key: 'market',        heading: 'Market',             hint: 'who it is for; is paying demand proven?' },
  { key: 'facts',         heading: 'Facts & hypotheses', hint: 'what is known (fact) vs what is being tested (hypothesis)' },
  { key: 'decisions',     heading: 'Decisions',          hint: 'append-only log: decision · why · date' },
  { key: 'communication', heading: 'Communication',      hint: 'what has gone out externally vs what is still queued' },
];
export function sectionsConfig() {
  const cfg = SECTIONS_DEFAULT.map(s => ({ ...s }));
  for (const fname of ['sections.json', 'report-sections.json']) {   // report-sections.json = deprecated alias
    try {
      const f = path.join(HUB, fname);
      if (!fs.existsSync(f)) continue;
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const s of cfg) {
        const ov = o[s.key];
        if (typeof ov === 'string') s.heading = ov;
        else if (ov && typeof ov === 'object') { if (ov.heading) s.heading = ov.heading; if (ov.hint) s.hint = ov.hint; }
      }
      return cfg;   // first file found wins (sections.json preferred)
    } catch {}
  }
  return cfg;
}

// "Buttons" (task #159): which queue roles are HUMAN owners, not agents — the
// distinction that turns a plain queue-depth number into "N buttons waiting".
// A plain JSON array of role names in HUB/owner-roles.json (mirrors sectionsConfig's
// file-config pattern); default empty so an instance that hasn't configured it just
// gets no button rollup, not a guess at who "the owner" is.
export function ownerRoles() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(HUB, 'owner-roles.json'), 'utf8'));
    return Array.isArray(arr) ? arr.filter(r => typeof r === 'string' && r) : [];
  } catch { return []; }
}

// Materialise the agent-facing protocol (prompts/protocol.md, shipped with the code) into
// HUB/HUBD.md, stamped with the installed version. GENERATED per-node artifact (like tasks.json):
// gitignored, never mesh-synced — so two nodes on different versions never fight over it and each
// node's HUBD.md matches the code running there. Any `hub` run / daemon start / `hub upgrade`
// refreshes it when the stamp != installed version. This is how a hubd upgrade's new instructions
// reach every ~/.hubd (yours and other users'), including agents that read the files directly.
// Ensure one literal line is present in HUB/.gitignore, appending it if missing.
// Runs unconditionally (not just when HUBD.md is (re)written) so an upgraded
// hubd on an EXISTING ~/.hubd still gets new runtime-only paths ignored before
// anything writes to them — mesh-sync.sh runs a plain `git add -A`, so an
// un-ignored runtime file becomes real (and noisy) mesh-synced history the
// first sync after it appears.
/* ── Environment checks: how an agent learns its environment needs work ──
 * An upgrade can require something OUTSIDE the code — a variable in a client's
 * config, a role declared in the hub, a protocol section worth re-reading. Nothing
 * told the agent. It found out by having a call rejected, or never.
 *
 * Three rules this is built on, each one a lesson from getting it wrong:
 *
 * NEVER THROW. A required field with no floor turns a forgotten argument into a
 * failed call; an environment check that blocks work would do the same at a larger
 * scale. Checks report, they do not gate.
 *
 * SAY WHO CAN FIX IT. `actor` is the axis that keeps this from becoming nagging
 * about things the agent cannot touch: 'agent' (write a file in the hub — do it),
 * 'agent+restart' (edit a client config, takes effect on restart), 'owner' (a human
 * on another host). For 'owner' the remedy SUGGESTS filing a button; this code never
 * writes to anyone's queue by itself.
 *
 * A CONDITION GATES ITSELF. There is deliberately no "acknowledged in version X"
 * bookkeeping: a check fires while its detector is true and goes quiet when it is
 * fixed. Version-gating would suppress a live problem because the node had already
 * seen that version — the state file would end up asserting things about the world
 * that stopped being true.
 *
 * State lives in .env-state.json: node-local, gitignored, NEVER mesh-synced. Three
 * machines have three different environments, so one shared file would be wrong for
 * all of them at once. Same class as tasks.json and HUBD.md. */
const envStateFile = () => path.join(HUB, '.env-state.json');
function readEnvState() { try { return JSON.parse(fs.readFileSync(envStateFile(), 'utf8')); } catch { return {}; } }
function writeEnvState(obj) { try { atomicWrite(envStateFile(), JSON.stringify(obj, null, 1)); } catch {} }

/**
 * Hash the protocol per SECTION, so an upgrade can say what actually moved instead
 * of "the file changed". Headings (## / ###) delimit; the preamble is excluded
 * because HUBD.md carries a generated version stamp there and a stamp is not a
 * change. Bodies are trimmed, so a reflowed blank line is not a change either.
 */
export function sectionHashes(text) {
  const secs = {};
  let title = null, buf = [];
  for (const line of String(text || '').split('\n')) {
    if (/^#{2,3}\s+/.test(line)) {
      if (title) secs[title] = buf.join('\n').trim();
      title = line.replace(/^#+\s*/, '').trim(); buf = [];
    } else buf.push(line);
  }
  if (title) secs[title] = buf.join('\n').trim();
  const out = {};
  for (const [k, v] of Object.entries(secs)) out[k] = crypto.createHash('sha1').update(v).digest('hex').slice(0, 10);
  return out;
}

function shippedProtocol() {
  try { return fs.readFileSync(new URL('../../prompts/protocol.md', import.meta.url), 'utf8'); }
  catch { return null; }
}

/**
 * Reconcile the stored protocol baseline with the installed one and return what an
 * agent should re-read: {from, titles} or null.
 *
 * The diff is against the last baseline stored for THIS NODE, not against the file
 * on disk. ensureProtocol runs on every CLI invocation, so the first `hub` call after
 * an upgrade already rewrote HUBD.md — a session starting a minute later would see no
 * difference at all. Storing the baseline also means deleting HUBD.md loses nothing.
 *
 * A first-ever run announces nothing: with no baseline there is no change, and
 * claiming "everything is new" on a fresh hub would be noise.
 *
 * If nobody acknowledged the previous announcement, its titles are carried forward
 * and `from` stays at the older version — so an agent that missed two upgrades hears
 * about both, not just the last.
 */
export function protocolChanges() {
  const body = shippedProtocol();
  if (!body) return null;
  const cur = sectionHashes(body);
  const st = readEnvState();
  const p = st.protocol || {};
  if (p.version === VERSION && p.sections) {
    return (p.changed && p.changed.length) ? { from: p.changedFrom || null, titles: p.changed } : null;
  }
  const titles = [];
  if (p.sections) {
    for (const [t, h] of Object.entries(cur)) if (p.sections[t] !== h) titles.push(t);
    for (const t of Object.keys(p.sections)) if (!(t in cur)) titles.push(t + ' (removed)');
  }
  const ackedPrev = Object.values(st.sessions || {}).some(s => s && s.protocolAcked === p.version);
  const carry = (!ackedPrev && Array.isArray(p.changed)) ? p.changed : [];
  const merged = [...new Set([...carry, ...titles])];
  st.protocol = {
    version: VERSION, sections: cur, changed: merged,
    changedFrom: (!ackedPrev && p.changedFrom) ? p.changedFrom : (p.version || null),
  };
  writeEnvState(st);
  return merged.length ? { from: st.protocol.changedFrom, titles: merged } : null;
}

/** Record something the code noticed in passing, for a check to interpret later. */
export function recordEnvObservation(kind, value) {
  try {
    const st = readEnvState();
    st.observations = st.observations || {};
    const cur = st.observations[kind] || { values: [] };
    if (value && !cur.values.includes(value)) cur.values.push(value);
    else if (value) return;                       // already known — no write
    cur.at = new Date().toISOString();
    st.observations[kind] = cur;
    writeEnvState(st);
  } catch {}
}

/** Drop an observation that no longer holds, so its check goes quiet by itself. */
export function clearEnvObservation(kind, value) {
  try {
    const st = readEnvState();
    const cur = (st.observations || {})[kind];
    if (!cur || !cur.values.includes(value)) return;
    cur.values = cur.values.filter(v => v !== value);
    writeEnvState(st);
  } catch {}
}

/**
 * What this environment needs, most severe first. Read-mostly, safe to call as often
 * as a caller likes: the one write is protocolChanges() persisting a fresh baseline on
 * the first call after an upgrade — idempotent, every later call is a pure read.
 * Capped, because a list nobody finishes reading is a list nobody reads: three items,
 * and the count tells the rest.
 */
export function envChecks({ session, transport } = {}) {
  const out = [];
  // The floor checks describe THIS process's env — which is the caller's environment
  // only on a local transport. Over HTTP one server serves many agents (or tenants):
  // HUBD_AGENT there could not be any caller's identity, so its absence is not a
  // finding, and the remedy ("edit the client config") points at the wrong machine.
  if (transport !== 'http') {
    const floor = (process.env.HUBD_AGENT || '').trim();
    if (!floor) {
      out.push({
        id: 'author-floor', severity: 'high', actor: 'agent+restart',
        what: 'HUBD_AGENT is not set on this server, so any write that omits an author fails instead of falling back to a name.',
        remedy: 'Add HUBD_AGENT to this hubd server\'s env in the client config (e.g. --env HUBD_AGENT=dev-<project>), naming the function you perform, not the model. Takes effect when the client restarts the server. Until then, pass agent/by explicitly on every write.',
      });
    } else {
      try { requireAuthor(floor, 'HUBD_AGENT'); }
      catch { out.push({
        id: 'author-floor-refused', severity: 'high', actor: 'agent+restart',
        what: `HUBD_AGENT is "${floor}", which names a model, a client or a placeholder, so it is ignored and writes without an author fail.`,
        remedy: 'Replace it with the function being performed — "dev-hubd", "reviewer-bsdos" — in the client config.',
      }); }
    }
  }

  const st = readEnvState();
  const conflicted = ((st.observations || {})['cursor-conflict'] || {}).values || [];
  if (conflicted.length) {
    out.push({
      id: 'queue-fanout-undeclared', severity: 'med', actor: 'agent',
      what: `Two sessions were seen waiting on one cursor for: ${conflicted.join(', ')}. A message goes to exactly one of them, so the other never sees it.`,
      remedy: `If those roles are meant to broadcast, add them to subscriber-roles.json in the team root and every waiter gets its own cursor. If they are work queues, this is working as intended — run a single waiter and the notice goes away.`,
    });
  }

  const pc = protocolChanges();
  if (pc && !(session && ((st.sessions || {})[session] || {}).protocolAcked === VERSION)) {
    out.push({
      id: 'protocol-changed', severity: 'low', actor: 'agent',
      what: `The hub protocol moved${pc.from ? ' from v' + pc.from : ''} to v${VERSION}. Changed section(s): ${pc.titles.join(' · ')}.`,
      remedy: 'Re-read those sections of HUBD.md in the hub root if they touch what you are doing. hubd does not judge which ones matter to you — you know what you are working on.',
    });
  }

  const rank = { high: 0, med: 1, low: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { items: out.slice(0, 3), total: out.length };
}

/** Remember that this session was told about the protocol change, so it is told once. */
export function ackEnvNotices(session) {
  if (!session) return;
  try {
    const st = readEnvState();
    st.sessions = st.sessions || {};
    st.sessions[session] = { ...(st.sessions[session] || {}), protocolAcked: VERSION, at: new Date().toISOString() };
    writeEnvState(st);
  } catch {}
}

function ensureGitignored(entry) {
  const gi = path.join(HUB, '.gitignore');
  let g = ''; try { g = fs.readFileSync(gi, 'utf8'); } catch {}
  const esc = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('^' + esc + '$', 'm').test(g)) return;
  try { fs.appendFileSync(gi, (g && !g.endsWith('\n') ? '\n' : '') + entry + '\n'); } catch {}
}

export function ensureProtocol(force) {
  try {
    fs.mkdirSync(HUB, { recursive: true });
    ensureGitignored('HUBD.md'); ensureGitignored('presence/'); ensureGitignored('.env-state.json');
  } catch {}
  let body;
  try { body = fs.readFileSync(new URL('../../prompts/protocol.md', import.meta.url), 'utf8'); }
  catch { return { ok: false }; }
  const target = path.join(HUB, 'HUBD.md');
  let cur = '';
  try { cur = fs.readFileSync(target, 'utf8'); } catch {}
  const curVer = (cur.match(/hubd-protocol v([0-9][0-9A-Za-z.\-]*)/) || [])[1] || null;
  if (!force && curVer === VERSION) return { ok: true, version: VERSION, wrote: false, current: curVer };
  const stamp = `<!-- hubd-protocol v${VERSION} — GENERATED from the installed hubd; do not edit. Team rules go in AGENTS.md. Refresh: hub upgrade -->\n\n`;
  try { atomicWrite(target, stamp + body); }
  catch { return { ok: false }; }
  return { ok: true, version: VERSION, wrote: true, from: curVer };
}

// The Harvest Protocol prompt (the paste-able block inside the shipped HARVEST.md) — served
// via the MCP `harvest` prompt and `hub harvest`, so the prompt travels with the package and
// nobody has to fetch it from the repo.
export function harvestPrompt() {
  let md;
  try { md = fs.readFileSync(new URL('../../HARVEST.md', import.meta.url), 'utf8'); }
  catch { return null; }
  const m = md.match(/```[a-z]*\n([\s\S]*?)\n```/);   // first fenced block = the paste-able prompt
  return (m ? m[1] : md).trim();
}

function cardScaffold() {
  try {
    const override = path.join(HUB, 'card-template.md');   // deprecated freeform escape hatch
    if (fs.existsSync(override)) { const t = fs.readFileSync(override, 'utf8').trim(); if (t) return t + '\n'; }
  } catch {}
  return sectionsConfig().map(s => `## ${s.heading}\n\n<${s.hint}>\n`).join('\n');
}

function openTaskCount(slug) {
  try { return loadTasks().tasks.filter(t => t.project === slug && t.status === 'open').length; }
  catch { return 0; }
}

export function runSync(a) {
  const author = requireAuthor(a.agent, 'agent');
  const dir = a.path;
  // Two different mistakes, two different messages — "path does not exist: undefined"
  // told a caller who forgot the argument nothing about what to fix.
  if (!dir) throw new Error('path required: absolute path to the project folder');
  if (!fs.existsSync(dir)) throw new Error('path does not exist: ' + dir);
  const pname = a.name || path.basename(dir);
  const slug = slugify(pname);
  const git = gitFacts(dir);
  const markers = markerFiles(dir);
  const prev = readCard(pname);
  const oldDigest = prev ? (prev.split('## Digest')[1] || '').split('## Facts')[0].trim() : null;
  const digest = a.digest || oldDigest || '_no digest yet — pass one on the next sync_';

  // Auto-detect project metrics (version, test count) and git diff since last sync.
  // The baseline is the lastCommitAt this function wrote into "## Facts (auto)" last
  // time — read it back from that section only, so a hand-written line elsewhere in
  // the card can't be mistaken for it.
  const prevFacts = prev ? (prev.split('## Facts (auto)')[1] || '') : '';
  const prevLastCommitAt = (prevFacts.match(/last commit: ([^\n]+)/) || [])[1] || null;
  const diff = git ? gitDiffSummary(dir, prevLastCommitAt) : null;
  // Only report movement when we had a real baseline to compare against.
  const hasNew = !!(diff && diff.sinceLastSync && diff.newCommits > 0);
  const metrics = projectMetrics(dir);

  if (a.digest && oldDigest && a.digest.trim() !== oldDigest) {
    const histFile = path.join(HISTORY, slug + '.md');
    fs.appendFileSync(histFile, `\n---\n### until ${now()} (sync by ${author})\n${oldDigest}\n`);
  }

  const frontmatter = cardFrontmatter(prev);
  const preserved = cardPreservedSections(prev, new Set(['## Digest', '## Facts (auto)']));
  const ownerBody = prev ? preserved : cardScaffold();   // new card → scaffold template; existing → keep its sections verbatim
  const card = frontmatter +
    `# ${pname}\n\n` +
    `- slug: ${slug}\n- path: ${dir}\n- synced: ${now()} by ${author}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (ownerBody ? ownerBody + '\n' : '') +
    `## Facts (auto)\n\n` +
    `- open tasks: ${openTaskCount(slug)}\n` +
    (metrics ? Object.entries(metrics).map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n' : '') +
    (hasNew ? `- since last sync: ${diff.newCommits} commit(s)${diff.filesChanged ? ', ' + diff.filesChanged + ' file(s)' : ''}${diff.insertions !== null ? ', +' + diff.insertions : ''}${diff.deletions !== null ? '/-' + diff.deletions + ' lines' : ''}\n` : '') +
    (git ? `- branch: ${git.branch} · uncommitted: ${git.dirty} · last commit: ${git.lastCommitAt}\n\n\`\`\`\n${git.last10}\n\`\`\`\n` : '- no git\n') +
    (markers.length ? `- markers: ${markers.join(', ')}\n` : '');
  atomicWrite(cardPath(pname), card);
  const diffText = hasNew ? ` (${diff.newCommits} new commits, +${diff.insertions || 0}/-${diff.deletions || 0})` : '';
  journalAppend({ ts: now(), project: slug, agent: author, kind: 'sync', text: 'synced' + (a.digest ? ' with digest' : '') + diffText });
  return { ok: true, project: slug, card: cardPath(pname), gitSeen: !!git, newCommits: hasNew ? diff.newCommits : 0, metrics, hint: a.digest ? undefined : 'Card kept old/empty digest — pass digest="..." to write your summary.' };
}

// Create or update a project card from just (project, digest) — no folder needed.
// Unlike runSync (which reads a real git folder), this lets harvest/triage capture
// projects that are not a local checkout. Preserves hand-written frontmatter and a
// "## Facts" section; archives a changed digest to history.
export function runCardSet(a) {
  const author = requireAuthor(a.by, 'by');
  const pname = a.project || a.name;
  if (!pname) throw new Error('project required');
  if (!a.digest || !String(a.digest).trim()) throw new Error('digest required');
  const slug = slugify(pname);
  const digest = String(a.digest).trim();
  const prev = readCard(pname);
  const oldDigest = prev ? (prev.split('## Digest')[1] || '').split('## Facts')[0].trim() : null;
  if (oldDigest && digest !== oldDigest) {
    const histFile = path.join(HISTORY, slug + '.md');
    fs.appendFileSync(histFile, `\n---\n### until ${now()} (card set by ${author})\n${oldDigest}\n`);
  }
  const preserved = cardPreservedSections(prev, new Set(['## Digest']));
  const ownerBody = prev ? preserved : cardScaffold();   // new card → scaffold template; existing → keep its sections verbatim
  const card = cardFrontmatter(prev) +
    `# ${pname}\n\n` +
    `- slug: ${slug}\n- set: ${now()} by ${author}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (ownerBody ? ownerBody + '\n' : '');
  atomicWrite(cardPath(pname), card);
  journalAppend({ ts: now(), project: slug, agent: author, kind: 'note', text: 'card set: ' + digest.split('\n')[0].slice(0, 80) });
  return { ok: true, project: slug, card: cardPath(pname) };
}

/* ── Resources (infra/topology as cards) + typed relationship graph ──
 * A resource is a card under resources/<slug>.md — a host, vm, service, endpoint,
 * provider, ... Its STRUCTURED attributes live in frontmatter (type/address/os/
 * provider/status); RELATIONSHIPS are typed frontmatter edges whose values are
 * [[wikilinks]] (runs_on / depends_on / deploys_to / part_of / exposes / connects).
 * The SAME edge mechanism reads project cards too (related: [[x]] etc.), so the graph
 * spans projects ↔ resources uniformly. Structure-first: facts go in fields, prose
 * only in ## Digest. Frontmatter is preserved verbatim by the card writer (no YAML dep —
 * a tiny key: value parser is enough; edges are any frontmatter value with [[links]]). */
export function resourcePath(name) { return path.join(RESOURCES, slugify(name) + '.md'); }
export function readResource(name) {
  const p = resourcePath(name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function extractLinks(value) {
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g; const out = []; let m;
  while ((m = re.exec(String(value)))) out.push(slugify(m[1]));
  return out;
}
function parseFront(text) {            // frontmatter as ordered [{key,value}] (no YAML dep)
  const fm = cardFrontmatter(text); const out = [];
  if (!fm) return out;
  for (const line of fm.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (m) out.push({ key: m[1], value: m[2] });
  }
  return out;
}
function frontToText(pairs) {
  return pairs.length ? '---\n' + pairs.map(p => `${p.key}: ${p.value}`).join('\n') + '\n---\n' : '';
}

// Create/update a resource card. Structured attrs (type/address/os/provider/status) and
// typed edges (a.edges = {rel:[slug,...]}) land in frontmatter; edges UNION with existing
// targets (append-friendly). Body = one-line ## Digest + any hand sections, preserved.
export function runResourceSet(a) {
  const author = requireAuthor(a.by, 'by');
  const name = a.slug || a.name || a.resource;
  if (!name) throw new Error('resource slug required');
  const slug = slugify(name);
  const prev = readResource(name);
  const pairs = parseFront(prev);
  const set = (k, v) => { const p = pairs.find(x => x.key === k); if (p) p.value = v; else pairs.push({ key: k, value: v }); };
  if (!pairs.find(p => p.key === 'kind')) pairs.unshift({ key: 'kind', value: 'resource' });
  for (const [k, v] of [['type', a.type], ['address', a.address], ['os', a.os], ['provider', a.provider], ['status', a.status]])
    if (v != null && v !== '') set(k, String(v));
  if (a.edges) for (const rel of Object.keys(a.edges)) {
    const targets = new Set(extractLinks((pairs.find(p => p.key === rel) || {}).value || ''));
    for (const t of a.edges[rel]) targets.add(slugify(t));
    set(rel, [...targets].map(s => `[[${s}]]`).join(', '));
  }
  const oldDigest = prev ? (prev.split('## Digest')[1] || '').split(/\n## /)[0].trim() : null;
  const digest = (a.digest != null && String(a.digest).trim()) || oldDigest || '<what this is, in one line>';
  if (prev && oldDigest && a.digest != null && String(a.digest).trim() && String(a.digest).trim() !== oldDigest) {
    fs.appendFileSync(path.join(HISTORY, 'resource-' + slug + '.md'), `\n---\n### until ${now()} (resource set by ${author})\n${oldDigest}\n`);
  }
  const preserved = cardPreservedSections(prev, new Set(['## Digest']));
  const card = frontToText(pairs) +
    `# ${name}\n\n` +
    `- slug: ${slug}\n- set: ${now()} by ${author}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (preserved ? preserved + '\n' : '');
  fs.mkdirSync(RESOURCES, { recursive: true });
  atomicWrite(resourcePath(name), card);
  journalAppend({ ts: now(), project: slug, agent: author, kind: 'resource', text: 'resource set: ' + slug });
  return { ok: true, resource: slug, card: resourcePath(name) };
}

function listCards() {
  const out = [];
  for (const [dir, kind] of [[PROJ, 'project'], [RESOURCES, 'resource']]) {
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) out.push({ slug: f.replace(/\.md$/, ''), kind, file: path.join(dir, f) }); } catch {}
  }
  return out;
}

// The typed relationship graph across ALL cards. A frontmatter value containing
// [[links]] is an edge whose TYPE is the key (runs_on, depends_on, related, ...).
export function buildGraph() {
  const nodes = {}; const edges = [];
  for (const c of listCards()) {
    let text = ''; try { text = fs.readFileSync(c.file, 'utf8'); } catch {}
    const front = parseFront(text); const attrs = {};
    for (const p of front) attrs[p.key] = p.value;
    nodes[c.slug] = { slug: c.slug, kind: c.kind, type: attrs.type || c.kind, status: attrs.status || null, address: attrs.address || null };
    for (const p of front) for (const to of extractLinks(p.value)) edges.push({ from: c.slug, rel: p.key, to });
  }
  return { nodes, edges };
}

export function runResourceList(a = {}) {
  const out = [];
  try {
    for (const f of fs.readdirSync(RESOURCES)) {
      if (!f.endsWith('.md')) continue;
      const attrs = {}; for (const p of parseFront(fs.readFileSync(path.join(RESOURCES, f), 'utf8'))) attrs[p.key] = p.value;
      if (a.type && attrs.type !== a.type) continue;
      out.push({ slug: f.replace(/\.md$/, ''), type: attrs.type || 'resource', status: attrs.status || null, address: attrs.address || null });
    }
  } catch {}
  out.sort((x, y) => (x.slug < y.slug ? -1 : 1));
  return { count: out.length, resources: out };
}

export function runResourceGet(a) {
  const name = a.slug || a.resource;
  const card = readResource(name);
  if (!card) throw new Error('no resource: ' + name + ' (create with: hub resource set ' + slugify(name || '') + ')');
  const slug = slugify(name);
  const g = buildGraph();
  return { card, out: g.edges.filter(e => e.from === slug), in: g.edges.filter(e => e.to === slug) };
}

export function runGraph(a = {}) {
  const g = buildGraph();
  let edges = g.edges;
  if (a.project) { const s = slugify(a.project); edges = edges.filter(e => e.from === s || e.to === s); }
  if (a.type) edges = edges.filter(e => (g.nodes[e.from] && g.nodes[e.from].type === a.type) || (g.nodes[e.to] && g.nodes[e.to].type === a.type));
  const dangling = g.edges.filter(e => !g.nodes[e.to]);
  return { nodes: g.nodes, edges, dangling };
}

/* ── Structured report ──
 * Agents recall the hub at session end and dump a BATCH. So `hub report` takes a
 * batch of prefix-tagged lines and deterministically (NO AI — pure prefix match)
 * fans them into the card's structured sections + task events, instead of one prose
 * blob. Multiplicity = more lines. Unprefixed lines degrade to a plain note (prose
 * still accepted). "What changed" (files/commits) is NOT typed — derive from git.
 * Section headings are English by default; an instance localises them with
 * HUB/report-sections.json (so the public code stays ASCII while a localised card
 * template routes correctly). */
const REPORT_PREFIX = {
  DECIDE: 'decide', DECISION: 'decide',
  FACT: 'fact', GOTCHA: 'fact', LEARNED: 'fact', LEARN: 'fact', DISCOVERY: 'fact',
  HYPO: 'hypo', HYPOTHESIS: 'hypo',
  COMM: 'comm', COMMS: 'comm', COMMUNICATION: 'comm', SHIPPED: 'comm',
  NEXT: 'next',
  DONE: 'done', CLOSED: 'done', CLOSE: 'done',
  TASK: 'task', TODO: 'task',
  NOTE: 'note',
};
function reportSections() {
  const byKey = {};
  for (const s of sectionsConfig()) byKey[s.key] = s.heading;   // same single source as the scaffold → no drift
  return { decide: byKey.decisions, fact: byKey.facts, hypo: byKey.facts, comm: byKey.communication, next: byKey.next };
}
function cardBaseFor(name) {
  const slug = slugify(name);
  return `# ${name}\n\n- slug: ${slug}\n\n## Digest\n\n<no digest yet — run hub card ${slug} -m "...">\n\n` + cardScaffold();
}
// Append (or set) one line under a "## Heading" of a card, preserving everything else;
// replaces a lone "<placeholder>" body or creates the section if it is missing.
function editSection(text, heading, payload, mode) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^## ' + esc + '[ \\t]*$', 'm').exec(text);
  if (!m) return text.replace(/\s*$/, '') + '\n\n## ' + heading + '\n\n' + payload + '\n';
  const bodyStart = m.index + m[0].length;
  const rest = text.slice(bodyStart);
  const nm = rest.match(/\n## /);
  const end = nm ? bodyStart + nm.index : text.length;
  const body = text.slice(bodyStart, end).replace(/^\n+/, '').replace(/\s+$/, '');
  const placeholder = /^<[^>]*>$/.test(body.trim());
  const next = (mode === 'set' || placeholder || !body) ? payload : body + '\n' + payload;
  return text.slice(0, bodyStart) + '\n\n' + next + '\n' + text.slice(end);
}

export function runReport(a) {
  const project = a.project || 'general';
  const slug = slugify(project);
  const by = requireAuthor(a.by ?? a.agent, 'by');
  const SEC = reportSections();
  const b = { decide: [], fact: [], hypo: [], comm: [], next: [], done: [], task: [], note: [] };
  for (const raw of String(a.text || '').split('\n')) {
    const ln = raw.replace(/\s+$/, '');
    if (!ln.trim()) continue;
    const m = ln.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/);
    const tag = m ? REPORT_PREFIX[m[1].toUpperCase()] : null;
    if (tag) b[tag].push(m[2].trim()); else b.note.push(ln.trim());
  }
  const summary = { ok: true, project: slug, decisions: 0, facts: 0, hypos: 0, comms: 0, next: false, done: [], doneMissed: [], tasks: [], note: false };
  if (b.decide.length || b.fact.length || b.hypo.length || b.comm.length || b.next.length) {
    let text = readCard(project) || cardBaseFor(project);
    for (const d of b.decide) {
      const [what, why] = d.split('|').map(s => s.trim());
      text = editSection(text, SEC.decide, `- ${now()}: ${what}${why ? ' — ' + why : ''}`, 'append');
      summary.decisions++;
      journalAppend({ ts: now(), project: slug, agent: by, kind: 'decision', text: what + (why ? ' — ' + why : '') });
    }
    for (const f of b.fact) { text = editSection(text, SEC.fact, `- fact: ${f}`, 'append'); summary.facts++; }
    for (const h of b.hypo) { text = editSection(text, SEC.hypo, `- hypothesis: ${h}`, 'append'); summary.hypos++; }
    for (const c of b.comm) { text = editSection(text, SEC.comm, `- ${now()}: ${c}`, 'append'); summary.comms++; }
    if (b.next.length) { text = editSection(text, SEC.next, b.next.map(n => '- ' + n).join('\n'), 'set'); summary.next = true; }
    fs.mkdirSync(PROJ, { recursive: true });
    atomicWrite(cardPath(project), text);
  }
  for (const list of b.done) for (const part of list.split(',')) {
    const id = part.trim();   // id may be a bare number OR a node-scoped string (task #194) — pass through as-is
    // A typo'd id used to vanish silently — the task stayed open and nothing said so.
    // DONE closes without per-task confirmation, so a miss must be loud: it goes in
    // the summary (doneMissed) for the caller to see and recheck.
    if (id) { try { runTaskUpdate({ id, status: 'done', by }); summary.done.push(id); } catch { summary.doneMissed.push(id); } }
  }
  for (const t of b.task) { try { summary.tasks.push(runTaskAdd({ project: slug, text: t, by }).task.id); } catch {} }
  if (b.note.length) {
    journalAppend({ ts: now(), project: slug, agent: by, kind: a.kind || 'note', text: b.note.join(' · ') });
    summary.note = true;
  }
  return summary;
}

export function runStatus() {
  const db = loadTasks();
  const files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md'));
  const projects = files.map(f => {
    const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
    const digest = (c.split('## Digest')[1] || '').split('## Facts')[0].trim().slice(0, 300);
    // hub_card_set cards write `- set:`, not `- synced:` — they used to show '?' here
    // (and never count as stale in runBrief). Either timestamp is a last touch.
    const synced = (c.match(/- (?:synced|set): ([^\n]+)/) || [])[1] || '?';
    const slug = f.replace('.md', '');
    const openTasks = db.tasks.filter(t => t.project === slug && t.status === 'open').length;
    // Extract auto-detected metrics from Facts (auto) section
    const version = (c.match(/- version: ([^\n]+)/) || [])[1] || null;
    const tests = (c.match(/- tests: ([^\n]+)/) || [])[1] || null;
    const sinceSync = (c.match(/- since last sync: ([^\n]+)/) || [])[1] || null;
    const p = { project: slug, synced, digest, openTasks };
    if (version) p.version = version;
    if (tests) p.tests = tests;
    if (sinceSync) p.sinceSync = sinceSync;
    return p;
  });
  return { projects, recentJournal: journalTail(null, 10) };
}

export function runGet(a) {
  const card = readCard(a.project);
  if (!card) throw new Error('no card for: ' + a.project + '. Run hub_sync in its folder first.');
  const slug = slugify(a.project);
  const claimsDb = loadClaims();
  return { card, journal: journalTail(a.project, 15), claims: activeClaims(claimsDb.claims).filter(c => c.project === slug) };
}

export function runSearch(a) {
  const q = String(a.query || '').toLowerCase();
  if (!q) throw new Error('empty query');
  const hits = [];
  for (const f of fs.readdirSync(PROJ).filter(f => f.endsWith('.md'))) {
    const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
    c.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(q)) hits.push({ where: f + ':' + (i + 1), line: line.trim().slice(0, 200) });
    });
  }
  for (const f of journalFiles()) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(l);
          if ((e.text || '').toLowerCase().includes(q))
            hits.push({ where: 'journal ' + e.ts + ' [' + e.project + '/' + e.agent + ']', line: e.text.slice(0, 200) });
        } catch {}
      }
    } catch {}
  }
  return { query: a.query, hits: hits.slice(0, 40), total: hits.length };
}

/* ── Bootstrap: cwd → project (memory series #164) ──
 * An agent's working directory rarely matches its hubd project slug (custom
 * project names, harvested cards with no synced folder, mesh nodes where the
 * same project lives at a different absolute path per host). resolveContext()
 * answers "which project card is THIS checkout", so an agent can self-orient
 * with one call instead of a manual hub_get — most to least certain:
 *   1. a .hubd marker file (repo root or an ancestor, capped at the repo root)
 *      whose trimmed first line IS the slug — explicit, portable across hosts.
 *   2. a project card's own recorded `- path:` (written by hub_sync) equal to
 *      or an ancestor of the resolved root — a real prior sync, not a guess.
 *   3. the root folder's name, slugified, IF a card with that exact slug
 *      already exists — flagged guessed:true so a same-name coincidence is
 *      never silently trusted as fact.
 * Never searches for a marker above the nearest .git root — a marker belongs
 * to the repo it names, not to some ancestor directory shared by unrelated
 * checkouts (the same false-positive hazard resolveQueueRootInfo guards
 * against in lib/queue.mjs).
 */
const CONTEXT_WALK_MAX = 8;   // same depth cap as resolveQueueRootInfo (lib/queue.mjs)

function findGitRoot(startDir) {
  let d = startDir;
  for (let i = 0; i < CONTEXT_WALK_MAX; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}

function findHubdMarker(startDir) {
  let d = startDir;
  for (let i = 0; i < CONTEXT_WALK_MAX; i++) {
    const marker = path.join(d, '.hubd');
    try {
      if (fs.statSync(marker).isFile()) {
        const slug = fs.readFileSync(marker, 'utf8').split('\n')[0].trim();
        if (slug) return { slug: slugify(slug), root: d };
      }
    } catch {}
    if (fs.existsSync(path.join(d, '.git'))) break;   // never search above the repo root
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

// Cards written by hub_sync carry `- path: <dir>` (see runSync below); harvested /
// hub_card_set cards do not, so this only ever matches a real prior sync, never a guess.
function findProjectByPath(root) {
  let files;
  try { files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md')); } catch { return null; }
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(PROJ, f), 'utf8'); } catch { continue; }
    const m = text.match(/^- path: (.+)$/m);
    if (!m) continue;
    const p = m[1].trim();
    if (p === root || root.startsWith(p + path.sep)) return f.replace(/\.md$/, '');
  }
  return null;
}

export function resolveContext(cwd) {
  const start = path.resolve(String(cwd || ''));
  const root = findGitRoot(start) || start;

  const marker = findHubdMarker(start);
  if (marker) return { project: marker.slug, via: 'marker', root: marker.root, guessed: false };

  const byPath = findProjectByPath(root);
  if (byPath) return { project: byPath, via: 'path', root, guessed: false };

  const guess = slugify(path.basename(root));
  if (fs.existsSync(cardPath(guess))) return { project: guess, via: 'guess', root, guessed: true };

  return { project: null, via: 'none', root, guessed: false,
    hint: `no project card matches "${guess}" — pass project explicitly, run hub_sync here, or create ${path.join(root, '.hubd')} containing the right slug` };
}

// Tool-facing wrapper: resolve + the digest/open-tasks/active-claims an agent
// actually wants, in one call. cwd is required and never defaulted to the
// hubd process's own process.cwd() — the server may be a long-lived daemon
// serving many agents in many directories, so only the CALLER can say where
// it is; defaulting here would silently answer for the wrong directory.
export function runContext(a) {
  const cwd = a && a.cwd;
  if (!cwd) throw new Error("cwd required — pass the CALLING agent's own absolute working directory (the hubd process's cwd is not reliable)");
  const ctx = resolveContext(cwd);
  if (!ctx.project) return { ...ctx, digest: null, openTasks: [], activeClaims: [] };
  const card = readCard(ctx.project);
  const digest = card ? (card.split('## Digest')[1] || '').split('## Facts')[0].trim().slice(0, 300) : null;
  const claimsDb = loadClaims();
  return {
    ...ctx,
    digest,
    openTasks: runTaskList({ project: ctx.project, status: 'open' }).tasks,
    activeClaims: activeClaims(claimsDb.claims).filter(c => c.project === ctx.project),
  };
}

// Task #194 root-cause fix: bare sequential ids were minted from `db.seq` — THIS
// node's local view of the global counter — so two nodes adding while offline from
// each other routinely computed the same next id (foldTasks's remap-on-collision
// patched the SYMPTOM after the fact, at fold time). New ids are node-scoped
// (`${node}-${n}`) instead, derived ONLY from this node's own append-only event
// file — no cross-node knowledge needed, so two offline adds can never collide by
// construction. Existing bare-numeric ids are left exactly as they are (still
// protected by the origin-keying fix); nothing here rewrites history.
function nextLocalSeq() {
  const esc = JOURNAL_NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '-(\\d+)$');
  let maxN = 0;
  try {
    for (const l of fs.readFileSync(TASK_EVENTS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (e.ev === 'add' && typeof e.id === 'string') {
          const m = re.exec(e.id);
          if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
        }
      } catch {}
    }
  } catch {}
  return maxN + 1;
}

// Canonical task category vocabulary: technical | communicative | decision | chore.
// `cat` is the single field for this; `kind` is a legacy alias — don't add new fields
// or invent new category values, keep the set small.
export function runTaskAdd(a) {
  const author = requireAuthor(a.by, 'by');
  return withLock(TASK_EVENTS, () => {
    const id = `${JOURNAL_NODE}-${nextLocalSeq()}`;
    const t = {
      id, project: slugify(a.project), text: a.text,
      importance: a.importance || 'normal', deadline: a.deadline || null,
      cat: a.cat || null, assignee: a.assignee || null, status: 'open',
      created: now(), by: author,
      depends_on: Array.isArray(a.depends_on) ? a.depends_on : [],
      resources: Array.isArray(a.resources) ? a.resources.map(slugify) : [],
    };
    fs.appendFileSync(TASK_EVENTS, JSON.stringify({ ts: now(), node: JOURNAL_NODE, ev: 'add', id, t }) + '\n');
    rebuildTaskCache();
    journalAppend({ ts: now(), project: t.project, agent: t.by, kind: 'task', text: '+ task #' + id + ': ' + t.text });
    return { ok: true, task: t };
  });
}

export function runTaskList(a) {
  const db = loadTasks();
  const st = a.status || 'open';
  let list = db.tasks;
  if (a.project) list = list.filter(t => t.project === slugify(a.project));
  if (st !== 'all') list = list.filter(t => t.status === st);
  return { count: list.length, tasks: list };
}

export function runTaskUpdate(a) {
  // `id` first: which task is the primary argument, and reporting the author as the
  // problem when the caller has not even said what to update sends it looking in the
  // wrong place.
  if (a.id == null || a.id === '') throw new Error('id required: the task id as hub_task_list reports it');
  const author = requireAuthor(a.by, 'by');
  return withLock(TASK_EVENTS, () => {
    const db = loadTasks();
    const t = db.tasks.find(x => String(x.id) === String(a.id));
    if (!t) throw new Error('no task #' + a.id);
    const patch = {};
    // `importance` belongs here too: hub_task_add accepts it, so a task could be
    // given a priority at creation and never change it again, while `deadline` right
    // next to it was editable. Passing it to update returned ok and silently did nothing.
    for (const k of ['status', 'importance', 'text', 'deadline', 'cat', 'assignee']) if (a[k] != null) patch[k] = a[k];
    if (Array.isArray(a.depends_on)) patch.depends_on = a.depends_on;
    if (Array.isArray(a.resources)) patch.resources = a.resources.map(slugify);
    if (a.status === 'done') patch.done = now();
    // Key the set to the task's ORIGIN (node,id) — NOT this writer's node + finalId — so the
    // unchanged reducer resolves it to the canonical task even when THIS node historically
    // collided on the finalId (else `set` mis-hits the writer's own remapped task). _origin
    // is supplied by the fold; fall back to writer/finalId for pre-migration caches.
    const origin = t._origin || { node: JOURNAL_NODE, id: t.id };
    fs.appendFileSync(TASK_EVENTS, JSON.stringify({ ts: now(), node: origin.node, ev: 'set', id: origin.id, patch }) + '\n');
    rebuildTaskCache();
    journalAppend({ ts: now(), project: t.project, agent: author, kind: 'task', text: '~ task #' + t.id + ' → ' + (a.status || 'edited') });
    return { ok: true, task: { ...t, ...patch } };
  });
}

export function runBrief(a = {}) {
  const hours = a.hours ?? 48;
  const staleDays = a.staleDays ?? 7;
  const nowMs = Date.now();
  const todayPlus3 = new Date(nowMs + 3 * 86400000).toISOString().slice(0, 10);

  const db = loadTasks();
  const tasksOpen = db.tasks
    .filter(t => t.status === 'open')
    .sort((x, y) => {
      const xu = x.deadline && x.deadline <= todayPlus3 ? 1 : 0;
      const yu = y.deadline && y.deadline <= todayPlus3 ? 1 : 0;
      if (xu !== yu) return yu - xu;
      const imp = { high: 3, med: 2, normal: 1 };
      const xi = imp[x.importance] || 1, yi = imp[y.importance] || 1;
      if (xi !== yi) return yi - xi;
      return x.created < y.created ? -1 : 1;
    });

  const journalRecent = journalSince(hours);

  const staleCards = [];
  try {
    for (const f of fs.readdirSync(PROJ).filter(f => f.endsWith('.md'))) {
      const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
      const m = c.match(/- (?:synced|set): (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);   // card-set cards go stale too
      if (m) {
        const daysAgo = Math.floor((nowMs - parseTs(m[1]).getTime()) / 86400000);
        if (daysAgo >= staleDays) staleCards.push({ project: f.replace('.md', ''), synced: m[1], daysAgo });
      }
    }
  } catch {}

  const claimsDb = loadClaims();
  return { tasksOpen, journalRecent, staleCards, activeClaims: activeClaims(claimsDb.claims), generated: now() };
}

/* ── Onboarding / what's-new ── */

// One-time orientation for an agent that has never worked with this hub before.
// Reuses the shipped protocol.md — the same source ensureProtocol() materializes
// into HUBD.md — so there is exactly one copy of "how hubd works" to keep in
// sync, never a duplicate onboarding text that quietly drifts from it.
export function runOnboarding() {
  ensureProtocol();
  let body;
  try { body = fs.readFileSync(new URL('../../prompts/protocol.md', import.meta.url), 'utf8'); }
  catch { return { ok: false, error: 'protocol.md not found in this hubd install' }; }
  return { ok: true, version: VERSION, protocol: body };
}

const checkinsFile = () => path.join(HUB, '.checkins.json');
function readCheckins() { try { return JSON.parse(fs.readFileSync(checkinsFile(), 'utf8')); } catch { return {}; } }
function writeCheckins(obj) { try { atomicWrite(checkinsFile(), JSON.stringify(obj, null, 1)); } catch {} }

// Personalized "what did I miss" — delta since THIS agent's own last
// hub_whatsnew call, backed by journalSince(). A never-seen agent has no prior
// checkpoint to diff against, so its first call falls back to a plain window
// (default 24h). Per-agent checkpoints live in .checkins.json (gitignored,
// per-node like .qstate/ — never mesh-synced, so it never merge-conflicts).
// Checkpoints store full-precision ISO (not now()'s minute-granularity, used
// for human-facing journal entries) — two hub_whatsnew calls in the same
// minute would otherwise both floor to the same instant and re-deliver the
// same entry, since journal timestamps are minute-granular too.
export function runWhatsNew(a = {}) {
  const author = requireAuthor(a.agent, 'agent');
  const fallbackHours = a.hours || 24;
  const checkins = readCheckins();
  // Key the checkpoint on the SESSION, not on the author label. The label names the
  // function being performed ("dev", then "reviewer"), and several functions travel
  // one trajectory — so keying on it means that reporting under a new label loses the
  // checkpoint, falls back to the 24h window and re-delivers everything already seen.
  // The session id is supplied by the transport, which knows its own process; when it
  // is absent (CLI, unknown client) the author is the key and nothing changes.
  const key = a.session || author;
  const lastSeen = checkins[key] || null;
  // No artificial minimum window: two calls seconds apart should see near-zero
  // new entries, not get padded back out to a 36s+ floor that re-delivers what
  // the previous call already returned. Only guard against negative (clock
  // skew) making the cutoff run ahead of now.
  const hours = lastSeen ? Math.max((Date.now() - parseTs(lastSeen).getTime()) / 3600000, 0) : fallbackHours;
  const entries = journalSince(hours);
  checkins[key] = new Date().toISOString();
  writeCheckins(checkins);
  // "What did I miss" is the right place for "and what does this environment need":
  // it is the tool a returning agent calls, and the protocol tells it to. Acknowledged
  // per session, so a protocol change is announced once and not on every check-in —
  // and the OTHER session on this host still hears it.
  const env = envChecks({ session: a.session, transport: a.transport });
  ackEnvNotices(a.session);
  return {
    agent: author, since: lastSeen, firstCheckin: !lastSeen,
    windowHours: Math.round(hours * 10) / 10,
    newEntries: entries.length,
    entries: entries.slice(0, 50),
    ...(env.items.length ? { environment: env.items, environmentTotal: env.total } : {}),
  };
}

// "What needs a decision" — distilled from hubd's OWN data (journal/tasks/claims),
// not from scraping agent terminals. Sharper than hub_brief: not "everything in the
// last 48h" but exactly the items where a human/owner has to act — blocked reports,
// overdue and unassigned open tasks, and claim locks whose TTL expired but were never
// released (stale locks that block other agents). Empty across the board = nothing to do.
export function runInbox(a = {}) {
  const hours = a.hours ?? 72;
  const today = new Date().toISOString().slice(0, 10);
  const db = loadTasks();
  const open = db.tasks.filter(t => t.status === 'open');

  const overdue = open.filter(t => t.deadline && t.deadline < today)
    .map(t => ({ id: t.id, project: t.project, deadline: t.deadline, assignee: t.assignee || null, text: (t.text || '').slice(0, 120) }));
  const unassigned = open.filter(t => !t.assignee)
    .map(t => ({ id: t.id, project: t.project, importance: t.importance, text: (t.text || '').slice(0, 120) }));

  const blocked = journalSince(hours).filter(e => e.kind === 'blocked')
    .map(e => ({ ts: e.ts, project: e.project, agent: e.agent, text: (e.text || '').slice(0, 200) }));

  const claims = loadClaims().claims;
  const live = new Set(activeClaims(claims).map(c => `${c.project}\0${c.area}\0${c.agent}`));
  const staleClaims = claims
    .filter(c => (c.ttlMin ?? 240) !== 0 && !live.has(`${c.project}\0${c.area}\0${c.agent}`))
    .map(c => ({ project: c.project, area: c.area, agent: c.agent, since: c.since, ttlMin: c.ttlMin ?? 240 }));

  const counts = { blocked: blocked.length, overdue: overdue.length, unassigned: unassigned.length, staleClaims: staleClaims.length };
  return { counts, empty: Object.values(counts).every(n => n === 0), blocked, overdue, unassigned, staleClaims, windowHours: hours, generated: now() };
}

// Deterministic dependency-graph planner over tasks' depends_on — the "probable
// trajectory" as a critical PATH, not an ML forecast. Kahn topo-layers (what's
// doable now vs unlocked-later), longest dependency chain (the critical path that
// bounds ordering), and cycle detection (auto-populated deps can loop). Weight is
// task-count for now; honest per-task durations (→ weighted critical path) come
// once logd records them (#193). ids may be bare numbers or node-scoped ("planck-3").
export function runTrajectory(a = {}) {
  const proj = a.project ? slugify(a.project) : null;
  const all = loadTasks().tasks;
  const byId = new Map(all.map(t => [String(t.id), t]));
  const open = all.filter(t => t.status === 'open' && (!proj || t.project === proj));
  const openIds = new Set(open.map(t => String(t.id)));
  const short = (t) => ({ id: t.id, project: t.project, importance: t.importance, text: (t.text || '').slice(0, 80) });
  // deps that are THEMSELVES still open (i.e. actually blocking); a done/absent dep is satisfied.
  const openDeps = (t) => (Array.isArray(t.depends_on) ? t.depends_on.map(String) : []).filter(d => openIds.has(d));

  const ready = open.filter(t => openDeps(t).length === 0);
  const blocked = open.filter(t => openDeps(t).length > 0)
    .map(t => ({ ...short(t), waitingOn: openDeps(t) }));

  // Kahn layers: layer 0 = ready now; layer k unlocks once all lower layers done.
  const layers = []; const placed = new Set();
  let frontier = ready.map(t => String(t.id));
  while (frontier.length) {
    layers.push(frontier); frontier.forEach(id => placed.add(id));
    frontier = open.filter(t => !placed.has(String(t.id)) && openDeps(t).every(d => placed.has(d)))
      .map(t => String(t.id));
  }
  const cyclic = open.filter(t => !placed.has(String(t.id))).map(t => String(t.id)); // unplaceable = in/behind a cycle

  // Longest dependency chain (critical path) over the acyclic part — DP in layer order, no recursion.
  const depth = new Map(), parent = new Map();
  for (const layer of layers) for (const id of layer) {
    let best = 0, bp = null;
    for (const d of openDeps(byId.get(id))) if ((depth.get(d) || 0) >= best) { best = depth.get(d) || 0; bp = d; }
    depth.set(id, best + 1); parent.set(id, bp);
  }
  let end = null, max = 0;
  for (const [id, d] of depth) if (d > max) { max = d; end = id; }
  const criticalPath = [];
  for (let x = end; x != null; x = parent.get(x)) criticalPath.unshift(x);

  return {
    project: proj,
    counts: { open: open.length, ready: ready.length, blocked: blocked.length, cyclic: cyclic.length, depth: layers.length },
    ready: ready.map(short),
    blocked,
    layers,
    criticalPath,
    cycles: cyclic,
    weighting: 'task-count (unweighted; weighted critical path pending honest durations from logd #193)',
    generated: now(),
  };
}

export function runClaim(a) {
  // Name the fields actually missing: this error fired on 4 of 33 real hub_claim
  // calls, the worst rate of any tool, and listing all three told the caller
  // nothing about which one it had left out.
  const missing = ['project', 'area', 'agent'].filter(k => !a[k]);
  if (missing.length) throw new Error('missing required: ' + missing.join(', ') + ' (claim needs project, area, agent)');
  return withLock(CLAIMS, () => {
    const db = loadClaims();
    db.claims = activeClaims(db.claims);
    const existing = db.claims.find(c => c.project === a.project && c.area === a.area && c.agent !== a.agent);
    const ttlMin = a.ttlMin ?? 240;
    const claim = { id: crypto.randomUUID(), project: a.project, area: a.area, agent: a.agent, since: now(), ttlMin };
    if (a.note) claim.note = a.note;
    db.claims.push(claim);
    atomicWrite(CLAIMS, db);
    const result = { ok: true, claim };
    if (existing) {
      const exp = new Date(parseTs(existing.since).getTime() + existing.ttlMin * 60000)
        .toISOString().slice(0, 16).replace('T', ' ');
      result.warning = `area already claimed by ${existing.agent} until ${exp}`;
    }
    return result;
  });
}

export function runRelease(a) {
  return withLock(CLAIMS, () => {
    const db = loadClaims();
    const before = db.claims.length;
    if (a.id) {
      db.claims = db.claims.filter(c => c.id !== a.id);
    } else {
      db.claims = db.claims.filter(c => !(c.project === a.project && c.area === a.area && c.agent === a.agent));
    }
    atomicWrite(CLAIMS, db);
    return { ok: true, removed: before - db.claims.length };
  });
}

/* ── Presence (task #191) ──
 * The orchestrator only ever SEES screen-scraped agents (watch.py tails ssh
 * hardcopy); an MCP/headless agent like this one is invisible until it tells
 * someone. hub_heartbeat/hub_presence are a fleet registry built the same way
 * claims are: one small JSON record per identity, freshness computed at READ
 * time from a stored ttlMin (see activeClaims above), not a push/pull daemon.
 * One file per AGENT (not per node) — presence/<agent>.json, last write wins;
 * a given agent identity has one live writer in practice (itself), same
 * assumption cardPath/resourcePath already make for their own atomicWrite.
 * Gitignored (ensureProtocol) and never mesh-synced: liveness is meaningful
 * for minutes, not the durable append-only history journal/tasks are — and
 * mesh-sync.sh's plain `git add -A` would otherwise turn every heartbeat
 * across the whole mesh into churned, pushed git history.
 */
export function presencePath(agent) { return path.join(PRESENCE, slugify(agent) + '.json'); }
export function readPresenceRecord(agent) {
  try { return JSON.parse(fs.readFileSync(presencePath(agent), 'utf8')); } catch { return null; }
}
export function loadPresence() {
  let files;
  try { files = fs.readdirSync(PRESENCE).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) { try { out.push(JSON.parse(fs.readFileSync(path.join(PRESENCE, f), 'utf8'))); } catch {} }
  return out;
}
function presenceAlive(rec, nowMs) {
  const ttl = rec.ttlMin ?? 15;
  if (ttl === 0) return false;
  return nowMs < parseTs(rec.last_seen).getTime() + ttl * 60000;
}

export function runHeartbeat(a) {
  const agent = a && a.agent;
  if (!agent) throw new Error('agent required');
  const rec = {
    agent, role: a.role || null, status: a.status || null,
    task_id: (a.task_id ?? null), cwd: a.cwd || null,
    node: JOURNAL_NODE, last_seen: now(), ttlMin: a.ttlMin ?? 15,
  };
  fs.mkdirSync(PRESENCE, { recursive: true });
  atomicWrite(presencePath(agent), rec);
  return { ok: true, agent, presence: presencePath(agent) };
}

export function runPresence(a = {}) {
  const nowMs = Date.now();
  let list = loadPresence().map(rec => ({ ...rec, alive: presenceAlive(rec, nowMs) }));
  if (a.role) list = list.filter(r => r.role === a.role);
  if (a.aliveOnly) list = list.filter(r => r.alive);
  list.sort((x, y) => (x.last_seen < y.last_seen ? 1 : -1));   // freshest first
  return { agents: list, generated: now() };
}

export function runKanban({ doneWindowHours = 24 } = {}) {
  const db = loadTasks();
  const nowMs = Date.now();
  const todayPlus3 = new Date(nowMs + 3 * 86400000).toISOString().slice(0, 10);
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const cutoff = nowMs - doneWindowHours * 3600000;
  const openIds = new Set(db.tasks.filter(t => t.status === 'open').map(t => t.id));
  // depends_on may carry numeric engine ids OR legacy gid strings ("T-002").
  // Resolve both to the numeric id so "blocked" actually fires either way.
  const gidToId = new Map(db.tasks.filter(t => t.gid).map(t => [t.gid, t.id]));
  const depId = (dep) => {
    const n = Number(dep);
    return Number.isInteger(n) && String(n) === String(dep) ? n : (gidToId.get(dep) ?? dep);
  };

  function isBlocked(t) {
    if (!t.depends_on || !t.depends_on.length) return false;
    return t.depends_on.some(dep => openIds.has(depId(dep)));
  }

  function mapTask(t) {
    return {
      id: t.id, project: t.project, text: t.text,
      importance: t.importance, deadline: t.deadline || null,
      assignee: t.assignee || null, depends_on: t.depends_on || [],
      resources: t.resources || [],
      blocked: isBlocked(t), overdue: !!(t.deadline && t.deadline < todayStr),
    };
  }

  function sortOpen(list) {
    return [...list].sort((x, y) => {
      const xu = x.deadline && x.deadline <= todayPlus3 ? 1 : 0;
      const yu = y.deadline && y.deadline <= todayPlus3 ? 1 : 0;
      if (xu !== yu) return yu - xu;
      const imp = { high: 3, med: 2, normal: 1 };
      const xi = imp[x.importance] || 1, yi = imp[y.importance] || 1;
      if (xi !== yi) return yi - xi;
      return x.created < y.created ? -1 : 1;
    });
  }

  const queued = sortOpen(db.tasks.filter(t => t.status === 'open' && !t.assignee)).map(mapTask);
  const inProgress = sortOpen(db.tasks.filter(t => t.status === 'open' && t.assignee)).map(mapTask);
  const doneToday = db.tasks
    .filter(t => t.status === 'done' && t.done && parseTs(t.done).getTime() >= cutoff)
    .sort((a, b) => b.done > a.done ? 1 : -1)
    .map(mapTask);

  const allJournal = [];
  for (const f of journalFiles()) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
        try { allJournal.push(JSON.parse(l)); } catch {}
      }
    } catch {}
  }
  const inbox = allJournal
    .sort((a, b) => b.ts > a.ts ? 1 : -1)
    .slice(0, 30)
    .map(e => ({ ts: e.ts, project: e.project, agent: e.agent, kind: e.kind, text: e.text }));

  return { queued, inProgress, doneToday, inbox, generated: now() };
}
