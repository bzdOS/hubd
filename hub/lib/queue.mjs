/**
 * queue.mjs — Node.js port of queue/qsend.py and queue/qwait.py.
 * Zero external dependencies (Node stdlib only).
 *
 * On-disk format:
 *   queues/<role>.<node>.queue.md — PER-HOST append-only markdown blocks.
 *     Each machine appends only to its OWN file (like journal.<node>.jsonl and
 *     tasks.<node>.events.jsonl), so several machines syncing one hub never
 *     collide on a queue — no git merge conflict, so mesh-sync never aborts on
 *     queues, so cross-node delivery actually works. (The legacy shared file
 *     queues/<role>.queue.md is still READ for back-compat, never written.)
 *   .qstate/<file>.offset — byte offset of the last-read position, PER source
 *     file. Local to the node (.qstate/ is gitignored).
 *   queues/read/<role>.<node>.json — how far <role>'s reader on <node> got in
 *     each source file. Written by that node only, and mesh-synced, so every
 *     node counts what is read the same way (see "Read marks" below).
 *
 * Block format:
 *   \n## YYYY-MM-DD HH:MM · from <sender>\n<text>\n
 *
 * Why per-host: a single shared queues/<role>.queue.md is shared mutable state;
 * two offline nodes appending both edit the same file → git merge conflict →
 * mesh-sync aborts → the waiting node never sees the message. Per-host files are
 * conflict-free by construction (single writer each), and the byte offset stays
 * valid because each file only ever grows by clean append from one writer.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HUB, JOURNAL_NODE, now, escRe, liveMeshNodes, shardHold, loadPresence, ownerRoles, parseTs, recordEnvObservation, clearEnvObservation, requireAuthor, shareMode, touchPresenceIfOwner, withLock, readJson, atomicWrite,
  loadTasks, loadClaims, activeClaims, eligibleOpen, byUrgency, taskTitle, taskClaimArea, runBrief, runTaskGet, ownerWaiting } from './core.mjs';

// A directory is a hubd TEAM ROOT only if it holds a hub-DATA file that a plain
// code checkout never has. NOT `.git` (that is a code repo, not a hub) and NOT a
// bare `queues/` — a MISROUTED send creates exactly `queues/<role>.<node>.queue.md`
// and nothing else, so `queues/` is precisely the false-positive we must reject.
// (This is the bug that silently wrote a handoff into a source repo's queues/
// instead of the real hub, and the waiting node never saw it.)
const HUB_DATA_FILES = ['sections.json', 'tasks.json', 'claims.json', 'HUBD.md'];
function isHubRoot(d) {
  if (HUB_DATA_FILES.some(f => fs.existsSync(path.join(d, f)))) return true;
  try { return fs.readdirSync(d).some(f => /^journal.*\.jsonl$/.test(f)); }
  catch { return false; }
}

let _warnedFallback = false;

/**
 * Resolve the queue root directory, returning both the path and how it was found.
 *
 * Priority:
 *   1. HUBD_TEAM_DIR (or legacy HUBD_QUEUE_DIR) env var                         -> via "env"
 *   2. Walk UP from process.cwd() (max 8 levels): first dir that is a real hub
 *      (has hub DATA — sections/tasks/claims/HUBD/journal, NOT just .git|queues/) -> via "walk-up"
 *   3. Fall back to HUB (~/.hubd)                                                -> via "fallback"
 *
 * On fallback from inside a git repo (a likely misroute site) warn ONCE to stderr,
 * so a queue silently landing in ~/.hubd instead of the repo is visible.
 *
 * @returns {{ root: string, via: 'env' | 'walk-up' | 'fallback' }}
 */
export function resolveQueueRootInfo() {
  const env = process.env.HUBD_TEAM_DIR || process.env.HUBD_QUEUE_DIR;
  if (env) return { root: env, via: 'env' };

  let d = process.cwd();
  let sawRepo = false;
  for (let i = 0; i < 8; i++) {
    if (isHubRoot(d)) return { root: d, via: 'walk-up' };
    if (fs.existsSync(path.join(d, '.git'))) sawRepo = true;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }

  if (sawRepo && !_warnedFallback) {
    _warnedFallback = true;
    process.stderr.write(
      `hubd: cwd is inside a git repo but no hub found above it — using ${HUB}. ` +
      `Set HUBD_TEAM_DIR to be explicit.\n`);
  }
  return { root: HUB, via: 'fallback' };
}

/**
 * Resolve the queue root directory.
 * @returns {string}
 */
export function resolveQueueRoot() {
  return resolveQueueRootInfo().root;
}

/* A role and a subscriber name become PATH COMPONENTS — queues/<role>.<node>.queue.md and
 * .qstate/<subscriber>/ — so they are checked before anything touches the disk. `hub_queue_send`
 * took the role verbatim, and "../../x" wrote x.<node>.queue.md two directories above the hub:
 * over the HTTP transport, a file anywhere the server user can write, from any tenant. Rejected
 * rather than sanitised, the same call secrets.mjs makes: a rewritten name delivers to a queue
 * nobody is waiting on. No dots in a role, because every reader splits <role>.<node> on the dot. */
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SUBSCRIBER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export function assertRole(role) {
  if (typeof role !== 'string' || !ROLE_RE.test(role)) {
    throw new Error(`invalid role ${JSON.stringify(role)}: letters, digits, "-" and "_" only, starting with a letter or digit ` +
      `(a role is part of a file name: queues/<role>.<node>.queue.md)`);
  }
  return role;
}
function assertSubscriber(sub) {
  if (sub == null || sub === '') return sub;
  if (typeof sub !== 'string' || !SUBSCRIBER_RE.test(sub)) {
    throw new Error(`invalid subscriber ${JSON.stringify(sub)}: letters, digits, ".", "-" and "_" only (it names a cursor directory)`);
  }
  return sub;
}

/** Every file that carries this role: <role>.queue.md (legacy) and <role>.<node>.queue.md. */
function roleFileRe(role) {
  const esc = escRe(role);
  return new RegExp(`^${esc}(\\.[^.]+)?\\.queue\\.md$`);
}

/* A queue file is <role>.<node>.queue.md, or <role>.queue.md from before per-node files (still
 * read, never written). A role holds no dot, so the split is exact. */
const SHARD_RE = /^(.+?)(?:\.([^.]+))?\.queue\.md$/;
/** Every queue file in `qdir` as {file, role, node}; [] when there is no such directory. */
export function listShards(qdir) {
  let names = [];
  try { names = fs.readdirSync(qdir); } catch {}
  const out = [];
  for (const file of names) { const m = SHARD_RE.exec(file); if (m) out.push({ file, role: m[1], node: m[2] || null }); }
  return out;
}

/** Move one queue file into queues/archive/ (a numbered name when that one is taken), its ack log
 *  beside it, and its shared cursor into .qstate/_archive/. Moved, never deleted: the mesh guard
 *  accepts a removed queue file only when an identical blob sits in an archive. Returns the
 *  archived path. */
export function archiveQueueFile(root, file) {
  const adir = path.join(root, 'queues', 'archive');
  fs.mkdirSync(adir, { recursive: true });
  let dest = path.join(adir, file);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(adir, file.replace(/\.queue\.md$/, `.${n}.queue.md`));
  fs.renameSync(path.join(root, 'queues', file), dest);
  // The ack log goes with its queue: left behind, it would answer for the next file's id 1.
  const acks = acksPath(path.join(root, 'queues', file));
  if (fs.existsSync(acks) && !fs.existsSync(acksPath(dest))) fs.renameSync(acks, acksPath(dest));
  const cur = path.join(root, '.qstate', `${file}.offset`);
  if (fs.existsSync(cur)) {
    const cdir = path.join(root, '.qstate', '_archive');
    fs.mkdirSync(cdir, { recursive: true });
    fs.renameSync(cur, path.join(cdir, path.basename(dest) + '.offset'));
  }
  return dest;
}

/** The bytes of `file` from `off` to `size`, decoded — cursors are byte offsets, never string ones. */
function readTail(file, off, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(size - off);
    fs.readSync(fd, buf, 0, size - off, off);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/* The subscriber namespaces under a .qstate dir: exactly the directory names a subscriber can have.
 * __watchall__ (the tap root) and _archive (retired namespaces) cannot match SUBSCRIBER_RE, which is
 * why they are named with a leading underscore — every reader skips them by construction. */
const NS_ARCHIVE = '_archive';
function subscriberDirs(stateDir) {
  try {
    return fs.readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && SUBSCRIBER_RE.test(d.name)).map(d => d.name);
  } catch { return []; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/**
 * Roles whose queue fans out: every subscriber sees every message.
 *
 * The default stays a COMPETING-WORKER queue — one message to exactly one reader —
 * because that is what the queue has always been and what task dispatch relies on.
 * Fan-out cannot be inferred from the transport: giving each session its own cursor
 * whenever the caller happens to be a long-lived server would silently turn every
 * work queue into a broadcast, and two sessions would both do the same task and both
 * claim it. Which of the two a role is, is a property of the ROLE, declared once —
 * same shape and spirit as HUB/owner-roles.json.
 *
 * <queue-root>/subscriber-roles.json: ["architect", "cto"]
 */
export function subscriberRoles(root) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(root, 'subscriber-roles.json'), 'utf8'));
    return Array.isArray(arr) ? arr.filter(r => typeof r === 'string' && r) : [];
  } catch { return []; }
}

/* ONE node identity for the whole hub. This used to read the hostname directly while the journal
 * and the task log went through JOURNAL_NODE (which honours HUBD_NODE) — so on a host whose
 * identity had to be normalised by that variable, journal.<node>.jsonl said one thing and
 * <role>.<node>.queue.md said another, for the same machine. That is the ghost-employee bug from
 * the other side: a hostname change already invented a node nobody hired, and half the files
 * following an override while the other half ignore it is how one machine becomes two.
 *
 * Renaming the write target is safe: readers match <role>.<anything>.queue.md, so files written
 * under the old name are still read and no message is stranded — only new appends move. */
function nodeName() {
  return JOURNAL_NODE;
}

