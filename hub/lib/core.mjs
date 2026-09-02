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

/* ── Project aliases ──
 * A project gets renamed mid-flight and the old slug keeps its own separate backlog: two
 * slugs of one project both lived here, each holding tasks, with one task's own text
 * documenting the rename. Nothing was wrong with either name — asking for one of them just answered about
 * half the project, silently.
 *
 * HUB/project-aliases.json maps old → canonical ({"old-name": "new-name"}). New writes land on
 * the canonical slug; reads (task list, journal, hub_get) resolve BOTH ways, so querying either
 * name surfaces the whole project. Nothing is renamed on disk: the old cards, events and journal
 * lines stay exactly as they were written, which is what the append-only contract requires. */
export function projectAliases() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(HUB, 'project-aliases.json'), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && v) out[slugify(k)] = slugify(v);
    return out;
  } catch { return {}; }
}

/** The canonical slug for a name, following an alias chain and refusing to loop on a cycle. */
export function canonProject(name) {
  const al = projectAliases();
  let cur = slugify(name || '');
  const seen = new Set();
  while (al[cur] && !seen.has(cur)) { seen.add(cur); cur = al[cur]; }
  return cur;
}

/** Every slug that means this project — the canonical one plus every alias pointing at it. */
export function projectSlugSet(name) {
  const canon = canonProject(name);
  const set = new Set([canon, slugify(name || '')]);
  for (const from of Object.keys(projectAliases())) if (canonProject(from) === canon) set.add(from);
  return set;
}

