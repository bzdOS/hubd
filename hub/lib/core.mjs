import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

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
export let HUB, PROJ, HISTORY, JOURNAL, TASKS, CLAIMS, TASK_EVENTS, RESOURCES;
export function setHubBase(dir) {
  HUB = dir;
  PROJ = path.join(HUB, 'projects');
  HISTORY = path.join(PROJ, 'history');
  RESOURCES = path.join(HUB, 'resources');
  JOURNAL = path.join(HUB, `journal.${JOURNAL_NODE}.jsonl`);
  TASKS = path.join(HUB, 'tasks.json');
  CLAIMS = path.join(HUB, 'claims.json');
  TASK_EVENTS = path.join(HUB, `tasks.${JOURNAL_NODE}.events.jsonl`);
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(HISTORY, { recursive: true });
  fs.mkdirSync(RESOURCES, { recursive: true });
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
      const t = { ...(e.t || {}), id: fid };
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

// Section skeleton scaffolded into a NEW card (no prior card). The engine owns ## Digest
// and ## Facts (auto); these are the owner-written sections every project carries. An
// instance can override the whole block with HUB/card-template.md (e.g. to localise the
// headings) — its content replaces CARD_TEMPLATE verbatim for new cards.
const CARD_TEMPLATE =
  '## Next step\n\n<the one next action — who, by when>\n\n' +
  '## Gates\n\n<kill / scale criteria — name the honest metric to judge by, not vanity>\n\n' +
  '## Metrics\n\n<current honest readings>\n\n' +
  '## Market\n\n<who it is for; is paying demand proven?>\n\n' +
  '## Facts & hypotheses\n\n<what is known (fact) vs what is being tested (hypothesis)>\n\n' +
  '## Decisions\n\n<append-only log: decision · why · date>\n\n' +
  '## Communication\n\n<what has gone out externally vs what is still queued>\n';

function cardScaffold() {
  try {
    const override = path.join(HUB, 'card-template.md');
    if (fs.existsSync(override)) {
      const t = fs.readFileSync(override, 'utf8').trim();
      if (t) return t + '\n';
    }
  } catch { /* fall through to built-in */ }
  return CARD_TEMPLATE;
}

function openTaskCount(slug) {
  try { return loadTasks().tasks.filter(t => t.project === slug && t.status === 'open').length; }
  catch { return 0; }
}

export function runSync(a) {
  const dir = a.path;
  if (!dir || !fs.existsSync(dir)) throw new Error('path does not exist: ' + dir);
  const pname = a.name || path.basename(dir);
  const slug = slugify(pname);
  const git = gitFacts(dir);
  const markers = markerFiles(dir);
  const prev = readCard(pname);
  const oldDigest = prev ? (prev.split('## Digest')[1] || '').split('## Facts')[0].trim() : null;
  const digest = a.digest || oldDigest || '_no digest yet — pass one on the next sync_';

  if (a.digest && oldDigest && a.digest.trim() !== oldDigest) {
    const histFile = path.join(HISTORY, slug + '.md');
    fs.appendFileSync(histFile, `\n---\n### until ${now()} (sync by ${a.agent || 'unknown'})\n${oldDigest}\n`);
  }

  const frontmatter = cardFrontmatter(prev);
  const preserved = cardPreservedSections(prev, new Set(['## Digest', '## Facts (auto)']));
  const ownerBody = prev ? preserved : cardScaffold();   // new card → scaffold template; existing → keep its sections verbatim
  const card = frontmatter +
    `# ${pname}\n\n` +
    `- slug: ${slug}\n- path: ${dir}\n- synced: ${now()} by ${a.agent || 'unknown'}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (ownerBody ? ownerBody + '\n' : '') +
    `## Facts (auto)\n\n` +
    `- open tasks: ${openTaskCount(slug)}\n` +
    (git ? `- branch: ${git.branch} · uncommitted: ${git.dirty} · last commit: ${git.lastCommitAt}\n\n\`\`\`\n${git.last10}\n\`\`\`\n` : '- no git\n') +
    (markers.length ? `- markers: ${markers.join(', ')}\n` : '');
  atomicWrite(cardPath(pname), card);
  journalAppend({ ts: now(), project: slug, agent: a.agent || 'unknown', kind: 'sync', text: 'synced' + (a.digest ? ' with digest' : '') });
  return { ok: true, project: slug, card: cardPath(pname), gitSeen: !!git, hint: a.digest ? undefined : 'Card kept old/empty digest — pass digest="..." to write your summary.' };
}

// Create or update a project card from just (project, digest) — no folder needed.
// Unlike runSync (which reads a real git folder), this lets harvest/triage capture
// projects that are not a local checkout. Preserves hand-written frontmatter and a
// "## Facts" section; archives a changed digest to history.
export function runCardSet(a) {
  const pname = a.project || a.name;
  if (!pname) throw new Error('project required');
  if (!a.digest || !String(a.digest).trim()) throw new Error('digest required');
  const slug = slugify(pname);
  const digest = String(a.digest).trim();
  const prev = readCard(pname);
  const oldDigest = prev ? (prev.split('## Digest')[1] || '').split('## Facts')[0].trim() : null;
  if (oldDigest && digest !== oldDigest) {
    const histFile = path.join(HISTORY, slug + '.md');
    fs.appendFileSync(histFile, `\n---\n### until ${now()} (card set by ${a.by || 'unknown'})\n${oldDigest}\n`);
  }
  const preserved = cardPreservedSections(prev, new Set(['## Digest']));
  const ownerBody = prev ? preserved : cardScaffold();   // new card → scaffold template; existing → keep its sections verbatim
  const card = cardFrontmatter(prev) +
    `# ${pname}\n\n` +
    `- slug: ${slug}\n- set: ${now()} by ${a.by || 'unknown'}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (ownerBody ? ownerBody + '\n' : '');
  atomicWrite(cardPath(pname), card);
  journalAppend({ ts: now(), project: slug, agent: a.by || 'unknown', kind: 'note', text: 'card set: ' + digest.split('\n')[0].slice(0, 80) });
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
    fs.appendFileSync(path.join(HISTORY, 'resource-' + slug + '.md'), `\n---\n### until ${now()} (resource set by ${a.by || 'unknown'})\n${oldDigest}\n`);
  }
  const preserved = cardPreservedSections(prev, new Set(['## Digest']));
  const card = frontToText(pairs) +
    `# ${name}\n\n` +
    `- slug: ${slug}\n- set: ${now()} by ${a.by || 'unknown'}\n\n` +
    `## Digest\n\n${digest}\n\n` +
    (preserved ? preserved + '\n' : '');
  fs.mkdirSync(RESOURCES, { recursive: true });
  atomicWrite(resourcePath(name), card);
  journalAppend({ ts: now(), project: slug, agent: a.by || 'unknown', kind: 'resource', text: 'resource set: ' + slug });
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

export function runReport(a) {
  const e = { ts: now(), project: slugify(a.project), agent: a.agent, kind: a.kind || 'note', text: a.text };
  journalAppend(e);
  return { ok: true, logged: e };
}

export function runStatus() {
  const db = loadTasks();
  const files = fs.readdirSync(PROJ).filter(f => f.endsWith('.md'));
  const projects = files.map(f => {
    const c = fs.readFileSync(path.join(PROJ, f), 'utf8');
    const digest = (c.split('## Digest')[1] || '').split('## Facts')[0].trim().slice(0, 300);
    const synced = (c.match(/- synced: ([^\n]+)/) || [])[1] || '?';
    const slug = f.replace('.md', '');
    const openTasks = db.tasks.filter(t => t.project === slug && t.status === 'open').length;
    return { project: slug, synced, digest, openTasks };
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

// Canonical task category vocabulary: technical | communicative | decision | chore.
// `cat` is the single field for this; `kind` is a legacy alias — don't add new fields
// or invent new category values, keep the set small.
export function runTaskAdd(a) {
  return withLock(TASK_EVENTS, () => {
    const db = loadTasks();
    const id = (db.seq || 0) + 1;
    const t = {
      id, project: slugify(a.project), text: a.text,
      importance: a.importance || 'normal', deadline: a.deadline || null,
      cat: a.cat || null, assignee: a.assignee || null, status: 'open',
      created: now(), by: a.by || 'unknown',
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
  return withLock(TASK_EVENTS, () => {
    const db = loadTasks();
    const t = db.tasks.find(x => String(x.id) === String(a.id));
    if (!t) throw new Error('no task #' + a.id);
    const patch = {};
    for (const k of ['status', 'text', 'deadline', 'cat', 'assignee']) if (a[k] != null) patch[k] = a[k];
    if (Array.isArray(a.depends_on)) patch.depends_on = a.depends_on;
    if (Array.isArray(a.resources)) patch.resources = a.resources.map(slugify);
    if (a.status === 'done') patch.done = now();
    fs.appendFileSync(TASK_EVENTS, JSON.stringify({ ts: now(), node: JOURNAL_NODE, ev: 'set', id: t.id, patch }) + '\n');
    rebuildTaskCache();
    journalAppend({ ts: now(), project: t.project, agent: a.by || 'unknown', kind: 'task', text: '~ task #' + t.id + ' → ' + (a.status || 'edited') });
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
      const m = c.match(/- synced: (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
      if (m) {
        const daysAgo = Math.floor((nowMs - parseTs(m[1]).getTime()) / 86400000);
        if (daysAgo >= staleDays) staleCards.push({ project: f.replace('.md', ''), synced: m[1], daysAgo });
      }
    }
  } catch {}

  const claimsDb = loadClaims();
  return { tasksOpen, journalRecent, staleCards, activeClaims: activeClaims(claimsDb.claims), generated: now() };
}

export function runClaim(a) {
  if (!a.project || !a.area || !a.agent) throw new Error('project, area, agent required');
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