/* The queue file to write, given a role and a node — and never a SECOND spelling of one that
 * already exists.
 *
 * The rename above was safe for readers and still cost a node its whole mesh. Two spellings of
 * one host ("Pine" from the raw hostname, "pine" through JOURNAL_NODE) became two tracked
 * paths, and on a case-insensitive filesystem two paths differing only by case are one file for
 * two index entries: git can satisfy only one, `git add -A` stages nothing for the other, and
 * every merge that must write it refuses. One machine sat 228 commits outside its own mesh while
 * its sync retried every 60 seconds.
 *
 * Note where the guard actually does work: on a case-insensitive filesystem the OS already
 * collapses the two names, so nothing there can create the pair. The nodes that CREATE it are the
 * case-sensitive ones, which never feel the damage — it lands on whichever peer runs macOS or
 * Windows. That asymmetry is why this went unnoticed for 228 commits, and why the check has to
 * live on the write path rather than in the place that suffers.
 *
 * So creating the second spelling is the thing to prevent, and prevention belongs at the two
 * places a queue file comes into existence — here. If a case-variant already exists, write to it.
 * Whichever spelling arrived first wins, which is arbitrary but harmless: readers match
 * <role>.<anything>.queue.md, cursors are keyed by file name, and one file per role and node is
 * the whole invariant. `hub doctor` still reports any pair that predates this.
 *
 * The decision is a pure function over a list of names, deliberately. On the filesystem this test
 * suite mostly runs on, the OS collapses the two names, so an integration test cannot tell a
 * working guard from a missing one — removing the guard leaves every filesystem-level assertion
 * passing. Only the case-sensitive nodes exercise the branch that matters, and they are the ones
 * not running the tests. So the branch is separated out and tested on its own. */
export function pickExistingVariant(names, want) {
  const lower = want.toLowerCase();
  for (const f of names) if (f !== want && f.toLowerCase() === lower) return f;
  return null;
}

export function resolveQueueFile(qdir, role, node) {
  const want = `${role}.${node}.queue.md`;
  const exact = path.join(qdir, want);
  if (fs.existsSync(exact)) return exact;
  let names = [];
  try { names = fs.readdirSync(qdir); } catch {}
  const found = pickExistingVariant(names, want);
  return found ? path.join(qdir, found) : exact;
}

/**
 * Deliver everything past `f`'s cursor and advance it — atomically w.r.t. other
 * waiters on the SAME cursor. Without the lock, two competing workers polling one
 * shared cursor could both see size > offset in the same instant and both deliver
 * the block: "goes to exactly one of them" held by timing luck, not construction.
 * The lock scope is one offset file for the few ms of a read; a contended or stale
 * lock skips this file for THIS poll (the next poll retries) instead of failing the
 * wait. Subscribers pay the same negligible cost for no benefit (their cursor has no
 * competitor by construction) — one code path beats two. Returns the new text, or
 * null when there is nothing new.
 */
/* The cursor file carries a byte offset AND, on a second line, the header of the last block
 * delivered — the watermark. See docs/queue-invariant.md.
 *
 * Format-compatible on purpose: every existing reader does parseInt(trim(contents)), and parseInt
 * stops at the first non-digit, so an older hubd on the same node still reads the offset and
 * ignores the rest. .qstate is node-local and gitignored, so none of this reaches the mesh. */
export const readCursor = (offFile) => {
  try {
    const raw = fs.readFileSync(offFile, 'utf8');
    const nl = raw.indexOf('\n');
    return { off: parseInt(raw.trim(), 10) || 0, mark: nl === -1 ? null : (raw.slice(nl + 1).trim() || null) };
  } catch { return { off: 0, mark: null }; }
};
const writeCursor = (offFile, off, mark) => {
  fs.writeFileSync(offFile, mark ? `${off}\n${mark}\n` : String(off), 'utf8');
  shareMode(offFile);   // a cursor in a shared hub belongs to the group, or the next user stalls
};

const BLOCK_HEAD = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from .*$/gm;
const lastHeaderIn = (text) => { const m = text.match(BLOCK_HEAD); return m ? m[m.length - 1] : null; };

/* ── Read marks: how far a role's reader got, visible from every node ──
 *
 * The cursor is node-local by design, and that made every count taken anywhere but on the reader's
 * own node wrong. Measured on a live mesh: one role's queue, 71 messages; the node that wrote them
 * said 44 pending, the node that reads them said 0, and a head on the first node spent its turns on
 * a backlog that did not exist. The ack log could not settle it either: every reader, taps
 * included, appended "delivered" for every block it was handed, so a queue handed out from its
 * start seventeen times over left 361 lines for 61 ids.
 *
 * So the reader publishes its position. queues/read/<role>.<node>.json is written by the node that
 * read and by no other, and travels with the mesh: one writer per file, so no merge can conflict.
 * Per queue file it holds the header of the last block handed out, the byte offset after it, and
 * when. The header is what is trusted: offsets agree across nodes only while nobody trims the file,
 * and a trimmed or recreated file must not look read. Any node then counts a file as read up to the
 * furthest of its own cursor and every node's mark.
 *
 * Only a role's own reader writes one — the shared cursor, or a subscriber of a broadcast role. A
 * tap (queueWaitAll) watches the fleet and reads for nobody, so it writes no mark and no ack. */
const READ_DIR = 'read';
const markFile = (qdir, role, node) => path.join(qdir, READ_DIR, `${role}.${node}.json`);

/** Publish that `reader` ({ role, sub }) has been handed file `f` up to byte `off`, block `mark`. */
function recordRead(qdir, reader, f, off, mark) {
  const p = markFile(qdir, reader.role, nodeName());
  withLock(p, () => {
    const m = readJson(p, {});
    const slot = reader.sub ? ((m.subs ??= {})[reader.sub] ??= {}) : (m.files ??= {});
    slot[f] = { mark, off, at: now() };
    // A file archived since (by any node) leaves no position worth publishing.
    for (const s of [m.files || {}, ...Object.values(m.subs || {})])
      for (const k of Object.keys(s)) if (!fs.existsSync(path.join(qdir, k))) delete s[k];
    atomicWrite(p, JSON.stringify(m, null, 1) + '\n');
  });
}

