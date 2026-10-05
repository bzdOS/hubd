import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { LEVELS, checkReflect, readReflect, reflectDigest, renderReflect, splitReflect } from './reflect.mjs';

// Installed hubd version (stamps the generated HUBD.md so each node can tell if its
// materialised protocol matches the code actually running there).
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0'; }
})();

// resolveHub:start
//   purpose: choose the hub base dir — the SINGLE source of truth for where data lives.
//   output: absolute path. Order: HUBD_DIR | PROJECT_HUB_DIR (env) wins; else HUBD_TEAM_DIR (or the
//     legacy HUBD_QUEUE_DIR) — a harness that names ONE directory means one directory, for the queues
//     AND for presence, journal and tasks; else ~/.hubd; else the legacy ~/.project-hub if it exists
//     and ~/.hubd does not (graceful rebrand — never orphan an old base).
//   why HUBD_TEAM_DIR counts: until 0.9.17 it moved only the queues. A fleet that set it to
//     /srv/team/hub for every role saw the roles' heartbeats, reports and 11 unread escalations land
//     in each role's own ~/.hubd for a day, while the orchestrator read /srv/team/hub and concluded no
//     role was alive (task maple-88). HUB_VIA says which rule won, for `hub doctor`.
//   INVARIANT: this is the ONLY place the hub location is decided. `os.homedir()` + '.hubd'/'.project-hub'
//     may appear ONLY inside this function. Every other reference to hub paths goes through the exported
//     HUB / PROJ / HISTORY / JOURNAL / TASKS / CLAIMS / TASK_EVENTS (set by setHubBase) — never rebuild a
//     hub path from os.homedir() or a literal '~/.hubd' anywhere else.
//   why: HUBD_DIR override, the multi-tenant per-request setHubBase(tenant) repoint, and the legacy base
//     each break the instant a path is hardcoded — a stray ~/.hubd then SHADOWS the real hub. This is the
//     exact bug that was in `hub doctor` / `hub serve` (a hardcoded ~/.hubd/AGENTS.md candidate); fixed.
export let HUB_VIA = 'default';
function resolveHub() {
  const env = process.env.HUBD_DIR || process.env.PROJECT_HUB_DIR;
  if (env) { HUB_VIA = 'env HUBD_DIR'; return env; }
  const team = process.env.HUBD_TEAM_DIR || process.env.HUBD_QUEUE_DIR;
  if (team) { HUB_VIA = 'env HUBD_TEAM_DIR'; return team; }
  const fresh = path.join(os.homedir(), '.hubd');
  const legacy = path.join(os.homedir(), '.project-hub');
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) { HUB_VIA = 'legacy ~/.project-hub'; return legacy; }
  return fresh;
}
// resolveHub:end
// Per-host journal: each machine appends to journal.<node>.jsonl so that several
// machines syncing the same hub never conflict on one append-only file. node id
// defaults to the hostname (override with HUBD_NODE). journalFiles() merges all
// journal*.jsonl on read, so legacy single-file journal.jsonl is still picked up.
export const JOURNAL_NODE = (process.env.HUBD_NODE || os.hostname() || 'node')
  .split('.')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';

// Task ID prefix: by default the same as JOURNAL_NODE, but can be overridden with
// HUBD_TASK_ID_PREFIX to avoid leaking hostnames into task IDs that get cited in
// public places (issue trackers, PR branches, chat rooms).
// The prefix is sanitised the same way as JOURNAL_NODE: lowercase, no dots, max 40.
// This does NOT change any existing IDs — only new tasks get the new prefix.
// nextLocalSeq() scans for both the old (JOURNAL_NODE) and new (TASK_ID_PREFIX)
// patterns so the sequence counter never resets.
export const TASK_ID_PREFIX = (() => {
  const raw = process.env.HUBD_TASK_ID_PREFIX;
  if (!raw) return JOURNAL_NODE;
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || JOURNAL_NODE;
})();

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
}
setHubBase(resolveHub());

/* The hub's directories, made by whatever is about to write (ensureProtocol, the MCP server per
 * tenant) — never by pointing at a base. setHubBase() used to create all four, so a CLI that only
 * read — `hub gc --json`, `hub status` — left presence/ projects/ resources/ behind in a hub it had
 * merely looked at. A reader copes with a directory that is not there; atomicWrite and the lock
 * make the parent of what they write, so a writer that skipped this still lands. */
export function ensureHubDirs() {
  for (const d of [PROJ, HISTORY, RESOURCES, PRESENCE]) fs.mkdirSync(d, { recursive: true });
}

/* A CLI command that only reads turns this on before it runs (cli.mjs, the read-only table). The
 * engine then skips the writes it would otherwise make in passing while reading: the task cache
 * rebuilt by loadTasks(), the environment baseline. Both are derived files the next writing
 * command makes again, so a read loses nothing by not making them. */