export function cardPath(name) { return path.join(PROJ, slugify(name) + '.md'); }
export function readCard(name) {
  const p = cardPath(name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/* The "## Digest" body ends at the NEXT "## " heading — never at a literal "## Facts".
 * Cutting on that one name only worked for cards whose following section happens to be
 * Facts. On a hub that localises its sections (HUB/sections.json) or on any card_set card
 * without that exact heading, the "digest" swallowed the whole rest of the body: hub_status
 * and hub_context reported an entire card where a one-liner belongs, and runSync compared a
 * new digest against that blob — so "the digest changed" was true on every sync and archived
 * the full card into history each time. runResourceSet already cut on the next heading; this
 * is the same rule, in one place, for project cards. */
export function digestOf(text) {
  if (!text) return null;
  const i = text.indexOf('## Digest');
  if (i === -1) return null;
  const rest = text.slice(i + '## Digest'.length);
  const nm = rest.match(/\n## /);
  return (nm ? rest.slice(0, nm.index) : rest).trim();
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

/* ── Repeated lines in an append-only log ──
 * A synced hub is a git repo, and the natural .gitattributes for append-only logs is
 * `merge=union`: keep both sides of a conflicting hunk instead of stopping to ask. For two
 * machines appending DIFFERENT lines that is exactly right, and it is why a mesh set up that way
 * never produces a sync conflict. What union does NOT do is deduplicate. A line present on both
 * sides survives twice — and the next merge sees the doubled file as one side of the next union,
 * so it compounds. On the hub this was found in, the journal held 27464 lines for 1919 distinct
 * entries, one task log held 5359 events for 519, and single lines appeared up to 33 times.
 *
 * Nothing detects that on its own. Git reports a clean merge, the file is still valid JSONL, every
 * line in it is a line somebody really did write, and append-only was never violated — the log
 * only grew, exactly as promised. Only the COUNTS are wrong, everywhere at once and all agreeing
 * with each other, which reads like corroboration. It is also what fed the 0.9.2 fold bug: union
 * made the replays, the fold minted a task per replay, and 427 tasks read as 1507.
 *
 * The fix belongs in the READER. Not the writer, and not the sync script: shrinking a log on disk
 * would trip the append-only guard in scripts/mesh-sync.sh on every other node, and the events
 * were never wrong — only the view built from them was. Byte-identical lines are indistinguishable
 * to every reader by construction, so keeping the first is lossless in the only sense available
 * here. The cost is real and small, and stating it is the point: two genuinely separate events
 * that serialize identically (same node, same minute, same text) now count once.
 *
 * Dedup is scoped per node log FAMILY — a node's live log plus the month archives journalAppend
 * rotates out — and never across nodes. A journal entry carries no node field, so the file name is
 * the only place that distinction lives; two nodes that happen to write the same line keep both.
 * `hub doctor` reports the inflation via logDuplication(), because serving a corrected number
 * while the files quietly keep the duplicates would be the same lie one level down. */
function* readLogEntries(files, nodeOf) {
  const seen = new Map();                       // node family -> raw lines already yielded
  for (const f of files) {
    const node = nodeOf(path.basename(f));
    let dup = seen.get(node);
    if (!dup) seen.set(node, dup = new Set());
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let idx = 0;
    for (const l of raw.split('\n')) {
      const line = l.trim();
      if (!line || dup.has(line)) continue;
      dup.add(line);
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      yield { e, node, idx: idx++ };
    }
  }
}

/* journal.<node>.jsonl, and the month archives rotated out of it as
 * journal.<node>-<YYYY-MM>[.<n>].jsonl — all one node. */
const journalNodeOf = (base) => {
  const m = base.match(/^journal\.(.+)\.jsonl$/);
  if (!m) return '';                                    // legacy single-file journal.jsonl
  return m[1].replace(/-\d{4}-\d{2}(\.\d+)?$/, '');
};
const taskEventNodeOf = (base) => (base.match(/^tasks\.(.+)\.events\.jsonl$/) || [])[1] || 'node';

/** Raw vs distinct line counts per node log family — exactly what readLogEntries drops, so the
 *  dedup is visible instead of merely applied. Empty when the logs are clean. */
export function logDuplication() {
  const groups = [];
  for (const [kind, files, nodeOf] of [['tasks', taskEventFiles(), taskEventNodeOf],
                                       ['journal', journalFiles(), journalNodeOf]]) {
    const byNode = new Map();
    for (const f of files) {
      const node = nodeOf(path.basename(f));
      let g = byNode.get(node);
      if (!g) byNode.set(node, g = { kind, node, files: [], lines: 0, seen: new Set() });
      g.files.push(path.basename(f));
      try {
        for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
          const line = l.trim();
          if (!line) continue;
          g.lines++; g.seen.add(line);
        }
      } catch {}
    }
    for (const g of byNode.values()) {
      if (g.lines <= g.seen.size) continue;
      groups.push({ kind: g.kind, node: g.node, files: g.files, lines: g.lines, distinct: g.seen.size, duplicate: g.lines - g.seen.size });
    }
  }
  return groups.sort((a, b) => b.duplicate - a.duplicate);
}

/** What `hub doctor` says about the journal: raw lines on disk vs entries a reader actually sees.
 *  The two diverge when a mesh merge duplicated lines, so reporting only one of them would hide
 *  either the bloat or the correction. Counts distinct-per-node, exactly as readLogEntries does. */
export function journalCounts() {
  const files = journalFiles();
  const seen = new Map();
  let lines = 0, entries = 0, malformed = 0;
  for (const f of files) {
    const node = journalNodeOf(path.basename(f));
    let dup = seen.get(node);
    if (!dup) seen.set(node, dup = new Set());
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        const line = l.trim();
        if (!line) continue;
        lines++;
        if (dup.has(line)) continue;
        dup.add(line);
        try { JSON.parse(line); entries++; } catch { malformed++; }
      }
    } catch {}
  }
  let distinct = 0;
  for (const s of seen.values()) distinct += s.size;
  return { files: files.length, lines, entries, malformed, duplicate: lines - distinct };
}

// Numeric compare, not string: '0.9.10' is NEWER than '0.9.2' and sorts before it as text.
export function cmpVersion(a, b) {
  const pa = String(a ?? '').split('.'), pb = String(b ?? '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/* Which hubd wrote which line.
 *
 * The incident: the global `hub` on the machine that DEVELOPS hubd sat nine releases behind for
 * weeks, and nothing could have said so. The lines it wrote were indistinguishable from current
 * ones, and the tool had no way to state its own version at all — finding out took `npm ls -g`.
 * That is this project's own thesis pointed back at it: not a crash, an answer, given confidently
 * by code too old to know what it was answering.
 *
 * So journalAppend stamps `v`. A node's append-only log now carries the version that appended to
 * it, and every node in the mesh already reads every other node's log — which makes the log the
 * only place a version can be observed across the fleet. (presence/ cannot: it is node-local and
 * never synced, so it can only ever describe the machine already asking.) Same rule as HUBD.md
 * and tasks.json, one level down: a written artifact names the code that produced it.
 *
 * It necessarily starts blank. Entries written before 0.9.4 have no stamp and are counted as
 * `unstamped` rather than attributed to a guess — a version this cannot know is reported as
 * unknown, never inferred from the line next to it. */
/* Two hubd installs writing into ONE node's log — the shape this machine was actually in, with a
 * nine-releases-old global `hub` on PATH and a current source checkout behind the MCP server,
 * both appending to journal.macbook-pro.jsonl.
 *
 * The test is INTERLEAVING, not "more than one version present". An ordinary upgrade also puts two
 * versions in a log, but it partitions them: every old line, then every new one. Two installs
 * running side by side keep taking turns, so an older version goes on appearing after the newer
 * one first showed up. Only that is reported.
 *
 * Bounded to the last 50 stamped entries because the claim is about the present. Interleaving that
 * stopped months ago is history, and a warning that can never be cleared is one a reader learns to
 * skip — which would cost more than this check is worth. */
function concurrentWriters(seq) {
  const recent = seq.slice(-50);
  if (!recent.length) return [];
  const newest = [...new Set(recent.map(x => x.v))].sort(cmpVersion).pop();
  const from = recent.findIndex(x => x.v === newest);
  const older = new Set(recent.slice(from + 1).filter(x => cmpVersion(x.v, newest) < 0).map(x => x.v));
  return older.size ? [...older, newest].sort(cmpVersion) : [];
}

export function writerVersions() {
  const byNode = new Map();
  for (const { e, node } of readLogEntries(journalFiles(), journalNodeOf)) {
    if (node === 'life') continue;               // the private braid is this machine's, not a node
    const key = node || 'legacy';
    let g = byNode.get(key);
    if (!g) byNode.set(key, g = { node: key, versions: {}, unstamped: 0, last: null, lastAt: null, _seq: [] });
    const v = typeof e.v === 'string' && e.v ? e.v : null;
    if (!v) { g.unstamped++; continue; }
    g.versions[v] = (g.versions[v] || 0) + 1;
    const ms = parseTs(e.ts).getTime();
    g._seq.push({ v, ms: Number.isFinite(ms) ? ms : 0 });
  }
  const out = [];
  for (const g of byNode.values()) {
    g._seq.sort((a, b) => a.ms - b.ms);
    const last = g._seq.length ? g._seq[g._seq.length - 1] : null;
    out.push({
      node: g.node, versions: g.versions, unstamped: g.unstamped,
      last: last ? last.v : null,
      lastAt: last ? new Date(last.ms).toISOString().slice(0, 16).replace('T', ' ') : null,
      concurrent: concurrentWriters(g._seq),
    });
  }
  return out.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}

/** Nodes whose newest stamped journal entry came from a hubd other than the one installed here.
 *  `ahead` matters more than `behind`: it means THIS copy is the stale one, and a stale reader is
 *  exactly the reader that cannot be relied on to notice anything else. */
export function versionSkew() {
  const nodes = writerVersions();
  const stamped = nodes.filter(g => g.last);
  const pick = (g) => ({ node: g.node, v: g.last, at: g.lastAt });
  return {
    installed: VERSION,
    nodes,
    stamped: stamped.length,
    behind: stamped.filter(g => cmpVersion(g.last, VERSION) < 0).map(pick),
    ahead: stamped.filter(g => cmpVersion(g.last, VERSION) > 0).map(pick),
    concurrent: nodes.filter(g => g.concurrent.length > 1).map(g => ({ node: g.node, versions: g.concurrent })),
  };
}

function readTaskEvents() {
  const evs = [];
  for (const { e, node, idx } of readLogEntries(taskEventFiles(), taskEventNodeOf)) {
    // _node = the ORIGIN node (what the remap key is built from); _file = the log this line
    // actually lives in. They differ only when a node addressed another node's origin, which
    // is the one thing that tells an origin-keyed write from a legacy final-id one.
    e._node = e.node || node; e._file = node; e._idx = idx;
    evs.push(e);
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
      /* A key that already has a home KEEPS it. The guard used to compare the remap against the
       * RAW id — so once a key had been remapped (its id was taken by someone else), every later
       * add for that same key mismatched again and minted yet another task. One duplicated line in
       * an event log therefore multiplied without limit, and worse, silently broke the invariant
       * three lines below that set/del depend on: eleven tasks ended up sharing one origin, so a
       * close keyed to that origin reached exactly one of them and the other ten were unreachable
       * forever. Live base: 1034 of 1507 tasks were copies born this way.
       * Re-applying an add for a known key now overwrites its own task, which is what a replayed
       * event should do — the logs are append-only and may legitimately be re-read forever. */
      const prior = remap.get(key);
      let fid = prior !== undefined ? prior : e.id;
      if (prior === undefined && (tasks.has(fid) || seen.has(fid))) fid = maxNum + 1; // id taken (even if since-deleted) → remap this key once
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
    } else if (e.ev === 'set' || e.ev === 'del') {
      // `set`/`del` carry a FINAL id: runTaskUpdate looks the task up in the folded
      // view and writes `id: t.id`. So when that id names a live task, THAT is the
      // target — consulting this node's remap first would silently redirect the write.
      // (Real case: macbook-pro's add of 168 remapped to 171, and planck's own add of
      // 171 remapped to 172; every later planck update addressed to the visible #171
      // then landed on #172, and #171 could not be updated from planck at all.)
      // The remap fallback stays for ids that name nothing live — a node's own
      // since-remapped or since-deleted add — otherwise a `set` after a `del` would
      // land on whatever task reused that id.
      // Two conventions live in these logs. An event marked keyed:'origin' names the (node,id)
      // the task was ADDED under, so the remap is authoritative for it. An unmarked event is
      // legacy and carries a FINAL id, where a live task with that id is the target and the
      // remap is only a fallback for ids naming nothing live (a since-remapped or since-deleted
      // add) — without that fallback a `set` after a `del` would land on whatever reused the id.
      // An event whose `node` is not the file it lives in was written by a node deliberately
      // addressing ANOTHER node's origin — only the origin-keyed writer does that, so it is
      // origin-keyed whether or not it carries the marker. That matters for real history: the
      // writer has recorded sets by origin since 0.4.8 without saying so, and reading those as
      // final-id events would misroute every one of them (85 in this hub). When node and file
      // agree, the two conventions are indistinguishable and coincide unless that node's own add
      // was remapped — which is the incident the live-id rule exists for, so it wins there.
      const originKeyed = e.keyed === 'origin' || (!!e.node && e.node !== e._file);
      const fid = originKeyed
        ? (remap.get(key) ?? e.id)
        : (tasks.has(e.id) ? e.id : (remap.get(key) ?? e.id));
      if (e.ev === 'set') { const t = tasks.get(fid); if (t) Object.assign(t, e.patch || {}); }
      else tasks.delete(fid);
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
  atomicWrite(TASKS, { ...db, foldVersion: VERSION });
  return db;
}

// Read tasks. If event logs exist they are the truth: rebuild the tasks.json
// cache whenever it is missing or older than the newest event file (e.g. a
// mesh pull just brought new events). No events yet → legacy single-file read.
/* And whenever the cache was folded by a DIFFERENT version of the code. The mtime check can only
 * see new events, and the case it therefore misses is the one that matters most: a fix to the fold
 * itself leaves every event byte-identical and every mtime untouched, so a cache built by the
 * buggy fold outlives the upgrade and keeps being served as fact. 0.9.2 fixed a fold that had
 * invented 1080 phantom tasks, and on the hub it was found in `hub doctor` still reported "977
 * open" afterwards — the corrected fold said 154. Same class as HUBD.md and sections.json: a
 * generated artifact carries the version that generated it, and a mismatch means regenerate. */
export function loadTasks() {
  if (taskEventFiles().length) {
    let cacheMtime = 0;
    try { cacheMtime = fs.statSync(TASKS).mtimeMs; } catch {}
    if (cacheMtime < newestEventMtime()) return rebuildTaskCache();
    try {
      const db = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
      if (db.foldVersion !== VERSION) return rebuildTaskCache();
      return db;
    } catch { return rebuildTaskCache(); }
  }
  try { return JSON.parse(fs.readFileSync(TASKS, 'utf8')); } catch { return { seq: 0, tasks: [] }; }
}

/* ── Usage: how long, how many tokens, how much ──
 * The hub knows WHO did WHAT. It does not know what that cost, and the PMF question for a solo
 * operator running a fleet is "what does each project cost me per week". So this exists — with one
 * hard line through the middle of it:
 *
 *   MEASURED is what the hub can observe in its own logs: a task's open-to-close span, and events
 *   per project. It is derived, never stored, and cannot be wrong about itself.
 *
 *   SUPPLIED is seconds, tokens and money — none of which the hub can see. Only the client knows
 *   them, so they arrive by explicit call and are labelled as reported, not observed.
 *
 * The split is the feature. A cost number that quietly mixes a measured span with a guessed rate
 * is worse than no number, because it will be quoted later as if someone had counted. Per-host
 * append-only (usage.<node>.jsonl), same shape as the journal and the task log, so several
 * machines can report into one hub without conflicting — and it IS mesh-synced, because
 * "what did the fleet cost" is a fleet-wide question. */
export function usageFile() { return path.join(HUB, `usage.${JOURNAL_NODE}.jsonl`); }
export function usageFiles() {
  try { return fs.readdirSync(HUB).filter(f => /^usage\..+\.jsonl$/.test(f)).sort().map(f => path.join(HUB, f)); }
  catch { return []; }
}

// An ABSENT value must stay absent: Number(null) is 0, and a 0 that means "not reported" is the
// exact lie this log exists to avoid — an empty entry would have recorded a $0 session.
// `true` appears because the CLI's flag parser returns it for a bare flag with no value.
const num = (v) => {
  if (v === null || v === undefined || v === '' || v === true) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function runUsageAdd(a = {}) {
  const agent = requireAuthor(a.agent ?? a.by, 'agent');
  const rec = {
    ts: now(), node: JOURNAL_NODE, agent,
    project: a.project ? canonProject(a.project) : null,
    task: (a.task ?? null) === null ? null : String(a.task),
    seconds: num(a.seconds), tokensIn: num(a.tokensIn), tokensOut: num(a.tokensOut),
    costUsd: num(a.costUsd), model: a.model ? String(a.model) : null,
  };
  if (rec.seconds === null && rec.tokensIn === null && rec.tokensOut === null && rec.costUsd === null) {
    throw new Error('nothing to record: pass at least one of seconds, tokensIn, tokensOut, costUsd — this log holds what only YOU can see, so an empty entry says nothing');
  }
  fs.appendFileSync(usageFile(), JSON.stringify(rec) + '\n');
  return { ok: true, recorded: rec };
}

export function runUsage(a = {}) {
  const days = a.days ?? 7;
  const cutoff = Date.now() - days * 86400000;
  const proj = a.project ? canonProject(a.project) : null;

  const supplied = { calls: 0, seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byProject: {}, byAgent: {}, models: {} };
  for (const f of usageFiles()) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (!e.ts || parseTs(e.ts).getTime() < cutoff) continue;
        if (proj && e.project !== proj) continue;
        if (a.agent && e.agent !== a.agent) continue;
        supplied.calls++;
        for (const k of ['seconds', 'tokensIn', 'tokensOut', 'costUsd']) supplied[k] += Number(e[k]) || 0;
        const pk = e.project || 'unassigned', ak = e.agent || 'unknown';
        supplied.byProject[pk] = supplied.byProject[pk] || { seconds: 0, tokens: 0, costUsd: 0 };
        supplied.byProject[pk].seconds += Number(e.seconds) || 0;
        supplied.byProject[pk].tokens += (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
        supplied.byProject[pk].costUsd += Number(e.costUsd) || 0;
        supplied.byAgent[ak] = supplied.byAgent[ak] || { seconds: 0, tokens: 0, costUsd: 0 };
        supplied.byAgent[ak].seconds += Number(e.seconds) || 0;
        supplied.byAgent[ak].tokens += (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
        supplied.byAgent[ak].costUsd += Number(e.costUsd) || 0;
        if (e.model) supplied.models[e.model] = (supplied.models[e.model] || 0) + 1;
      }
    } catch {}
  }
  supplied.costUsd = Math.round(supplied.costUsd * 100) / 100;

  // Measured: the hub's own arithmetic over its own logs. A closed task's span is real; nothing
  // here is inferred from a rate card.
  const closed = loadTasks().tasks.filter(t => t.status === 'done' && t.done && t.created &&
    parseTs(t.done).getTime() >= cutoff && (!proj || t.project === proj));
  const spans = closed.map(t => (parseTs(t.done).getTime() - parseTs(t.created).getTime()) / 86400000)
    .filter(d => d >= 0).sort((x, y) => x - y);
  const median = spans.length ? Math.round(spans[Math.floor(spans.length / 2)] * 10) / 10 : null;
  const events = {};
  for (const e of journalSince(days * 24)) {
    if (!e.project || (proj && e.project !== proj)) continue;
    events[e.project] = (events[e.project] || 0) + 1;
  }

  return {
    windowDays: days, project: proj,
    supplied,
    measured: { tasksClosed: closed.length, medianDaysToClose: median, journalEventsByProject: events },
    note: supplied.calls
      ? 'seconds/tokens/cost are SUPPLIED by callers (hub_usage_add) — the hub cannot observe them. tasksClosed and journal events are MEASURED from its own logs.'
      : 'nothing supplied in this window: the hub cannot see time, tokens or money — a client has to report them with hub_usage_add. The measured half below is the hub\'s own arithmetic.',
    generated: now(),
  };
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

/* The life braid: entries that never leave this machine (docs/narrative-layer.md). A separate
 * file, gitignored, never mesh-synced — and NOT a separate reader: journalFiles() picks it up, so
 * an agent writing the weekly chapter sees it, which is the one thing it is for. Every entry
 * carries private:true, so anything that copies text into a synced file can tell what it is
 * holding. */
export function journalAppendPrivate(entry) {
  const target = path.join(HUB, 'journal.life.jsonl');
  ensureGitignored('journal.life.jsonl');
  withLock(target, () => { fs.appendFileSync(target, JSON.stringify({ ...entry, private: true }) + '\n'); });
  return target;
}

/* The one human in the fleet was the only member of it who did not exist in `hub presence`.
 * Agents heartbeat because the protocol tells them to; nobody tells the owner anything, so a
 * board could show buttons waiting twelve days with no way to tell "away" from "here and not
 * answering" — the two states that decide whether to wait or to route around them.
 *
 * Nothing new is asked of the human. A write authored by a declared owner role IS the evidence:
 * they reported, closed a task, or replied in their queue, and that only happens when a person
 * acted. Recorded from journalAppend, the choke point every write already passes through, so no
 * caller has to remember it. TTL is longer than an agent's: a person who answered an hour ago is
 * still around in a way a polling loop is not. */
export function touchPresenceIfOwner(agent) {
  try {
    const who = String(agent ?? '').trim();
    if (!who || !ownerRoles().includes(who)) return;
    runHeartbeat({ agent: who, role: who, status: 'acted', ttlMin: 240 });
  } catch {}
}

export function journalAppend(entry) {
  if (entry && entry.agent) touchPresenceIfOwner(entry.agent);
  withLock(JOURNAL, () => {
    try {
      if (fs.existsSync(JOURNAL) && fs.statSync(JOURNAL).size > 2 * 1024 * 1024) {
        const ym = new Date().toISOString().slice(0, 7);
        let archive = path.join(HUB, `journal.${JOURNAL_NODE}-${ym}.jsonl`);
        for (let n = 2; fs.existsSync(archive); n++) archive = path.join(HUB, `journal.${JOURNAL_NODE}-${ym}.${n}.jsonl`);
        fs.renameSync(JOURNAL, archive);   // unique name — never overwrite an existing month-archive (was silent data loss)
      }
    } catch {}
    // Stamp the writer's version (writerVersions() explains why the log is the only place this
    // can live). An entry that already carries one keeps it: a forwarded or replayed line
    // describes the hubd that ORIGINALLY wrote it, not the one passing it along.
    fs.appendFileSync(JOURNAL, JSON.stringify(entry && entry.v ? entry : { ...entry, v: VERSION }) + '\n');
  });
}

export function journalTail(project, n = 12) {
  const all = [];
  for (const { e } of readLogEntries(journalFiles(), journalNodeOf)) all.push(e);
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // merge multiple per-host files by time
  // Alias-aware: entries written under a project's OLD slug belong to the same project, and a
  // reader asking about either name wants both halves of the trail.
  const set = project ? projectSlugSet(project) : null;
  const filtered = set ? all.filter(e => set.has(e.project)) : all;
  return filtered.slice(-n);
}

/* Newest journal timestamp per project, in ONE pass over the merged journal.
 * The freshness contract a card owes its reader is not "was it touched lately" but
 * "does it still describe what the project has been doing": a card can be days old and
 * perfectly true on a quiet project, while a busy one goes wrong within a day. So the
 * signal is the GAP between the card's last touch and the project's last journal entry
 * (one card here sat 33 days behind its own journal). Compared through parseTs, not as strings —
 * the journal carries both "YYYY-MM-DD HH:MM" and ISO stamps, and ' ' sorts before 'T'. */
/* Kinds the TRACKER writes about its own records, as opposed to anything a session reported.
 * They are excluded from the freshness signal, and that exclusion is load-bearing: filing an
 * incident is itself a journal entry for that project, so `hub audit` moved every project's
 * journal forward and then, on its next run, reported those same projects as having cards that
 * trail their journal — an incident generated by the act of filing an incident. A weekly pass
 * would have grown its own backlog forever, through a route the keyed dedup does not cover.
 * A card is behind when WORK it does not reflect has happened, not when the tracker took notes. */
const BOOKKEEPING_KINDS = new Set(['task', 'audit']);

export function lastJournalByProject() {
  const out = {};
  for (const { e } of readLogEntries(journalFiles(), journalNodeOf)) {
    if (!e.project || !e.ts || BOOKKEEPING_KINDS.has(e.kind)) continue;
    const cur = out[e.project];
    if (!cur || parseTs(cur).getTime() < parseTs(e.ts).getTime()) out[e.project] = e.ts;
  }
  return out;
}

/** How far a card's digest trails its project's own journal, or null if it doesn't. */
export function digestLag(cardTouchedAt, lastJournalAt, staleDays) {
  if (!cardTouchedAt || cardTouchedAt === '?' || !lastJournalAt) return null;
  const behind = Math.floor((parseTs(lastJournalAt).getTime() - parseTs(cardTouchedAt).getTime()) / 86400000);
  return behind >= staleDays ? { daysBehind: behind, lastJournal: lastJournalAt } : null;
}

export function journalSince(hours) {
  const cutoff = Date.now() - hours * 3600000;
  const all = [];
  for (const { e } of readLogEntries(journalFiles(), journalNodeOf)) {
    if (parseTs(e.ts).getTime() >= cutoff) all.push(e);
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)); // merge per-host files by time
  return all.reverse(); // newest first
}

/* ── Rules: which of them are checks, and which are only wishes ──
 * A rule written as prose gets broken; a rule that is a check does not. That is the whole
 * finding behind this file — gates expired silently for weeks, and attention diverged from
 * what the cards declared by an order of magnitude, while both rules sat plainly written down.
 *
 * HUB/rules.json, one file, two sections:
 *   { "strict": { "<lintId>": true, ... },
 *     "laws":   { "<lintId or audit finding id>": { "text": "<the rule, verbatim>",
 *                                                   "since": "YYYY-MM-DD", "source": "AGENTS.md" } } }
 *
 * `strict` is OPT-IN and empty by default: hubd never starts refusing work because it was
 * upgraded. `laws` is what an incident QUOTES — the point of the audit is that the only
 * authority a person reliably accepts is their own past self, with a date on it. Without a
 * local law the finding still fires; it just cites the engine's own wording and says so. */
export function rulesConfig() {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(path.join(HUB, 'rules.json'), 'utf8')) || {}; } catch {}
  const strict = (o.strict && typeof o.strict === 'object') ? o.strict : {};
  const laws = (o.laws && typeof o.laws === 'object') ? o.laws : {};
  // Which projects are money bets. DECLARED, never inferred: most cards in a real hub say
  // outright that they are not one ("not a money bet — craft"), and a gate-needs-a-date check
  // run over all of them produced 11 findings where the rule covers a handful. A check that
  // cries about things its rule does not cover is how a check stops being read.
  const money = Array.isArray(o.money) ? o.money.map(slugify) : [];
  return { strict, laws, money };
}

/** The law behind a finding: the owner's own words with the date they wrote them, if declared. */
export function lawFor(id, fallback) {
  const l = rulesConfig().laws[id];
  if (l && typeof l === 'object' && l.text) {
    return { text: String(l.text), since: l.since || null, source: l.source || null, declared: true };
  }
  return { text: fallback, since: null, source: null, declared: false };
}

/** The body of one "## Heading" section, or null. Read-side twin of editSection. */
export function sectionBody(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('^## ' + esc + '[ \\t]*$', 'm').exec(String(text || ''));
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = String(text).slice(start);
  const nm = rest.match(/\n## /);
  return (nm ? rest.slice(0, nm.index) : rest).trim();
}

const headingFor = (key) => (sectionsConfig().find(s => s.key === key) || {}).heading || key;
const isPlaceholder = (body) => !body || /^<[^>]*>$/.test(body.trim());

/** A project's declared MODE — a bare "MODE: ..." line anywhere in its card. */
export function modeOf(card) {
  const m = String(card || '').match(/^MODE:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}
// Deliberately coarse: three buckets is all any check here needs, and a card's MODE is prose.
export function modeClass(mode) {
  const v = String(mode || '').toLowerCase();
  if (!v) return null;
  if (/\bidea\b|seed/.test(v)) return 'idea';
  if (/background|slow.?burn|\bjob\b|dormant|paused/.test(v)) return 'background';
  if (/active|shipped|money|revenue|launch/.test(v)) return 'active';
  return 'other';
}

// Reserved cards (operator) live in projects/ so that every card tool reaches them for free, but
// they are NOT projects: counting one as a project would have it audited for gates it cannot have
// and listed in a status table it does not belong in. Recall asks for them on purpose.
function projectCards({ includeReserved = false } = {}) {
  const out = [];
  try {
    for (const f of fs.readdirSync(PROJ).filter(f => f.endsWith('.md'))) {
      const slug = f.replace(/\.md$/, '');
      if (!includeReserved && RESERVED_CARDS.has(slug)) continue;
      try { out.push({ slug, text: fs.readFileSync(path.join(PROJ, f), 'utf8') }); } catch {}
    }
  } catch {}
  return out;
}

/**
 * Every rule that CAN be checked, checked. Read-only, never throws, never files anything.
 * A lint appears in `findings` whether or not it is enforced; `enforced` says which ones the
 * instance opted into, so "we have a rule about that" and "the rule bites" stay distinguishable.
 */
export function runLint(a = {}) {
  const { strict, money } = rulesConfig();
  const findings = [];
  const notes = [];
  const gatesHeading = headingFor('gates');
  const restrict = Array.isArray(a.projects) ? a.projects.map(slugify) : null;

  // (1) A gate with no date cannot expire, so it is not a gate — it is an intention. Only money
  //     bets are held to it (see rulesConfig), and silence here is reported, not implied.
  if (!money.length) {
    notes.push('gate-without-date checked nothing: no money bets are declared. List them in rules.json → money ["<slug>", ...] — the gate rule only covers those.');
  }
  for (const c of projectCards()) {
    if (restrict && !restrict.includes(c.slug)) continue;
    if (!money.includes(c.slug)) continue;
    const body = sectionBody(c.text, gatesHeading);
    if (isPlaceholder(body)) continue;
    if (!/\d{4}-\d{2}-\d{2}/.test(body)) {
      findings.push({ id: 'gate-without-date', severity: 'med', project: c.slug,
        what: `${c.slug} is a declared money bet and its ${gatesHeading} section names a criterion but no date — nothing can ever declare it missed`,
        fix: `add the date to ## ${gatesHeading} (hub section add ${c.slug} gates "<criterion> by YYYY-MM-DD" --by <you>)` });
    }
  }

  // (2) A decision only a human can make, filed as one undivided task, is a task nobody can
  //     start: the agent part and the 30-second human part have to be separable to move.
  for (const t of loadTasks().tasks.filter(t => t.status === 'open')) {
    if (restrict && !restrict.includes(t.project)) continue;
    const human = t.owner_kind === 'human';
    const comms = (t.cat || t.kind) === 'communicative';
    if (human && comms && !(Array.isArray(t.depends_on) && t.depends_on.length)) {
      findings.push({ id: 'button-without-prep', severity: 'med', project: t.project, task: t.id,
        what: `#${t.id} [${t.project}] is a human-owned communicative task with no prep it depends on — the owner has to both prepare and decide`,
        fix: 'split it: an agent task that prepares the package, and this one depending on it (hub_task_update depends_on)' });
    }
  }

  for (const f of findings) {
    const law = lawFor(f.id, f.id === 'gate-without-date'
      ? 'A gate is a date plus a criterion; without a date it is an intention.'
      : 'Work only the owner can do splits into prep (an agent) and the button (the owner).');
    f.law = law.text; f.lawSince = law.since; f.lawDeclared = law.declared;
    f.enforced = !!strict[f.id];
  }
  const enforcedIds = Object.keys(strict).filter(k => strict[k]);
  return { findings, notes, enforced: enforcedIds, generated: now() };
}

/* ── Audit: what was declared against what happened ──
 * This is a role that was run BY HAND for weeks before it was allowed to become code — the same
 * road harvest took. What it found, repeatedly, is why it exists: gates expire in silence, and
 * the share of attention a project actually gets diverges from the mode its own card declares by
 * an order of magnitude. Neither is a mistake anyone makes on purpose; both are invisible without
 * arithmetic.
 *
 * Three properties are deliberate, and each one is a refusal:
 *
 * NOT A DASHBOARD. The output is incidents — tasks somebody owns — plus one report. A number on a
 * screen changes nothing after the tab is closed.
 *
 * IT QUOTES THE OWNER, NOT ITSELF. Every incident carries the rule it enforces and the date that
 * rule was written (rules.json → laws). The only authority reliably accepted here is one's own
 * past self with a date on it; an engine's opinion is worth nothing by comparison.
 *
 * A WEEKLY RUN MUST NOT PILE UP. Every finding has a stable key, stamped into the incident text
 * as [audit:<key>]; applying skips a key that is already open. Otherwise the fifth run has filed
 * the same five incidents five times and the backlog is the noise it was meant to remove. */
const AUDIT_DEFAULTS = {
  'gate-expired': 'A money bet whose gate date has passed without a verdict goes to background; coming back needs a DECIDE with a new date.',
  'attention-vs-mode': 'A card declares what a project IS; where the journal goes declares what it is really getting. When they disagree, one of the two is a lie.',
  'button-stale': 'A package waiting on the owner is either decided or withdrawn — an unanswered button is a decision made by default.',
  'card-behind-journal': 'A card that stopped following its own project misinforms every session that reads it next.',
  'task-without-project': 'Work with no project cannot be prioritised against anything.',
};

/**
 * Compare declarations with behaviour. Read-only unless `apply` is set.
 *
 * @param {{days?:number, apply?:boolean, by?:string, staleButtonDays?:number}} a
 */
export function runAudit(a = {}) {
  const days = a.days ?? 7;
  const staleButtonDays = a.staleButtonDays ?? 7;
  const { money } = rulesConfig();
  const today = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  const findings = [];
  const notes = [];
  const gatesHeading = headingFor('gates');
  const cards = projectCards();
  const tasks = loadTasks().tasks;
  const open = tasks.filter(t => t.status === 'open');

  // (1) Gates x calendar. A date in the gate that has passed, with no decision recorded since —
  //     the decision is what turns an expiry into a verdict, so its absence IS the finding.
  if (!money.length) notes.push('gates x calendar checked nothing: no money bets declared (rules.json -> money).');
  const decisionsSince = {};
  for (const e of journalSince(365 * 24)) {
    if (e.kind === 'decision' && e.project) {
      const cur = decisionsSince[e.project];
      if (!cur || parseTs(cur).getTime() < parseTs(e.ts).getTime()) decisionsSince[e.project] = e.ts;
    }
  }
  for (const c of cards) {
    if (!money.includes(c.slug)) continue;
    const body = sectionBody(c.text, gatesHeading);
    if (isPlaceholder(body)) continue;
    const dates = (body.match(/\d{4}-\d{2}-\d{2}/g) || []).sort();
    const last = dates[dates.length - 1];
    if (!last || last >= today) continue;
    const decided = decisionsSince[c.slug];
    if (decided && decided.slice(0, 10) > last) continue;   // a verdict was recorded after the date
    findings.push({ id: 'gate-expired', key: `gate-expired:${c.slug}:${last}`, severity: 'high', project: c.slug,
      what: `${c.slug}: gate date ${last} passed with no decision recorded since`,
      fix: `either DECIDE a new date or let it drop to background — hub decide "<verdict>" --why "<why>" -p ${c.slug}` });
  }

  // (2) Attention x declared MODE. Both directions are wrong in the same way: a card that says
  //     one thing while the journal says another.
  const windowEntries = journalSince(days * 24).filter(e => e.project);
  const total = windowEntries.length;
  const share = {};
  for (const e of windowEntries) share[e.project] = (share[e.project] || 0) + 1;
  if (!total) notes.push(`attention x mode checked nothing: no journal entries in the last ${days}d.`);
  for (const c of cards) {
    const cls = modeClass(modeOf(c.text));
    if (!cls || !total) continue;
    const pct = Math.round(((share[c.slug] || 0) / total) * 100);
    if ((cls === 'background' || cls === 'idea') && pct > 30) {
      findings.push({ id: 'attention-vs-mode', key: `attention-vs-mode:${c.slug}:over`, severity: 'med', project: c.slug,
        what: `${c.slug} declares MODE ${cls} but took ${pct}% of ${total} journal entries in ${days}d`,
        fix: `either promote it in the card (MODE:) or move the work — one of the two is currently false` });
    }
    if (cls === 'active' && money.includes(c.slug) && pct < 10) {
      findings.push({ id: 'attention-vs-mode', key: `attention-vs-mode:${c.slug}:under`, severity: 'med', project: c.slug,
        what: `${c.slug} is a declared money bet in MODE active but took only ${pct}% of ${total} journal entries in ${days}d`,
        fix: 'either it is not active (say so in the card) or it is starved (schedule it)' });
    }
  }

  // (3) Buttons that nobody pressed. Not a slow decision — an unmade one.
  //     The rows come from the CALLER: queue.mjs imports this file, so reading queues from here
  //     would close an import cycle, and every tool here is synchronous by contract (see
  //     setHubBase) so a dynamic import is not an option either. Absent rows = say so.
  if (Array.isArray(a.queues)) {
    for (const r of a.queues) {
      if (!r.isButton || !(r.pending > 0) || (r.ageDays ?? 0) < staleButtonDays) continue;
      findings.push({ id: 'button-stale', key: `button-stale:${r.role}:${r.oldestWaiting || ''}`, severity: 'high', role: r.role,
        what: `${r.pending} item(s) waiting in the owner queue "${r.role}", oldest ${r.ageDays}d`,
        fix: 'decide it or withdraw it — an unanswered button decides by default' });
    }
  } else {
    notes.push('stale buttons not checked: the caller passed no queue rows (hub audit and the MCP tool both do).');
  }

  // (4) Cards that stopped following their own project — the same lag hub_status marks, filed.
  const lastJournal = lastJournalByProject();
  for (const c of cards) {
    const m = c.text.match(/- (?:synced|set): (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
    if (!m) continue;
    const lag = digestLag(m[1], lastJournal[c.slug], 14);
    if (lag) findings.push({ id: 'card-behind-journal', key: `card-behind-journal:${c.slug}`, severity: 'med', project: c.slug,
      what: `${c.slug}: card last touched ${m[1]}, its journal moved on ${lag.daysBehind}d further (to ${lag.lastJournal})`,
      fix: `re-sync the digest: hub card ${c.slug} -m "<what is true now>" --by <you>` });
  }

  // (5) Orphans.
  for (const t of open.filter(t => !t.project)) {
    findings.push({ id: 'task-without-project', key: `task-without-project:${t.id}`, severity: 'low', task: t.id,
      what: `#${t.id} has no project`, fix: 'assign one, or close it' });
  }

  // The thermometer: reported, never filed. A rate is not a violation, and dressing one up as an
  // incident is how an audit loses the reader it needs.
  const closedInWindow = tasks.filter(t => t.status === 'done' && t.done && parseTs(t.done).getTime() >= nowMs - days * 86400000);
  const rate = (list) => {
    const by = {};
    for (const t of list) {
      const k = t.cat || t.kind || 'none';
      by[k] = by[k] || { closed: 0 };
      by[k].closed++;
    }
    return by;
  };
  const numbers = {
    windowDays: days,
    journalEntries: total,
    attentionShare: Object.fromEntries(Object.entries(share).sort((x, y) => y[1] - x[1]).slice(0, 10)),
    closedByCat: rate(closedInWindow),
    closedByAssignee: Object.entries(closedInWindow.reduce((acc, t) => {
      const k = t.assignee || 'unassigned'; acc[k] = (acc[k] || 0) + 1; return acc;
    }, {})).sort((x, y) => y[1] - x[1]).slice(0, 10),
    openTasks: open.length,
  };

  for (const f of findings) {
    const law = lawFor(f.id, AUDIT_DEFAULTS[f.id] || f.id);
    f.law = law.text; f.lawSince = law.since; f.lawDeclared = law.declared;
  }
  const rank = { high: 0, med: 1, low: 2 };
  findings.sort((x, y) => rank[x.severity] - rank[y.severity]);

  if (!a.apply) return { apply: false, findings, notes, numbers, generated: now() };

  // Applying: one incident task per finding whose key is not already open, then ONE report.
  const by = requireAuthor(a.by, 'by');
  const openText = open.map(t => String(t.text || ''));
  const filed = [], skipped = [];
  for (const f of findings) {
    const stamp = `[audit:${f.key}]`;
    if (openText.some(x => x.includes(stamp))) { skipped.push(f.key); continue; }
    const cite = f.law + (f.lawSince ? ` (rule recorded ${f.lawSince})` : f.lawDeclared ? '' : ' [engine default — declare your own in rules.json -> laws]');
    try {
      const t = runTaskAdd({
        project: f.project || 'general',
        text: `AUDIT ${f.id}: ${f.what}. Rule: ${cite}. Fix: ${f.fix} ${stamp}`,
        importance: f.severity === 'high' ? 'high' : f.severity === 'med' ? 'med' : 'normal',
        cat: f.id === 'attention-vs-mode' ? 'decision' : 'chore',
        by,
      });
      filed.push({ key: f.key, task: t.task.id });
    } catch { skipped.push(f.key); }
  }
  const lines = [
    ...Object.entries(numbers.attentionShare).map(([p, n]) => `FACT: attention ${days}d: ${p} ${n}/${total} entries (${Math.round((n / total) * 100)}%)`),
    `FACT: closed in ${days}d by category: ${Object.entries(numbers.closedByCat).map(([k, v]) => k + ' ' + v.closed).join(', ') || 'none'}`,
    `NOTE: audit pass ${now()}: ${findings.length} finding(s), ${filed.length} filed, ${skipped.length} already open`,
  ];
  // kind 'audit', not 'note': its own summary must not count as work a card fails to reflect
  // (see BOOKKEEPING_KINDS).
  runReport({ project: 'general', by, text: lines.join('\n'), kind: 'audit' });
  return { apply: true, findings, notes, numbers, filed, skipped, generated: now() };
}

/* ── Output budgets ──
 * hub_brief(hours=168) once returned 196K characters and did not fit the context of the agent
 * that asked for it. Nothing was wrong with the data — the tool simply had no idea it was
 * talking to a reader with a finite window, and a reply that does not fit is worth less than a
 * short one: the agent loses the whole call, not the tail of it.
 *
 * So every list-shaped answer gets a default ceiling, and the reply SAYS what it left out
 * (`truncated`) instead of quietly ending early — a silent cut is indistinguishable from
 * "that's all there is", which is how a caller comes to believe a lie about its own hub.
 *
 * Two stages. First a per-key top-N. Then, if the payload is still over budget, lists are cut
 * further IN PLAN ORDER — the plan lists the journal first everywhere it appears, because
 * recent chatter is the most compressible thing in any of these answers and open tasks or
 * pending buttons are the least. `full: true` opts out entirely; that is the caller's call to
 * make, and it stays available so nothing is unreachable through the tool.
 *
 * Applied at the MCP boundary only (see index.mjs): the CLI writes to a terminal, where a
 * human can pipe, grep and scroll, and truncating there would hide data from the one reader
 * who can handle all of it. */
export const OUTPUT_BUDGET_CHARS = Math.max(2000, parseInt(process.env.HUBD_MAX_OUTPUT_CHARS || '', 10) || 40000);

// `indent` defaults to what the MCP transport actually serialises with (JSON.stringify(r, null, 1)),
// not to compact JSON: pretty-printing adds a newline and a run of spaces per key, which came to
// ~15% on a real brief — measuring the compact form let a payload pass the budget and still arrive
// over it, which is the one failure this whole mechanism exists to prevent.
export function capOutput(obj, plan = [], { full = false, maxChars = OUTPUT_BUDGET_CHARS, indent = 1 } = {}) {
  if (full || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  const truncated = {};
  const totals = {};
  const note = (key, arr) => { truncated[key] = { shown: arr.length, hidden: totals[key] - arr.length }; };

  for (const [key, limit] of plan) {
    const arr = out[key];
    if (!Array.isArray(arr)) continue;
    totals[key] = arr.length;
    if (arr.length > limit) { out[key] = arr.slice(0, limit); note(key, out[key]); }
  }

  // Headroom for the two keys this function adds itself: `truncated` and `hint` are written
  // AFTER the last measurement, and a budget blind to them is a budget missed by exactly the
  // size of its own explanation.
  const budget = Math.max(1000, maxChars - 400);
  const size = () => JSON.stringify(out, null, indent).length;
  // Quarter at a time: a handful of re-serialisations rather than one per element, and it never
  // overshoots to empty where a smaller cut would have fit.
  const shrink = (floor) => {
    for (const [key] of plan) {
      if (size() <= budget) return;
      let arr = out[key];
      if (!Array.isArray(arr)) continue;
      while (arr.length > floor && size() > budget) {
        arr = arr.slice(0, Math.max(floor, arr.length - Math.max(1, Math.ceil(arr.length / 4))));
        out[key] = arr;
        note(key, arr);
      }
    }
  };
  // Two passes, because a list cut to nothing is worse than several lists cut short: first take
  // every list down to a still-readable floor in plan order, and only if that is not enough let
  // them go empty — again in plan order, so the journal empties before the open tasks do.
  shrink(5);
  shrink(0);

  if (Object.keys(truncated).length) {
    out.truncated = truncated;
    out.hint = 'Capped to fit an agent context — ' +
      Object.entries(truncated).map(([k, v]) => `${k}: ${v.shown} shown, ${v.hidden} hidden`).join(' · ') +
      '. Pass full:true for everything, or narrow the question (project, hours, status).';
  }
  return out;
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
  const oldDigest = digestOf(prev);
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
  const oldDigest = digestOf(prev);
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
  // An explicit `NOTE:` is a deliberate aside; an unprefixed line is prose that just happened.
  // Only the second kind is what the strict check below is about, so they cannot share a flag.
  let explicitNote = false;
  for (const raw of String(a.text || '').split('\n')) {
    const ln = raw.replace(/\s+$/, '');
    if (!ln.trim()) continue;
    const m = ln.match(/^\s*([A-Za-z]+)\s*:\s*(.*)$/);
    const tag = m ? REPORT_PREFIX[m[1].toUpperCase()] : null;
    if (tag) { if (tag === 'note') explicitNote = true; b[tag].push(m[2].trim()); }
    else b.note.push(ln.trim());
  }
  // Opt-in (rules.json → strict.rejectNoteOnlyReport): a report made of nothing but prose is
  // almost always coordination wearing a report's clothes — "I'm on it" belongs in a claim, and
  // a session that files prose leaves the card exactly as uninformative as it found it. Off by
  // default, because refusing a write is the harshest thing this engine can do and an upgrade
  // must never start doing it uninvited.
  const noteOnly = b.note.length && !explicitNote && !b.decide.length && !b.fact.length && !b.hypo.length &&
    !b.comm.length && !b.next.length && !b.done.length && !b.task.length;
  if (noteOnly && rulesConfig().strict.rejectNoteOnlyReport) {
    throw new Error('strict: this report is prose only. Use a prefix so it lands somewhere a later reader will find it — ' +
      'DECIDE: / FACT: / COMM: / NEXT: / DONE: / TASK: — or, if you are just saying you started, hub claim instead. ' +
      '(rules.json → strict.rejectNoteOnlyReport; NOTE: <text> still works for a real aside.)');
  }
  /* A private report is local by definition, and every structured prefix writes into a card that
   * IS mesh-synced — so accepting both would quietly publish the thing the caller asked to keep on
   * this machine. Refuse the combination instead of silently dropping half of it. */
  if (a.private && (b.decide.length || b.fact.length || b.hypo.length || b.comm.length || b.next.length || b.done.length || b.task.length)) {
    throw new Error('private: only prose lines can be private. DECIDE:/FACT:/HYPO:/COMM:/NEXT: write into the project card, and cards are mesh-synced — ' +
      'that would publish what you asked to keep local. Send the private part as its own report, and the shareable part as a normal one.');
  }
  const summary = { ok: true, project: slug, decisions: 0, facts: 0, hypos: 0, comms: 0, next: false, done: [], doneAlready: [], doneMissed: [], tasks: [], note: false };
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
    // Three outcomes, three lists: closed by this report, already closed by someone else
    // (no-op — see runTaskUpdate), and no such id. Folding the middle one into `done` would
    // report work this session did not do.
    if (id) {
      try {
        const r = runTaskUpdate({ id, status: 'done', by });
        (r.noop === 'already-done' ? summary.doneAlready : summary.done).push(id);
      } catch { summary.doneMissed.push(id); }
    }
  }
  for (const t of b.task) { try { summary.tasks.push(runTaskAdd({ project: slug, text: t, by }).task.id); } catch {} }
  if (b.note.length) {
    const entry = { ts: now(), project: slug, agent: by, kind: a.kind || 'note', text: b.note.join(' · ') };
    if (a.private) { journalAppendPrivate(entry); summary.private = true; }
    else journalAppend(entry);
    summary.note = true;
  }
  // A report of pure FACT:/COMM:/NEXT: lines writes the CARD and never touches the journal, so the
  // choke point inside journalAppend misses it — and filing one is unmistakably somebody acting.
  touchPresenceIfOwner(by);
  return summary;
}

/** Where else this name exists — the pointer a "no card" error owes its caller. */
export function namespaceHint(name) {
  const slug = slugify(name || '');
  const hints = [];
  try {
    if (fs.existsSync(resourcePath(slug)))
      hints.push(`"${slug}" IS a resource, not a project card — use hub_resource_get({slug:"${slug}"}) or hub_graph`);
  } catch {}
  try {
    const near = fs.readdirSync(PROJ).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
      .filter(s => s !== slug && (s.startsWith(slug) || slug.startsWith(s)));
    if (near.length) hints.push('did you mean: ' + near.join(', '));
  } catch {}
  hints.push('Otherwise hub_search("<keyword>") finds where it is discussed, and hub_sync in its folder creates the card');
  return hints.join('. ');
}

/* ── Writing into one section of a card ──
 * Until now a tool could write exactly two things: the digest (hub_card_set) and the four
 * sections the report router owns (Decisions, Facts & hypotheses, Communication, Next step).
 * Gates, Metrics, Market and every hand-written section were reachable only by editing raw
 * markdown — which is precisely the operation that once ate curated content (the 0.1.6
 * section-loss fix). So: one tool that appends a line to ANY section, through the same
 * editSection used by reports, which preserves everything around it and creates the heading
 * when it is missing.
 *
 * `section` takes a KEY from sections.json ('gates') or a literal heading ('Gates', and on a
 * localised hub its translation) — an agent should not have to know which of the two it is
 * holding. An unknown name is not an error: hand sections are legitimate, so it is created —
 * but the result says `created: true`, because a typo silently growing a second, nearly
 * identical section is the failure mode here.
 *
 * `provenance` is the beginning of the answer to "was this still true when you read it": it
 * records where a line came from, next to the date it was written. */
export function runSectionAdd(a = {}) {
  const project = a.project || a.name;
  if (!project) throw new Error('project required');
  const raw = String(a.text ?? '').trim();
  if (!raw) throw new Error('text required: the one line to append');
  const by = requireAuthor(a.by ?? a.agent, 'by');
  const cfg = sectionsConfig();
  const want = String(a.section ?? '').trim();
  if (!want) throw new Error('section required: a key (' + cfg.map(s => s.key).join(' | ') +
    ') or a literal heading as it appears in the card');
  const heading = (cfg.find(s => s.key === want.toLowerCase())
    || cfg.find(s => s.heading.toLowerCase() === want.toLowerCase())
    || { heading: want.replace(/^#+\s*/, '') }).heading;

  const slug = slugify(project);
  const before = readCard(project) || cardBaseFor(project);
  const created = !new RegExp('^## ' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*$', 'm').test(before);
  const line = `- ${now()}: ${raw}` + (a.provenance ? ` · src: ${String(a.provenance).trim()}` : '');
  const after = editSection(before, heading, line, a.mode === 'set' ? 'set' : 'append');
  fs.mkdirSync(PROJ, { recursive: true });
  atomicWrite(cardPath(project), after);
  journalAppend({ ts: now(), project: slug, agent: by, kind: 'note', text: `${heading}: ${raw.slice(0, 100)}` });
  return { ok: true, project: slug, section: heading, created, card: cardPath(project) };
}

export function runStatus(a = {}) {
  const staleDays = a.staleDays ?? 7;
  const lastJournal = lastJournalByProject();
  const db = loadTasks();
  const files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md') && !RESERVED_CARDS.has(f.replace(/\.md$/, '')));
  const projects = files.map(f => {
    const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
    const digest = (digestOf(c) || '').slice(0, 300);
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
    // `synced` is the whole display string ("<ts> by <author>") — parse the timestamp out
    // of it, or parseTs sees "2026-06-26T09:42 by dev-mac", returns NaN, and the lag check
    // silently never fires (it did exactly that until this line existed).
    const syncedTs = (synced.match(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/) || [])[0] || null;
    const lag = digestLag(syncedTs, lastJournal[slug], staleDays);
    if (lag) p.digestStale = lag;
    return p;
  });
  return { projects, recentJournal: journalTail(null, 10) };
}

export function runGet(a) {
  const canon = canonProject(a.project);
  const card = readCard(a.project) || (canon !== slugify(a.project) ? readCard(canon) : null);
  // A miss used to dead-end at "run hub_sync", even when the name existed perfectly well in
  // the RESOURCE namespace (a service card did) or differed from a real card by a suffix. The
  // caller is not wrong about the name — it is looking in the wrong namespace, and only this
  // function can see that.
  if (!card) throw new Error('no card for: ' + a.project + '. ' + namespaceHint(a.project));
  const set = projectSlugSet(a.project);   // a lock taken under the old slug still locks this project
  const claimsDb = loadClaims();
  return { card, journal: journalTail(a.project, 15), claims: activeClaims(claimsDb.claims).filter(c => set.has(slugify(c.project))) };
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
  for (const { e } of readLogEntries(journalFiles(), journalNodeOf)) {
    if ((e.text || '').toLowerCase().includes(q))
      hits.push({ where: 'journal ' + e.ts + ' [' + e.project + '/' + e.agent + ']', line: e.text.slice(0, 200) });
  }
  return { query: a.query, hits: hits.slice(0, 40), total: hits.length };
}

/* ── Scope layers: what belongs to a project, to the person, and to nobody but this machine ──
 * Everything the hub stores has so far belonged to a PROJECT. Two kinds of thing do not, and both
 * were being forced into a project card or left out entirely:
 *
 * THE OPERATOR. Facts and preferences about the human — rhythm, what framing works, what they will
 * not be asked about — belong to no project and change slower than any of them. That is a card
 * like any other (slug `operator`), so section writes, recall and search reach it for free; it is
 * simply not counted as a project, because it is not one.
 *
 * THE PRIVATE RECORD. Some entries must never leave the machine they were written on. The design
 * already named this the life braid (docs/narrative-layer.md): journal.life.jsonl, local, gitignored,
 * never mesh-synced. `private: true` on a report routes there and stamps the entry, so a later
 * reader can see what it is holding — an agent may read it to write the weekly chapter and must
 * never quote it into a synced file. The flag is the only way in: nothing is classified by guess.
 *
 * THE RULES. AGENTS.md is the constitution, and until now it was readable only by an agent that
 * happened to know the path and had file access. Reading it is plainly right; appending is the part
 * that needs a shape, so an amendment goes at the END, under one heading, dated and attributed —
 * never rewriting a line somebody else wrote. */
export const RESERVED_CARDS = new Set(['operator']);

const OPERATOR_SCAFFOLD = [
  '## Rhythm',
  '',
  '<when the work actually happens; strong days and dead days>',
  '',
  '## Interface',
  '',
  '<how to talk to this human: framing that works, batching, one question or several>',
  '',
  '## Boundaries',
  '',
  '<what is never collected or structured. Agents READ this section and never edit it.>',
  '',
].join('\n');

export function runOperatorGet() {
  const card = readCard('operator');
  if (card) return { exists: true, card, path: cardPath('operator') };
  return { exists: false, card: null, path: cardPath('operator'),
    hint: 'no operator card yet. Create it with hub_card_set({project:"operator", digest:"<who this is in the system>", by:"..."}) — ' +
      'then fill Rhythm / Interface / Boundaries with hub_section_add. Boundaries is the owner\'s section: agents read it, never edit it.',
    scaffold: OPERATOR_SCAFFOLD };
}

/** The constitution, and the one shape an amendment may take. `teamRoot` is passed IN by the
 *  caller (the CLI and the server both resolve it) — core has no business walking directories. */
export function rulesFilePath(teamRoot) {
  const candidates = [path.join(HUB, 'AGENTS.md')];
  if (teamRoot && teamRoot !== HUB) candidates.push(path.join(teamRoot, 'AGENTS.md'));
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}

export function runRules(a = {}) {
  const file = rulesFilePath(a.teamRoot) || path.join(HUB, 'AGENTS.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  if (!a.append) {
    return { file, exists: !!text, text: text || null,
      ...(text ? {} : { hint: 'no AGENTS.md in this hub — run hub init, or write the team rules there. hubd mechanics live in the generated HUBD.md; AGENTS.md is for the rules YOU set.' }) };
  }
  const by = requireAuthor(a.by, 'by');
  const line = String(a.append).trim();
  if (!line) throw new Error('append: nothing to add');
  const HEAD = '## Amendments';
  // Appended, never edited in place: an amendment that rewrites an existing rule destroys the
  // record of what the rule USED to say, which is exactly what an incident needs to quote.
  const body = `- ${now()} (${by}): ${line}`;
  const next = text.includes(HEAD)
    ? editSection(text, 'Amendments', body, 'append')
    : (text.replace(/\s*$/, '') + `\n\n${HEAD}\n\n${body}\n`);
  atomicWrite(file, next);
  journalAppend({ ts: now(), project: 'general', agent: by, kind: 'decision', text: 'rules amended: ' + line.slice(0, 120) });
  return { ok: true, file, appended: body };
}

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
const RECALL_WEIGHT = { decision: 5, digest: 4, section: 3, task: 2, journal: 1 };

export function runRecall(a = {}) {
  const raw = String(a.query || '').trim();
  if (!raw) throw new Error('query required: a word or phrase to recall');
  const terms = [...new Set(raw.toLowerCase().split(/\s+/).filter(t => t.length > 1))];
  if (!terms.length) throw new Error('query too short');
  const staleDays = a.staleDays ?? 30;
  const limit = a.limit ?? 20;
  const nowMs = Date.now();
  const hits = [];

  const score = (kind, text, ts) => {
    const low = String(text).toLowerCase();
    const matched = terms.filter(t => low.includes(t));
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
    const r = score(kind, text, ts);
    if (!r) return;
    hits.push({ kind, where, project, text: String(text).trim().slice(0, 300), asOf: ts || null,
      ageDays: r.ageDays === null ? null : Math.round(r.ageDays),
      stale: r.ageDays !== null && r.ageDays >= staleDays,
      score: Math.round(r.s * 100) / 100, matched: r.matched });
  };

  for (const c of projectCards({ includeReserved: true })) {
    const touched = (c.text.match(/- (?:synced|set): (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/) || [])[1] || null;
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
  for (const e of journalTail(null, 4000)) {
    push(e.kind === 'decision' ? 'decision' : 'journal',
      `journal ${e.ts} [${e.project || '?'}/${e.agent || '?'}]`, e.project || null, e.text || '', e.ts);
  }
  for (const t of loadTasks().tasks) {
    push('task', `task #${t.id} (${t.status})`, t.project, t.text || '', t.done || t.created);
  }

  hits.sort((x, y) => y.score - x.score);
  const top = hits.slice(0, limit);
  const staleCount = top.filter(h => h.stale).length;
  return {
    query: raw, terms, total: hits.length, hits: top,
    stale: staleCount,
    hint: staleCount
      ? `${staleCount} of ${top.length} hit(s) are older than ${staleDays}d — each says what it was true as of. Verify before acting on one, or re-state it as a fresh FACT.`
      : undefined,
    generated: now(),
  };
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
  const digest = card ? (digestOf(card) || '').slice(0, 300) : null;
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

/* Canonical task category vocabulary: technical | communicative | decision | chore.
 * `cat` is the single field for this; `kind` is a legacy alias.
 *
 * The vocabulary is closed on purpose. `cat` answers exactly one question — what KIND of
 * work this is — and every number built on it (conversion by type, median time-to-done per
 * kind, the narrative layer's "what does this operator actually finish") only means something
 * while the axis stays four values wide. Left open, it drifted: this hub collected 18 one-off
 * values (build, jail, semmarkup, cost-estimation, ...) across 37 tasks, most of them a bucket
 * of one, and the analytics quietly became noise.
 *
 * An off-enum value is NOT rejected, though — "jail" is real information, it just isn't a
 * category. It moves to `tags`, which is open by design. Nothing a caller said is lost; the
 * axis stays countable. */
export const TASK_CATS = ['technical', 'communicative', 'decision', 'chore'];

export function normalizeCat(cat, tags) {
  const clean = [...new Set((Array.isArray(tags) ? tags : []).map(x => slugify(x)).filter(Boolean))];
  const v = String(cat ?? '').trim().toLowerCase();
  if (!v) return { cat: null, tags: clean, moved: null };
  if (TASK_CATS.includes(v)) return { cat: v, tags: clean, moved: null };
  const tag = slugify(v);
  return { cat: null, tags: clean.includes(tag) ? clean : [...clean, tag], moved: tag };
}

export function runTaskAdd(a) {
  const author = requireAuthor(a.by, 'by');
  return withLock(TASK_EVENTS, () => {
    const id = `${JOURNAL_NODE}-${nextLocalSeq()}`;
    const norm = normalizeCat(a.cat, a.tags);
    const t = {
      // New work lands on the canonical slug, so an alias never grows a fresh backlog of its own.
      id, project: canonProject(a.project), text: a.text,
      importance: a.importance || 'normal', deadline: a.deadline || null,
      cat: norm.cat, tags: norm.tags, assignee: a.assignee || null, status: 'open',
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
  if (a.project) { const set = projectSlugSet(a.project); list = list.filter(t => set.has(t.project)); }
  if (st !== 'all') list = list.filter(t => t.status === st);
  // Paging is the deliberate alternative to a silent cap: the caller that wants the 269th task
  // can reach it, instead of being told "100 tasks" by a tool that had 322. `total` is always
  // the full matching count, so a page never masquerades as the whole answer.
  const total = list.length;
  const offset = Math.max(0, parseInt(a.offset, 10) || 0);
  const limit = a.limit != null ? Math.max(1, parseInt(a.limit, 10) || 1) : null;
  if (offset || limit != null) list = list.slice(offset, limit != null ? offset + limit : undefined);
  return { count: list.length, total, offset, tasks: list };
}

/* One task by id — the counterpart hub_resource_get always had and tasks did not. Without it,
 * knowing a number but not its project meant guessing project × status combinations against
 * hub_task_list (three wasted calls, in the session that filed this). Returns the dependency
 * edges in BOTH directions, since "what is this waiting on / what waits on it" is the question
 * that follows every lookup of a single task. */
/* Closing a task does not make its linked resources real, and nothing used to say so: a task
 * closed with linked resources left the app's own resource card reading "planned"
 * a full day later, and hub_graph kept answering with it. This does NOT cascade — only the person
 * closing the task knows whether the thing is actually live now, and a tool guessing that would
 * write a fact nobody checked. It names what looks stale and the one call that fixes it. */
const RESOURCE_NOT_LIVE = new Set(['planned', 'plan', 'proposed', 'todo', 'draft', 'wip', 'in-progress', 'in progress', 'pending']);
function staleResourceHint(t) {
  const stale = [];
  for (const slug of (Array.isArray(t.resources) ? t.resources : [])) {
    const text = readResource(slug);
    if (!text) continue;
    const st = (parseFront(text).find(p => p.key === 'status') || {}).value;
    if (st && RESOURCE_NOT_LIVE.has(String(st).trim().toLowerCase())) stale.push(`${slug} (${String(st).trim()})`);
  }
  return stale.length
    ? `closed, but its linked resource(s) still read not-live: ${stale.join(', ')}. If this work made them real, say so: hub_resource_set({slug:"<one>", status:"live", by:"<you>"}) — nothing here guesses that for you.`
    : null;
}

export function runTaskGet(a) {
  if (a == null || a.id == null || a.id === '') throw new Error('id required: the task id as hub_task_list reports it');
  const all = loadTasks().tasks;
  const t = all.find(x => String(x.id) === String(a.id));
  if (!t) throw new Error('no task #' + a.id +
    ' — ids are node-scoped ("planck-3") or legacy numbers. Know a keyword instead? hub_search finds the task and the project it lives in.');
  const deps = (Array.isArray(t.depends_on) ? t.depends_on : []).map(String);
  const brief = (x) => ({ id: x.id, project: x.project, status: x.status, text: (x.text || '').slice(0, 80) });
  return {
    task: t,
    blockedBy: all.filter(x => deps.includes(String(x.id))).map(brief),
    blocks: all.filter(x => (Array.isArray(x.depends_on) ? x.depends_on : []).map(String).includes(String(t.id))).map(brief),
  };
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
    for (const k of ['status', 'importance', 'text', 'deadline', 'assignee']) if (a[k] != null) patch[k] = a[k];
    // cat and tags move together: an off-enum cat becomes a tag (see normalizeCat), so
    // editing either one has to recompute both from the task's current pair.
    if (a.cat != null || a.tags != null) {
      const norm = normalizeCat(a.cat != null ? a.cat : t.cat, a.tags != null ? a.tags : t.tags);
      patch.cat = norm.cat;
      patch.tags = norm.tags;
    }
    if (Array.isArray(a.depends_on)) patch.depends_on = a.depends_on;
    if (Array.isArray(a.resources)) patch.resources = a.resources.map(slugify);
    /* Closing a closed task is a no-op, not a second closing. `DONE:` in a report closes
     * ids without asking, and two agents finishing the same handoff both report it (task
     * #189 was closed twice, 34 minutes apart, by two sessions) — which used to append a
     * second done event and move `done` to the later timestamp, so every count downstream
     * saw two closes and the task's own lifespan silently grew by the gap. The attempt is
     * still worth a line in the journal: it says two sessions believed they owned it. */
    const reclose = a.status === 'done' && t.status === 'done';
    if (reclose) delete patch.status;
    else if (a.status === 'done') patch.done = now();
    if (reclose && !Object.keys(patch).length) {
      journalAppend({ ts: now(), project: t.project, agent: author, kind: 'task',
        text: '= task #' + t.id + ' already closed' + (t.done ? ' ' + t.done : '') + ' — no-op' });
      return { ok: true, noop: 'already-done', closedAt: t.done || null, task: t };
    }
    // Key the set to the task's ORIGIN (node,id) — NOT this writer's node + finalId — so the
    // unchanged reducer resolves it to the canonical task even when THIS node historically
    // collided on the finalId (else `set` mis-hits the writer's own remapped task). _origin
    // is supplied by the fold; fall back to writer/finalId for pre-migration caches.
    const origin = t._origin || { node: JOURNAL_NODE, id: t.id };
    // `keyed: 'origin'` is not decoration: an origin-keyed set and a legacy final-id-keyed set
    // are otherwise BYTE-IDENTICAL while meaning different tasks (planck updating its own
    // remapped task emits exactly what "update the visible #169" used to emit). The reader
    // cannot guess, so new writes say which convention they use and old ones keep the
    // best-effort heuristic they were written under.
    fs.appendFileSync(TASK_EVENTS, JSON.stringify({ ts: now(), node: origin.node, ev: 'set', id: origin.id, keyed: 'origin', patch }) + '\n');
    rebuildTaskCache();
    /* Say WHAT changed, not just that something did. The line used to read "~ task #N → edited"
     * for every non-status edit, so the single most useful event in a coordination log — somebody
     * took this task — was indistinguishable from a typo fix in its text. A reader scanning the
     * journal needs the new owner, the new priority, the new date; that is the whole reason the
     * line exists. */
    if (!a.quiet) {
      const bits = [];
      if (a.status) bits.push(a.status);
      if (patch.assignee != null) bits.push('@' + patch.assignee);
      if (patch.importance != null) bits.push('importance ' + patch.importance);
      if (patch.deadline != null) bits.push(patch.deadline ? 'due ' + patch.deadline : 'no deadline');
      if (patch.cat != null || patch.tags != null) bits.push('cat/tags');
      if (patch.depends_on != null) bits.push('deps');
      if (patch.resources != null) bits.push('resources');
      if (patch.text != null) bits.push('text');
      journalAppend({ ts: now(), project: t.project, agent: author, kind: 'task',
        text: '~ task #' + t.id + ' → ' + (bits.join(', ') || 'edited') });
    }
    const resourceHint = a.status === 'done' ? staleResourceHint(t) : null;
    return { ok: true, task: { ...t, ...patch }, ...(resourceHint ? { resourceHint } : {}) };
  });
}

/* Soft migration for the off-enum categories already in a base: move each one into `tags`.
 * Append-only, as the task-log contract requires — this replays them through runTaskUpdate,
 * which writes `set` events; no file is rewritten and no field is dropped. Dry by default:
 * a migration you cannot preview first is a migration nobody runs twice.
 * The per-task journal lines are suppressed (quiet) in favour of ONE summary entry — a
 * migration is a single act, and 37 identical "~ task edited" lines would flood every brief
 * and whatsnew across the mesh with something no reader needs item by item. */
export function runTaskRetag(a = {}) {
  const offEnum = (t) => {
    const v = String(t.cat ?? '').trim().toLowerCase();
    return v && !TASK_CATS.includes(v);
  };
  const affected = loadTasks().tasks.filter(offEnum)
    .map(t => ({ id: t.id, project: t.project, cat: t.cat, tag: slugify(t.cat) }));
  if (!a.apply) return { apply: false, count: affected.length, tasks: affected };
  const by = requireAuthor(a.by, 'by');
  let moved = 0;
  const failed = [];
  for (const x of affected) {
    try { runTaskUpdate({ id: x.id, cat: x.cat, by, quiet: true }); moved++; }
    catch { failed.push(x.id); }
  }
  if (moved) journalAppend({ ts: now(), project: 'general', agent: by, kind: 'note',
    text: `cat→tags: ${moved} task(s) moved off-enum categories into tags (${[...new Set(affected.map(x => x.tag))].join(', ')})` });
  return { apply: true, count: affected.length, moved, failed, tasks: affected };
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
  // Two different silences, deliberately reported apart: staleCards = nobody touched this
  // card in N days (it may still be true — the project could be dormant); staleDigests =
  // the project kept WORKING and its card did not follow, which is the one that misleads.
  const staleDigests = [];
  const lastJournal = lastJournalByProject();
  try {
    for (const f of fs.readdirSync(PROJ).filter(f => f.endsWith('.md') && !RESERVED_CARDS.has(f.replace(/\.md$/, '')))) {
      const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
      const m = c.match(/- (?:synced|set): (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);   // card-set cards go stale too
      if (m) {
        const project = f.replace('.md', '');
        const daysAgo = Math.floor((nowMs - parseTs(m[1]).getTime()) / 86400000);
        if (daysAgo >= staleDays) staleCards.push({ project, synced: m[1], daysAgo });
        const lag = digestLag(m[1], lastJournal[project], staleDays);
        if (lag) staleDigests.push({ project, synced: m[1], ...lag });
      }
    }
  } catch {}
  staleDigests.sort((x, y) => y.daysBehind - x.daysBehind);

  const claimsDb = loadClaims();
  return { tasksOpen, journalRecent, staleCards, staleDigests, activeClaims: activeClaims(claimsDb.claims), generated: now() };
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

/* ── The one next thing, and the shape of the day ──
 * hub_brief answers "what is going on" and hub_inbox answers "what needs a decision". Neither
 * answers the question an agent actually opens a session with — "what do I do now" — and a list
 * is not an answer to it: picking is work, and a session that has to pick often picks the easy
 * one. So: exactly one task, and the reason it won, which is also the part a human can argue with.
 *
 * The order is the same one hub_brief sorts by (overdue, then importance, then age) with one
 * addition that matters more than any of them: a task whose dependencies are still open is not
 * eligible, no matter how loud it is. */
function eligibleOpen(tasks, { project, assignee } = {}) {
  const open = tasks.filter(t => t.status === 'open');
  const openIds = new Set(open.map(t => String(t.id)));
  const blocked = (t) => (Array.isArray(t.depends_on) ? t.depends_on : []).map(String).some(d => openIds.has(d));
  let list = open.filter(t => !blocked(t));
  if (project) { const set = projectSlugSet(project); list = list.filter(t => set.has(t.project)); }
  if (assignee) list = list.filter(t => t.assignee === assignee);
  return { list, blocked: open.filter(blocked), openIds };
}

const IMPORTANCE_RANK = { high: 3, med: 2, normal: 1 };
function byUrgency(today3) {
  return (x, y) => {
    const xu = x.deadline && x.deadline <= today3 ? 1 : 0;
    const yu = y.deadline && y.deadline <= today3 ? 1 : 0;
    if (xu !== yu) return yu - xu;
    const xi = IMPORTANCE_RANK[x.importance] || 1, yi = IMPORTANCE_RANK[y.importance] || 1;
    if (xi !== yi) return yi - xi;
    return String(x.created || '') < String(y.created || '') ? -1 : 1;
  };
}

export function runNext(a = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const today3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const { list, blocked } = eligibleOpen(loadTasks().tasks, a);
  if (!list.length) {
    return { task: null, why: blocked.length
      ? `nothing is ready: all ${blocked.length} open task(s) here wait on something still open (hub plan shows the chain)`
      : 'nothing open here', blockedCount: blocked.length };
  }
  const sorted = [...list].sort(byUrgency(today3));
  const t = sorted[0];
  const reasons = [];
  if (t.deadline && t.deadline < today) reasons.push(`overdue since ${t.deadline}`);
  else if (t.deadline && t.deadline <= today3) reasons.push(`due ${t.deadline}`);
  if (t.importance === 'high') reasons.push('importance high');
  if (!reasons.length) reasons.push('oldest of the equally urgent');
  if (t.owner_kind === 'human' || (t.assignee && new Set(ownerRoles()).has(t.assignee)))
    reasons.push('NOTE: this one is the owner\'s to press, not an agent\'s — prepare it, do not decide it');
  return {
    task: t,
    why: reasons.join(' · '),
    runnerUp: sorted[1] ? { id: sorted[1].id, text: (sorted[1].text || '').slice(0, 80) } : null,
    eligible: list.length, blockedCount: blocked.length,
  };
}

/* The day split by WHO CAN ACT, which is the split that decides whether anything moves: agent
 * work, the owner's buttons, and what is waiting on something else. A single mixed list hides
 * the fact that half of it cannot be started by the reader holding it. */
export function runAgenda(a = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const today3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const { list, blocked } = eligibleOpen(loadTasks().tasks, a);
  const sorted = [...list].sort(byUrgency(today3));
  const short = (t) => ({ id: t.id, project: t.project, importance: t.importance, deadline: t.deadline || null,
    assignee: t.assignee || null, text: (t.text || '').slice(0, 100),
    overdue: !!(t.deadline && t.deadline < today) });
  // A task is the owner's either because it says so (owner_kind) or because it is assigned to a
  // role the instance already DECLARED as a human owner. Most real tasks carry no owner_kind, so
  // without the second test every owner decision lands in the "agent work, ready now" column —
  // a list whose whole purpose is that its reader can start everything in it.
  const owners = new Set(ownerRoles());
  const isOwner = (t) => t.owner_kind === 'human' || (t.assignee && owners.has(t.assignee));
  return {
    overdue: sorted.filter(t => t.deadline && t.deadline < today).map(short),
    dueSoon: sorted.filter(t => t.deadline && t.deadline >= today && t.deadline <= today3).map(short),
    agentReady: sorted.filter(t => !isOwner(t)).map(short),
    ownerButtons: sorted.filter(isOwner).map(short),
    blocked: blocked.map(t => ({ ...short(t), waitingOn: (t.depends_on || []).map(String) })),
    counts: { eligible: list.length, blocked: blocked.length,
      agentReady: sorted.filter(t => !isOwner(t)).length, ownerButtons: sorted.filter(isOwner).length },
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
  for (const { e } of readLogEntries(journalFiles(), journalNodeOf)) allJournal.push(e);
  const inbox = allJournal
    .sort((a, b) => b.ts > a.ts ? 1 : -1)
    .slice(0, 30)
    .map(e => ({ ts: e.ts, project: e.project, agent: e.agent, kind: e.kind, text: e.text }));

  return { queued, inProgress, doneToday, inbox, generated: now() };
}