/** Every node's read marks for `role`, as [{ node, files, subs }]. */
function readMarks(qdir, role) {
  let names = [];
  try { names = fs.readdirSync(path.join(qdir, READ_DIR)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^([^.]+)\.([^.]+)\.json$/.exec(n);   // neither a role nor a node holds a dot
    if (!m || m[1] !== role) continue;
    const j = readJson(path.join(qdir, READ_DIR, n), null);
    if (j && typeof j === 'object') out.push({ node: m[2], files: j.files || {}, subs: j.subs || {} });
  }
  return out;
}

/** The marks for file `f` — the shared reader's, or subscriber `sub`'s — as [{ node, entry }]. */
const marksFor = (marks, f, sub = null) => marks
  .map(m => ({ node: m.node, entry: sub ? (m.subs[sub] || {})[f] : m.files[f] }))
  .filter(x => x.entry && x.entry.mark);

/* The byte offset just past the block a mark names, or null when the file no longer holds it. The
 * offset the mark carries is taken when the last header before it is the mark itself — one window
 * read, not the whole file; otherwise the header is searched for, last occurrence first, the same
 * way a shrunken file's cursor finds its watermark. `buf`, when the caller already holds the file. */
function markOffset(full, size, entry, buf = null) {
  const { mark, off } = entry;
  if (Number.isInteger(off) && off > 0 && off <= size) {
    const from = Math.max(0, off - 65536);
    let win = ''; try { win = buf ? buf.subarray(from, off).toString('utf8') : readTail(full, from, off); } catch {}
    if (lastHeaderIn(win) === mark) return off;
  }
  let text; try { text = buf ? buf.toString('utf8') : fs.readFileSync(full, 'utf8'); } catch { return null; }
  for (let at = text.lastIndexOf(mark); at !== -1; at = at ? text.lastIndexOf(mark, at - 1) : -1) {
    const end = at + mark.length;
    if ((at && text[at - 1] !== '\n') || (end < text.length && text[end] !== '\n')) continue;   // not a whole line
    const next = new RegExp(BLOCK_HEAD.source, 'gm');
    next.lastIndex = end;
    const n = next.exec(text);
    // a block ends on the newline before the next header: where a reader's cursor stops
    return Buffer.byteLength(n ? text.slice(0, n.index - 1) : text, 'utf8');
  }
  return null;
}

/* How far a file has been read: the furthest of this node's cursor `local` (null: none here) and
 * the marks `entries`. `by` is the node whose mark is furthest, null when nothing beats the cursor
 * here; `seen`, whether anything has read the file at all. */
function readPosition(full, size, local, entries, buf = null) {
  let off = local == null ? 0 : Math.min(Math.max(0, local), size), by = null, at = null, seen = local != null;
  for (const { node, entry } of entries) {
    const o = markOffset(full, size, entry, buf);
    if (o == null) continue;
    seen = true;
    if (o > off) { off = o; by = node; at = entry.at || null; }
  }
  return { off, by, at, seen };
}

// Block ID in a queue header: `## YYYY-MM-DD HH:MM · from <sender> · id <N>`
const BLOCK_ID_RE = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from [^\n·]+? · id (\d+)/gm;

/* Every block in `text`, header fields and body. The header is the one queueSend writes,
 * `## <ts> · from <sender>[ · id <n>][ · task #<ids>]`, matched whole so that a timestamp quoted
 * inside a message body never starts a block. */
const BLOCK_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · from ([^\n·]+?)(?: · id (\d+))?(?: · task #([^\n]+))?$/gm;
function blocksIn(text) {
  const out = [];
  let prev = null;
  for (const m of text.matchAll(BLOCK_RE)) {
    if (prev) out.push({ ...prev.h, body: text.slice(prev.end, m.index) });
    prev = { h: { ts: m[1], from: m[2].trim(), id: m[3] ? Number(m[3]) : null, task: m[4] ? m[4].trim() : null }, end: m.index + m[0].length };
  }
  if (prev) out.push({ ...prev.h, body: text.slice(prev.end) });
  return out;
}

// ── Delivery acknowledgement ──
// When a block is delivered (cursor advanced past it), its id is recorded as "delivered".
// When the consumer confirms processing, it moves to "acked". The sender can query unacked
// blocks to detect zombie consumers that read but never responded.

function acksPath(qfile) { return qfile.replace(/\.queue\.md$/, '.acks'); }

function readAcks(acksFile) {
  try {
    const raw = fs.readFileSync(acksFile, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}

function writeAck(acksFile, id, status) {
  fs.appendFileSync(acksFile, JSON.stringify({ id, status, ts: now() }) + '\n', 'utf8');
  shareMode(acksFile);
}

/* Where the cursor belongs after the file shrank.
 *
 * Resetting to 0 was right for a file that was RECREATED and wrong for one that was PURGED —
 * and purging is routine here: two commits removed 15531 and 13422 lines of consumed messages
 * from queue files, because the files had grown past fifteen thousand lines and hubd offers no
 * operation for trimming them. Every surviving block then got delivered a second time, silently,
 * to workers whose contract is at-most-once.
 *
 * The watermark settles it without knowing what was removed. Found in the new content: the purge
 * cut above it, so resume just past that block. Absent: it was purged together with everything
 * before it, so every remaining block postdates it and really is undelivered — and a genuinely
 * recreated file lands in the same branch and wants the same answer.
 *
 * On a repeated header — timestamps are minute-resolution, so one sender can write two identical
 * ones — take the LAST. That errs toward delivering less rather than twice, which is the
 * direction at-most-once points. */
function offsetAfterShrink(text, mark) {
  if (!mark) return 0;
  const at = text.lastIndexOf(mark);
  if (at === -1) return 0;
  const after = text.indexOf('\n## ', at + mark.length);
  return Buffer.byteLength(after === -1 ? text : text.slice(0, after + 1), 'utf8');
}

/* A cursor this consumer cannot WRITE is the one failure that used to look exactly like an empty
 * queue. Measured 2026-09-14 across four live roles: 12 KB, 27 KB, 43 KB of orders sat undelivered
 * for a day while every wait answered NO_CHANGES and every send answered "delivered" (task
 * maple-98). The mechanism: mesh-sync runs as root on the fleet nodes, a root-run hub command
 * leaves a root-owned .qstate/<file>.offset behind, and the role — a different user — then fails to
 * write it. drainFile caught THAT the same way it caught a busy lock, and a busy lock is the only
 * error where "skip this poll, retry next" is the right answer.
 *
 * Two changes, and the second is the one that matters. A non-transient error is now raised instead
 * of swallowed, AND queueWait checks writability BEFORE it blocks — so the stall is reported when
 * the queue is still empty, not first discovered by the message that gets lost. */
export class QueueStalled extends Error {
  constructor(file, cause) {
    super(`queue cursor for ${path.basename(file)} cannot be written (${cause && cause.code ? cause.code : cause}): ` +
      `messages cannot be delivered and would be silently held forever. ` +
      `Fix the owner/permissions of ${file} and its directory (on a fleet node: chgrp -R <group> and chmod -R g+rwX over the hub dir), then retry.`);
    this.name = 'QueueStalled';
    this.file = file;
    this.code = cause && cause.code;
  }
}

/** Can this process advance these cursors? Returns the unwritable ones — never throws. */
export function cursorStalls(stateDir, files) {
  const out = [];
  try {
    // A state dir not there yet is judged by its parent: the first read that needs it creates it,
    // and this check must not (hub doctor and a dry hub queue gc call it, and they write nothing).
    fs.accessSync(fs.existsSync(stateDir) ? stateDir : path.dirname(stateDir), fs.constants.W_OK);
  } catch (e) { return [{ file: stateDir, code: e.code || 'EACCES' }]; }
  for (const f of files) {
    const offFile = path.join(stateDir, `${f}.offset`);
    if (!fs.existsSync(offFile)) continue;            // absent is fine: it will be created in a writable dir
    try { fs.accessSync(offFile, fs.constants.W_OK); }
    catch (e) { out.push({ file: offFile, code: e.code || 'EACCES' }); }
  }
  return out;
}

/* `reader` is the role and subscriber this cursor reads for — null for a tap, which reads for
 * nobody and so leaves no ack and no read mark behind. */
function drainFile(qdir, stateDir, f, reader = null) {
  const offFile = path.join(stateDir, `${f}.offset`);
  const full = path.join(qdir, f);
  const sizeOf = () => { try { return fs.statSync(full).size; } catch { return 0; } };
  if (sizeOf() === readCursor(offFile).off) return null;   // nothing new — don't even lock
  let text, read = null;
  try {
    text = withLock(offFile, () => {
      let { off, mark } = readCursor(offFile);
      const sz = sizeOf();   // both re-read under the lock
      if (sz < off) {        // the file shrank: resume after the watermark, and deliver from there now
        let text = ''; try { text = fs.readFileSync(full, 'utf8'); } catch {}
        off = Math.min(offsetAfterShrink(text, mark), sz);
        writeCursor(offFile, off, mark);
      }
      if (sz === off) return null;                    // a competitor drained it first
      const chunk = readTail(full, off, sz);
      const last = lastHeaderIn(chunk) || mark;
      writeCursor(offFile, sz, last);
      if (reader) {
        if (last) read = { off: sz, mark: last };
        // One "delivered" per block: handing a block out again — a cursor reset, a second
        // subscriber of a broadcast — does not deliver it again.
        try {
          const af = acksPath(full);
          const have = new Set(readAcks(af).map(a => a.id));
          for (const m of chunk.matchAll(BLOCK_ID_RE)) {
            const id = parseInt(m[1], 10);
            if (id && !have.has(id)) { writeAck(af, id, 'delivered'); have.add(id); }
          }
        } catch {}
      }
      return chunk.trim() || null;
    });
  } catch (e) {
    // A contended lock is the ONE transient case: skip this file for this poll, retry next.
    if (e && /hub busy/.test(String(e.message))) return null;
    throw new QueueStalled(offFile, e);
  }
  // Outside the cursor's lock, and never fatal: the block is already handed out, and a mark that
  // could not be written only leaves the other nodes' counts behind until the next read.
  if (read) { try { recordRead(qdir, reader, f, read.off, read.mark); } catch {} }
  return text;
}

/**
 * Append a message block to <root>/queues/<role>.<node>.queue.md (this node's
 * own file). Creates the queues/ directory if it does not exist.
 * Returns the path to the queue file.
 *
 * @param {string} role
 * @param {string} text
 * @param {{ from: string, root?: string, node?: string }} options
 * @returns {string} path to the queue file
 */
/* Which task a message is about. A HOLD reply to a task once sat consumed in a queue while the
 * task itself stayed plain open/high with no trace of the blocker for four days — the reply and
 * the task had no way to reference each other. So a sender may name the task, the reference is
 * stamped into the block header (durable, mesh-synced, and still matching the header pattern
 * every reader already uses), and a consumer gets the ids back with the text so it can report
 * against them instead of guessing what the message was about. */
export const TASK_REF_RE = /·\s*task\s*#([^\s·]+)/gi;
export function parseTaskRefs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TASK_REF_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function queueSend(role, text, { from, root, node, task } = {}) {
  // A queue block is a durable, mesh-synced write that says "from <sender>" forever —
  // so the sender is held to the same rule as every other author. This used to default
  // to 'unknown' (CLI) / 'mcp' (server): exactly the placeholders requireAuthor refuses
  // everywhere else, on the one durable channel that skipped the rule. The MCP floor
  // (HUBD_AGENT) fills an omitted `from` before it reaches here.
  const sender = requireAuthor(from, 'from');
  assertRole(role);
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  fs.mkdirSync(qdir, { recursive: true });
  const nd = node || nodeName();
  const qfile = resolveQueueFile(qdir, role, nd);

  const ts = now();
  // Block identity: a monotonic counter per file, so the sender can ask "was block N delivered?"
  // and the consumer can ack individual blocks. It also counts past every id the file's ack log
  // still holds: a file emptied or replaced by hand used to start again at 1, and its new id 1
  // was then already "delivered" or "acked" by the old file's lines. Archiving moves the ack log
  // with the file, so only an archived queue starts a new one at 1.
  let blockId = 1;
  try {
    const existing = fs.readFileSync(qfile, 'utf8');
    const matches = existing.match(/^## .* · id (\d+)/gm);
    if (matches) {
      const nums = matches.map(m => parseInt(m.match(/id (\d+)/)[1], 10));
      blockId = Math.max(...nums) + 1;
    }
  } catch {}
  for (const a of readAcks(acksPath(qfile))) if (Number.isInteger(a.id) && a.id >= blockId) blockId = a.id + 1;
  // The task ref goes AFTER "from <sender>", so the header still matches the `## <ts> · from `
  // prefix every existing reader (peekQueueDepth, doctor, the archive) keys on.
  const ref = (task ?? '') !== '' ? ` · task #${String(task).trim()}` : '';
  const entry = `\n## ${ts} · from ${sender} · id ${blockId}${ref}\n${String(text).trim()}\n`;

  // append is atomic on POSIX for small writes (same guarantee as Python version)
  fs.appendFileSync(qfile, entry, 'utf8');
  shareMode(qfile);          // a queue file another user must append to as well
  // A queue reply is the one write that never touches the journal, and it is exactly how an
  // owner answers a button — so presence would miss the human's most characteristic act.
  touchPresenceIfOwner(sender);
  return qfile;
}

/**
 * Block until new content appears in ANY of this role's queue files
 * (<role>.<node>.queue.md for every node, plus the legacy <role>.queue.md).
 *
 *   - Per-file byte offset in <root>/.qstate/<file>.offset.
 *   - Each poll: for every source file, deliver bytes past its offset; if a file
 *     shrank (truncated/recreated) reset that file's offset to 0.
 *   - New content from several files in one poll is concatenated.
 *   - Poll every 2000 ms until `timeout` seconds elapse.
 *
 * Single-consumer guard: advisory warning if another live waiter is detected
 *   (marker <root>/.qstate/<role>.waiter, refreshed each poll, removed on exit).
 *
 * @param {string} role
 * @param {{ timeout?: number, root?: string }} options
 * @returns {Promise<{ changed: true, text: string } | { changed: false }>}
 */
/* ── A role's queue as a view on its tasks ──
 *
 * Orders and tasks were two stores, and work fell between them. An order taken by a turn that did
 * nothing was gone while its task stayed open; a cancellation queued BEHIND the order it cancelled
 * arrived after the order was executed; "a task is assigned and no order was ever sent" was a whole
 * class of idle time that only an outside observer could see. So the work itself becomes the queue:
 *
 *   - the view is the role's open, ready tasks (every dependency closed), most urgent first;
 *   - reading it consumes nothing — a task leaves the view only when it is closed;
 *   - starting is a claim on `task:<id>` with a TTL; while it holds, the task is in progress and
 *     not offered again, and when it lapses (a dead session, an abandoned turn) the task is back;
 *   - cancelling is closing the task, so there is nothing left in the queue to execute;
 *   - "idle" is a ready task with no claim — one read of the hub, no inference from a loop's text.
 *
 * Messages keep working exactly as before and ride along: the newest blocks that name a task are
 * attached to it, so a clarification is read with the work it clarifies. */

export function roleWork(role, { root, messages = 5 } = {}) {
  const tasks = loadTasks().tasks;
  const { list } = eligibleOpen(tasks, { assignee: role });
  const claims = activeClaims(loadClaims().claims || []);
  const today3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const blocks = recentBlocks({ root, to: [role], textChars: 2000 }).filter(b => b.task);
  return [...list].sort(byUrgency(today3)).map(t => {
    const c = claims.find(x => x.area === taskClaimArea(t.id));
    const until = c ? new Date(parseTs(c.since).getTime() + (c.ttlMin ?? 240) * 60000).toISOString().slice(0, 16).replace('T', ' ') : null;
    const about = blocks.filter(b => b.task === String(t.id)).slice(-messages)
      .map(b => ({ ts: b.ts, from: b.from, id: b.id, text: b.text }));
    return { id: t.id, project: t.project, title: taskTitle(t.text), text: t.text, importance: t.importance || null,
      deadline: t.deadline || null, claim: c ? { agent: c.agent, since: c.since, until, note: c.note || null } : null,
      ...(about.length ? { messages: about } : {}) };
  });
}

/** The delivered text split back into blocks, with the ones about closed tasks held back: a
 *  cancellation closes the task, and the order still sitting in the file must not run after it. */
function withholdClosed(text) {
  const tasks = new Map(loadTasks().tasks.map(t => [String(t.id), t]));
  const heads = [...String(text).matchAll(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from .*$/gm)];
  if (!heads.length) return { text, skipped: [] };
  const keep = [String(text).slice(0, heads[0].index)], skipped = [];
  heads.forEach((h, i) => {
    const block = String(text).slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const refs = parseTaskRefs(h[0]);
    const closed = refs.length && refs.every(r => tasks.has(r) && tasks.get(r).status !== 'open');
    if (closed) skipped.push({ header: h[0], tasks: refs, status: refs.map(r => tasks.get(r).status) });
    else keep.push(block);
  });
  return { text: keep.join('').trim(), skipped };
}

export async function queueWait(role, { timeout = 540, root, subscriber, fromNow = false, work = false } = {}) {
  assertRole(role);
  assertSubscriber(subscriber);
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  // A subscriber gets its OWN cursor namespace, the same trick queueWaitAll already
  // uses for __watchall__: several sessions can then subscribe to one role without
  // consuming each other's messages. Two conditions, both required: the caller has an
  // identity to be a subscriber WITH, and the role is declared a fan-out role. Absent
  // either, the cursor stays where it has always been — shared per node — so competing
  // workers keep at-most-once delivery and existing offsets keep working.
  const declared = subscriberRoles(r).includes(role);
  const fanout = !!subscriber && declared;
  const stateDir = fanout ? path.join(r, '.qstate', subscriber) : path.join(r, '.qstate');
  // Declaring the role is the fix for the conflict recorded below; once declared, stop
  // reporting it. Cheap: clearEnvObservation only writes when it actually holds one.
  if (declared) clearEnvObservation('cursor-conflict', role);

  fs.mkdirSync(qdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Ensure this node's own file exists (so a fresh waiter has a file to track). Through
  // resolveQueueFile, so a waiter never creates a second spelling of a file already here — the
  // other half of the deadlock, and the easier half to miss, since waiting looks read-only.
  const ownFile = resolveQueueFile(qdir, role, nodeName());
  if (!fs.existsSync(ownFile)) { fs.writeFileSync(ownFile, '', 'utf8'); shareMode(ownFile); }

  // Match <role>.queue.md (legacy) and <role>.<node>.queue.md (per-host). Node
  // names have no dots, so a single optional [^.]+ segment is exact per role.
  const fileRe = roleFileRe(role);
  // A cursor that does not exist yet reads as offset 0, so a NEW subscriber
  // namespace replays the whole queue on its first wait. For a human joining a
  // broadcast that is right — the history is the point. For a supervisor whose
  // only job is to notice the NEXT message it is wrong twice over: it fires
  // immediately with a payload of already-handled traffic, and it does so every
  // time the subscriber name changes. Observed for real: declaring a role
  // fan-out and starting a monitor delivered 74 KB of the day's own backlog as
  // if it had just arrived.
  //
  // fromNow seeds any missing cursor at each file's current end, so the first
  // wait blocks on what happens next. Deliberately only seeds MISSING cursors:
  // an existing one is never rewound or skipped forward, or a restarted monitor
  // would silently drop whatever landed while it was down.
  if (fromNow) {
    fs.mkdirSync(stateDir, { recursive: true });
    for (const f of (() => { try { return fs.readdirSync(qdir).filter(x => fileRe.test(x)); } catch { return []; } })()) {
      const off = path.join(stateDir, `${f}.offset`);
      if (!fs.existsSync(off)) {
        let size = 0; try { size = fs.statSync(path.join(qdir, f)).size; } catch {}
        fs.writeFileSync(off, String(size), 'utf8'); shareMode(off);
      }
    }
  }
  const waiterFile = path.join(stateDir, `${role}.waiter`);

  const sourceFiles = () => {
    try { return fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return []; }
  };

  function writeWaiter() {
    fs.writeFileSync(waiterFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), 'utf8');
    shareMode(waiterFile);
  }

  // A marker whose process is gone is litter, not a competitor: the `finally` below only runs on a
  // clean exit, so every killed session (a fleet respawn, a client restart) left one behind. Six sat
  // on two nodes on 2026-09-14, and each new waiter reported a conflict that did not exist. Clear it
  // here — the only place that already knows whether the pid is alive.
  try {
    const w = JSON.parse(fs.readFileSync(waiterFile, 'utf8'));
    if (w.pid !== process.pid && !pidAlive(w.pid)) { try { fs.unlinkSync(waiterFile); } catch {} }
  } catch { /* no marker or unreadable — fine */ }

  // Single-consumer guard: warn if a fresh, live competing waiter exists.
  let competitor = null;
  try {
    const w = JSON.parse(fs.readFileSync(waiterFile, 'utf8'));
    if (w.pid !== process.pid && (Date.now() - new Date(w.since).getTime()) < 10000 && pidAlive(w.pid)) competitor = w;
  } catch { /* no marker or unreadable — fine */ }
  // A subscriber id that outlives the process (HUBD_AGENT, HUBD_SESSION, --as) can be held by two
  // live sessions at once — two sessions on one machine with the same HUBD_AGENT. They then split a
  // broadcast between them, each seeing half. Recorded while it is true, cleared when it is not.
  const sharedKey = fanout ? `${role} as ${subscriber}` : null;
  if (competitor) {
    // Sharing a cursor is the conflict, not sharing a role: distinct subscribers
    // have their own cursor namespace and never reach this warning.
    process.stderr.write(`warning: another waiter (pid ${competitor.pid}) shares this cursor — one live consumer per cursor\n`);
    // stderr is invisible to an MCP client, so this used to be a warning nobody read.
    // Record it: an env check turns it into "declare the role, or run one waiter".
    if (!declared) recordEnvObservation('cursor-conflict', role);
    else if (sharedKey) recordEnvObservation('subscriber-shared', sharedKey);
  } else if (sharedKey) clearEnvObservation('subscriber-shared', sharedKey);
  // A work queue that is back to one waiter is healthy again: cleared the same way, or the notice
  // outlives its cause forever — on one fleet it rode on every tool answer for a day after the
  // duplicate waiters were gone, and an orchestrator escalated it as a live defect.
  else if (!declared) clearEnvObservation('cursor-conflict', role);

  // Before blocking, not after: a consumer that cannot advance its cursors would otherwise sit in a
  // long-poll that can only ever answer NO_CHANGES, and the first message to arrive would be the one
  // that discovers it — by being lost. Checked every call, because ownership changes underneath a
  // long-lived waiter (a root-run command, a git pull as another user).
  {
    const bad = cursorStalls(stateDir, sourceFiles());
    if (bad.length) throw new QueueStalled(bad[0].file, { code: bad[0].code });
  }

  writeWaiter();
  try {
    const deadline = Date.now() + timeout * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parts = [];
      const stalled = [];
      for (const f of sourceFiles()) {
        let t = null;
        // One unreadable cursor must not hide the files that ARE deliverable — but it is
        // reported either way, never swallowed.
        try { t = drainFile(qdir, stateDir, f, { role, sub: fanout ? subscriber : null }); }
        catch (e) { if (e && e.name === 'QueueStalled') { stalled.push(e); continue; } throw e; }
        if (t) parts.push(t);
      }
      // With `work`, the role's ready tasks are part of what wakes it: an unclaimed one means there
      // is something to do whether or not a message arrived — including after a turn that did
      // nothing with it, which is exactly the case where a consumed order used to be lost.
      const view = work ? roleWork(role, { root: r }) : null;
      const offered = view ? view.filter(w => !w.claim) : [];
      if (parts.length || offered.length) {
        let text = parts.join('\n').trim();
        let skipped = [];
        if (work && text) ({ text, skipped } = withholdClosed(text));
        const tasks = parseTaskRefs(text);
        if (text || offered.length || skipped.length) {
          return { changed: true, text, ...(tasks.length ? { tasks } : {}),
            ...(view ? { work: view, offered: offered.map(w => w.id) } : {}),
            ...(skipped.length ? { skipped } : {}),
            ...(stalled.length ? { stalled: stalled.map(s => ({ file: s.file, code: s.code })) } : {}) };
        }
      }
      if (stalled.length) throw stalled[0];
      if (Date.now() >= deadline) return { changed: false };

      writeWaiter();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    try { fs.unlinkSync(waiterFile); } catch {}
  }
}

/**
 * Block until new content appears in ANY queue file, across every role — a
 * supervisory subscription for an orchestrator that reacts to whichever agent
 * reports first, instead of polling role-by-role or ssh-ing into each host to
 * check.
 *
 * NOT the same consumer as a role's own `queueWait(role)` — this uses a
 * SEPARATE offset namespace (.qstate/__watchall__/<file>.offset), so watching
 * everything never steals a message from a role's own consumer (a competing-worker
 * role keeps its at-most-once delivery; this is a tap, not a competing reader).
 *
 * A tap is a subscriber by definition, so a `subscriber` here always gets its own
 * cursor and needs no role declaration: several orchestrators may watch the fleet at
 * once, and none of them consumes from anyone.
 *
 * @param {{ timeout?: number, root?: string }} options
 * @returns {Promise<{ changed: true, events: Array<{ role: string, node: string|null, text: string }> } | { changed: false }>}
 */
export async function queueWaitAll({ timeout = 540, root, subscriber } = {}) {
  assertSubscriber(subscriber);
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  // Same reasoning as queueWait: __watchall__ already keeps taps off a role's own
  // consumer, but two orchestrators tapping at once still shared one cursor.
  const stateDir = subscriber
    ? path.join(r, '.qstate', '__watchall__', subscriber)
    : path.join(r, '.qstate', '__watchall__');

  fs.mkdirSync(qdir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Any <role>.queue.md or <role>.<node>.queue.md — no role filter.
  const fileRe = /^[^.]+(\.[^.]+)?\.queue\.md$/;
  const waiterFile = path.join(stateDir, 'waiter');

  const sourceFiles = () => {
    try { return fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return []; }
  };

  function parseFile(f) {
    const m = f.match(/^(.+?)(?:\.([^.]+))?\.queue\.md$/);
    return m ? { role: m[1], node: m[2] || null } : { role: f, node: null };
  }

  function writeWaiter() {
    fs.writeFileSync(waiterFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), 'utf8');
    shareMode(waiterFile);
  }

  try {
    const w = JSON.parse(fs.readFileSync(waiterFile, 'utf8'));
    if (w.pid !== process.pid && !pidAlive(w.pid)) { try { fs.unlinkSync(waiterFile); } catch {} }
    else if (w.pid !== process.pid && (Date.now() - new Date(w.since).getTime()) < 10000 && pidAlive(w.pid)) {
      process.stderr.write(`warning: another all-queues waiter (pid ${w.pid}) is active\n`);
    }
  } catch { /* no marker or unreadable — fine */ }

  {
    const bad = cursorStalls(stateDir, sourceFiles());
    if (bad.length) throw new QueueStalled(bad[0].file, { code: bad[0].code });
  }

  writeWaiter();
  try {
    const deadline = Date.now() + timeout * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const events = [];
      const stalled = [];
      for (const f of sourceFiles()) {
        let t = null;
        try { t = drainFile(qdir, stateDir, f); }
        catch (e) { if (e && e.name === 'QueueStalled') { stalled.push(e); continue; } throw e; }
        if (t) {
          const { role, node } = parseFile(f);
          const tasks = parseTaskRefs(t);
          events.push({ role, node, text: t, ...(tasks.length ? { tasks } : {}) });
        }
      }
      if (events.length) return { changed: true, events, ...(stalled.length ? { stalled: stalled.map(s => ({ file: s.file, code: s.code })) } : {}) };
      if (stalled.length) throw stalled[0];
      if (Date.now() >= deadline) return { changed: false };

      writeWaiter();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally {
    try { fs.unlinkSync(waiterFile); } catch {}
  }
}

/**
 * Non-consuming peek at how many messages are waiting in a role's queue — for
 * hub_brief/hub_presence to show "N queued for role X" without stealing from
 * the role's own hub_queue_wait consumer. Reads the SAME per-file byte offsets
 * queueWait uses (.qstate/<file>.offset), and every node's read marks, but never
 * writes either, so calling this never advances anyone's read position.
 *
 * @param {string} role
 * @param {{ root?: string }} options
 * @returns {{ pending: number, oldestWaiting: string|null }}
 */
export function peekQueueDepth(role, { root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');
  const fileRe = roleFileRe(role);
  let files;
  try { files = fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return { pending: 0, oldestWaiting: null }; }
  const marks = readMarks(qdir, role);

  let pending = 0, oldest = null;
  for (const f of files) {
    const offFile = path.join(stateDir, `${f}.offset`);
    let size = 0; try { size = fs.statSync(path.join(qdir, f)).size; } catch {}
    const { off } = readPosition(path.join(qdir, f), size, fs.existsSync(offFile) ? readCursor(offFile).off : null, marksFor(marks, f));
    if (size <= off) continue;
    // A file this user cannot read is a stall for doctor to name, not a crash inside hub_brief.
    let tail;
    try { tail = readTail(path.join(qdir, f), off, size); } catch { continue; }
    // Match the FULL block header (incl. "· from") that queueSend writes — a bare
    // timestamp pattern also matched such a line quoted inside a message body and
    // inflated the count.
    const heads = tail.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm) || [];
    pending += heads.length;
    for (const h of heads) {
      const ts = h.slice(3, 19);
      if (!oldest || ts < oldest) oldest = ts;
    }
  }
  return { pending, oldestWaiting: oldest };
}

/** Confirm that a delivered block was processed by the consumer.
 *  Writes "acked" to the blocks ack file, or "delivered" if not yet recorded.
 *  Idempotent: acking an already-acked block is a no-op.
 *  @returns {{ ok: true, id: number, status: string }} */
export function queueAck(role, id, { root } = {}) {
  // the ack log compares ids as numbers, and a "12" from a client would never match its own ack
  const blockId = Number(id);
  if (!Number.isInteger(blockId) || blockId < 1) throw new Error(`block id must be a positive integer, got ${JSON.stringify(id)}`);
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const fileRe = roleFileRe(role);
  let files;
  try { files = fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { files = []; }
  // Find the block across all queue files for this role
  let found = false;
  for (const f of files) {
    const af = acksPath(path.join(qdir, f));
    const acks = readAcks(af);
    if (acks.some(a => a.id === blockId && a.status === 'acked')) return { ok: true, id: blockId, status: 'acked' };
    if (acks.some(a => a.id === blockId)) { found = true; break; }
  }
  // Write to the first queue file's acks (the block id is unique per file)
  for (const f of files) {
    const full = path.join(qdir, f);
    try {
      const text = fs.readFileSync(full, 'utf8');
      if (new RegExp(`· id ${blockId}(?![0-9])`).test(text)) {   // id 1 is not id 12
        const af = acksPath(full);
        const acks = readAcks(af);
        if (!acks.some(a => a.id === blockId)) writeAck(af, blockId, 'delivered');
        writeAck(af, blockId, 'acked');
        return { ok: true, id: blockId, status: 'acked' };
      }
    } catch {}
  }
  if (found) return { ok: true, id: blockId, status: 'acked' }; // already acked
  throw new Error(`block id ${blockId} not found in any queue file for role ${role}`);
}

/** Return blocks that have been delivered but not yet acked.
 *  @returns {{ blocks: Array<{id, status, ts, roleFile}>, total: number }} */
export function getUnacked(role, { root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const fileRe = roleFileRe(role);
  let files;
  try { files = fs.readdirSync(qdir).filter(f => fileRe.test(f)); } catch { return { blocks: [], total: 0 }; }
  const blocks = [];
  for (const f of files) {
    // The ack log is append-only, so an acked block still has its "delivered" line: an id is
    // unacked only while no "acked" line follows it, and a redelivery does not count it twice.
    const pending = new Map();
    for (const a of readAcks(acksPath(path.join(qdir, f)))) {
      if (a.status === 'acked') pending.set(a.id, null);
      else if (a.status === 'delivered' && !pending.has(a.id)) pending.set(a.id, a);
    }
    for (const a of pending.values()) if (a) blocks.push({ id: a.id, status: a.status, ts: a.ts, roleFile: f });
  }
  return { blocks, total: blocks.length };
}

/** Extend peekQueueDepth with unacked counts. */
export function peekQueueDepthWithAcks(role, opts = {}) {
  const d = peekQueueDepth(role, opts);
  const u = getUnacked(role, opts);
  return { ...d, unacked: u.total, unackedBlocks: u.blocks.slice(0, 20) };
}

/**
 * Every role's queue depth in one call, cross-referenced with presence
 * (core.mjs's fleet registry) so a brief can show "N queued for role X, agent
 * last-seen T" — visibility into delivery without screen-scraping to check who
 * is even listening. Roles are discovered from queue FILENAMES: a role only
 * shows up once something has been sent to it at least once. Rows with nothing
 * pending and no known presence are dropped — this augments hub_brief's recent-
 * attention view, not a permanent roster (that's hub_presence).
 *
 * @param {{ root?: string }} options
 * @returns {Array<{ role: string, pending: number, oldestWaiting: string|null, lastSeen: string|null }>}
 */
/**
 * How recently each transport last moved this hub's queues.
 *
 * The queue *depth* answers "how much is pending". It cannot answer "is
 * replication converging", and the two look identical from the outside: a quiet
 * queue and a stopped transport both read as silence. On 2026-08-27 three agents
 * on two machines spent real time on exactly that ambiguity — one of them read
 * silence as "nothing to report" three separate times, and once it was not
 * silence at all but a stalled counterpart.
 *
 * Two transports run concurrently on the same directory (see
 * docs/interop.md -> Transport), and each leaves an observable artefact:
 *
 *   git mesh-sync   the last commit touching queues/ in the hub repo
 *   Matrix bridge   the mtime of <hub>/.mxstate/<file>.offset, which the bridge
 *                   rewrites every time it ingests that queue
 *
 * Neither is authoritative about the other, so both are reported, and a
 * transport that leaves no artefact is reported as unknown rather than as
 * healthy. Pure filesystem/git reads — no network, no assumption that either
 * transport is configured.
 */
export function transportHealth({ root } = {}) {
  const r = root ?? resolveQueueRoot();
  const out = { git: { lastSync: null, ageSec: null }, bridge: { lastIngest: null, ageSec: null, queues: 0 } };
  const now = Date.now();

  // git mesh-sync: the newest commit that touched queues/.
  try {
    // Bounded on purpose: this runs inside a hub_brief request, and a git lock
    // held by a concurrent mesh-sync would otherwise hang the call forever.
    // A missed reading degrades to "unknown", which is the honest answer anyway.
    const iso = execFileSync('git', ['-C', r, 'log', '-1', '--format=%cI', '--', 'queues/'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (iso) {
      out.git.lastSync = iso;
      out.git.ageSec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
    }
  } catch {}

  // the Matrix hubd bridge: newest .mxstate offset mtime.
  try {
    const mx = path.join(r, '.mxstate');
    const files = fs.readdirSync(mx).filter(f => f.endsWith('.offset'));
    out.bridge.queues = files.length;
    let newest = 0;
    for (const f of files) {
      const m = fs.statSync(path.join(mx, f)).mtimeMs;
      if (m > newest) newest = m;
    }
    if (newest) {
      out.bridge.lastIngest = new Date(newest).toISOString();
      out.bridge.ageSec = Math.max(0, Math.round((now - newest) / 1000));
    }
  } catch {}

  return out;
}

export function queueSummaryForBrief({ root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const shards = listShards(qdir);
  if (!shards.length) return [];
  const roles = new Set(shards.map(s => s.role));

  let presence = [];
  try { presence = loadPresence(); } catch {}
  const owners = new Set(ownerRoles());
  const fanoutRoles = new Set(subscriberRoles(r));

  // Which roles were ever consumed at all — the difference between "N waiting for someone who
  // is away" and "N waiting for someone who has never existed". Both used to print identically.
  const everRead = new Set(shards.filter(s => fileEverRead(r, s.file)).map(s => s.role));

  return [...roles].sort().map(role => {
    // A declared broadcast role is consumed through PER-READER cursors
    // (.qstate/<subscriber>/) — nothing ever advances the shared cursor peekQueueDepth
    // reads, so a byte count from it is a phantom backlog that only grows. Per-reader
    // depth is not one number; report the role as fanout instead of a wrong count.
    const fanout = fanoutRoles.has(role);
    const { pending, oldestWaiting } = fanout ? { pending: null, oldestWaiting: null } : peekQueueDepth(role, { root: r });
    const forRole = presence.filter(p => p.role === role).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
    const ageDays = oldestWaiting ? Math.floor((Date.now() - parseTs(oldestWaiting).getTime()) / 86400000) : null;
    return { role, fanout, pending, oldestWaiting, lastSeen: forRole[0] ? forRole[0].last_seen : null,
      isButton: owners.has(role), ageDays, neverRead: !everRead.has(role) && !owners.has(role) };
  }).filter(s => s.pending > 0 || s.lastSeen);
}

/* ── Queue lifecycle ──
 * A queue file is born on the first send to a role and never dies. In this hub that left 43
 * files against ONE live cursor: 42 roles nobody had ever listened on — mostly one-off
 * experiments (revtest, difftest, teamtest, ...) — still counted as pending work by
 * hub_brief and read as fleet load by anyone glancing at it. Backlog addressed to a consumer
 * that never existed is not backlog, and a number that only ever grows teaches its reader to
 * ignore the number.
 *
 * "Never read" is the discriminator, not age. A cursor under .qstate, or a read mark from any
 * node, means somebody really did consume this file through hub_queue_wait. Two things
 * deliberately do NOT count as reading:
 * a tap (.qstate/__watchall__/) — an orchestrator watching the fleet was never that role's
 * consumer — and a HUMAN owner role, whose queue is read as a file by a person, so a missing
 * cursor there is normal rather than evidence of a ghost.
 *
 * Nothing is deleted. A ghost is MOVED to queues/archive/, so every message stays readable and
 * the move is one reviewable rename in the mesh's git history instead of a silent loss. */
/** Has THIS node ever consumed this role — any of its per-host files. The discriminator between
 *  "a backlog" and "the only view a machine that does not run the role can have". */
export function everConsumedHere(role, { root } = {}) {
  const r = root ?? resolveQueueRoot();
  const re = roleFileRe(role);
  let files = [];
  try { files = fs.readdirSync(path.join(r, 'queues')).filter(f => re.test(f)); } catch { return false; }
  return files.some(f => queueCursorSeen(r, f));
}

export function queueCursorSeen(root, file) {
  const st = path.join(root, '.qstate');
  if (fs.existsSync(path.join(st, `${file}.offset`))) return true;
  // subscriberDirs skips the tap root (a tap is not a consumer) and the archive.
  return subscriberDirs(st).some(d => fs.existsSync(path.join(st, d, `${file}.offset`)));
}

/** Has ANY node read this file as its role's reader: a cursor here, or a read mark from anywhere.
 *  queueCursorSeen is the same question asked of this node alone. */
export function fileEverRead(root, file) {
  if (queueCursorSeen(root, file)) return true;
  const sh = SHARD_RE.exec(file);
  if (!sh) return false;
  return readMarks(path.join(root, 'queues'), sh[1])
    .some(m => (m.files[file] && m.files[file].mark) || Object.values(m.subs).some(s => s && s[file] && s[file].mark));
}

/** The nodes whose reader has a read mark for any of this role's files, newest first. */
export function whereRead(role, { root } = {}) {
  const r = root ?? resolveQueueRoot();
  const latest = new Map();
  for (const m of readMarks(path.join(r, 'queues'), role)) {
    for (const e of [...Object.values(m.files), ...Object.values(m.subs).flatMap(s => Object.values(s || {}))]) {
      if (e && e.mark && (!latest.has(m.node) || (e.at || '') > latest.get(m.node))) latest.set(m.node, e.at || '');
    }
  }
  return [...latest].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([node, at]) => ({ node, at: at || null }));
}

/**
 * Every queue file with what decides its fate: was it ever consumed, is anyone present for
 * its role, how old is its newest message. Pure read — never moves or writes anything.
 *
 * @param {{ root?: string, days?: number }} options
 * @returns {Array<{file, role, node, bytes, messages, newest, ageDays, read, lastSeen, isOwner, ghost}>}
 */
export function queueInventory({ root, days = 30 } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const shards = listShards(qdir);
  if (!shards.length) return [];
  let presence = [];
  try { presence = loadPresence(); } catch {}
  const owners = new Set(ownerRoles());
  const nowMs = Date.now();

  return shards.map(({ file: f, role, node }) => {
    const full = path.join(qdir, f);
    let text = '', bytes = 0, mtimeMs = nowMs;
    try { text = fs.readFileSync(full, 'utf8'); } catch {}
    try { const st = fs.statSync(full); bytes = st.size; mtimeMs = st.mtimeMs; } catch {}
    const heads = text.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm) || [];
    const stamps = heads.map(h => h.slice(3, 19));
    const newest = stamps.length ? stamps.reduce((x, y) => (x > y ? x : y)) : null;
    // An empty file (queueWait creates one for its own node before anything is sent) has no
    // message to date, so fall back to the file's own age — otherwise it is ageless and never
    // collectable, which is the wrong answer for the emptiest kind of ghost.
    const ageDays = Math.floor((nowMs - (newest ? parseTs(newest).getTime() : mtimeMs)) / 86400000);
    const lastSeen = presence.filter(p => p.role === role).map(p => p.last_seen).sort().pop() || null;
    const read = fileEverRead(r, f);
    const isOwner = owners.has(role);
    // A cursor this user cannot write stops delivery dead while every other number here looks
    // healthy — so it is measured where the numbers are read, not only where a wait would trip
    // over it (task maple-98).
    const stalled = cursorStalls(path.join(r, '.qstate'), [f]).map(s => s.code)[0] || null;
    return { file: f, role, node, bytes, messages: heads.length, newest, ageDays, read, lastSeen, isOwner,
      ...(stalled ? { stalled } : {}),
      ghost: !read && !lastSeen && !isOwner && ageDays >= days };
  });
}

/* Queue files that were trimmed or replaced outside hubd.
 *
 * A cursor whose recorded offset is past the file's current size is direct evidence: the file was
 * shorter than something had already read from it, which only happens if it lost content after
 * that read. No git, no heuristic, no false positives.
 *
 * The alternative — comparing the node in each filename against the authors of its commits — is a
 * better forensic tool than a monitor. It does find real cross-node writes (one file here carried
 * commits from three nodes), but it also flags renamed files, nodes that are not in the git mesh
 * at all (their files are committed by whichever node received them), hostname case, and history
 * that was already resolved. A monitor that cries about settled history is one a reader learns to
 * skip. So the cursor comparison is what doctor carries, and the author check stays a thing you
 * run by hand when doctor has already told you where to look.
 *
 * This is reported rather than prevented because the trimming is LEGITIMATE: the files had grown
 * past fifteen thousand lines and hubd has no operation for compacting them, so it happens with a
 * shell redirect. The watermark in drainFile keeps that from re-delivering everything; naming it
 * here is how the missing operation stops being invisible. */
export function outOfBandTrims({ root } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');
  const out = [];
  const check = (subscriber, dir) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter(x => x.endsWith('.queue.md.offset')); } catch { return; }
    for (const n of names) {
      const file = n.replace(/\.offset$/, '');
      let size = null;
      try { size = fs.statSync(path.join(qdir, file)).size; } catch { continue; }   // gone: that is gc's business
      const { off, mark } = readCursor(path.join(dir, n));
      if (off > size) out.push({ file, subscriber, cursor: off, size, lost: off - size, hasMark: !!mark });
    }
  };
  check(null, stateDir);
  for (const d of subscriberDirs(stateDir)) check(d, path.join(stateDir, d));
  return out.sort((a, b) => b.lost - a.lost);
}

/* Queues holding messages that nobody has taken, RIGHT NOW — not in thirty days.
 *
 * `ghost` above needs ageDays >= 30, which is the correct threshold for "archive this" and the
 * wrong one for "did anything happen". The case it misses is the one that costs work: a task is
 * dispatched to a role with no consumer running, `hub queue send` reports success, and the hub
 * looks busy while nothing is happening. On this hub two roles were sent work twice in one
 * afternoon and it sat there; the only thing that ever noticed was a third agent writing
 * "REPEATED ESCALATION" in prose, hours later. A send that cannot be delivered should not read
 * as a send that was.
 *
 * Scope, stated because it bounds the claim: "read" is mesh-wide (a cursor here or a read mark
 * from any node), but presence is node-local. So this answers "no node has ever read these, and
 * no agent for the role is running here". A reader on another node that runs a hubd from before
 * read marks leaves none, and is still invisible from this one; the caller has to say so rather
 * than let a reader assume the stronger claim. */
export function strandedQueues({ root, days = 30 } = {}) {
  return queueInventory({ root, days })
    .filter(x => x.messages > 0 && !x.read && !x.lastSeen && !x.isOwner && !x.ghost)
    .sort((a, b) => b.messages - a.messages || (a.file < b.file ? -1 : 1));
}

/**
 * One host-agnostic ledger of a role's traffic: how much has been DELIVERED and how much is
 * still pending, aggregated across every per-host file.
 *
 * Why this exists: per-host files each look authoritative on their own. A reply that had
 * already been consumed elsewhere sat in `worker.<host>.queue.md`, and read with
 * plain `cat` from another host it looked like it had never been delivered — there was no view
 * that answered "delivered or pending?" without opening N files and knowing which cursor
 * belonged to which. Byte offsets are split on a Buffer, never on a JS string: a cursor counts
 * bytes, and slicing UTF-16 code units instead would miscount every non-ASCII message.
 *
 * "Delivered" is read through readPosition: this node's cursor or any node's read mark, whichever
 * got further. So the same mesh gives the same ledger on every node. `cursor` stays this node's
 * own, for forensics; `readBy` names the node whose mark set the position (null: this node).
 *
 * @param {{ root?: string, role?: string }} options
 */
export function queueLedger({ root, role } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');
  const shards = listShards(qdir);
  const fanoutRoles = new Set(subscriberRoles(r));
  const owners = new Set(ownerRoles());
  const HEAD = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm;
  const countHeads = (s) => (s.match(HEAD) || []).length;
  const localSubs = subscriberDirs(stateDir);
  const marksByRole = new Map();

  const byRole = new Map();
  for (const { file: f, role: rl, node } of shards) {
    if (role && rl !== role) continue;
    if (!marksByRole.has(rl)) marksByRole.set(rl, readMarks(qdir, rl));
    const marks = marksByRole.get(rl);
    const full = path.join(qdir, f);
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(full); } catch {}
    const offFile = path.join(stateDir, `${f}.offset`);
    const cursor = fs.existsSync(offFile) ? Math.min(Math.max(0, readCursor(offFile).off), buf.length) : null;
    const pos = readPosition(full, buf.length, cursor, marksFor(marks, f), buf);
    const total = countHeads(buf.toString('utf8'));
    const delivered = countHeads(buf.subarray(0, pos.off).toString('utf8'));
    // Per-subscriber cursors (broadcast roles): each reader has its own position, so there is
    // no single "delivered" for the role — report the readers instead of averaging them into a
    // number that is true for nobody. A reader is one with a cursor here or a mark from anywhere.
    const subs = new Map();
    for (const d of localSubs) {
      const c = path.join(stateDir, d, `${f}.offset`);
      if (fs.existsSync(c)) subs.set(d, readCursor(c).off);
    }
    for (const m of marks) for (const s of Object.keys(m.subs)) if (m.subs[s] && m.subs[s][f] && !subs.has(s)) subs.set(s, null);
    const readers = [];
    for (const [s, local] of subs) {
      const p = readPosition(full, buf.length, local, marksFor(marks, f, s), buf);
      if (!p.seen) continue;
      readers.push({ subscriber: s, delivered: countHeads(buf.subarray(0, p.off).toString('utf8')), on: p.by || (local != null ? 'here' : null) });
    }
    if (!byRole.has(rl)) byRole.set(rl, { role: rl, fanout: fanoutRoles.has(rl), isButton: owners.has(rl), total: 0, delivered: 0, pending: 0, files: [], readers: [] });
    const agg = byRole.get(rl);
    agg.total += total; agg.delivered += delivered; agg.pending += total - delivered;
    agg.files.push({ file: f, node, total, delivered, pending: total - delivered, bytes: buf.length,
      cursor, readTo: pos.seen ? pos.off : null, readBy: pos.by, readAt: pos.at });
    for (const rd of readers) {
      const found = agg.readers.find(x => x.subscriber === rd.subscriber);
      if (!found) { agg.readers.push({ subscriber: rd.subscriber, delivered: rd.delivered, on: rd.on ? [rd.on] : [] }); continue; }
      found.delivered += rd.delivered;
      if (rd.on && !found.on.includes(rd.on)) found.on.push(rd.on);
    }
  }
  /* A broadcast role has no shared cursor: every reader keeps its own, and nothing ever advances
   * the one this ledger read. Reporting its arithmetic as "delivered / pending" produced a number
   * that is true for nobody and only ever grows — and it was quoted as evidence of a delivery
   * failure that was happening somewhere else entirely (task maple-98: "kestrel, 26896 bytes
   * pending" for a head that was working all day). So say who the readers are and how far each one
   * is behind, and refuse to print a single number that cannot exist. */
  for (const agg of byRole.values()) {
    if (!agg.fanout) continue;
    agg.sharedCursorPending = agg.pending;      // kept for forensics, never the headline
    agg.delivered = null; agg.pending = null;
    for (const rd of agg.readers) rd.behind = agg.total - rd.delivered;
    agg.readers.sort((a, b) => b.behind - a.behind);
  }
  return { roles: [...byRole.values()].sort((a, b) => (a.role < b.role ? -1 : 1)) };
}

/* ── Subscriber namespaces that nobody reads with any more ──
 *
 * Every per-reader cursor namespace (.qstate/<subscriber>/, and taps under __watchall__/) lived
 * forever, and a dead one read as a reader "behind" in `hub queue status` indistinguishable from a
 * live one (task maple-99). Liveness is observable: a waiting reader rewrites its .waiter
 * marker every poll and its offsets on every delivery, so the newest mtime inside the namespace is
 * its last sign of life. Idle past `days` = retired — MOVED to .qstate/_archive/, never deleted, so a
 * reader that comes back after a long absence can be restored by moving the directory back. */
export function subscriberNamespaces({ root, days = 7 } = {}) {
  const r = root ?? resolveQueueRoot();
  const st = path.join(r, '.qstate');
  const nowMs = Date.now();
  const out = [];
  const scan = (dir, tap) => {
    for (const name of subscriberDirs(dir)) {
      const full = path.join(dir, name);
      let newest = 0;
      try { for (const f of fs.readdirSync(full)) { try { newest = Math.max(newest, fs.statSync(path.join(full, f)).mtimeMs); } catch {} } } catch {}
      if (!newest) { try { newest = fs.statSync(full).mtimeMs; } catch {} }
      const ageDays = Math.floor((nowMs - newest) / 86400000);
      out.push({ name, tap, dir: full, lastActive: newest ? new Date(newest).toISOString().slice(0, 16).replace('T', ' ') : null,
        ageDays, stale: ageDays >= days });
    }
  };
  scan(st, false);
  scan(path.join(st, '__watchall__'), true);
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/** Move stale namespaces into .qstate/_archive/ (taps into _archive/__watchall__/). */
export function archiveStaleSubscribers({ root, days = 7 } = {}) {
  const r = root ?? resolveQueueRoot();
  const moved = [], failed = [];
  for (const ns of subscriberNamespaces({ root: r, days }).filter(n => n.stale)) {
    const destDir = path.join(r, '.qstate', NS_ARCHIVE, ...(ns.tap ? ['__watchall__'] : []));
    try {
      fs.mkdirSync(destDir, { recursive: true });
      let dest = path.join(destDir, ns.name);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(destDir, `${ns.name}.${n}`);
      fs.renameSync(ns.dir, dest);
      moved.push((ns.tap ? '__watchall__/' : '') + ns.name);
    } catch { failed.push(ns.name); }
  }
  return { moved, failed };
}

/**
 * Archive the ghost queues. Dry by default — prints what it WOULD move, so the first run is
 * always safe to type. `apply` moves them into queues/archive/, never unlinks.
 *
 * @param {{ root?: string, days?: number, apply?: boolean }} options
 */
/* Which ghosts THIS node may move: shardHold in core (its own shards and writerless ones, never
 * another live node's, never an empty file). The others are listed as `held`, with the reason. */
export function runQueueGc({ root, days = 30, apply = false, subscriberDays = 7 } = {}) {
  const r = root ?? resolveQueueRoot();
  const inv = queueInventory({ root: r, days });
  const live = liveMeshNodes({ root: r, days: Math.max(days, 30) });
  const why = (x) => shardHold(x.node, x.messages, live);
  const held = inv.filter(x => x.ghost && why(x)).map(x => ({ ...x, why: why(x) }));
  const ghosts = inv.filter(x => x.ghost && !why(x));
  // Report what the age threshold is holding back, never just what it caught: in this hub 42
  // of 43 files had never been consumed but only 5 were older than the default 30 days, and a
  // bare "5 ghosts" would read as "the other 38 are fine".
  const neverRead = inv.filter(x => !x.read && !x.lastSeen && !x.isOwner).length;
  // Reader namespaces are the other thing a queue leaves behind, on a much shorter clock: a
  // subscriber idle for a week is gone, while a queue file idle for a week may just be quiet.
  const staleSubscribers = subscriberNamespaces({ root: r, days: subscriberDays }).filter(n => n.stale);
  if (!apply) return { apply: false, days, count: ghosts.length, ghosts, held, live: inv.length - ghosts.length - held.length, neverRead, total: inv.length,
    subscriberDays, staleSubscribers };
  const subs = archiveStaleSubscribers({ root: r, days: subscriberDays });
  const dir = path.join(r, 'queues', 'archive');
  const moved = [], failed = [];
  for (const g of ghosts) {
    try { archiveQueueFile(r, g.file); moved.push(g.file); } catch { failed.push(g.file); }
  }
  return { apply: true, days, count: ghosts.length, moved, failed, archive: dir, ghosts, held,
    subscriberDays, staleSubscribers, subscribersArchived: subs.moved, subscribersFailed: subs.failed };
}

/**
 * Roll up the owner-role rows from queueSummaryForBrief into the single line
 * task #159 asks for: "N buttons waiting (oldest X days)". A "button" is a
 * pending message in a HUMAN-owner's queue (HUB/owner-roles.json) — a decision
 * only OWNER can make, packaged by an agent down to a <=30s call (see AGENTS.md's
 * "prep vs button" split). Pure function over already-computed rows — no I/O.
 *
 * @param {Array<{ role: string, pending: number, oldestWaiting: string|null, isButton: boolean, ageDays: number|null }>} rows
 * @returns {{ count: number, oldestDays: number|null, items: Array }}
 */
/* ── What is actually waiting, not how many bytes ──
 *
 * buttonsSummary answers "6 waiting, oldest 61 days". That number was right and useless: the
 * items it counted had been sitting since 2026-07-10, and finding out WHAT they were meant opening
 * the queue file and scrolling past two months of blocks, which is precisely the friction that let
 * them rot in the first place. A count tells the owner that they are behind. A list lets them
 * answer one and be done.
 *
 * So: one row per pending block, with its age, its sender, and its first line — the line every
 * sender in this hub already uses as the subject ("BUTTON (#195, <=30s): publish @bzdos/hubd?").
 * Nothing new is asked of senders and no format is enforced; the convention that already exists is
 * simply read.
 *
 * WHAT THIS DOES NOT DO. The spec around it wanted every owner item to carry `proposal` and
 * `default_on_silence`, with hub_queue_send REFUSING items that lack them and a sweep inside
 * hub_brief EXECUTING the default once an expiry passed — hibernate, kill, defer. That half is
 * refused, and not on grounds of effort:
 *
 *   - Executing a default on silence is hubd deciding the owner's work for them because they did
 *     not answer fast enough. Silence is not consent, and an engine that reads it as consent is
 *     worse than a queue that grows. The owner's own law on buttons says a default must never be
 *     an outward action taken in their name; killing their task is inward, which makes it easier
 *     to justify and no more theirs.
 *   - A hard refusal in queueSend breaks every existing sender in the fleet at once, to enforce a
 *     field shape that has never been written down anywhere the senders can read.
 *
 * What survives is the honest part: make the queue legible, then let the person decide. Age is
 * reported so an unanswered item is visibly a decision being deferred — which is the thing the
 * spec was really after — without anything pretending to have made it.
 *
 * Pure read: no cursor is moved, nothing is delivered. Reading a queue to LOOK at it must not
 * consume it (that is a bug this project has already had) — the offsets are untouched.
 *
 * @param {{ root?: string, roles?: string[], limit?: number, subjectChars?: number }} options
 * @returns {Array<{role,file,ts,from,task,ageDays,subject}>} oldest first
 */
export function ownerQueueItems({ root, roles, limit = 20, subjectChars = 100 } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const stateDir = path.join(r, '.qstate');
  const want = new Set(roles && roles.length ? roles : ownerRoles());
  if (!want.size) return [];
  const out = [];
  for (const { file: f, role } of listShards(qdir)) {
    if (!want.has(role)) continue;
    const { off } = readCursor(path.join(stateDir, `${f}.offset`));
    let text;
    try {
      const size = fs.statSync(path.join(qdir, f)).size;
      if (size <= off) continue;
      text = readTail(path.join(qdir, f), off, size);
    } catch { continue; }

    // The full header, block id included: without the id every block written since ids exist
    // matched nothing here, and the owner's list went empty while the count said there was work.
    for (const h of blocksIn(text)) {
      const subject = h.body.split('\n').map(l => l.trim()).find(Boolean) || '';
      const ms = parseTs(h.ts).getTime();
      out.push({
        role, file: f, ts: h.ts, from: h.from, task: h.task,
        ageDays: Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 86400000) : null,
        subject: subject.length > subjectChars ? subject.slice(0, subjectChars) + '…' : subject,
      });
    }
  }
  out.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));   // oldest first: that is the queue
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Blocks written inside a time window, across every host's file for a role — read-only, no cursor
 * involved, so it answers "what was said" rather than "what is unread here". `to` restricts by the
 * role a file belongs to, `from` by the sender. Only the tail of each file is read: a window of
 * days never needs a file's whole history, and some role files run to hundreds of kilobytes.
 *
 * @returns {Array<{role,node,ts,from,id,task,subject,text}>} oldest first
 */
export function recentBlocks({ root, to, from, sinceMs = 0, tailBytes = 262144, subjectChars = 160, textChars = 1200 } = {}) {
  const r = root ?? resolveQueueRoot();
  const qdir = path.join(r, 'queues');
  const toSet = to ? new Set(to) : null;
  const fromSet = from ? new Set(from) : null;
  const out = [];
  for (const { file: f, role, node } of listShards(qdir)) {
    if (toSet && !toSet.has(role)) continue;
    let text;
    try {
      const file = path.join(qdir, f);
      const size = fs.statSync(file).size;
      if (!size) continue;
      text = readTail(file, Math.max(0, size - tailBytes), size);
    } catch { continue; }
    for (const h of blocksIn(text)) {
      const ms = parseTs(h.ts).getTime();
      if (!(ms >= sinceMs)) continue;
      if (fromSet && !fromSet.has(h.from)) continue;
      const b = h.body.trim();
      const subject = b.split('\n').map(l => l.trim()).find(Boolean) || '';
      out.push({ role, node, ts: h.ts, from: h.from, id: h.id, task: h.task,
        subject: subject.length > subjectChars ? subject.slice(0, subjectChars) + '…' : subject,
        text: b.length > textChars ? b.slice(0, textChars) + '…' : b });
    }
  }
  out.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  return out;
}

export function buttonsSummary(rows) {
  // A fanout role carries pending:null (per-reader cursors, see queueSummaryForBrief),
  // so `pending > 0` also keeps a broadcast owner role out of the rollup — the count
  // would otherwise never clear.
  const items = (rows || []).filter(r => r.isButton && r.pending > 0);
  const count = items.reduce((n, r) => n + r.pending, 0);
  const oldestDays = items.length ? Math.max(...items.map(r => r.ageDays ?? 0)) : null;
  return { count, oldestDays, items };
}

/* ── What the CLI and the MCP server both answer ── */

/** hub brief: the engine's brief plus what only this module can read (core cannot import it). */
export function briefWithQueues({ root, ...a } = {}) {
  const r = root ?? resolveQueueRoot();
  const queues = queueSummaryForBrief({ root: r });
  // `queues` goes into runBrief as well: the audit rides on the brief (runReview), and its
  // stale-button check needs the rows.
  const b = runBrief({ ...a, queues });
  return {
    ...b, queues, buttons: buttonsSummary(queues),
    // Queue DEPTH says how much is pending; it cannot say whether replication is converging, and a
    // quiet queue reads exactly like a stopped transport. Both transports leave an observable
    // artefact, so both ages are reported — see transportHealth() and docs/interop.md -> Transport.
    transport: transportHealth({ root: r }),
    // Two different waits, deliberately apart: a package addressed to the owner and not yet
    // answered, vs a decision on the board that only the owner may move.
    buttonItems: ownerQueueItems({ root: r }),
    ownerWaiting: ownerWaiting(b.tasksOpen),
  };
}

/** queueSend, and what the sender needs to know about it: whether the task it names exists, and
 *  what now waits in the role's queue. The task ref is checked but never refuses the send: the
 *  message is the urgent thing, a mistyped id a warning the caller can act on at once. */
export function queueSendChecked(role, text, { from, root, task } = {}) {
  const r = root ?? resolveQueueRoot();
  let taskKnown;
  if (task != null && task !== '') { try { runTaskGet({ id: task }); taskKnown = true; } catch { taskKnown = false; } }
  const file = queueSend(role, text, { from, root: r, task });
  // What is actually WAITING for this role, after the append. "Sent" says the write happened; it
  // never said whether anything is reading, and a sender read it as "delivered" — while four roles
  // sat on a day of undelivered orders. A depth that keeps climbing is the sender's own evidence.
  const depth = (() => { try { return peekQueueDepthWithAcks(role, { root: r }); } catch { return null; } })();
  /* The depth counts this node's cursor and every node's read mark, so a role read on another
   * machine is measured too — as of the last mesh sync. What it cannot see is a reader on a hubd
   * from before read marks: its cursor never leaves its node, and its queue reads as unconsumed from
   * here. Saying "nothing is consuming" about that would be wrong, and a warning that is often wrong
   * is one its reader learns to skip. So: consumed here, or marked as read elsewhere, gets the real
   * warning and says where; neither gets the caveat instead of an accusation. */
  const seenHere = (() => { try { return everConsumedHere(role, { root: r }); } catch { return false; } })();
  const readOn = seenHere ? [] : (() => { try { return whereRead(role, { root: r }); } catch { return []; } })();
  const head = depth ? `${depth.pending} message(s) now wait in this role's queue, oldest ${depth.oldestWaiting} — sending appends, it does not deliver.` : '';
  const note = !depth || depth.pending <= 1 ? null
    : seenHere
      ? `${head} This role IS consumed on this node, so a depth that keeps climbing means its consumer stopped: check it is waiting, and run hub doctor there for a cursor it cannot write.`
      : readOn.length
        ? `${head} This node has never consumed this role; it is read on ${readOn.map(x => x.node).join(', ')} (last read ${readOn[0].at || 'at an unknown time'}), counted here as of the last mesh sync. A depth that keeps climbing means that reader stopped: check it there.`
        : `${depth.pending} message(s) are in this role's queue as seen FROM HERE, oldest ${depth.oldestWaiting}. This node has never consumed this role, and no node has left a read mark for it — so either nobody reads it, or its reader runs a hubd from before read marks and its cursor never leaves that node. Check on the node that runs the role.`;
  return { file, ...(taskKnown === undefined ? {} : { task, taskKnown }),
    ...(depth ? { pending: depth.pending, oldestWaiting: depth.oldestWaiting, consumedHere: seenHere,
      ...(readOn.length ? { readOn: readOn.map(x => x.node) } : {}),
      unacked: depth.unacked || 0, ...(note ? { note } : {}) } : {}) };
}