let READ_ONLY = false;
export function setReadOnly(on) { READ_ONLY = !!on; }
export const isReadOnly = () => READ_ONLY;

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
/** A multi-tenant token's workspace directory name, the same for the MCP server and the board. */
export const tenantKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 40);
/** A string matched literally inside a RegExp. */
export const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/** A non-negative integer from env var `name`; unset, empty or malformed gives `dflt`. 0 means "no limit". */
export function envLimit(name, dflt) {
  const raw = String(process.env[name] ?? '').trim();
  if (raw === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
}

/* ── A message is prose, not cargo ──
 *
 * A queue message, a report and a task are read whole by a model, every time, and a role loop cuts
 * a message past 16 KB, so cargo sent this way never arrives: a 2.3 MB base64 bundle sent to one
 * head overflowed it twice, and the work it carried stood still. The artifact belongs in a file on
 * the sender's node; the message carries its path, size and sha256. So the size is capped
 * (HUBD_MSG_MAX, bytes, 0 = no cap), and four shapes are refused at any size — they are cargo
 * however short, and a few KB of them is a file pasted where a sentence was due. */
export const PROSE_RULE = 'A message is prose, not cargo: put the artifact in a file on your node and send its path, size and sha256sum.';
const MSG_MAX_DEFAULT = 16384;
// base64 or hex: one run of 2 KB+ with no space in it. Lines wrapped at 60+ columns (an encoder's
// default) are one run; a run with no digit or no letter in it is a ruler, not an encoding.
const B64_RUN = /(?:[A-Za-z0-9+/=_-]{60,}\r?\n)+[A-Za-z0-9+/=_-]+(?=\r?\n|$)|[A-Za-z0-9+/=_-]{2049,}/g;
const CARGO_SHAPES = [
  { what: 'a git diff', re: /^diff --git \S/m },
  { what: 'a git bundle', re: /^# v[23] git bundle\s*$/m },
  { what: 'a PEM block (a key or a certificate)', re: /^-----BEGIN [A-Z0-9 ]+-----\s*$/m },
];

/** The first cargo shape in `text`, as { what, line }, or null. */
export function cargoIn(text) {
  const s = String(text ?? '');
  const lineAt = (i) => s.slice(0, i).split('\n').length;
  for (const m of s.matchAll(B64_RUN)) {
    if (m[0].length <= 2048) continue;
    const run = m[0].replace(/\s+/g, '');
    if (run.length > 2048 && /[0-9]/.test(run) && /[A-Za-z]/.test(run))
      return { what: `a base64 or hex run of ${run.length} characters`, line: lineAt(m.index) };
  }
  for (const c of CARGO_SHAPES) {
    const m = c.re.exec(s);
    if (m) return { what: c.what, line: lineAt(m.index) };
  }
  return null;
}

/** Refuse `text` that is too big or carries cargo; `what` names it in the error ("message", "report", ...). */
export function assertProse(text, what = 'message') {
  const s = String(text ?? '');
  const max = envLimit('HUBD_MSG_MAX', MSG_MAX_DEFAULT);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (max && bytes > max) throw new Error(`${what} refused: ${bytes} bytes, over the ${max}-byte limit (HUBD_MSG_MAX). ${PROSE_RULE}`);
  const cargo = cargoIn(s);
  if (cargo) throw new Error(`${what} refused: it carries ${cargo.what} (line ${cargo.line}). ${PROSE_RULE}`);
  return s;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireLock(file) {
  const lock = file + '.lock';
  const deadline = Date.now() + 2000;
  let madeDir = false;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.closeSync(fd);
      return lock;
    } catch (e) {
      // the directory is made by the first write into it, not by pointing at the hub (ensureHubDirs)
      if (e.code === 'ENOENT' && !madeDir) { madeDir = true; fs.mkdirSync(path.dirname(lock), { recursive: true }); continue; }
      if (e.code !== 'EEXIST') throw e;
      // Check for stale lock: if mtime > 30s old, treat as abandoned and steal it.
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 30000) {
          /* Steal by RENAME, then look at what was taken. unlink-by-path had a window: two waiters
           * both see the stale lock, the first removes it and takes a fresh one, and the second's
           * unlink then removes that FRESH lock — two holders at once. A rename moves exactly one
           * inode; if the one we moved turns out to be fresh, it is linked back before retrying. */
          const grave = `${lock}.stale.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
          try { fs.renameSync(lock, grave); } catch (renameErr) {
            if (renameErr.code !== 'ENOENT') throw renameErr;
            continue;                                      // someone else took it first — retry
          }
          let fresh = false;
          try { fresh = Date.now() - fs.statSync(grave).mtimeMs <= 30000; } catch {}
          if (fresh) { try { fs.linkSync(grave, lock); } catch {} }
          try { fs.unlinkSync(grave); } catch {}
          if (!fresh) continue;                              // the stale one is gone — retry now
          sleepMs(50);
          continue;
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

export function releaseLock(lock) {
  try { fs.unlinkSync(lock); } catch {}
}

/* A file in a SHARED directory must be writable by the group that shares it.
 *
 * On a fleet node one hub directory is written by several users — the roles under one account, the
 * sync under another, an operator under a third. The directory is group-writable and setgid, so
 * everyone can create files in it; but a file created with the default umask (0022) is writable by
 * its OWNER only, and the next user to need it is locked out of that one file forever. Measured
 * 2026-09-14 on bsdbox: the role ran as `freebsd`, its queue cursor had been created by `agent`
 * as rw-r--r--, and nine orders sat undelivered because a byte offset could not be advanced (task
 * maple-98). mesh-sync cannot repair it either — chmod requires ownership, and the file
 * belongs to the other user.
 *
 * So the rule is applied where the file is born: if the containing directory grants group write,
 * the file does too. A private hub (no group write on the directory) is untouched, which is every
 * single-user install. Failures are ignored on purpose — not owning the file is exactly the case
 * this prevents in the future, and it must never break the write that is happening now. */
export function shareMode(file) {
  try {
    const dir = fs.statSync(path.dirname(file));
    if (!(dir.mode & 0o020)) return;                       // private directory — leave modes alone
    const st = fs.statSync(file);
    if ((st.mode & 0o060) === 0o060) return;               // already group rw
    fs.chmodSync(file, st.mode | 0o060);
  } catch {}
}

/** A JSON file's value, or `fallback` when it is missing, unreadable, malformed or null. */
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; }
}

export function atomicWrite(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
    shareMode(file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {} // cleanup on error or after successful rename
  }
}

/* projects/history/<name>.md — superseded digests and rotated card sections. Appended by whichever
 * user happens to write the card, so on a shared hub it needs the same group bit as every other
 * append: the first writer used to leave it rw-r--r--, and the next user's card write then failed
 * on the history step, before the card itself was saved. One helper, so no caller forgets. */
export function appendHistory(name, text) {
  const f = path.join(HISTORY, name + '.md');
  fs.mkdirSync(HISTORY, { recursive: true });
  fs.appendFileSync(f, text);
  shareMode(f);
  return f;
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

export const CONFLICT_RE = /^<<<<<<< |^=======$|^>>>>>>> /m;

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
export const journalNodeOf = (base) => {
  const m = base.match(/^journal\.(.+)\.jsonl$/);
  if (!m) return '';                                    // legacy single-file journal.jsonl
  return m[1].replace(/-\d{4}-\d{2}(\.\d+)?$/, '');
};
export const taskEventNodeOf = (base) => (base.match(/^tasks\.(.+)\.events\.jsonl$/) || [])[1] || 'node';

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
 * both appending to journal.maple.jsonl.
 *
 * The test is INTERLEAVING, not "more than one version present". An ordinary upgrade also puts two
 * versions in a log, but it partitions them: every old line, then every new one. Two installs
 * running side by side keep taking turns, so an older version goes on appearing after the newer
 * one first showed up. Only that is reported.
 *
 * Bounded to the last CONCURRENT_WINDOW stamped entries because the claim is about the present.
 * Interleaving that stopped months ago is history, and a warning that can never be cleared is one a
 * reader learns to skip — which would cost more than this check is worth. */
const CONCURRENT_WINDOW = 50;

function concurrentWriters(seq) {
  const recent = seq.slice(-CONCURRENT_WINDOW);
  if (!recent.length) return [];
  const newest = [...new Set(recent.map(x => x.v))].sort(cmpVersion).pop();
  const from = recent.findIndex(x => x.v === newest);
  const older = new Set(recent.slice(from + 1).filter(x => cmpVersion(x.v, newest) < 0).map(x => x.v));
  return older.size ? [...older, newest].sort(cmpVersion) : [];
}

/* WHO is running the old one. The version pair alone sent a reader to the wrong place: doctor said
 * "two installs on one node - check before upgrading", and on this very hub that diagnosis was
 * false. There is one install; the resident MCP server had loaded core.mjs when VERSION still read
 * 0.9.10 and went on writing 0.9.10 while a freshly spawned CLI wrote 0.9.11 from the same file.
 * Upgrading a package on disk does not reach into a process that already imported it, and no amount
 * of checking `npm ls -g` would have revealed that.
 *
 * So report the agent names per version. That converts an unanswerable question ("where is the
 * second install?") into an addressable one ("these agents are holding the older module — restart
 * their clients"), and it stays honest when the cause really is two installs, because then the
 * names point at the sessions using each. An agent appearing under BOTH versions is not a
 * contradiction to smooth over: it means that agent name is used by more than one process, which is
 * itself the thing worth seeing. */
function concurrentBy(seq, versions) {
  if (!versions.length) return {};
  const want = new Set(versions), out = {};
  for (const x of seq.slice(-CONCURRENT_WINDOW)) {
    if (!want.has(x.v) || !x.agent) continue;
    (out[x.v] = out[x.v] || new Set()).add(x.agent);
  }
  for (const v of Object.keys(out)) out[v] = [...out[v]].sort();
  return out;
}

export function writerVersions() {
  const byNode = new Map();
  for (const { e, node } of readLogEntries(journalFiles(), journalNodeOf)) {
    if (node === 'life') continue;               // the private braid is this machine's, not a node
    const key = node || 'legacy';
    let g = byNode.get(key);
    if (!g) byNode.set(key, g = { node: key, versions: {}, unstamped: 0, last: null, lastAt: null, lastWrite: null, _seq: [] });
    /* Newest entry of ANY kind, stamped or not. `lastAt` can only see stamped ones, so a node
     * still running a pre-0.9.4 hubd reported lastAt: null — indistinguishable from a node that
     * has never written at all. Membership questions need the second fact, not the first. */
    if (e.ts && (!g.lastWrite || String(g.lastWrite) < String(e.ts))) g.lastWrite = e.ts;
    const v = typeof e.v === 'string' && e.v ? e.v : null;
    if (!v) { g.unstamped++; continue; }
    g.versions[v] = (g.versions[v] || 0) + 1;
    const ms = parseTs(e.ts).getTime();
    g._seq.push({ v, ms: Number.isFinite(ms) ? ms : 0, agent: e.agent || null });
  }
  const out = [];
  for (const g of byNode.values()) {
    g._seq.sort((a, b) => a.ms - b.ms);
    const last = g._seq.length ? g._seq[g._seq.length - 1] : null;
    const concurrent = concurrentWriters(g._seq);
    out.push({
      node: g.node, versions: g.versions, unstamped: g.unstamped,
      last: last ? last.v : null,
      lastAt: last ? new Date(last.ms).toISOString().slice(0, 16).replace('T', ' ') : null,
      lastWrite: g.lastWrite,
      concurrent,
      concurrentBy: concurrentBy(g._seq, concurrent),
    });
  }
  return out.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
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
      // (Real case: maple's add of 168 remapped to 171, and pine's own add of
      // 171 remapped to 172; every later pine update addressed to the visible #171
      // then landed on #172, and #171 could not be updated from pine at all.)
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
  if (!READ_ONLY) atomicWrite(TASKS, { ...db, foldVersion: VERSION });
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
  return readJson(TASKS, { seq: 0, tasks: [] });
}

/* ── Claims ── */
export function loadClaims() {
  return readJson(CLAIMS, { claims: [] });
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
  // Private lines: ignored here whatever the shared .gitignore says. Only a hub that is not its own
  // repository (a folder inside some other checkout) gets the line in .gitignore, since that is the
  // one ignore file such a repository reads from the hub.
  if (!ensureLocalIgnores()) ensureGitignored('journal.life.jsonl');
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
    shareMode(JOURNAL);
  });
}

/* A month archive is rotated out of the live log DURING its month (journalAppend names it by the
 * month it was cut in), so nothing in it is newer than that month's end. A reader with a cutoff
 * after that never needs to open it: the board asked for seven days every 30 seconds and read and
 * parsed every archive since the hub began, then threw all but a week away. The live log and any
 * file not named like an archive can hold anything, so they are always read. */
export function journalFileEndMs(base) {
  const m = /^journal\..+-(\d{4})-(\d{2})(?:\.\d+)?\.jsonl$/.exec(base);
  return m ? Date.UTC(+m[1], +m[2], 1) : Infinity;    // month m[2] is 1-based: as an index, the next month
}
/** Every journal entry, each node's repeated lines dropped (see readLogEntries), in file order.
 *  With `sinceMs`, month archives that end before it are not read (see journalFileEndMs); the
 *  caller still filters by entry, since the files that are read hold older lines too. */
export function* journalEntries(sinceMs = -Infinity) {
  const files = journalFiles().filter(f => journalFileEndMs(path.basename(f)) > sinceMs);
  for (const { e } of readLogEntries(files, journalNodeOf)) yield e;
}

/* A card's last touch: the `- synced:` line hub sync writes or the `- set:` line card-set writes,
 * with its author when the line names one. */
const CARD_STAMP_RE = /- (?:synced|set): (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)(?: by ([^\n]+))?/;
export function cardStamp(text) {
  const m = CARD_STAMP_RE.exec(text || '');
  return { at: m ? m[1] : null, by: m && m[2] ? m[2].trim() || null : null };
}
/** Whole days from `ts` to now, never negative. */
export const daysSince = (ts, nowMs = Date.now()) => Math.max(0, Math.floor((nowMs - parseTs(ts).getTime()) / 86400000));

export function journalTail(project, n = 12) {
  const all = [...journalEntries()];
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
  for (const e of journalEntries()) {
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

/* Identical entries — same kind, project, author and text — folded into the newest one with
 * `times` and `firstTs`. Four of six lines in one hub_whatsnew were bookkeeping, two of them the
 * same "resource set" twice (task maple-83); an agent's context is the budget this spends.
 * Lossless for a reader: nothing distinguishes the copies but their timestamps, and both are
 * kept. Entries stay newest-first, exactly as journalSince returns them. */
export function collapseRepeats(entries) {
  const seen = new Map();
  const out = [];
  for (const e of entries) {
    const k = [e.kind, e.project, e.agent, e.text].join('\u0000');
    const cur = seen.get(k);
    if (cur) { cur.times = (cur.times || 1) + 1; cur.firstTs = e.ts; continue; }
    const copy = { ...e };
    seen.set(k, copy);
    out.push(copy);
  }
  return out;
}

export function journalSince(hours) { return journalSinceMs(Date.now() - hours * 3600000); }

/** Monthly journal entry counts for the sparkline chart.
 *  Returns [{month: "2026-01", label: "Jan", count: 42}, ...] sorted chronologically. */
export function sparklineData() {
  const months = new Map();
  for (const e of journalEntries()) {
    if (!e.ts) continue;
    const m = e.ts.slice(0, 7); // YYYY-MM
    months.set(m, (months.get(m) || 0) + 1);
  }
  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const out = [...months.entries()]
    .map(([month, count]) => ({ month, label: labels[parseInt(month.slice(5,7),10)-1] || month, count }))
    .sort((a, b) => a.month < b.month ? -1 : a.month > b.month ? 1 : 0);
  return out;
}
/* Entries at or after an absolute instant. Callers that hold an instant use this rather than
 * converting to hours and back: the round trip through floating point can land a hair past the
 * instant and drop the entry written in that very minute. */
export function journalSinceMs(cutoff) {
  const all = [];
  for (const e of journalEntries(cutoff)) {
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
  const o = readJson(path.join(HUB, 'rules.json'), {});
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
  const m = headingRe(heading).exec(String(text || ''));
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = String(text).slice(start);
  const nm = rest.match(/\n## /);
  return (nm ? rest.slice(0, nm.index) : rest).trim();
}

const headingFor = (key) => (sectionsConfig().find(s => s.key === key) || {}).heading || key;
export const isPlaceholder = (body) => !body || /^<[^>]*>$/.test(body.trim());

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
export function projectCards({ includeReserved = false } = {}) {
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

/** Find project cards that likely represent the same real project under different slugs.
 *  Compares by `path:` frontmatter field (basename) and `repo:` URL. Returns pairs of
 *  [canonical, duplicate] slugs — the canonical is the one with more journal entries.
 *  Does NOT modify anything; lint/doctor use this to warn, cards merge uses it to suggest. */
export function findProjectDuplicates() {
  const cards = projectCards({ includeReserved: false });
  const dupes = [];
  // Group by basename of the `path:` frontmatter field
  const byPath = new Map();
  const byRepo = new Map();
  for (const c of cards) {
    const pathM = c.text.match(/^- path:\s*(.+)$/m);
    const repoM = c.text.match(/^- repo:\s*(.+)$/m);
    if (pathM) {
      const base = path.basename(pathM[1].trim());
      if (!byPath.has(base)) byPath.set(base, []);
      byPath.get(base).push(c.slug);
    }
    if (repoM) {
      const repo = repoM[1].trim().replace(/\.git$/, '').toLowerCase();
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo).push(c.slug);
    }
  }
  // Collect pairs from path-based groups
  for (const [base, slugs] of byPath) {
    if (slugs.length < 2) continue;
    for (let i = 1; i < slugs.length; i++) dupes.push([slugs[0], slugs[i]]);
  }
  // Add pairs from repo-based groups (skip if already covered by path)
  for (const [repo, slugs] of byRepo) {
    if (slugs.length < 2) continue;
    for (let i = 1; i < slugs.length; i++) {
      const pair = [slugs[0], slugs[i]];
      if (!dupes.some(d => d[0] === pair[0] && d[1] === pair[1])) dupes.push(pair);
    }
  }
  return dupes;
}

/**
 * Every rule that CAN be checked, checked. Read-only, never throws, never files anything.
 * A lint appears in `findings` whether or not it is enforced; `enforced` says which ones the
 * instance opted into, so "we have a rule about that" and "the rule bites" stay distinguishable.
 */
/** The patterns of a `private` value (a regex string or a list of them) that compile, as the
 *  sensor compiles them: an invalid one is dropped there, so it must not count as declared here. */
export function validPatterns(p) {
  return (Array.isArray(p) ? p : [p]).filter(x => {
    if (typeof x !== 'string' || !x) return false;
    try { new RegExp(x, 'i'); return true; } catch { return false; }
  });
}
/** Whether the hub-wide private patterns (sense.json -> private) hold at least one that compiles. */
export function privatePatternsDeclared() {
  try { return validPatterns((JSON.parse(fs.readFileSync(path.join(HUB, 'sense.json'), 'utf8')) || {}).private).length > 0; }
  catch { return false; }
}

/* Two readers of one work queue, seen two ways.
 *   cursor  two live waiters on ONE cursor on this node. queueWait records it the moment the second
 *           one starts and clears it once one is left, so it is true now: each message goes to one
 *           of them at random, and each thinks it saw the whole queue.
 *   nodes   one role alive on two nodes at once. Every node keeps its own cursors, so there BOTH
 *           receive every message and both act on it — an orphaned session on a second node once
 *           undid a worker's tree for ten hours this way.
 * Broadcast roles (subscriber-roles.json) and owner roles have many readers by design. With a role
 * registry, only declared roles count: a free-form presence `role` is not necessarily a queue. */
export function queueReaderConflicts() {
  const out = [];
  for (const role of ((envObservations()['cursor-conflict'] || {}).values || [])) out.push({ role: String(role), how: 'cursor', nodes: [JOURNAL_NODE] });
  const skip = new Set(ownerRoles());
  for (const dir of new Set([HUB, process.env.HUBD_TEAM_DIR].filter(Boolean))) {
    try { for (const r of JSON.parse(fs.readFileSync(path.join(dir, 'subscriber-roles.json'), 'utf8'))) skip.add(r); } catch {}
  }
  const roster = roleRegistry();
  const nowMs = Date.now();
  const byRole = new Map();
  const add = (p, node) => {
    if (!p || !p.agent || !node || !presenceAlive(p, nowMs)) return;
    const role = p.role || p.agent;
    if (skip.has(role) || (roster.size && !roster.has(slugify(role)))) return;
    (byRole.get(role) || byRole.set(role, new Set()).get(role)).add(node);
  };
  for (const p of loadPresence()) add(p, p.node || JOURNAL_NODE);
  for (const sn of presenceSnapshots()) for (const p of sn.agents) add(p, sn.node);
  for (const [role, nodes] of byRole) {
    if (nodes.size > 1 && !out.some(o => o.role === role)) out.push({ role, how: 'nodes', nodes: [...nodes].sort() });
  }
  return out;
}
function readerConflictText(c) {
  return c.how === 'cursor'
    ? { what: `two live sessions wait on the work queue "${c.role}" through one cursor — each message reaches only one of them, and neither knows`,
        fix: `stop one of them, or give each its own cursor: declare "${c.role}" in subscriber-roles.json (a broadcast) and start each with its own HUBD_SUBSCRIBER` }
    : { what: `the role "${c.role}" is alive on ${c.nodes.length} nodes at once (${c.nodes.join(', ')}) — each node has its own cursor, so every order to it is carried out ${c.nodes.length} times`,
        fix: `stop the session that should not be running (hub presence --role ${c.role} shows both), or declare "${c.role}" a broadcast in subscriber-roles.json if it is meant to have many readers` };
}

export function runLint(a = {}) {
  const { strict, money } = rulesConfig();
  const findings = [];
  const notes = [];
  const gatesHeading = headingFor('gates');
  const restrict = Array.isArray(a.projects) ? a.projects.map(slugify) : null;

  // A declared law that the engine can only check approximately says so here, once, rather than
  // letting a finding imply a precision it does not have (task maple-80).
  if (rulesConfig().laws['report-at-end-only']) {
    notes.push('report-at-end-only is declared: hub audit checks it per calendar day from journal, task creation, claim and presence timestamps — heartbeats keep no history, so a session is approximated by the day.');
  }

  // (1) A gate with no date cannot expire, so it is not a gate — it is an intention. Only money
  //     bets are held to it (see rulesConfig), and silence here is reported, not implied.
  if (!money.length) {
    notes.push('gate-without-date checked nothing: no money bets are declared. List them in rules.json → money ["<slug>", ...] — the gate rule only covers those.');
  }
  for (const c of projectCards()) {
    if (restrict && !restrict.includes(c.slug)) continue;
    if (!money.includes(c.slug)) continue;
    const body = sectionBody(c.text, liveHeading(c.text, 'gates'));
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

  /* (3) A card the engine cannot check.
   *
   * The freshness checks — hub_status's digestStale, hub_brief's staleDigests, the audit's
   * card-behind-journal — all key off the card's own `- synced:`/`- set:` line, and every one of
   * them SKIPS a card that has none. On the hub this was written against, three of thirty-nine
   * cards had no digest line, and two of those were substantial: 55 and 60 lines, nine sections,
   * real content that no freshness check has ever looked at. The card reads perfectly well to a
   * person and is invisible to the instrument, which is the worst of the two states to be in,
   * because nothing ever says so.
   *
   * (4) And the degenerate case, kept separate because the remedy is different: a card that is a
   * title and nothing else (one card was one line, no sections). "Write the card" and "stamp the
   * card you already wrote" are not the same job. */
  for (const c of projectCards()) {
    if (restrict && !restrict.includes(c.slug)) continue;
    const lines = String(c.text || '').split('\n').filter(l => l.trim());
    const sections = (String(c.text || '').match(/^## /gm) || []).length;
    if (lines.length <= 2 && !sections) {
      findings.push({ id: 'card-empty', severity: 'med', project: c.slug,
        what: `${c.slug}.md is ${lines.length} line(s) with no sections — the card exists and says nothing`,
        fix: `hub card ${c.slug} -m "<what this project is and where it stands>" --by <you>` });
      continue;   // no point telling an empty card it also lacks a digest
    }
    if (!/^- (?:synced|set): /m.test(c.text)) {
      findings.push({ id: 'card-without-digest', severity: 'med', project: c.slug,
        what: `${c.slug}.md has ${lines.length} lines and ${sections} section(s) but no digest line, so every freshness check skips it silently`,
        fix: `hub card ${c.slug} -m "<what is true now>" --by <you>  (writes the "- synced:" line the checks read)` });
    }
  }

  // (5) Duplicate project cards: two slugs for the same repo or working directory.
  //     A duplicate has already sent a worker into an empty loop.
  const dupes = findProjectDuplicates();
  for (const [a, b] of dupes) {
    findings.push({ id: 'duplicate-project', severity: 'high', project: a,
      what: `${a}.md and ${b}.md likely describe the same project (same path or repo) — a worker was observed entering an empty loop on a duplicate`,
      fix: `hub cards merge ${b} ${a} --by <you>  (aliases ${b} → ${a} and archives ${b}.md)` });
  }

  /* (6) Work assigned to a name no role answers to. A task on a retired or misspelt role is open
   *     forever and nobody's: no loop waits under that name, no supervisor counts it as anyone's
   *     idle time. Owner roles and human-owned tasks are people, not roles, and are left alone.
   *     Checked only once a registry exists — before that every assignee would be "unknown". */
  const roster = roleRegistry();
  if (!roster.size) {
    notes.push('assignee-outside-roster checked nothing: no roles are declared (resource cards of type "role").');
  } else {
    const owners = new Set(ownerRoles().map(slugify));
    const orphans = new Map();
    for (const t of loadTasks().tasks.filter(t => t.status === 'open' && t.assignee)) {
      if (restrict && !restrict.includes(t.project)) continue;
      const who = slugify(t.assignee);
      if (roster.has(who) || owners.has(who) || t.owner_kind === 'human') continue;
      (orphans.get(t.assignee) || orphans.set(t.assignee, []).get(t.assignee)).push(t.id);
    }
    for (const [who, ids] of [...orphans].sort((x, y) => y[1].length - x[1].length)) {
      findings.push({ id: 'assignee-outside-roster', severity: 'low', tasks: ids,
        what: `${ids.length} open task(s) assigned to "${who}", which is neither a declared role nor an owner role: #${ids.slice(0, 8).join(', #')}${ids.length > 8 ? ' …' : ''}`,
        fix: `reassign them (hub task update <id> --assignee <role>), or declare the role: hub resource set ${slugify(who)} --type role --attr rank=worker --attr project=<slug> --by <you>` });
    }
  }

  // (7) Two live readers on one work queue — see queueReaderConflicts.
  for (const c of queueReaderConflicts()) findings.push({ id: 'two-readers-one-queue', severity: 'high', role: c.role, ...readerConflictText(c) });

  /* (8) A head that accepts branches for a repo with no private patterns to check them against.
   *     The sensor fails every such branch (a check with nothing to check with is not a pass), so
   *     this is the finding that says why before a head meets it branch by branch. */
  if (roster.size) {
    const global = privatePatternsDeclared();
    for (const h of [...roster.values()].filter(r => r.rank === 'head' && r.status !== 'off' && r.attrs && r.attrs.repo)) {
      if (global || validPatterns(h.attrs.private).length) continue;
      if (restrict && !(h.project && restrict.includes(h.project))) continue;
      findings.push({ id: 'private-check-undeclared', severity: 'high', role: h.role, project: h.project || undefined,
        what: `head ${h.role} accepts branches of ${h.attrs.repo}, and no private pattern that compiles is declared (an invalid regex is dropped) — the sensor fails every branch until one is`,
        fix: `declare them as data: "private": ["<regex>", ...] in the hub's sense.json (every head), or hub resource set ${h.role} --attr private='<regex>' --by <you> (this head)` });
    }
  }

  const LINT_DEFAULTS = {
    'gate-without-date': 'A gate is a date plus a criterion; without a date it is an intention.',
    'two-readers-one-queue': 'A work queue has one reader per cursor; a second one silently takes half the orders.',
    'button-without-prep': 'Work only the owner can do splits into prep (an agent) and the button (the owner).',
    'card-empty': 'A card is what a session reads before it acts; a title is not a card.',
    'card-without-digest': 'A card no check can read is unchecked, however well it reads to a person.',
    'duplicate-project': 'Two slugs for the same project split its history and tasks between two cards — a worker was seen entering an empty loop.',
    'assignee-outside-roster': 'The role registry is the only source of role names; work assigned to any other name is nobody\'s.',
    'private-check-undeclared': 'What counts as private is data the owner declares; a check that has none passes nothing.',
  };
  for (const f of findings) {
    const law = lawFor(f.id, LINT_DEFAULTS[f.id] || f.id);
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
  'owner-backlog': 'A decision only the owner can make is either made or withdrawn; carrying it is the third option nobody chose.',
  'report-at-end-only': 'A finding is written as FACT: at the moment of the finding; a report that lies entirely in the last minutes of a session is the findings that were not.',
  'work-without-journal': 'Commits without a journal are work nobody else can build on; the repository knows what changed, only the journal knows what was learned.',
  'two-readers-one-queue': 'A work queue has one reader; a second one either takes half the orders unseen or carries out every order twice.',
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
  /* A YEAR of journal, read only if something can use it. Nothing below consults decisionsSince
   * unless a money bet is declared, and `money` is empty until someone declares one — so on an
   * undeclared hub this scan cost 460 of the 472ms runAudit took and answered no question at all.
   * That mattered the moment the audit started riding on hub_brief: the price of a check that
   * checks nothing is paid by every call that carries it. */
  const decisionsSince = {};
  if (money.length) {
    for (const e of journalSince(365 * 24)) {
      if (e.kind === 'decision' && e.project) {
        const cur = decisionsSince[e.project];
        if (!cur || parseTs(cur).getTime() < parseTs(e.ts).getTime()) decisionsSince[e.project] = e.ts;
      }
    }
  }
  for (const c of cards) {
    if (!money.includes(c.slug)) continue;
    const body = sectionBody(c.text, liveHeading(c.text, 'gates'));
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
  const windowAll = journalSince(days * 24);
  const windowEntries = windowAll.filter(e => e.project);
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
    const touched = cardStamp(c.text).at;
    if (!touched) continue;
    const lag = digestLag(touched, lastJournal[c.slug], 14);
    if (lag) findings.push({ id: 'card-behind-journal', key: `card-behind-journal:${c.slug}`, severity: 'med', project: c.slug,
      what: `${c.slug}: card last touched ${touched}, its journal moved on ${lag.daysBehind}d further (to ${lag.lastJournal})`,
      fix: `re-sync the digest: hub card ${c.slug} -m "<what is true now>" --by <you>` });
  }

  // (5) Orphans.
  for (const t of open.filter(t => !t.project)) {
    findings.push({ id: 'task-without-project', key: `task-without-project:${t.id}`, severity: 'low', task: t.id,
      what: `#${t.id} has no project`, fix: 'assign one, or close it' });
  }

  /* (6) The owner's own backlog — ONE finding, not one per task. Thirty-one separate incidents
   * saying "the owner has not decided this" is a backlog about a backlog, and the reader it needs
   * is the person it would be shouting at. Keyed on the oldest item, so a weekly run refiles only
   * when the oldest one changes — which is exactly when something actually moved. */
  const waiting = ownerWaiting(tasks, { today, limit: 5 });
  if (waiting.count && (waiting.oldestDays ?? 0) >= staleButtonDays) {
    findings.push({ id: 'owner-backlog', key: `owner-backlog:${waiting.items[0] ? waiting.items[0].id : 'none'}`,
      severity: waiting.overdue ? 'high' : 'med',
      what: `${waiting.count} open task(s) only the owner can move, oldest ${waiting.oldestDays}d` +
        (waiting.overdue ? `, ${waiting.overdue} past its deadline` : '') +
        (waiting.unknownAge ? ` (${waiting.unknownAge} with no created stamp)` : ''),
      fix: 'hub agenda shows them as ownerButtons — decide, delegate or close; an unanswered one decides by default' });
  }

  /* (7) The end-of-session dump. Two days of audit work, dozens of findings, and not one journal
   * line until 08:38 on the third morning — not laziness, ritual: the protocol said "ONE report at
   * session end", and fleet sessions compact rather than end, so the moment never came and the
   * findings left with the context (task maple-80). Computable from timestamps alone: an
   * agent's structured entries for a day all fall within two minutes at the END of a trace that is
   * at least half an hour long. The trace is every timestamp the hub holds for that agent that
   * day — journal lines of any kind, tasks it created, claims it took, its presence record.
   * Heartbeats keep no history, so "session" is approximated by the calendar day; the notes say so.
   * A thermometer, never a gate: nothing is blocked, and --apply files one incident per (agent, day). */
  const ACT_KINDS = new Set(['decision', 'done', 'note', 'broken', 'blocked']);
  const sinceMs = nowMs - days * 86400000;
  const dayOf = (ts) => String(ts || '').slice(0, 10);
  const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
  const trace = new Map();
  let extraSignals = 0;
  const addPoint = (agent, ts, structured) => {
    if (!agent || !ts) return;
    const ms = parseTs(ts).getTime();
    if (!Number.isFinite(ms) || ms < sinceMs) return;
    const k = agent + '|' + dayOf(ts);
    let t = trace.get(k);
    if (!t) trace.set(k, t = { agent, day: dayOf(ts), points: [], structured: [] });
    t.points.push(ms);
    if (structured) t.structured.push(ms); else extraSignals++;
  };
  for (const e of windowAll) addPoint(e.agent, e.ts, ACT_KINDS.has(e.kind));
  for (const ev of readTaskEvents()) if (ev.ev === 'add' && ev.t && ev.t.by) addPoint(ev.t.by, ev.ts, false);
  for (const c of (loadClaims().claims || [])) addPoint(c.agent, c.since, false);
  for (const p of loadPresence()) addPoint(p.agent, p.last_seen, false);
  for (const t of trace.values()) {
    if (t.structured.length < 3) continue;
    const s = [...t.structured].sort((x, y) => x - y), p = [...t.points].sort((x, y) => x - y);
    const spanMin = (p[p.length - 1] - p[0]) / 60000, burstMin = (s[s.length - 1] - s[0]) / 60000;
    if (spanMin < 30 || burstMin > 2 || s[0] < p[p.length - 1] - 2 * 60000) continue;
    findings.push({ id: 'report-at-end-only', key: `report-at-end-only:${t.agent}:${t.day}`, severity: 'med', agent: t.agent,
      what: `${t.agent} on ${t.day}: ${s.length} structured entries, all within ${Math.max(1, Math.ceil(burstMin))} min at the end of a ${Math.round(spanMin)}-min trace (first activity ${hhmm(p[0])}, last ${hhmm(p[p.length - 1])} UTC)`,
      fix: 'write FACT:/DECIDE: at the moment of the finding — a compacting session never reaches "the end"; after a compaction resume from hub_context, not from memory' });
  }
  notes.push(extraSignals
    ? 'report-at-end-only: traces are journal lines + task creations + claims + presence records; heartbeats keep no history, so a session is approximated by the calendar day.'
    : `report-at-end-only: no task creations, claims or presence records in ${days}d — traces are journal-only, and a session is approximated by the calendar day.`);

  /* (8) Work that left no journal. The weaker signal: a project whose local checkout gained commits
   * in the window while its journal gained nothing. Only checkable where the card's recorded
   * `- path:` exists on THIS node with a .git — elsewhere the check says it checked nothing. Never on
   * a remote transport: a card's `- path:` is tenant-written text, and this runs git in it. */
  if (a.git !== false && a.local !== false) {
    let checked = 0;
    const gitDays = Math.max(1, parseInt(days, 10) || 7);
    for (const c of cards) {
      const p = (c.text.match(/^- path: (.+)$/m) || [])[1];
      if (!p || checked >= 20) continue;
      const dir = p.trim();
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      checked++;
      const commits = sh(`git log --since="${gitDays} days ago" --format=%h`, dir).split('\n').filter(Boolean).length;
      if (commits >= 5 && !(share[c.slug] > 0)) {
        findings.push({ id: 'work-without-journal', key: `work-without-journal:${c.slug}`, severity: 'med', project: c.slug,
          what: `${c.slug}: ${commits} commit(s) in ${dir} over ${gitDays}d and not one journal entry`,
          fix: `the work happened — say what was learned: hub report -p ${c.slug} with FACT:/DECIDE: lines, as you go` });
      }
    }
    if (!checked) notes.push('work-without-journal checked nothing: no card records a local `- path:` with a git checkout on this node.');
  }

  // (9) Two readers of one work queue (queueReaderConflicts): declared one reader, observed two.
  for (const c of queueReaderConflicts()) {
    findings.push({ id: 'two-readers-one-queue', key: `two-readers-one-queue:${c.role}:${c.how}`, severity: 'high', role: c.role, ...readerConflictText(c) });
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

/* ── The audit rides on traffic it does not generate ──
 *
 * roles/auditor.md has existed for months and has never been run once. hub_lint and hub_audit both
 * work; nothing calls them, because calling them is a separate decision somebody has to remember to
 * make, and the whole class of thing they catch is the class nobody remembers. A check that depends
 * on being remembered checks nothing.
 *
 * So the findings ride on the two calls a session already makes — hub_brief at the start, and
 * hub_whatsnew on return. Top few only, each quoting the rule it enforces with the date that rule
 * was written, exactly as the filed incidents do: an engine's opinion carries no weight, the
 * reader's own past decision does.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — and the spec asked for it — is file anything. The proposal
 * was that a finding older than seven days should be applied automatically under the author
 * `auditor-ambient`, one incident per key. That is an agent writing a record that claims a
 * verdict nobody reached, which is the same move as "acknowledged in version X" that this project
 * bans in so many words. A finding that has sat for a week is not thereby decided; it is a finding
 * that has sat for a week, and saying so is the whole of what an instrument may do here.
 * `hub audit --apply` still files, from a human's or an agent's explicit call, with their name on
 * it. That is the difference between a report and a forgery.
 *
 * Read-only. Never throws: it is a passenger on someone else's call, and a passenger that can
 * crash the vehicle is not worth carrying. */
export function runReview(a = {}) {
  const limit = Number.isFinite(a.limit) ? Math.max(0, a.limit) : 3;
  const rank = { high: 0, med: 1, low: 2 };
  let all = [], lintTotal = 0, auditTotal = 0, notes = [];
  try {
    const l = runLint({});
    lintTotal = l.findings.length;
    all = all.concat(l.findings.map(f => ({ ...f, from: 'lint' })));
  } catch (e) { notes.push('lint failed: ' + (e && e.message ? e.message : String(e))); }
  try {
    // `queues` comes from the caller for the same reason runAudit takes it there: queue.mjs
    // imports this file. Without rows the stale-button check is skipped, and runAudit says so in
    // its own notes rather than reading as "no buttons are stale".
    const r = runAudit({ apply: false, days: a.days, queues: a.queues, local: a.local });
    auditTotal = r.findings.length;
    all = all.concat(r.findings.map(f => ({ ...f, from: 'audit' })));
  } catch (e) { notes.push('audit failed: ' + (e && e.message ? e.message : String(e))); }
  all.sort((x, y) => (rank[x.severity] ?? 3) - (rank[y.severity] ?? 3));
  /* One per KIND, not the first N by severity. The plain top-3 filled itself with three copies of
   * button-without-prep — same rule, same wording, three different task numbers — and pushed two
   * other kinds of problem off the list entirely. A reader given three instances of one rule learns
   * less than one given three rules, so each kind appears once with its remaining count beside it. */
  const byId = new Map();
  for (const f of all) if (!byId.has(f.id)) byId.set(f.id, f);
  const top = [...byId.values()].slice(0, limit).map(f => ({
    from: f.from, id: f.id, severity: f.severity, what: f.what, fix: f.fix,
    law: f.law, lawSince: f.lawSince || null, lawDeclared: !!f.lawDeclared,
    project: f.project || null, task: f.task || null, role: f.role || null,
    alsoLikeThis: all.filter(x => x.id === f.id).length - 1,
  }));
  return {
    total: all.length, kinds: byId.size, lint: lintTotal, audit: auditTotal, shown: top.length,
    findings: top, notes,
    // Stated, not implied: the caller sees a short list and must not read it as the whole list.
    hint: all.length > top.length
      ? `${all.length - top.length} more finding(s)` +
        (byId.size > top.length ? ` in ${byId.size - top.length} further kind(s)` : ' of the kinds above') +
        ' — hub lint / hub audit for all of them'
      : null,
  };
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
/* A plan entry is [key, limit] or [key, limit, opts], and opts are what make a DEFAULT view compact
 * rather than merely capped (hub_get, hub_whatsnew, hub_task_list came to 6-11k tokens a call on a
 * live hub):
 *   keep: 'tail'  — the list is oldest-first and its END is the news (a journal tail): cut from
 *                   the front, here and in the over-budget passes alike;
 *   textMax: N    — each item's `text` is cut to N chars, and the note says how many were;
 *   drop: [keys]  — bookkeeping fields no reader of the view acts on;
 *   dropEmpty     — null, '' and [] fields are left out: an absent key says the same, for less.
 * `full: true` still bypasses all of it. */
export function capOutput(obj, plan = [], { full = false, maxChars = OUTPUT_BUDGET_CHARS, indent = 1 } = {}) {
  if (full || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  const truncated = {};
  const totals = {};
  const textCut = {};
  const note = (key, arr) => { truncated[key] = { shown: arr.length, hidden: totals[key] - arr.length, ...textCut[key] }; };
  const cut = (arr, n, opts) => opts?.keep === 'tail' ? (n > 0 ? arr.slice(-n) : []) : arr.slice(0, n);
  const slim = (key, arr, { textMax, drop, dropEmpty } = {}) => {
    if (!textMax && !drop && !dropEmpty) return arr;
    let n = 0;
    const res = arr.map(it => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
      const c = { ...it };
      for (const k of drop || []) delete c[k];
      if (dropEmpty) for (const [k, v] of Object.entries(c)) if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete c[k];
      if (textMax && typeof c.text === 'string' && c.text.length > textMax) { c.text = c.text.slice(0, textMax - 1) + '…'; n++; }
      return c;
    });
    if (n) textCut[key] = { textCut: n, textMax };
    return res;
  };
  /* A long STRING was invisible to this budget, and it is the one payload a caller cannot page
   * through: hub_get returns the card as one field, and a 72 KB card therefore left here whole and
   * was refused by the caller's context — the tool could not deliver its own data (task
   * maple-111). Cut from the head, which is the right end for a card: frontmatter, digest and
   * next step come first, and the accumulated tail is what a reader can do without. */
  const noteStr = (key, s) => { truncated[key] = { shownChars: s.length, hiddenChars: totals[key] - s.length,
    hint: `read the rest with full: true, or open the file` }; };

  const opts = Object.fromEntries(plan.map(([key, , o]) => [key, o || {}]));
  for (const [key, limit] of plan) {
    const v = out[key];
    if (typeof v === 'string') {
      totals[key] = v.length;
      if (v.length > limit) { out[key] = v.slice(0, limit); noteStr(key, out[key]); }
      continue;
    }
    if (!Array.isArray(v)) continue;
    totals[key] = v.length;
    out[key] = slim(key, v.length > limit ? cut(v, limit, opts[key]) : v, opts[key]);
    if (v.length > limit || textCut[key]) note(key, out[key]);
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
      if (typeof arr === 'string') {
        // Same quarter-at-a-time walk, never below a head that still answers "what is this".
        const strFloor = floor ? 2000 : 500;
        while (arr.length > strFloor && size() > budget) {
          arr = arr.slice(0, Math.max(strFloor, arr.length - Math.max(1, Math.ceil(arr.length / 4))));
          out[key] = arr;
          noteStr(key, arr);
        }
        continue;
      }
      if (!Array.isArray(arr)) continue;
      while (arr.length > floor && size() > budget) {
        arr = cut(arr, Math.max(floor, arr.length - Math.max(1, Math.ceil(arr.length / 4))), opts[key]);
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
      // A string is cut by characters and a list by items, and the note says which: the string
      // branch once printed "card: undefined shown, undefined hidden" here.
      Object.entries(truncated).map(([k, v]) => v.shownChars != null
        ? `${k}: ${v.shownChars} chars shown, ${v.hiddenChars} hidden`
        : `${k}: ${v.shown} shown, ${v.hidden} hidden` + (v.textCut ? `, ${v.textCut} text(s) cut to ${v.textMax} chars` : '')).join(' · ') +
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
  // `defaultHeading` survives the override: a card written before sections.json existed (or on a
  // node with another locale) carries the English heading, and a writer that only knows the local
  // one used to miss it and start a second section beside it (task maple-112). `aliases` is
  // for headings an instance DECLARES as the same section — never guessed, because a hand-written
  // section that merely looks similar may hold something else.
  const cfg = SECTIONS_DEFAULT.map(s => ({ ...s, defaultHeading: s.heading, aliases: [] }));
  for (const fname of ['sections.json', 'report-sections.json']) {   // report-sections.json = deprecated alias
    try {
      const f = path.join(HUB, fname);
      if (!fs.existsSync(f)) continue;
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const s of cfg) {
        const ov = o[s.key];
        if (typeof ov === 'string') s.heading = ov;
        else if (ov && typeof ov === 'object') {
          if (ov.heading) s.heading = ov.heading;
          if (ov.hint) s.hint = ov.hint;
          if (Array.isArray(ov.aliases)) s.aliases = ov.aliases.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
        }
      }
      return cfg;   // first file found wins (sections.json preferred)
    } catch {}
  }
  return cfg;
}

/** Every heading that means section `key`, most preferred first: configured, default, aliases. */
export function sectionHeadings(key) {
  const s = sectionsConfig().find(x => x.key === key);
  if (!s) return [];
  const seen = new Set(), out = [];
  for (const h of [s.heading, s.defaultHeading, ...s.aliases]) {
    const k = h.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(h); }
  }
  return out;
}

const headingRe = (heading) => new RegExp('^## ' + escRe(heading) + '[ \\t]*$', 'mi');
/** Is "## heading" in this text — case-insensitive, trailing blanks ignored, like every writer here. */
export function hasHeading(text, heading) { return headingRe(heading).test(String(text || '')); }

/** The heading section `key` actually lives under in THIS card, or the configured one to create. */
export function liveHeading(text, key) {
  const all = sectionHeadings(key);
  for (const h of all) {
    const m = headingRe(h).exec(String(text || ''));
    if (m) return m[0].slice(3).trim();
  }
  return all[0] || key;
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
function readEnvState() { return readJson(envStateFile(), {}); }
function writeEnvState(obj) { if (READ_ONLY) return; try { atomicWrite(envStateFile(), JSON.stringify(obj, null, 1)); } catch {} }
/** The recorded environment observations, {kind: {values, at}} — read-only (hub gc prunes the stale ones). */
export function envObservations() { return readEnvState().observations || {}; }

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
 * on disk. ensureProtocol runs on every writing CLI invocation, so the first such call after
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

  /* Can this process write its own hub at all. A shared fleet hub is written by several users
   * (roles under one account, mesh-sync under root), and a directory that arrives through a git
   * pull carries the puller's ownership — so an agent can find itself able to READ everything and
   * write nothing, which every command then reports as an empty, healthy hub. Cheap: one access
   * check per top-level directory, and only the unwritable ones are named. */
  const unwritable = [];
  for (const d of [HUB, PROJ, RESOURCES, PRESENCE, path.join(HUB, 'queues'), path.join(HUB, '.qstate')]) {
    if (!fs.existsSync(d)) continue;
    try { fs.accessSync(d, fs.constants.W_OK); } catch { unwritable.push(d); }
  }
  if (unwritable.length) {
    out.push({
      id: 'hub-not-writable', severity: 'high', actor: 'operator',
      what: `This process cannot write ${unwritable.length === 1 ? 'a directory' : 'directories'} of its own hub: ${unwritable.join(', ')}. Reads succeed, so the hub looks healthy while nothing you write is kept — and a queue whose cursor cannot be advanced answers "nothing new" forever.`,
      remedy: `Fix the ownership of the hub directory for the user this process runs as. On a shared fleet node: chgrp -R <group> "${HUB}" && chmod -R g+rwX "${HUB}". Directories created by a git pull as another user are the usual source.`,
    });
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

  const shared = ((st.observations || {})['subscriber-shared'] || {}).values || [];
  if (shared.length) {
    out.push({
      id: 'subscriber-shared', severity: 'med', actor: 'agent+restart',
      what: `Two live sessions waited under one subscriber id: ${shared.join(', ')}. A broadcast then splits between them — each sees only part of it.`,
      remedy: 'Give each session its own reader name: HUBD_SUBSCRIBER (or HUBD_SESSION) in that client\'s hubd env, or `--as <name>` on the CLI. The id falls back to HUBD_AGENT, which every session on one machine shares.',
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

/** Session records older than `days` (hub gc): counted, and dropped with `apply`. */
export function staleEnvSessions({ days = 7, apply = false } = {}) {
  const st = readEnvState(), keep = {}, cutoff = Date.now() - days * 86400000;
  let stale = 0;
  for (const [sid, rec] of Object.entries(st.sessions || {})) {
    const at = rec && rec.at ? new Date(rec.at).getTime() : 0;
    if (at && at >= cutoff) keep[sid] = rec; else stale++;
  }
  if (apply && stale) { st.sessions = keep; writeEnvState(st); }
  return stale;
}

/* Everything in a hub that belongs to ONE node and must never travel by mesh-sync (which runs a
 * plain `git add -A`). One list, written to two places:
 *
 *   .gitignore         — `hub init` creates it with these lines, or completes an existing one with
 *                        the lines it lacks. Explicitly, and only there: the file is TRACKED.
 *   .git/info/exclude  — completed by every writing command (ensureProtocol), by `hub freeze` and
 *                        by the life braid. Untracked, so it never travels and never conflicts.
 *
 * The exclude file is the half that keeps a node safe. init used to write .gitignore only when it
 * created it, so a hub made before a line existed never got it — and `.mesh-freeze` was such a
 * line: a manual `git add -A` in a frozen hub committed the marker, the next sync carried it to a
 * peer, and the peer froze too. The repair then went too far the other way: every hub run appended
 * the lines .gitignore lacked, which is a change to a tracked file on a read — and on a mixed
 * rollout two nodes appended different lines to the same end of the file, a content conflict that
 * stops both syncs. Locks, tmp files and the task cache are here because `git add -A` would
 * otherwise commit a live lock with everything else. */
export const HUB_GITIGNORE = ['.qstate/', 'HUBD.md', 'presence/', '.env-state.json', '.checkins.json', '.mesh-freeze', '.sense/', '.watch/',
  'journal.life.jsonl', 'tasks.json', 'claims.json', '*.lock', '*.tmp.*'];

/* `hub freeze`: the node-local marker scripts/mesh-sync.sh checks before every run. */
export const freezeFile = () => path.join(HUB, '.mesh-freeze');
/** The marker's record: null when this node is not frozen, {} when the marker cannot be read. */
export function readFreeze() {
  if (!fs.existsSync(freezeFile())) return null;
  return readJson(freezeFile(), {});
}
export function ensureGitignored(entry) {
  const gi = path.join(HUB, '.gitignore');
  let g = ''; try { g = fs.readFileSync(gi, 'utf8'); } catch {}
  if (new RegExp('^' + escRe(entry) + '$', 'm').test(g)) return false;
  try { fs.appendFileSync(gi, (g && !g.endsWith('\n') ? '\n' : '') + entry + '\n'); return true; } catch { return false; }
}
/** The exclude file of the hub's OWN repository: null when the hub is not one (no .git directory
 *  in it — a plain folder, or a folder inside another checkout, whose exclude is not the hub's). */
function localExcludeFile() {
  try { return fs.statSync(path.join(HUB, '.git')).isDirectory() ? path.join(HUB, '.git', 'info', 'exclude') : null; } catch { return null; }
}
const fileLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()); } catch { return []; } };
/** Add the node-local lines .git/info/exclude lacks. Returns the lines added ([] when none were
 *  missing), or null when the hub is not its own repository and there is nothing to add them to. */
export function ensureLocalIgnores() {
  const ex = localExcludeFile();
  if (!ex) return null;
  const have = fileLines(ex);
  const add = HUB_GITIGNORE.filter(e => !have.includes(e));
  if (!add.length) return [];
  let cur = ''; try { cur = fs.readFileSync(ex, 'utf8'); } catch {}
  try {
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    fs.appendFileSync(ex, (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  } catch { return []; }
  return add;
}
/** Node-local lines that neither the shared .gitignore nor this node's exclude file has — what a
 *  plain `git add -A` here would commit. Read-only; [] when the hub is not its own repository. */
export function unignoredNodeLocal() {
  const ex = localExcludeFile();
  if (!ex) return [];
  const have = [...fileLines(path.join(HUB, '.gitignore')), ...fileLines(ex)];
  return HUB_GITIGNORE.filter(e => !have.includes(e));
}
/** Node-local lines the shared .gitignore lacks — `hub init` completes it, on purpose, once. */
export function gitignoreMissing() {
  if (!localExcludeFile()) return [];
  const have = fileLines(path.join(HUB, '.gitignore'));
  return HUB_GITIGNORE.filter(e => !have.includes(e));
}
/** Node-local paths that git TRACKS anyway — ignoring a file does not untrack it, so these travel
 *  whatever .gitignore says. */
export function trackedNodeLocal() {
  if (!fs.existsSync(path.join(HUB, '.git'))) return [];
  return HUB_GITIGNORE.filter(e => sh(`git ls-files -- "${e.replace(/\/$/, '')}"`, HUB).trim());
}

/* What a writing command does to a hub before it runs: its directories, the node-local ignore
 * lines in .git/info/exclude (HUB_GITIGNORE says why there and not .gitignore), and HUBD.md when
 * the installed version changed. Read-only commands never call it (cli.mjs). It used to also unlink
 * every .tmp.* older than a minute, which made `hub gc` list none: the dry run deleted them before
 * looking. Stale tmp files are gc's litter class now, removed with --apply like the rest. */
export function ensureProtocol(force) {
  try {
    fs.mkdirSync(HUB, { recursive: true });
    ensureHubDirs();
    ensureLocalIgnores();
  } catch {}
  const body = shippedProtocol();
  if (body == null) return { ok: false };
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

  const lim = cardLimits();
  if (a.digest) assertDigestSize(String(a.digest).trim(), lim);
  if (a.digest && oldDigest && a.digest.trim() !== oldDigest) {
    appendHistory(slug, `\n---\n### until ${now()} (sync by ${author})\n${oldDigest}\n`);
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
  const rot = rotateCardOverflow(card, slug, author, lim);
  atomicWrite(cardPath(pname), rot.text);
  const diffText = hasNew ? ` (${diff.newCommits} new commits, +${diff.insertions || 0}/-${diff.deletions || 0})` : '';
  journalAppend({ ts: now(), project: slug, agent: author, kind: 'sync', text: 'synced' + (a.digest ? ' with digest' : '') + diffText });
  return { ok: true, project: slug, card: cardPath(pname), gitSeen: !!git, newCommits: hasNew ? diff.newCommits : 0, metrics,
    ...(rot.moved.length ? { rotated: rot.moved } : {}),
    hint: a.digest ? undefined : 'Card kept old/empty digest — pass digest="..." to write your summary.' };
}

// Create or update a project card from just (project, digest) — no folder needed.
// Unlike runSync (which reads a real git folder), this lets harvest/triage capture
// projects that are not a local checkout. Preserves hand-written frontmatter and a
// "## Facts" section; archives a changed digest to history.
/* Patch a digest instead of replacing it. A digest is typically two things braided together:
 * the owner's strategic frame ("NEW TRACK — lane A, gate #87 …") and a few lines of fact ("v17",
 * "156-item instrument"). The facts go stale in a week; the frame is not an agent's to rewrite.
 * hub_card_set replaced the whole text, so the agent who knew v17 had become v19 left the digest
 * alone rather than touch the frame — and hub_context kept handing the next session a four-month
 * old state (task maple-81). `replace: [{from, to}]` edits exactly the lines named;
 * `appendLine` adds one. A `from` that is not there is an ERROR, not a no-op: a patch that
 * silently changed nothing is how a digest stays wrong while its author believes it fixed. */
function patchDigest(oldDigest, { replace = [], appendLine } = {}) {
  let text = String(oldDigest || '');
  if (!text.trim()) throw new Error('nothing to patch: the card has no digest yet — pass digest instead');
  const applied = [];
  for (const r of Array.isArray(replace) ? replace : []) {
    const from = String(r && r.from != null ? r.from : ''), to = String(r && r.to != null ? r.to : '');
    if (!from) throw new Error('replace: each item needs a non-empty `from`');
    const at = text.indexOf(from);
    if (at === -1) throw new Error(`replace: "${from.slice(0, 60)}" is not in the digest — nothing changed. The digest reads:\n${text}`);
    if (text.indexOf(from, at + 1) !== -1) throw new Error(`replace: "${from.slice(0, 60)}" occurs more than once in the digest — quote more of the line so the patch is unambiguous`);
    text = text.slice(0, at) + to + text.slice(at + from.length);
    applied.push({ from, to });
  }
  if (appendLine != null && String(appendLine).trim()) { text = text.replace(/\s*$/, '') + '\n' + String(appendLine).trim(); applied.push({ appendLine: String(appendLine).trim() }); }
  if (!applied.length) throw new Error('patch: pass replace: [{from, to}] and/or appendLine');
  return { text: text.trim(), applied };
}

export function runCardSet(a) {
  const author = requireAuthor(a.by, 'by');
  const pname = a.project || a.name;
  if (!pname) throw new Error('project required');
  const patching = (Array.isArray(a.replace) && a.replace.length) || (a.appendLine != null && String(a.appendLine).trim());
  if (patching && a.digest && String(a.digest).trim()) throw new Error('pass either digest (replace the whole text) or replace/appendLine (patch it), not both');
  if (!patching && (!a.digest || !String(a.digest).trim())) throw new Error('digest required (or replace: [{from, to}] / appendLine to patch the existing one)');
  const slug = slugify(pname);
  const prev = readCard(pname);
  const oldDigest = digestOf(prev);
  /* A dated line is an event, and an event belongs in the journal. This is how a snapshot turns
   * into a log one honest-looking line at a time: 57 dated lines had accumulated in one card, each
   * of them a hub_report that was never filed, and the card then answered "what is true now" with
   * three weeks of history. Refused at the door, naming where the text goes. */
  if (a.appendLine != null && /^\s*[-*+]?\s*(?:\d{4}-\d{2}-\d{2}|\d{2}[./]\d{2}[./]\d{2,4})\b/.test(String(a.appendLine))) {
    throw new Error('appendLine starts with a date, so it is an event, not state: file it with hub_report ' +
      '(FACT: / DECIDE: / COMM:), which writes the right card section AND the journal. ' +
      'A card is the snapshot — "what is true now" — and a dated line is what makes it stop being one.');
  }
  let digest, patched = null;
  if (patching) { patched = patchDigest(oldDigest, a); digest = patched.text; }
  else digest = String(a.digest).trim();
  const lim = cardLimits();
  assertDigestSize(digest, lim);
  if (oldDigest && digest !== oldDigest) {
    appendHistory(slug, `\n---\n### until ${now()} (card set by ${author})\n${oldDigest}\n`);
  }
  const preserved = cardPreservedSections(prev, new Set(['## Digest']));
  const ownerBody = prev ? preserved : cardScaffold();   // new card → scaffold template; existing → keep its sections verbatim
  const card = cardFrontmatter(prev) +
    `# ${pname}\n\n` +
    `- slug: ${slug}\n- set: ${now()} by ${author}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (ownerBody ? ownerBody + '\n' : '');
  const rot = rotateCardOverflow(card, slug, author, lim);
  atomicWrite(cardPath(pname), rot.text);
  journalAppend({ ts: now(), project: slug, agent: author, kind: 'note',
    text: (patched ? 'card patched: ' + patched.applied.map(p => p.appendLine ? '+ ' + p.appendLine.slice(0, 40) : `"${p.from.slice(0, 30)}" -> "${p.to.slice(0, 30)}"`).join('; ')
                   : 'card set: ' + digest.split('\n')[0].slice(0, 80)).slice(0, 160) });
  return { ok: true, project: slug, card: cardPath(pname), bytes: Buffer.byteLength(digest, 'utf8'),
    ...(patched ? { patched: patched.applied, digest } : {}), ...(rot.moved.length ? { rotated: rot.moved } : {}) };
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
  /* Open attributes: a role card needs repo / base / plan / idle_min, which no fixed list could
   * anticipate. One line per key in the frontmatter, the same place the fixed ones live, so a
   * reader (and grep) sees every attribute of the card in one block. An empty value removes the
   * key. `kind` is the card class, not an attribute, and a value may not break the line it sits
   * on — the frontmatter is parsed one line per key. */
  if (a.attrs && typeof a.attrs === 'object') {
    for (const [k, v] of Object.entries(a.attrs)) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || k === 'kind') throw new Error(`attribute name "${k}" — lowercase letters, digits and _ only, and not "kind"`);
      const val = v == null ? '' : String(v);
      if (/[\r\n]/.test(val)) throw new Error(`attribute ${k}: one line only`);
      if (val === '') { const i = pairs.findIndex(p => p.key === k); if (i !== -1) pairs.splice(i, 1); }
      else set(k, val);
    }
  }
  if (a.edges) for (const rel of Object.keys(a.edges)) {
    const targets = new Set(extractLinks((pairs.find(p => p.key === rel) || {}).value || ''));
    for (const t of a.edges[rel]) targets.add(slugify(t));
    set(rel, [...targets].map(s => `[[${s}]]`).join(', '));
  }
  const oldDigest = prev ? digestOf(prev) : null;
  const digest = (a.digest != null && String(a.digest).trim()) || oldDigest || '<what this is, in one line>';
  if (prev && oldDigest && a.digest != null && String(a.digest).trim() && String(a.digest).trim() !== oldDigest) {
    appendHistory('resource-' + slug, `\n---\n### until ${now()} (resource set by ${author})\n${oldDigest}\n`);
  }
  const preserved = cardPreservedSections(prev, new Set(['## Digest']));
  const card = frontToText(pairs) +
    `# ${name}\n\n` +
    `- slug: ${slug}\n- set: ${now()} by ${author}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (preserved ? preserved + '\n' : '');
  // A set that changes nothing is not an event. The same resource was "set" twice in ten hours
  // with byte-identical content, and both lines sat in the next agent's hub_whatsnew where two
  // real entries were (task maple-83). Compared with the set-stamp masked, because that is
  // the only line this write would have changed; the file is left alone too, so the mesh does not
  // carry a commit whose whole content is a new timestamp.
  const stripStamp = (s) => String(s || '').replace(/^- set: .*$/m, '- set: <stamp>');
  if (prev && stripStamp(card) === stripStamp(prev)) return { ok: true, resource: slug, card: resourcePath(name), unchanged: true };
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

/* ── Roles: who works under whom ──
 *
 * The hub knew every role only by what it wrote — a presence record, a journal author, a queue
 * file — and never what the role IS: which project it serves, which head it answers to, which repo
 * that head accepts branches into. That lived in the fleet's own tooling, so every judgement about
 * a track (is this worker idle, whose branch is this, which rows belong on one board) had to be
 * made outside the hub, against a table the hub could not see.
 *
 * A role is a resource card of type `role`, because cards already travel the mesh one file per
 * slug and already carry typed links:
 *
 *   type: role          rank: head | worker | fleet (a fleet-level coordinator above the heads)
 *   project: <slug>     head: [[<head role>]]  (a worker's head)
 *   status: live | off  and any attribute the tooling needs (repo, base, plan, idle_min ...)
 *
 * The registry is whatever cards exist; an empty registry means "not declared", and every reader
 * treats it that way rather than calling every role unknown. */
export function roleRegistry() {
  const roles = new Map();
  let files = [];
  try { files = fs.readdirSync(RESOURCES).filter(f => f.endsWith('.md')); } catch { return roles; }
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(path.join(RESOURCES, f), 'utf8'); } catch { continue; }
    const attrs = {}; for (const p of parseFront(text)) attrs[p.key] = p.value;
    if (attrs.type !== 'role') continue;
    const name = f.replace(/\.md$/, '');
    const link = (v) => (extractLinks(v || '')[0] || (v ? slugify(v) : null));
    const idle = parseInt(attrs.idle_min, 10);
    roles.set(name, {
      role: name, rank: attrs.rank || 'worker', project: link(attrs.project), head: link(attrs.head),
      status: attrs.status || 'live', node: link(attrs.runs_on), idleMin: Number.isFinite(idle) ? idle : null,
      attrs,
    });
  }
  return roles;
}

/** A head and the roles that answer to it, from the registry. `off` workers are listed with
 *  their status: a switched-off worker is part of the track, not missing from it. */
export function headConf(head) {
  const roles = roleRegistry();
  const me = roles.get(slugify(head));
  if (!me) return null;
  const workers = [...roles.values()].filter(r => r.head === me.role).sort((x, y) => (x.role < y.role ? -1 : 1));
  return { ...me, workers };
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
  TO: 'to',   // addressee: a role or "fleet" — the entry is still public, but readers filter
};
// Prefixes route to section KEYS, resolved per card by liveHeading(): the heading the card already
// uses for that key, whichever locale it was written in, before the configured one is created.
function cardBaseFor(name) {
  const slug = slugify(name);
  return `# ${name}\n\n- slug: ${slug}\n\n## Digest\n\n<no digest yet — run hub card ${slug} -m "...">\n\n` + cardScaffold();
}
// Append (or set) one line under a "## Heading" of a card, preserving everything else;
// replaces a lone "<placeholder>" body or creates the section if it is missing.
export function editSection(text, heading, payload, mode) {
  const m = headingRe(heading).exec(text);
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

/* ── A card is a snapshot, and nothing was holding it to that ──
 *
 * "3-6 lines of current state" is in hub_card_set's own description, and it held for nobody: of 41
 * cards on one hub, three had grown past 72 KB and one past 250 KB, and `hub_get` on the largest
 * returned 72444 characters that the caller's context refused — the tool could not deliver its own
 * data (task maple-111).
 *
 * WHERE THE GROWTH ACTUALLY IS, which is not where it was assumed to be. The digests are fine:
 * 1.7-3.6 KB each, nobody stuffs them. It is `## Facts & hypotheses` — 47 KB, 63 KB, 231 KB —
 * written one `- fact:` line at a time by hub_report, forever, with nothing to rotate it. So a cap
 * on the digest alone would have changed nothing measurable.
 *
 * WHY THE OVERFLOW IS MOVED AND NOT DROPPED. DECIDE: is journaled as well as written to the card;
 * FACT:, HYPO: and COMM: are NOT — the card is their only home (see runReport). Trimming a section
 * would therefore destroy the only copy. The overflow goes to projects/history/<slug>.md, which
 * already exists for superseded digests, is mesh-synced, and is one grep away.
 *
 * ON WRITE, never on read: cards travel between nodes by git, so a card allowed to grow here
 * arrives over-sized everywhere. Read-side capping (capOutput) is the second half, not the fix.
 *
 * Thresholds live in the hub, not in this file: <hub>/limits.json, so an operator can raise them
 * for their own hub without patching code. */
/** One refusal for an over-long digest, whichever tool wrote it (hub_sync and hub_card_set). */
function assertDigestSize(digest, lim = cardLimits()) {
  const bytes = Buffer.byteLength(String(digest), 'utf8');
  if (bytes <= lim.digestBytes) return;
  throw new Error(`digest is ${bytes} bytes, over this hub's limit of ${lim.digestBytes} ` +
    `(<hub>/limits.json → card.digestBytes). A digest is the current state in a few lines, not the record of how it got there. ` +
    `Move the narrative to hub_report — FACT:/DECIDE:/COMM: lines land in the right card section and in the journal — and keep here only what is true now.`);
}

export function cardLimits() {
  const def = { digestBytes: 8192, sectionBytes: 8192 };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HUB, 'limits.json'), 'utf8'));
    const c = (j && j.card) || {};
    return {
      digestBytes: Number.isFinite(c.digestBytes) && c.digestBytes > 0 ? c.digestBytes : def.digestBytes,
      sectionBytes: Number.isFinite(c.sectionBytes) && c.sectionBytes > 0 ? c.sectionBytes : def.sectionBytes,
    };
  } catch { return def; }
}

/* Sections that are NOT rotated. Digest has its own cap and its own history trail; Facts (auto) is
 * regenerated from git on every sync, so moving it to history would archive a derived value. */
export const NO_ROTATE = new Set(['Digest', 'Facts (auto)']);
export const MOVED_MARK = '- … older entries moved to ';

/* Split a section body into ENTRIES. A list item starts an entry; anything that follows without
 * starting one belongs to it (a fact that wrapped, a fenced block). Prose with no list at all
 * falls back to lines, so a hand-written section still rotates rather than being exempt by shape. */
function sectionEntries(body) {
  const lines = String(body).split('\n');
  const starts = lines.filter(l => /^\s*[-*+]\s/.test(l)).length;
  if (starts < 2) return lines.filter(l => l.trim()).map(l => [l]);
  const out = [];
  for (const l of lines) {
    if (/^\s*[-*+]\s/.test(l) || !out.length) out.push([l]);
    else out[out.length - 1].push(l);
  }
  return out.filter(e => e.join('\n').trim());
}

/** Rotate every over-cap section of a card into its history file. Returns the new text and what
 *  moved; writes history itself, because the caller has a card to save either way. */
export function rotateCardOverflow(text, slug, by, limits = cardLimits()) {
  const moved = [];
  if (!text || CONFLICT_RE.test(text)) return { text, moved };   // a half-merged card is not ours to rewrite
  const histRel = path.join('projects', 'history', slug + '.md');
  const parts = String(text).split(/(?=^## )/m);
  const outParts = parts.map(part => {
    const m = /^## (.+?)[ \t]*$/m.exec(part);
    if (!m || NO_ROTATE.has(m[1].trim())) return part;
    const heading = m[1].trim();
    const head = part.slice(0, m.index + m[0].length);
    const body = part.slice(m.index + m[0].length);
    if (Buffer.byteLength(body, 'utf8') <= limits.sectionBytes) return part;
    // The marker line is regenerated, never accumulated: one line saying where the rest went.
    const entries = sectionEntries(body).filter(e => !e.join('\n').startsWith(MOVED_MARK));
    const keep = [];
    let bytes = 0;
    for (let i = entries.length - 1; i >= 0; i--) {          // newest first — the snapshot end
      const b = Buffer.byteLength(entries[i].join('\n') + '\n', 'utf8');
      if (keep.length && bytes + b > limits.sectionBytes) break;
      keep.unshift(entries[i]); bytes += b;
    }
    const out = entries.slice(0, entries.length - keep.length);
    if (!out.length) return part;
    moved.push({ section: heading, entries: out.length, bytes: Buffer.byteLength(out.map(e => e.join('\n')).join('\n'), 'utf8') });
    try {
      appendHistory(slug, `\n---\n### until ${now()} (${heading} — overflow past ${limits.sectionBytes}B, by ${by || 'hubd'})\n` +
        out.map(e => e.join('\n')).join('\n') + '\n');
    } catch { return part; }                                  // could not archive → keep the card whole
    return head + '\n\n' + MOVED_MARK + histRel + '\n' + keep.map(e => e.join('\n')).join('\n') + '\n';
  });
  return { text: outParts.join(''), moved };
}

/* The current step of a "## Next step" body: its text, and who set it when, read back from the
 * ` — set <ts> by <who>` stamp runReport writes. A body written before the stamp existed reads
 * as {by: null, at: null} — it is still reported as replaced, just without an owner check,
 * because there is nothing to check against. The `prev` line is not part of the current step. */
const NEXT_STAMP_RE = / — set (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) by (\S+)$/;
function parseNextStep(body) {
  if (isPlaceholder(body)) return null;
  const steps = String(body).split('\n').map(l => l.trim()).filter(l => l && !/^- prev \(/.test(l));
  if (!steps.length) return null;
  let by = null, at = null;
  const texts = steps.map(l => {
    let t = l.replace(/^[-*+]\s+/, '');
    const m = t.match(NEXT_STAMP_RE);
    if (m) { if (!at) { at = m[1]; by = m[2]; } t = t.slice(0, m.index); }
    return t.trim();
  }).filter(Boolean);
  if (!texts.length) return null;
  return { text: texts.join(' · '), by, at };
}

export function runReport(a) {
  const project = a.project || 'general';
  const slug = slugify(project);
  const by = requireAuthor(a.by ?? a.agent, 'by');
  assertProse(a.text, 'report');
  // Checked before anything is written: a refused reflection must not leave half a report behind.
  const rf = a.reflect != null ? checkReflect(a.reflect) : null;
  if (rf) {
    if (splitReflect(a.text).reflect) throw new Error('reflect: given twice, as the field and as a REFLECT block in the text. Send one of them.');
    assertProse(renderReflect(rf), 'reflect');
  }
  const b = { decide: [], fact: [], hypo: [], comm: [], next: [], done: [], task: [], note: [], to: [] };
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
  const noteOnly = b.note.length && !explicitNote && !rf && !b.decide.length && !b.fact.length && !b.hypo.length &&
    !b.comm.length && !b.next.length && !b.done.length && !b.task.length && !b.to.length;
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
      // Split on the FIRST "|" only: a destructuring of split('|') kept two parts and silently
      // dropped the rest, so "a | because b | and c" lost "and c" from the card AND the journal.
      const cut = d.indexOf('|');
      const what = (cut === -1 ? d : d.slice(0, cut)).trim();
      const why = cut === -1 ? '' : d.slice(cut + 1).trim();
      text = editSection(text, liveHeading(text, 'decisions'), `- ${now()}: ${what}${why ? ' — ' + why : ''}`, 'append');
      summary.decisions++;
      journalAppend({ ts: now(), project: slug, agent: by, kind: 'decision', text: what + (why ? ' — ' + why : '') });
    }
    for (const f of b.fact) { text = editSection(text, liveHeading(text, 'facts'), `- fact: ${f}`, 'append'); summary.facts++; }
    for (const h of b.hypo) { text = editSection(text, liveHeading(text, 'facts'), `- hypothesis: ${h}`, 'append'); summary.hypos++; }
    for (const c of b.comm) { text = editSection(text, liveHeading(text, 'communication'), `- ${now()}: ${c}`, 'append'); summary.comms++; }
    if (b.next.length) {
      /* NEXT: replaces the section by design — "one concrete physical step". What it used to do as
       * well was replace it SILENTLY: a side session's one-line NEXT: wiped a step the owner had
       * written, the response said {next: true}, and the old text survived only in a journal
       * nobody reads for that. So the step carries its author and time, the previous step stays
       * as one dated `prev` line (one, not a history — the journal holds that), the response
       * says what was replaced, and a step set by an owner role is not replaced by anyone else
       * without force. */
      const prev = parseNextStep(sectionBody(text, liveHeading(text, 'next')));
      const owners = new Set(ownerRoles());
      if (prev && prev.by && owners.has(prev.by) && !owners.has(by) && !a.force) {
        throw new Error(`NEXT: refused — the current next step was set by owner role "${prev.by}"${prev.at ? ' on ' + prev.at : ''}: "${prev.text}". ` +
          'Pass force:true (CLI: --force) to replace it, and say why in a DECIDE: line.');
      }
      const lines = b.next.map(n => `- ${n} — set ${now()} by ${by}`);
      if (prev) lines.push(`- prev (${prev.at || 'undated'}${prev.by ? ', by ' + prev.by : ''}): ${prev.text}`);
      text = editSection(text, liveHeading(text, 'next'), lines.join('\n'), 'set');
      summary.next = true;
      if (prev) summary.nextReplaced = { text: prev.text, by: prev.by, at: prev.at };
    }
    fs.mkdirSync(PROJ, { recursive: true });
    // The cap is applied HERE, on the write that grows the card, because a card that is allowed to
    // grow on one node arrives over-sized on every other one.
    const rot = rotateCardOverflow(text, slug, by);
    if (rot.moved.length) summary.rotated = rot.moved;
    atomicWrite(cardPath(project), rot.text);
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
  /* A reflection field rides on the report's own entry, and its block is written into the text as
   * well: the field is what a digest counts, the text what the head's order and every grep read. */
  if (b.note.length || rf) {
    const to = b.to.length ? b.to.join(',') : (a.to || undefined);
    const lines = rf ? [...b.note, ...renderReflect(rf).split('\n')] : b.note;
    const entry = { ts: now(), project: slug, agent: by, kind: a.kind || 'note', text: lines.join(' · ') };
    if (to) entry.to = to;
    if (rf) entry.reflect = rf;
    if (a.private) { journalAppendPrivate(entry); summary.private = true; }
    else journalAppend(entry);
    summary.note = true;
  }
  /* The writer hears at once what a digest would make of its reflection: a block off the list is
   * still filed (a refusal would lose the report), and the reply says what was off. */
  if (rf) summary.reflect = { level: rf.level, source: 'field' };
  else {
    const t = readReflect(a.text);
    if (t) summary.reflect = { level: t.level, source: 'text', ...(t.problems.length ? { problems: t.problems } : {}) };
  }
  // A report of pure FACT:/COMM:/NEXT: lines writes the CARD and never touches the journal, so the
  // choke point inside journalAppend misses it — and filing one is unmistakably somebody acting.
  touchPresenceIfOwner(by);
  /* The digest's age, said at the one moment the caller has fresh facts in hand. hub_status and
   * hub_brief flag a stale digest, but nobody calls them while reporting; hub_report is the call
   * every session makes with the facts that would fix it (task maple-81). Measured AFTER the
   * write, so a report that just moved the journal on counts against the digest it left behind. */
  const cardNow = readCard(project);
  if (cardNow) {
    const { at: touched, by: touchedBy } = cardStamp(cardNow);
    if (touched) {
      const staleDays = a.staleDays ?? 7;
      summary.digestAgeDays = daysSince(touched);
      const lag = digestLag(touched, lastJournalByProject()[slug], staleDays);
      if (lag) {
        summary.digestStale = lag;
        summary.hint = `digest is ${summary.digestAgeDays} day(s) old and ${lag.daysBehind} day(s) behind this project's journal — ` +
          `last set ${touched}${touchedBy ? ' by ' + touchedBy : ''}. Fix the lines that went stale with hub_card_set({replace:[{from,to}]}) ` +
          `(\`hub card ${slug} --replace "<old>" --with "<new>"\`), or rewrite it with digest.`;
      }
    }
  }
  return summary;
}

/** `since` for a reader: a duration back from now (`7d`, `12h`, `30m`) or a time (`2026-10-01`,
 *  `2026-10-01 14:00`, ISO). Anything else is an error, never a silent "everything". */
export function sinceToMs(since, nowMs = Date.now()) {
  const s = String(since).trim();
  const d = /^(\d+)([dhm])$/.exec(s);
  if (d) return nowMs - d[1] * { d: 86400000, h: 3600000, m: 60000 }[d[2]];
  const t = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d\d:?\d\d)?)?$/.test(s) ? parseTs(s).getTime() : NaN;
  if (Number.isNaN(t)) throw new Error(`since: "${s}" is neither a duration (7d, 12h, 30m) nor a time (2026-10-01, 2026-10-01 14:00)`);
  return t;
}

/** The reflection digest of one project (reflect.mjs → reflectDigest), over a window. */
export function runReflect(a = {}) {
  if (!a.project || typeof a.project !== 'string') throw new Error('project required: hub reflect --project <project>');
  if (a.level != null && !LEVELS.includes(a.level)) throw new Error(`level "${a.level}" is not one of ${LEVELS.join(' | ')}`);
  const sinceMs = sinceToMs(a.since ?? '7d');
  const set = projectSlugSet(a.project);
  const entries = [];
  for (const e of journalEntries(sinceMs)) if (set.has(e.project) && parseTs(e.ts).getTime() >= sinceMs) entries.push(e);
  entries.sort((x, y) => parseTs(x.ts) - parseTs(y.ts));
  return { project: canonProject(a.project), since: new Date(sinceMs).toISOString().slice(0, 16).replace('T', ' '),
    ...reflectDigest(entries, { level: a.level ?? null }) };
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
  const literal = want.replace(/^#+\s*/, '');
  // A key, or ANY heading that means a key (configured, default English, declared alias), lands in
  // the section this card already has for it — never a second one beside it (task maple-112).
  const key = (cfg.find(s => s.key === want.toLowerCase())
    || cfg.find(s => sectionHeadings(s.key).some(h => h.toLowerCase() === literal.toLowerCase())) || {}).key;

  const slug = slugify(project);
  const before = readCard(project) || cardBaseFor(project);
  const heading = key ? liveHeading(before, key) : literal;
  const created = !hasHeading(before, heading);
  const line = `- ${now()}: ${raw}` + (a.provenance ? ` · src: ${String(a.provenance).trim()}` : '');
  const after = editSection(before, heading, line, a.mode === 'set' ? 'set' : 'append');
  fs.mkdirSync(PROJ, { recursive: true });
  // The fourth way to grow a card, and the one 0.9.23 missed: report, sync and card-set rotate on
  // write, and a section fed only through here grew without bound on every node it synced to.
  const rot = rotateCardOverflow(after, slug, by);
  atomicWrite(cardPath(project), rot.text);
  journalAppend({ ts: now(), project: slug, agent: by, kind: 'note', text: `${heading}: ${raw.slice(0, 100)}` });
  return { ok: true, project: slug, section: heading, created, card: cardPath(project),
    ...(rot.moved.length ? { rotated: rot.moved } : {}) };
}

export function runStatus(a = {}) {
  const staleDays = a.staleDays ?? 7;
  const lastJournal = lastJournalByProject();
  const db = loadTasks();
  let files = []; try { files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md') && !RESERVED_CARDS.has(f.replace(/\.md$/, ''))); } catch {}
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
    // of it, or parseTs sees "2026-06-26T09:42 by dev-desk", returns NaN, and the lag check
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
  let cards = []; try { cards = fs.readdirSync(PROJ).filter(f => f.endsWith('.md')); } catch {}
  for (const f of cards) {
    const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
    c.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(q)) hits.push({ where: f + ':' + (i + 1), line: line.trim().slice(0, 200) });
    });
  }
  for (const e of journalEntries()) {
    if ((e.text || '').toLowerCase().includes(q))
      hits.push({ where: 'journal ' + e.ts + ' [' + e.project + '/' + e.agent + ']', line: e.text.slice(0, 200) });
  }
  // Every hit, uncut. This used to slice to 40 here, BEFORE the server's capOutput ran — so the
  // cap saw a list already at its limit, wrote no `truncated`, and `full:true` had nothing to
  // restore. 106 matches came back as 42 with nothing saying so (task maple-82). The
  // per-tool plan in index.mjs is the one place that trims, and the one place that says it did.
  return { query: a.query, hits, total: hits.length };
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

/* `project` as a slug, a comma-separated list or an array → a Set of slugs, or null for "all". */
export function projectFilter(p) {
  const list = Array.isArray(p) ? p : String(p ?? '').split(',');
  // Blanks go BEFORE slugify: slugify('') is not '' (it names the fallback project), and one
  // blank would have turned "no filter" into "only the fallback project" — zero hits, silently.
  const set = new Set(list.map(x => String(x ?? '').trim()).filter(Boolean).map(slugify));
  return set.size ? set : null;
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
        const lines = fs.readFileSync(marker, 'utf8').split('\n').map(l => l.trim());
        const slug = lines[0];
        // Second line, optional: a project-local inventory script `hub whereami` runs after its own
        // report — project-specific registers stay in the project, not in the engine.
        if (slug) return { slug: slugify(slug), root: d, ...(lines[1] && !lines[1].startsWith('#') ? { inventory: lines[1] } : {}) };
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

/* `local: false` is the HTTP transport. There the cwd is a path on the CALLER's machine, and walking
 * it here would walk the server's disk instead — reading any `.hubd` file it names and, through
 * claimsTouched, listing recently modified files under any directory a tenant cares to pass. So a
 * remote resolve uses only what the hub itself holds: recorded sync paths and card names. */
export function resolveContext(cwd, { local = true } = {}) {
  const start = path.resolve(String(cwd || ''));
  const root = (local && findGitRoot(start)) || start;

  const marker = local ? findHubdMarker(start) : null;
  if (marker) return { project: marker.slug, via: 'marker', root: marker.root, guessed: false, ...(marker.inventory ? { inventory: marker.inventory } : {}) };

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
/* Who is working HERE — live heartbeats whose cwd sits under `root`, or resolves to `project`.
 * Shared by runContext (presenceHere) and runPresence (cwd/project filters) so the two answers
 * cannot disagree. A record without a cwd cannot be placed and is left out of a cwd question. */
const underRoot = (cwd, root) => {
  if (!cwd || !root) return false;
  const c = path.resolve(String(cwd)), r = path.resolve(String(root));
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};
export function presenceHere({ root = null, project = null, aliveOnly = true, local = true } = {}) {
  const slug = project ? slugify(project) : null;
  let list = runPresence({ aliveOnly, local }).agents;
  if (root) list = list.filter(r => underRoot(r.cwd, root));
  if (slug) list = list.filter(r => r.cwd && resolveContext(r.cwd, { local }).project === slug);
  return list.map(({ agent, role, status, task_id, cwd, last_seen, observedOn, alive }) =>
    ({ agent, role, status, task_id, cwd, last_seen, observedOn, alive }));
}

/* hub_context is the call the protocol says to make FIRST, and it was the one read that never
 * warned: it handed back a digest four months behind the project's own journal with no date and
 * no flag, while hub_status and hub_brief flagged the same card (task maple-78). The same
 * call said nothing about the other session editing the same checkout, which its caller then
 * found by file mtimes. So: the digest's age and the same stale verdict the other tools use,
 * a hint for the one-line fix when the project was only guessed, who else is heartbeating under
 * this root, and the last few journal lines — enough to resume from state after a compaction
 * without grepping the repository. */
export function runContext(a) {
  const cwd = a && a.cwd;
  if (!cwd) throw new Error("cwd required — pass the CALLING agent's own absolute working directory (the hubd process's cwd is not reliable)");
  const local = a.local !== false;
  const ctx = resolveContext(cwd, { local });
  if (ctx.guessed) ctx.hint = `guessed from the folder name — write ${path.join(ctx.root, '.hubd')} with one line "${ctx.project}" to make it certain`;
  if (!ctx.project) return { ...ctx, digest: null, openTasks: [], activeClaims: [], presenceHere: presenceHere({ root: ctx.root }), journalTail: [] };
  const card = readCard(ctx.project);
  const digest = card ? (digestOf(card) || '').slice(0, 300) : null;
  const { at: digestSetAt, by: digestSetBy } = cardStamp(card);
  const digestAgeDays = digestSetAt ? daysSince(digestSetAt) : null;
  const digestStale = digestLag(digestSetAt, lastJournalByProject()[ctx.project], a.staleDays ?? 7);
  const claimsDb = loadClaims();
  return {
    ...ctx,
    digest, digestSetAt, digestSetBy, digestAgeDays,
    ...(digestStale ? { digestStale } : {}),
    openTasks: runTaskList({ project: ctx.project, status: 'open' }).tasks,
    activeClaims: activeClaims(claimsDb.claims).filter(c => c.project === ctx.project),
    presenceHere: presenceHere({ root: ctx.root, project: null }),
    journalTail: journalTail(ctx.project, a.journalTail ?? 5),
    // "You are already editing somebody's zone": live claims (not the caller's, when it says who
    // it is) whose glob covers a file changed in this checkout in the last half hour. Needs the
    // checkout's own disk, so a remote transport says it did not look rather than answering "none".
    claimsTouched: local
      ? claimsTouched({ root: ctx.root, project: ctx.project, agent: a.agent || null, minutes: a.recentMinutes ?? 30 })
      : { touched: [], recentFiles: 0, capped: false, minutes: a.recentMinutes ?? 30,
          note: 'not checked: this server cannot see your checkout — run `hub claim check <path>` locally' },
  };
}

/* "Where am I" for a shell: hub_context plus the git-side inventory an agent otherwise rebuilds
 * by hand after a compaction — and gets wrong. The findings live in commit subjects (a session
 * re-discovered one committed under a subject that named it); "does this already exist" lives in
 * the untracked list (a script sat there while a second one was written); another session in the
 * same tree shows first in fresh mtimes. Read-only, no network, bounded: git calls carry the
 * 8-second cap `sh` always had, the walk the cap recentFiles has. A project's own registers are
 * not the engine's business — the second line of the `.hubd` marker names a local script, and it
 * runs last, with its output capped (task maple-74). */
export function runWhereAmI(a = {}) {
  const cwd = a.cwd || process.cwd();
  const ctx = runContext({ cwd, agent: a.agent, staleDays: a.staleDays, journalTail: a.journalTail ?? 8, recentMinutes: a.recentMinutes ?? 30 });
  const root = ctx.root;
  const out = { ...ctx, git: null, localInventory: null };
  if (root && fs.existsSync(path.join(root, '.git'))) {
    const firstLine = (f) => {
      try { return (fs.readFileSync(path.join(root, f), 'utf8').split('\n').find(l => l.trim()) || '').trim().slice(0, 100); } catch { return ''; }
    };
    const untracked = sh('git status --porcelain', root).split('\n').filter(l => l.startsWith('?? ')).map(l => l.slice(3).trim())
      .slice(0, 30).map(f => ({ file: f, firstLine: f.endsWith('/') ? '(directory)' : firstLine(f) }));
    const stat = sh('git diff --stat', root).split('\n').filter(Boolean);
    out.git = {
      branch: sh('git rev-parse --abbrev-ref HEAD', root),
      commits: sh(`git log --format='%h %s' -n ${Math.max(1, parseInt(a.commits ?? 8, 10) || 8)}`, root).split('\n').filter(Boolean),
      dirty: stat.length ? stat[stat.length - 1].trim() : 'clean',
      dirtyFiles: stat.slice(0, -1).map(l => l.trim()).slice(0, 20),
      untracked,
      recent: recentFiles(root, a.recentMinutes ?? 30).files.slice(0, 20),
    };
  }
  if (ctx.inventory && root) {
    const script = path.isAbsolute(ctx.inventory) ? ctx.inventory : path.join(root, ctx.inventory);
    if (fs.existsSync(script)) {
      let text = '';
      // No shell: the path comes from a file in the repository, and JSON-style double quotes do not
      // stop a shell from expanding $(...) or backticks inside them.
      try { text = execFileSync(script, [], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }); }
      catch (e) { text = String((e && e.stdout) || '') + (e && e.stderr ? '\n[stderr] ' + String(e.stderr).slice(0, 500) : '') + (e && e.killed ? '\n[inventory script exceeded 5 s and was stopped]' : ''); }
      out.localInventory = { script: ctx.inventory, output: String(text).slice(0, 4000), truncated: String(text).length > 4000 };
    } else out.localInventory = { script: ctx.inventory, missing: true };
  }
  return out;
}

// Task #194 root-cause fix: bare sequential ids were minted from `db.seq` — THIS
// node's local view of the global counter — so two nodes adding while offline from
// each other routinely computed the same next id (foldTasks's remap-on-collision
// patched the SYMPTOM after the fact, at fold time). New ids are node-scoped
// (`${node}-${n}`) instead, derived ONLY from this node's own append-only event
// file — no cross-node knowledge needed, so two offline adds can never collide by
// construction. Existing bare-numeric ids are left exactly as they are (still
// protected by the origin-keying fix); nothing here rewrites history.
//
// Scans for BOTH the JOURNAL_NODE and TASK_ID_PREFIX patterns so that changing
// the prefix via HUBD_TASK_ID_PREFIX never resets the sequence counter — new IDs
// continue from the highest N seen under either prefix.
function nextLocalSeq() {
  let maxN = 0;
  const prefixes = TASK_ID_PREFIX === JOURNAL_NODE ? [JOURNAL_NODE] : [TASK_ID_PREFIX, JOURNAL_NODE];
  const res = prefixes.map(p => {
    const esc = escRe(p);
    return new RegExp('^' + esc + '-(\\d+)$');
  });
  try {
    for (const l of fs.readFileSync(TASK_EVENTS, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (e.ev === 'add' && typeof e.id === 'string') {
          for (const re of res) {
            const m = re.exec(e.id);
            if (m) { maxN = Math.max(maxN, parseInt(m[1], 10)); break; }
          }
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
  assertProse(a.text, 'task text');
  return withLock(TASK_EVENTS, () => {
    const id = `${TASK_ID_PREFIX}-${nextLocalSeq()}`;
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
    shareMode(TASK_EVENTS);
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
    ' — ids are node-scoped ("pine-3") or legacy numbers. Know a keyword instead? hub_search finds the task and the project it lives in.');
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
  if (a.text != null) assertProse(a.text, 'task text');
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
    // are otherwise BYTE-IDENTICAL while meaning different tasks (pine updating its own
    // remapped task emits exactly what "update the visible #169" used to emit). The reader
    // cannot guess, so new writes say which convention they use and old ones keep the
    // best-effort heuristic they were written under.
    fs.appendFileSync(TASK_EVENTS, JSON.stringify({ ts: now(), node: origin.node, ev: 'set', id: origin.id, keyed: 'origin', patch }) + '\n');
    shareMode(TASK_EVENTS);
    rebuildTaskCache();
    /* Say WHAT changed, not just that something did. The line used to read "~ task #N → edited"
     * for every non-status edit, so the single most useful event in a coordination log — somebody
     * took this task — was indistinguishable from a typo fix in its text. A reader scanning the
     * journal needs the new owner, the new priority, the new date; that is the whole reason the
     * line exists. */
    /* WHAT REACHES THE JOURNAL, AND WHAT STAYS IN THE EVENT LOG.
     *
     * The journal is the owner's memory prosthesis and has to stay readable by a person. Measured
     * on a live hub it was not: of 2642 entries, 1211 were task echo, and 725 of those were this
     * line. `~ task #pine-66 → @opencode-bsdos` is not something a human reads for meaning —
     * every field of it is already in tasks.<node>.events.jsonl at full fidelity, which is where a
     * machine looks anyway.
     *
     * So a field edit no longer writes here at all. But the spec that asked for this wanted `kind:
     * task` gone entirely, and that would have been wrong: of 467 "-> done" echoes, 83 were the
     * ONLY journal trace that the task was ever closed, because closing through the CLI never wrote
     * a `done` entry — the assumption that hub_report already covers closures is false for that
     * path. Deleting them would have erased 83 closures from the readable record to remove noise.
     *
     * A CLOSURE IS NARRATIVE, so it is promoted rather than dropped: `kind: 'done'`, carrying the
     * task's text, which is what a person scanning the month actually needs. A reopen is an event
     * too and keeps its line. Everything else — assignee, dates, tags, deps, text fixes — is
     * bookkeeping and now lives in exactly one place.
     *
     * ASSIGNMENT STAYS TOO. The comment this replaces made the case and it still holds: "somebody
     * took this task" is the single most useful event in a coordination log, and it is 33 of the
     * 725 lines, not the bulk. What goes is attribute maintenance — text fixes, tags, deps,
     * resources, importance, dates, and the bare "edited" that said nothing at all. The dividing
     * line is not verbosity, it is whether a person reconstructing the month needs it: who holds
     * a task and what state it is in, yes; which of its fields was touched, no.
     *
     * `kind: 'task'` survives for creation (runTaskAdd), assignment and non-done status, and that
     * matters beyond taste: BOOKKEEPING_KINDS excludes `task` from the card-freshness signal
     * precisely so that filing a task does not count as the project having moved. Promoting
     * creation to `note` would silently undo that fix. */
    if (!a.quiet) {
      const bits = [];
      if (a.status && a.status !== 'done') bits.push(a.status);
      if (patch.assignee != null) bits.push('@' + patch.assignee);
      if (a.status === 'done') {
        journalAppend({ ts: now(), project: t.project, agent: author, kind: 'done',
          text: '#' + t.id + ' ' + String(t.text || '').slice(0, 160) });
      }
      if (bits.length) {
        journalAppend({ ts: now(), project: t.project, agent: author, kind: 'task',
          text: '~ task #' + t.id + ' → ' + bits.join(', ') });
      }
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
  const tasksOpen = db.tasks.filter(t => t.status === 'open').sort(byUrgency(todayPlus3));

  const journalRecent = collapseRepeats(journalSince(hours));

  const staleCards = [];
  // Two different silences, deliberately reported apart: staleCards = nobody touched this
  // card in N days (it may still be true — the project could be dormant); staleDigests =
  // the project kept WORKING and its card did not follow, which is the one that misleads.
  const staleDigests = [];
  const lastJournal = lastJournalByProject();
  try {
    for (const f of fs.readdirSync(PROJ).filter(f => f.endsWith('.md') && !RESERVED_CARDS.has(f.replace(/\.md$/, '')))) {
      const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
      const synced = cardStamp(c).at;   // card-set cards go stale too
      if (synced) {
        const project = f.replace('.md', '');
        const daysAgo = daysSince(synced, nowMs);
        if (daysAgo >= staleDays) staleCards.push({ project, synced, daysAgo });
        const lag = digestLag(synced, lastJournal[project], staleDays);
        if (lag) staleDigests.push({ project, synced, ...lag });
      }
    }
  } catch {}
  staleDigests.sort((x, y) => y.daysBehind - x.daysBehind);

  const claimsDb = loadClaims();
  return {
    tasksOpen, journalRecent, staleCards, staleDigests, activeClaims: activeClaims(claimsDb.claims),
    // The audit rides here rather than waiting to be called — see runReview. `queues` arrives from
    // the caller (index.mjs/cli.mjs already compute the rows for the queue section).
    review: runReview({ queues: a.queues, limit: a.reviewLimit, local: a.local }),
    generated: now(),
  };
}

/* ── Onboarding / what's-new ── */

// One-time orientation for an agent that has never worked with this hub before.
// Reuses the shipped protocol.md — the same source ensureProtocol() materializes
// into HUBD.md — so there is exactly one copy of "how hubd works" to keep in
// sync, never a duplicate onboarding text that quietly drifts from it.
/* mode "short" (default): the channel table, the author rule, the session ritual and the list of
 * everything else — under 600 words. The full manual is ~4000 words and the protocol says to call
 * this FIRST, so an agent re-orienting after a compaction "just in case" paid the most expensive
 * call of its day for text it had already read (task maple-83). Cut from the same file, not
 * a second copy that would drift: the table is the first table under "## Channels", the author rule
 * is its own "###", the ritual its own "##". mode "full" is the whole document, as before. */
function protocolSlice(body, heading, { firstBlockOnly = false } = {}) {
  const lines = body.split('\n');
  const start = lines.findIndex(l => l.trim() === heading.trim());
  if (start === -1) return '';
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  let sec = lines.slice(start, end);
  if (firstBlockOnly) {
    // heading, blank, then the first table plus the paragraph right after it
    const out = [sec[0], ''];
    let i = 1; while (i < sec.length && !sec[i].trim()) i++;
    while (i < sec.length && sec[i].startsWith('|')) out.push(sec[i++]);
    out.push('');
    while (i < sec.length && !sec[i].trim()) i++;
    while (i < sec.length && sec[i].trim()) out.push(sec[i++]);
    sec = out;
  }
  return sec.join('\n').replace(/\s+$/, '');
}
export function runOnboarding(a = {}) {
  ensureProtocol();
  const body = shippedProtocol();
  if (body == null) return { ok: false, error: 'protocol.md not found in this hubd install' };
  const mode = String(a.mode || 'short');
  if (mode === 'full') return { ok: true, version: VERSION, mode, protocol: body };
  if (mode !== 'short') throw new Error(`mode: "${mode}" is not "short" or "full"`);
  const sections = body.split('\n').filter(l => /^## /.test(l)).map(l => l.replace(/^## /, ''));
  const channels = protocolSlice(body, body.split('\n').find(l => /^## Channels/.test(l)) || '## Channels', { firstBlockOnly: true });
  const author = protocolSlice(body, '### Say who you are — every write needs an author');
  const ritual = protocolSlice(body, '## Session ritual');
  const recovering = protocolSlice(body, '## Recovering after compaction').split('\n').slice(0, 4).join('\n') +
    '\n(five steps — full manual)';
  const short = [
    '# How to work with this hub — the short version',
    '',
    channels, '', author, '', ritual, '', recovering,
    '',
    '## The rest of the manual — mode:"full", or HUBD.md',
    '',
    ...sections.map(s => '- ' + s),
  ].join('\n');
  return { ok: true, version: VERSION, mode, protocol: short, sections,
    hint: 'This is the short orientation (channels, author rule, ritual, recovery). Everything else is one call away: hub_onboarding({mode:"full"}) — or read HUBD.md in the hub, it is the same text.' };
}

const checkinsFile = () => path.join(HUB, '.checkins.json');
function readCheckins() { return readJson(checkinsFile(), {}); }
function writeCheckins(obj) { try { atomicWrite(checkinsFile(), JSON.stringify(obj, null, 1)); } catch {} }

// Personalized "what did I miss" — delta since THIS agent's own last
// hub_whatsnew call, backed by journalSince(). A never-seen agent has no prior
// checkpoint to diff against, so its first call falls back to a plain window
// (default 24h). Per-agent checkpoints live in .checkins.json (gitignored by
// ensureProtocol since 0.9.15 — it was tracked in a real hub before that,
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
  const nowMs = Date.now();
  const hoursBack = (iso) => Math.max((nowMs - parseTs(iso).getTime()) / 3600000, 0);
  /* since: "checkpoint" (default) | "session" | an ISO time.
   * The checkpoint answers "what did I miss since my last call" — right after a night away and
   * useless right after a context compaction, which is the way a fleet session actually returns:
   * the same session, the same checkpoint, and everything it wrote itself lies BEFORE it. The
   * server's own instruction sent returning agents here and they got zero on their own topic
   * (task maple-84). "session" starts at the earliest of this key's first check-in and the
   * author's first journal line today — heartbeats keep no history, so that is the honest
   * approximation of "since this session began". */
  const sinceArg = String(a.since || 'checkpoint').trim();
  const firstKey = 'first:' + key;
  if (!checkins[firstKey]) checkins[firstKey] = new Date(nowMs).toISOString();
  let hours, sinceMode = 'checkpoint', sinceAt = lastSeen;
  if (sinceArg === 'session') {
    sinceMode = 'session';
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const firstToday = journalSince(hoursBack(today + 'T00:00:00Z')).filter(e => e.agent === author).map(e => e.ts).sort()[0] || null;
    const starts = [checkins[firstKey], firstToday].filter(Boolean).map(t => parseTs(t).getTime());
    sinceAt = new Date(Math.min(...starts)).toISOString();
    hours = hoursBack(sinceAt);
  } else if (sinceArg !== 'checkpoint') {
    if (!Number.isFinite(parseTs(sinceArg).getTime())) throw new Error(`since: "${sinceArg}" is not "checkpoint", "session" or an ISO time`);
    sinceMode = 'time'; sinceAt = sinceArg; hours = hoursBack(sinceArg);
  } else {
    hours = lastSeen ? hoursBack(lastSeen) : fallbackHours;
  }
  // `project` narrows the delta to the projects named; an agent sitting in one project got six
  // entries from three others and none from its own (task maple-77).
  const only = projectFilter(a.project);
  const raw = sinceMode === 'checkpoint' ? journalSince(hours) : journalSinceMs(parseTs(sinceAt).getTime());
  const entries = collapseRepeats(raw.filter(e => !only || only.has(slugify(String(e.project || '')))));
  checkins[key] = new Date(nowMs).toISOString();
  writeCheckins(checkins);
  // A fresh checkpoint and an empty delta is the compaction signature, not "nothing happened".
  const compactionHint = sinceMode === 'checkpoint' && lastSeen && hours < 1 && entries.length === 0
    ? `your checkpoint is ${Math.round(hours * 60)} min old and nothing is new since it — if you are resuming after a context compaction, ` +
      `call again with since:"session" for everything this session wrote, or read the card: hub_context({cwd}) / hub log <slug>`
    : undefined;
  // "What did I miss" is the right place for "and what does this environment need":
  // it is the tool a returning agent calls, and the protocol tells it to. Acknowledged
  // per session, so a protocol change is announced once and not on every check-in —
  // and the OTHER session on this host still hears it.
  const env = envChecks({ session: a.session, transport: a.transport });
  ackEnvNotices(a.session);
  return {
    agent: author, since: sinceAt, sinceMode, firstCheckin: !lastSeen,
    ...(only ? { project: [...only] } : {}),
    windowHours: Math.round(hours * 10) / 10,
    newEntries: entries.length,
    entries: entries.slice(0, 50),
    ...(compactionHint ? { hint: compactionHint } : {}),
    ...(env.items.length ? { environment: env.items, environmentTotal: env.total } : {}),
    // Same passenger as in runBrief: an agent that returns to work sees what the hub's own rules
    // say is wrong, without anyone having to remember to ask (see runReview).
    review: runReview({ queues: a.queues, limit: a.reviewLimit, local: a.local }),
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

  // Entries addressed to a role: when the caller provides their role, surface entries
  // where `to` matches that role or 'fleet'. This is how a head's signal ("windows done,
  // NAT can close") reaches the orchestrator without them having to scan the full journal.
  const role = a.agent || a.role || undefined;
  const addressed = role ? journalSince(hours).filter(e => e.to && (e.to === role || e.to.includes(role) || e.to === 'fleet'))
    .map(e => ({ ts: e.ts, project: e.project, agent: e.agent, to: e.to, text: (e.text || '').slice(0, 200) })) : [];

  const claims = loadClaims().claims;
  const live = new Set(activeClaims(claims).map(c => `${c.project}\0${c.area}\0${c.agent}`));
  const staleClaims = claims
    .filter(c => (c.ttlMin ?? 240) !== 0 && !live.has(`${c.project}\0${c.area}\0${c.agent}`))
    .map(c => ({ project: c.project, area: c.area, agent: c.agent, since: c.since, ttlMin: c.ttlMin ?? 240 }));

  const counts = { blocked: blocked.length, overdue: overdue.length, unassigned: unassigned.length, staleClaims: staleClaims.length, addressed: addressed.length };
  return { counts, empty: Object.values(counts).every(n => n === 0), blocked, overdue, unassigned, staleClaims, addressed, windowHours: hours, generated: now() };
}

// Deterministic dependency-graph planner over tasks' depends_on — the "probable
// trajectory" as a critical PATH, not an ML forecast. Kahn topo-layers (what's
// doable now vs unlocked-later), longest dependency chain (the critical path that
// bounds ordering), and cycle detection (auto-populated deps can loop). Weight is
// task-count for now; honest per-task durations (→ weighted critical path) come
// once logd records them (#193). ids may be bare numbers or node-scoped ("pine-3").
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
export function eligibleOpen(tasks, { project, assignee } = {}) {
  const open = tasks.filter(t => t.status === 'open');
  const openIds = new Set(open.map(t => String(t.id)));
  const blocked = (t) => (Array.isArray(t.depends_on) ? t.depends_on : []).map(String).some(d => openIds.has(d));
  let list = open.filter(t => !blocked(t));
  if (project) { const set = projectSlugSet(project); list = list.filter(t => set.has(t.project)); }
  if (assignee) list = list.filter(t => t.assignee === assignee);
  return { list, blocked: open.filter(blocked), openIds };
}

/* The one "what first" order — due within three days, then importance, then oldest — shared by
 * hub_next, hub_agenda, hub_brief and the kanban. It was written out three times, and a fix to one
 * copy (a task with no `created` sorting unpredictably) had not reached the other two. */
const IMPORTANCE_RANK = { high: 3, med: 2, normal: 1 };
export function byUrgency(today3) {
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
/* A task is the owner's either because it says so (owner_kind) or because it is assigned to a role
 * the instance already DECLARED as a human owner. Most real tasks carry no owner_kind, so without
 * the second test every owner decision lands in the "agent work, ready now" column — a list whose
 * whole purpose is that its reader can start everything in it. */
export const isOwnerTask = (owners) => (t) => t.owner_kind === 'human' || (t.assignee && owners.has(t.assignee));

/* ── The buttons that are actually rotting ──
 *
 * The spec that asked for this was aimed at the owner QUEUE: items sent to a human, waiting weeks.
 * Measured on the hub it was written for, that queue was empty — read to the byte, offsets equal to
 * file size. What had actually rotted was on the other surface entirely: 31 of 143 open tasks
 * belonged to the owner, the oldest 80 days old, three of them past deadlines that fell 15 days
 * ago. The queue was read; the decisions were never made.
 *
 * The two are not the same thing and are reported apart (see ownerQueueItems in queue.mjs for the
 * other one). A queue item is a package somebody addressed and is waiting on. An owner-assigned
 * task is a decision sitting on the board that nobody else is permitted to move — invisible in
 * every "what can I start" list precisely because the answer there is "not this".
 *
 * Age is measured from `created`, and a task without a stamp is counted but reported as unknown
 * rather than as new: guessing zero would make the oldest backlog look like the freshest.
 *
 * Pure over the task list — no I/O, so it costs nothing to carry on a call that already loaded it. */
export function ownerWaiting(tasks, { today = new Date().toISOString().slice(0, 10), limit = 10 } = {}) {
  const owners = new Set(ownerRoles());
  const isOwner = isOwnerTask(owners);
  const ageOf = (t) => {
    const ms = t.created ? parseTs(t.created).getTime() : NaN;
    return Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 86400000)) : null;
  };
  const rows = (tasks || []).filter(t => t.status === 'open' && isOwner(t)).map(t => ({
    id: t.id, project: t.project || null, assignee: t.assignee || null,
    deadline: t.deadline || null,
    overdueDays: t.deadline && t.deadline < today
      ? Math.floor((parseTs(today).getTime() - parseTs(t.deadline).getTime()) / 86400000) : null,
    ageDays: ageOf(t), text: String(t.text || '').slice(0, 100),
  })).sort((x, y) => (y.ageDays ?? -1) - (x.ageDays ?? -1));
  const aged = rows.filter(r => r.ageDays != null);
  return {
    count: rows.length,
    oldestDays: aged.length ? aged[0].ageDays : null,
    unknownAge: rows.length - aged.length,
    overdue: rows.filter(r => r.overdueDays != null).length,
    items: limit > 0 ? rows.slice(0, limit) : rows,
  };
}

export function runAgenda(a = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const today3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const { list, blocked } = eligibleOpen(loadTasks().tasks, a);
  const sorted = [...list].sort(byUrgency(today3));
  const short = (t) => ({ id: t.id, project: t.project, importance: t.importance, deadline: t.deadline || null,
    assignee: t.assignee || null, text: (t.text || '').slice(0, 100),
    overdue: !!(t.deadline && t.deadline < today) });
  const isOwner = isOwnerTask(new Set(ownerRoles()));
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

/* ── A claim's area as a glob ──
 * `area` was free text, and a claim was informational in the weakest sense: nothing told an agent
 * that the file it had just opened was somebody's declared zone. Two sessions edited one checkout
 * on 2026-09-11; one had claimed, the other did not know claims existed, and the conflict was
 * avoided by luck (task maple-79). So an area is READ as a path pattern when it can be —
 * `src/**\/*.ts`, `docs/{a,b}.md`, a bare directory — relative to the project root, and a path can
 * be asked about. Free text stays legal; it is simply `matchable:false`, and the claim says so.
 * `+` and `,` outside braces separate several patterns in one area. */
function expandBraces(s) {
  const m = s.match(/\{([^{}]*)\}/);
  if (!m) return [s];
  const out = [];
  for (const alt of m[1].split(',')) out.push(...expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)));
  return out;
}
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A pattern with no glob characters names a file or a directory: itself, or anything under it.
  const plain = !/[*?[{]/.test(g);
  return new RegExp('^' + re + (plain ? '(?:/.*)?' : '') + '$');
}
/** RegExps for a claim area, or null when the area is prose that no path can match. */
export function areaPatterns(area) {
  const a = String(area || '').trim();
  if (!a) return null;
  const tokens = a.split(/\s*\+\s*|,(?![^{]*\})\s*/).map(t => t.trim()).filter(Boolean);
  if (!tokens.length || tokens.some(t => /\s/.test(t))) return null;
  const pats = [];
  for (const t of tokens) for (const alt of expandBraces(t)) pats.push(globToRe(alt.replace(/^\.\//, '').replace(/\/+$/, '')));
  return pats;
}
const relTo = (root, p) => {
  const abs = path.isAbsolute(p) ? path.normalize(p) : p;
  if (root && path.isAbsolute(abs)) {
    const r = path.resolve(root);
    if (abs === r) return '.';
    if (abs.startsWith(r + path.sep)) return abs.slice(r.length + 1).split(path.sep).join('/');
  }
  return String(p).replace(/^\.\//, '');
};
/** Is `path` inside somebody's live claim? Pure read; exit-code semantics live in the CLI. */
export function runClaimCheck(a = {}) {
  const p = String(a.path || '').trim();
  if (!p) throw new Error('path required: the file you are about to edit');
  let project = a.project ? slugify(a.project) : null, root = a.root || null;
  if (!project && a.local === false) throw new Error('project required on a remote server: it cannot resolve a path on your machine');
  if ((!project || !root) && a.local !== false) {
    const ctx = resolveContext(path.isAbsolute(p) ? (fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p)) : process.cwd());
    project = project || ctx.project; root = root || ctx.root;
  }
  if (!project) return { path: p, project: null, free: true, holders: [], mine: [], unmatchable: [], hint: 'no project resolves for this path — pass project, or write a .hubd marker at the repo root' };
  const rel = relTo(root, p);
  const holders = [], mine = [], unmatchable = [];
  for (const c of activeClaims(loadClaims().claims).filter(c => slugify(c.project) === project)) {
    const pats = areaPatterns(c.area);
    const row = { agent: c.agent, area: c.area, since: c.since, ttlMin: c.ttlMin ?? 240, ...(c.note ? { note: c.note } : {}) };
    if (!pats) { unmatchable.push(row); continue; }
    if (pats.some(re => re.test(rel))) (a.agent && c.agent === a.agent ? mine : holders).push(row);
  }
  return { path: p, rel, project, root, free: holders.length === 0, holders, mine, unmatchable };
}
/* Files under `root` modified in the last `minutes`, relative, bounded — this runs inside
 * hub_context, so a monorepo must not turn "where am I" into a filesystem census. */
function recentFiles(root, minutes, { cap = 3000, maxDepth = 8 } = {}) {
  const out = [];
  const since = Date.now() - minutes * 60000;
  const skip = new Set(['.git', 'node_modules', '.hubd', 'target', 'dist', 'build', '.venv', '__pycache__']);
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen > cap) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (seen++ > cap) return;
      if (d.name.startsWith('.') && d.isDirectory()) continue;
      if (skip.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full, depth + 1);
      else { try { if (fs.statSync(full).mtimeMs >= since) out.push(relTo(root, full)); } catch {} }
    }
  };
  walk(path.resolve(root), 0);
  return { files: out, capped: seen > cap };
}
/** Live claims (optionally not the caller's own) whose area covers a file modified recently. */
export function claimsTouched({ root, project, agent = null, minutes = 30 } = {}) {
  if (!root || !project) return { touched: [], recentFiles: 0, capped: false };
  const { files, capped } = recentFiles(root, minutes);
  const touched = [];
  for (const c of activeClaims(loadClaims().claims).filter(c => slugify(c.project) === slugify(project) && c.agent !== agent)) {
    const pats = areaPatterns(c.area);
    if (!pats) continue;
    const hit = files.filter(f => pats.some(re => re.test(f)));
    if (hit.length) touched.push({ agent: c.agent, area: c.area, since: c.since, files: hit.slice(0, 5), more: Math.max(0, hit.length - 5) });
  }
  return { touched, recentFiles: files.length, capped, minutes };
}

/** A claim on a task is a claim whose area is `task:<id>` — the "started" mark of a role's work
 *  queue (see roleWork in queue.mjs). */
export const taskClaimArea = (id) => 'task:' + String(id);

export function runClaim(a) {
  if (a.task != null && a.task !== '') {
    const t = runTaskGet({ id: a.task }).task;
    if (t.status !== 'open') throw new Error(`task #${t.id} is ${t.status} — there is nothing to start`);
    a = { ...a, project: a.project || t.project, area: taskClaimArea(t.id) };
  }
  // Name the fields actually missing: this error fired on 4 of 33 real hub_claim
  // calls, the worst rate of any tool, and listing all three told the caller
  // nothing about which one it had left out.
  const missing = ['project', 'area', 'agent'].filter(k => !a[k]);
  if (missing.length) throw new Error('missing required: ' + missing.join(', ') + ' (claim needs project, area, agent)');
  requireAuthor(a.agent, 'agent');   // a claim holder is an author: "claude" holds nothing anyone can tell apart
  return withLock(CLAIMS, () => {
    const db = loadClaims();
    db.claims = activeClaims(db.claims);
    const existing = db.claims.find(c => c.project === a.project && c.area === a.area && c.agent !== a.agent);
    const ttlMin = a.ttlMin ?? 240;
    const claim = { id: crypto.randomUUID(), project: a.project, area: a.area, agent: a.agent, since: now(), ttlMin };
    if (a.note) claim.note = a.note;
    db.claims.push(claim);
    atomicWrite(CLAIMS, db);
    const matchable = areaPatterns(a.area) !== null;
    const result = { ok: true, claim, matchable,
      ...(matchable ? {} : { hint: 'this area is prose, so `hub claim check <path>` cannot match files against it — a glob like "src/**/*.ts" or "docs/{a,b}.md" would' }) };
    if (existing) {
      // `?? 240` as activeClaims reads it: a claim written without ttlMin made this NaN, and
      // toISOString() on an Invalid Date throws — the new claim was saved and the call still failed.
      const exp = new Date(parseTs(existing.since).getTime() + (existing.ttlMin ?? 240) * 60000)
        .toISOString().slice(0, 16).replace('T', ' ');
      result.warning = `area already claimed by ${existing.agent} until ${exp}`;
    }
    return result;
  });
}

export function runRelease(a) {
  if (a.task != null && a.task !== '' && !a.id) {
    const t = runTaskGet({ id: a.task }).task;
    a = { ...a, project: t.project, area: taskClaimArea(t.id) };
  }
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
 *
 * That last decision is right and it had a cost nobody had accounted for: read from another node,
 * this registry describes a different machine and says nothing about it. See writePresenceSnapshot
 * below for the 92 hours that cost, and for the one file per node that fixes it without syncing
 * the directory. The `presence/` gitignore entry carries a trailing slash, which matches only the
 * DIRECTORY — `presence.<node>.json` sits beside it and does travel.
 */
export function presencePath(agent) { return path.join(PRESENCE, slugify(agent) + '.json'); }
export function readPresenceRecord(agent) { return readJson(presencePath(agent)); }
export function loadPresence() {
  let files;
  try { files = fs.readdirSync(PRESENCE).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) { const r = readJson(path.join(PRESENCE, f)); if (r) out.push(r); }
  return out;
}
export function presenceAlive(rec, nowMs = Date.now()) {
  const ttl = rec.ttlMin ?? 15;
  if (ttl === 0) return false;
  return nowMs < parseTs(rec.last_seen).getTime() + ttl * 60000;
}

/* ── One node's registry, published to the mesh ──
 *
 * The incident, measured across three nodes: the same role read as 383 minutes since heartbeat on
 * fir and 8469 minutes — 5.9 days — on pine. Nothing was stale and nothing had diverged.
 * `presence/` is node-local by design (see above), the roles run on fir, the orchestrators run
 * on pine, so the orchestrator was reading pine's registry as if it were the fleet's. It
 * escalated "worker is dead, cannot dispatch" four times while the worker was working: **92 hours**
 * lost to a number that could not mean what it looked like.
 *
 * Syncing `presence/` itself is still wrong for the reason the comment above gives — a file per
 * agent, rewritten every few seconds, would turn every heartbeat in the fleet into pushed git
 * history. So each node publishes ONE snapshot of its own registry instead: `presence.<node>.json`,
 * a single small file, written at most once per PRESENCE_SNAPSHOT_MS.
 *
 * Two properties make this safe in the mesh where syncing the directory was not:
 *
 *   - A node only ever writes the file bearing its OWN name, exactly like `journal.<node>.jsonl`
 *     and `tasks.<node>.events.jsonl`. Two nodes never touch one file, so there is nothing for a
 *     merge to resolve — no union rule needed, no conflict possible. JOURNAL_NODE is already
 *     lowercased and sanitised at the top of this file, so two nodes cannot mint names that differ
 *     only in case either: that collision is what took one node out of this mesh for 246 commits.
 *
 *   - The throttle is deliberately SHORTER than the shortest ttlMin in use (15 minutes by
 *     default). If it were longer, a live agent could read as expired from another node — the same
 *     lie in a new place. Five minutes leaves 3x headroom and cuts the write rate to one small
 *     file per node per five minutes, whatever the heartbeat rate.
 */
export const PRESENCE_SNAPSHOT_MS = Math.max(1000, parseInt(process.env.HUBD_PRESENCE_SNAPSHOT_MS || '', 10) || 300000);
export function presenceSnapshotPath(node = JOURNAL_NODE) { return path.join(HUB, 'presence.' + node + '.json'); }

/** Publish this node's registry. Throttled by the file's own mtime — no extra state to keep in
 *  sync with, and it survives a process restart, which a counter in memory would not. */
export function writePresenceSnapshot({ force = false } = {}) {
  const f = presenceSnapshotPath();
  if (!force) {
    try {
      if (Date.now() - fs.statSync(f).mtimeMs < PRESENCE_SNAPSHOT_MS) return null;
    } catch {}   // no snapshot yet — write the first one
  }
  try { atomicWrite(f, { node: JOURNAL_NODE, written: now(), v: VERSION, agents: loadPresence() }); }
  catch { return null; }
  return f;
}

/** Every OTHER node's published snapshot. Ours is skipped: the live directory is fresher than any
 *  snapshot of it, and reading both would list this node's agents twice. */
export function presenceSnapshots() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(HUB).filter(f => /^presence\..+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    const node = f.slice('presence.'.length, -'.json'.length);
    if (node === JOURNAL_NODE) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(HUB, f), 'utf8')) || {};
      out.push({ node, written: o.written || null, v: o.v || null, agents: Array.isArray(o.agents) ? o.agents : [] });
    } catch { out.push({ node, written: null, v: null, agents: [], unreadable: true }); }
  }
  return out.sort((a, b) => (a.node < b.node ? -1 : 1));
}

/* ── Who may move a queue file ──
 *
 * A shard <role>.<node>.queue.md has ONE writer: the node in its name (a sender appends to its own
 * node's shard, and a waiting loop creates its own node's empty one). Moving it from anywhere else
 * races that writer, and the owner is left with a modify/delete conflict that stops its sync until
 * a person resolves it — reproduced on two clones. So a node moves its own shards, and two kinds
 * that have no writer left: a shard of a node that no longer writes to the mesh (no presence
 * snapshot and no mesh commit for `days`), and a file with no node in its name (written before
 * per-node files existed; nothing writes one now). Two nodes moving the same writerless file at
 * once make the same change, which merges cleanly. An empty file is never moved: it is what a
 * waiting loop creates for itself and the likeliest to be written again. */
export const nodeKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
/** The newest 'YYYY-MM-DD HH:MM' that `re` (global, stamp in group 1) finds in the tail of `file`,
 *  in ms; null when there is none. The content, not the mtime: a git checkout or pull stamps every
 *  file it writes with the time of the pull, which would make a year-old file look written today. */
export function newestStampMs(file, re, size) {
  try {
    if (size == null) size = fs.statSync(file).size;
    if (!size) return null;
    const fd = fs.openSync(file, 'r');
    try {
      // the tail first; the whole file only when one entry is longer than the tail
      for (const n of [Math.min(size, 65536), Math.min(size, 16 * 1048576)]) {
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        let best = null;
        for (const m of buf.toString('utf8').matchAll(re)) {
          const ms = parseTs(m[1]).getTime();
          if (Number.isFinite(ms) && (best == null || ms > best)) best = ms;
        }
        if (best != null || n === size) return best;
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
/** A queue message's header line: `## <stamp> · from <sender>`. */
export const QUEUE_BLOCK_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · from /gm;
const LOG_STAMP_RE = /"ts":"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g;
/** The nodes that still write to the mesh, or null when the hub is not a git mesh at all.
 *  A node counts by its presence snapshot, by the name its sync commits carry, and by its own
 *  files: the newest stamp in its journal, its task log or a queue shard of its name. The files
 *  are the part that does not depend on a name matching: mesh-sync commits under the hostname
 *  unless HUBD_NODE is set where it runs, so a node whose HUBD_NODE differs and whose presence
 *  snapshot had gone stale read as gone, and its shards were the ones gc offered to move. */
export function liveMeshNodes({ root = HUB, days = 30 } = {}) {
  const repo = [root, HUB].find(d => d && fs.existsSync(path.join(d, '.git')));
  if (!repo) return null;
  const live = new Set([JOURNAL_NODE]);
  const since = Date.now() - days * 86400000;
  for (const sn of presenceSnapshots()) { const ms = sn.written ? parseTs(sn.written).getTime() : NaN; if (ms >= since) live.add(nodeKey(sn.node)); }
  for (const n of sh(`git log --since="${Math.max(1, Math.floor(days))} days ago" --format=%cn`, repo).split('\n')) if (n.trim()) live.add(nodeKey(n.trim()));
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const recent = (f, re) => (newestStampMs(f, re) ?? -Infinity) >= since;
  for (const f of ls(HUB)) {
    const node = /^journal\..+\.jsonl$/.test(f) ? journalNodeOf(f) : /^tasks\..+\.events\.jsonl$/.test(f) ? taskEventNodeOf(f) : '';
    if (node && !live.has(nodeKey(node)) && recent(path.join(HUB, f), LOG_STAMP_RE)) live.add(nodeKey(node));
  }
  for (const f of ls(path.join(root, 'queues'))) {
    const m = /^[^.]+\.([^.]+)\.queue\.md$/.exec(f);
    if (m && !live.has(nodeKey(m[1])) && recent(path.join(root, 'queues', f), QUEUE_BLOCK_RE)) live.add(nodeKey(m[1]));
  }
  return live;
}
/** Why THIS node may not move a queue file (null: it may). `live` from liveMeshNodes. */
export function shardHold(node, messages, live) {
  if (!messages) return 'holds no message';
  if (live == null || !node) return null;
  const k = nodeKey(node);
  if (k === JOURNAL_NODE || !live.has(k)) return null;
  return `a shard of node ${node}, which still writes to the mesh: only that node moves it (hub gc there)`;
}

/* ── What a loop is doing, as fields ──
 *
 * `status` is free text for a person. A supervisor that wants to know "is this worker idle, stuck,
 * or three hours into one turn" had only that text, and parsed it with patterns of the wording the
 * loop happened to use — change a word in the loop and the supervisor goes blind without an error.
 * These fields are the same facts in a shape nothing has to parse:
 *
 *   state         turn | waiting | exit (open vocabulary, lowercase)
 *   turn          number of the current or last turn
 *   turn_started  when the current turn began ("now" stamps the write time)
 *   empty_count   consecutive empty polls while waiting
 *   silent_count  consecutive restarts of a model that stopped producing output
 *   exit_reason   one line, with state=exit
 *
 * Each is optional and absent unless given: an old loop's record keeps its old shape.
 *
 * One more is kept by the hub itself: `state_since`, when the current state began. A loop's own
 * counters reset whenever the loop restarts, so "waiting for 55 minutes" read as "3 empty polls"
 * three times over and no supervisor ever saw the hour. The record outlives the loop, so the hub
 * carries the start of a state across heartbeats that repeat it, and restarts it on a change. A
 * turn's start is carried the same way while the turn number stays the same. */
export const HEARTBEAT_STATES_RE = /^[a-z][a-z_-]{0,19}$/;
export function heartbeatState(a = {}, prev = null) {
  const out = {};
  if (a.state != null && a.state !== '') {
    const s = String(a.state).toLowerCase();
    if (!HEARTBEAT_STATES_RE.test(s)) throw new Error(`state "${a.state}": a short lowercase word, e.g. turn | waiting | exit`);
    out.state = s;
  }
  const count = (k) => {
    if (a[k] == null || a[k] === '') return;
    const n = Number(a[k]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a non-negative integer, got "${a[k]}"`);
    out[k] = n;
  };
  count('turn'); count('empty_count'); count('silent_count');
  if (a.turn_started != null && a.turn_started !== '') {
    const v = String(a.turn_started);
    if (v === 'now') out.turn_started = now();
    else if (Number.isFinite(parseTs(v).getTime())) out.turn_started = v;
    else throw new Error(`turn_started "${v}": a timestamp (YYYY-MM-DD HH:MM, ISO) or "now"`);
  }
  if (a.exit_reason != null && a.exit_reason !== '') out.exit_reason = String(a.exit_reason).replace(/\s+/g, ' ').slice(0, 200);
  if (out.state) {
    // a new turn number is a new turn even with no wait between the two
    const same = !!prev && prev.state === out.state && (out.turn == null || prev.turn === out.turn);
    out.state_since = (same && prev.state_since) || now();
    if (out.state === 'turn' && !out.turn_started && same && prev.turn_started) out.turn_started = prev.turn_started;
  }
  return out;
}

export function runHeartbeat(a) {
  // Held to the author rule like every other write: presence keys one record per name, and a
  // placeholder name would merge every session that used it into one row.
  const agent = requireAuthor(a && a.agent, 'agent');
  /* Which hub this agent is actually writing to, resolved through symlinks.
   *
   * A fleet split does not announce itself: roles configured with a different hub path keep
   * heartbeating, keep reporting, keep closing tasks — into a directory nobody else reads. Seen
   * for a full day across five roles (tasks maple-88, -96), and the way it was finally
   * noticed was a human comparing directories by hand. A heartbeat that carries its own base
   * makes the split a line in `hub presence` instead: a record whose hub differs from the reader's
   * is either a second hub or a misrouted role, and both are worth knowing within the minute.
   * realpath, because /home/agent/.hubd and /srv/team/hub are routinely the same directory. */
  let hubReal = HUB;
  try { hubReal = fs.realpathSync(HUB); } catch {}
  const rec = {
    agent, role: a.role || null, status: a.status || null,
    task_id: (a.task_id ?? null), cwd: a.cwd || null,
    node: JOURNAL_NODE, hub: hubReal, last_seen: now(), ttlMin: a.ttlMin ?? 15,
    ...heartbeatState(a, readPresenceRecord(agent)),
  };
  fs.mkdirSync(PRESENCE, { recursive: true });
  atomicWrite(presencePath(agent), rec);
  const snapshot = writePresenceSnapshot();
  return { ok: true, agent, presence: presencePath(agent), ...(snapshot ? { snapshot } : {}) };
}

/**
 * The fleet as far as it can honestly be seen from here: this node's live registry, plus every
 * other node's published snapshot, each row saying WHICH node observed it.
 *
 * `coverage` is the part that matters and the part that was missing. A role nobody reports is
 * indistinguishable from a role that is dead, and that is precisely the confusion that cost 92
 * hours — so every mesh member (taken from who writes journals, which is how membership is
 * observable at all) is listed with the age of its snapshot, or with `snapshot: null` when it has
 * published none. "I cannot see fir" then reads differently from "fir's agents are gone",
 * which is the whole point.
 */
export function runPresence(a = {}) {
  const nowMs = Date.now();
  const ageMin = (ts) => {
    const ms = ts ? parseTs(ts).getTime() : NaN;
    return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / 60000)) : null;
  };
  const rows = loadPresence().map(rec => ({ ...rec, observedOn: JOURNAL_NODE, live: true }));
  const snaps = presenceSnapshots();
  for (const s of snaps) {
    for (const rec of s.agents) {
      rows.push({ ...rec, observedOn: s.node, live: false, reportedBy: s.node, snapshotWritten: s.written });
    }
  }
  /* One agent identity can appear on two nodes — it moved, or the name is reused. Keep the
   * freshest heartbeat and say where the others were, rather than picking silently: a name used
   * by two processes is itself worth seeing (the same call the version-skew report makes). */
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.agent);
    if (!cur || String(cur.last_seen || '') < String(r.last_seen || '')) {
      best.set(r.agent, cur ? { ...r, alsoOn: [...(cur.alsoOn || []), cur.observedOn] } : r);
    } else if (cur.observedOn !== r.observedOn) {
      cur.alsoOn = [...(cur.alsoOn || []), r.observedOn];
    }
  }
  let hubReal = HUB;
  try { hubReal = fs.realpathSync(HUB); } catch {}
  // elsewhere = an agent ON THIS NODE heartbeats into a different hub directory than the one being
  // read: same machine, two hubs, which is the split itself. Compared only within this node on
  // purpose — every remote node legitimately has its own path, and flagging those would be noise
  // that teaches a reader to skip the line. Silent for pre-0.9.20 records, which carry no path.
  let list = [...best.values()].map(rec => ({ ...rec, alive: presenceAlive(rec, nowMs),
    ...(rec.hub && rec.node === JOURNAL_NODE && rec.hub !== hubReal ? { elsewhere: rec.hub } : {}) }));
  if (a.role) list = list.filter(r => r.role === a.role);
  if (a.aliveOnly) list = list.filter(r => r.alive);
  // "Who is here" — by working directory or by the project a cwd resolves to. Through the same
  // predicates runContext's presenceHere uses, so the two never name different people.
  if (a.cwd) list = list.filter(r => underRoot(r.cwd, a.cwd));
  if (a.project) { const slug = slugify(a.project); list = list.filter(r => r.cwd && resolveContext(r.cwd, { local: a.local !== false }).project === slug); }
  list.sort((x, y) => (x.last_seen < y.last_seen ? 1 : -1));   // freshest first

  /* Membership is not "ever wrote a journal" — that set never shrinks, and this hub's journals
   * still carry three retired node names (one of them the same machine under an old hostname).
   * Listing them as SILENT members would report six blind spots where there are two, and a
   * warning that cries about the past is one a reader learns to skip. A member is a node that has
   * written within memberDays; a retired one drops off on its own. */
  const memberDays = a.memberDays ?? 30;
  const cutoff = nowMs - memberDays * 86400000;
  const members = new Set(writerVersions()
    .filter(g => g.node && g.node !== 'legacy' && g.node !== 'life')
    .filter(g => { const ms = g.lastWrite ? parseTs(g.lastWrite).getTime() : NaN; return Number.isFinite(ms) && ms >= cutoff; })
    .map(g => g.node));
  members.add(JOURNAL_NODE);
  // A node whose snapshot we are reading is a member whatever its journal says: without this, a
  // row could name an observedOn that coverage never mentions, which is the same unattributable
  // absence one level along.
  for (const s of snaps) members.add(s.node);
  const byNode = new Map(snaps.map(s => [s.node, s]));
  const coverage = [...members].sort().map(node => {
    if (node === JOURNAL_NODE) return { node, self: true, snapshot: 'live', agents: rows.filter(r => r.live).length };
    const s = byNode.get(node);
    if (!s) return { node, self: false, snapshot: null, agents: 0 };
    return { node, self: false, snapshot: s.written, snapshotAgeMin: ageMin(s.written),
      stale: (ageMin(s.written) ?? Infinity) > PRESENCE_SNAPSHOT_MS / 60000 * 3, agents: s.agents.length,
      ...(s.unreadable ? { unreadable: true } : {}) };
  });
  /* TWO different gaps, and the first version of this reported them as one — caught by running it
   * against the mesh rather than a fixture, which is the only place the difference shows.
   *
   * `blindTo` is a node that has published NOTHING: its agents are unobservable from here, and
   * that is the state the whole 92-hour incident consisted of.
   *
   * `laggingBehind` is a node whose registry IS here and was published a while ago. That is not
   * blindness and must not read as it. The rows from that node carry their own `last_seen` and are
   * judged by their own ttlMin, so nothing they say is any less true; what is missing is only
   * heartbeats made SINCE the snapshot. An idle node refreshes on heartbeat and therefore has an
   * old snapshot precisely because nothing happened on it — calling that a blind spot would flag a
   * quiet machine as an unseen one, and then the warning is back to meaning two things at once. */
  const blind = coverage.filter(c => !c.self && c.snapshot === null).map(c => c.node);
  const lagging = coverage.filter(c => !c.self && c.snapshot !== null && c.stale)
    .map(c => ({ node: c.node, ageMin: c.snapshotAgeMin }));
  return {
    agents: list, coverage,
    ...(blind.length ? { blindTo: blind,
      note: 'no registry at all from ' + blind.join(', ') + ' — a role running there is invisible here, which is NOT the same as dead' } : {}),
    ...(lagging.length ? { laggingBehind: lagging,
      lagNote: lagging.map(l => l.node + ' published ' + l.ageMin + 'm ago').join(', ') +
        ' — the rows from there are as good as their own last_seen; only heartbeats made SINCE are missing' } : {}),
    generated: now(),
  };
}

/** A head's verdict on a branch, as written into the journal: "ACCEPT <sha> <branch> ..." or the
 *  same with a leading "decision:". Null for anything else. */
export function parseVerdict(text) {
  const m = /^\s*(?:decision:\s*)?(ACCEPT|REJECT)\s+([0-9a-f]{7,40})\b(?:\s+([^\s:]+))?/.exec(String(text || ''));
  if (!m) return null;
  const branch = m[3] && !/^[→>-]+$/.test(m[3]) ? m[3] : null;
  return { verdict: m[1].toLowerCase(), sha: m[2], branch };
}

/** A task's title: its first non-empty line, at most `max` characters, cut at a word where one is
 *  near. Old tasks carry a whole brief in `text`; nothing is rewritten, the rest stays one click
 *  away as `text`. */
export function taskTitle(text, max = 80) {
  const first = String(text || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp >= max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(—-]+$/, '') + '…';
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
      id: t.id, project: t.project, title: taskTitle(t.text), text: t.text,
      importance: t.importance, deadline: t.deadline || null,
      assignee: t.assignee || null, depends_on: t.depends_on || [],
      resources: t.resources || [],
      blocked: isBlocked(t), overdue: !!(t.deadline && t.deadline < todayStr),
    };
  }

  const sortOpen = (list) => [...list].sort(byUrgency(todayPlus3));

  const queued = sortOpen(db.tasks.filter(t => t.status === 'open' && !t.assignee)).map(mapTask);
  const inProgress = sortOpen(db.tasks.filter(t => t.status === 'open' && t.assignee)).map(mapTask);
  const doneToday = db.tasks
    .filter(t => t.status === 'done' && t.done && parseTs(t.done).getTime() >= cutoff)
    .sort((a, b) => b.done > a.done ? 1 : -1)
    .map(mapTask);

  const inbox = [...journalEntries()]
    .sort((a, b) => b.ts > a.ts ? 1 : -1)
    .slice(0, 30)
    .map(e => ({ ts: e.ts, project: e.project, agent: e.agent, kind: e.kind, text: e.text }));

  return { queued, inProgress, doneToday, inbox, generated: now() };
}

