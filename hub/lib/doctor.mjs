/* doctor.mjs — `hub doctor`: every check a human runs against a hub, with its reason printed.
 *
 * Read-only: it runs as a read-only command (cli.mjs), so it reports what it finds and writes
 * nothing, not even what a writing command would repair in passing. Each block
 * prints what it found and counts a warning only for what is wrong in THIS hub now; the exit code
 * is the warning count, so a shell or CI step can gate on it.
 *
 * The checks nothing else reads live here too: duplicated log lines, torn journal writes, writer
 * versions, whether this node and its peers are syncing, and paths only a case-insensitive
 * filesystem cannot hold. */
import fs from 'node:fs';
import path from 'node:path';
import {
  HUB, HUB_VIA, PROJ, RESOURCES, VERSION, now, parseTs, sh, projectAliases, loadTasks, loadClaims,
  activeClaims, journalFiles, taskEventFiles, journalNodeOf, taskEventNodeOf, writerVersions,
  cmpVersion, envChecks, runPresence, runGraph, unignoredNodeLocal, gitignoreMissing, trackedNodeLocal, readFreeze,
  rulesFilePath, readJson,
} from './core.mjs';
import { conflictedFiles } from './conflicts.mjs';
import { cardSectionIssues } from './cards.mjs';
import {
  resolveQueueRoot, resolveQueueRootInfo, subscriberRoles, subscriberNamespaces, queueInventory, strandedQueues, outOfBandTrims,
  listShards, readCursor, pidAlive, queuesNearFull, queueLimits,
} from './queue.mjs';

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
/* `malformedRecent` exists because of a rule this tool states about itself and then broke: a
 * warning that can never be cleared is one a reader learns to skip, which costs more than the
 * warning is worth. Two malformed lines — a stray plain-text line and a write torn mid-key — sat
 * in one node's journal, and there is no legitimate repair: editing them would rewrite an
 * append-only file and trip the sync guard on every peer. So doctor was set to nag about them
 * forever, in the same release whose own comment forbids exactly that.
 *
 * The distinction that matters is not "is it malformed" but "is it STILL HAPPENING". A torn write
 * at the tail of a live log means a writer is failing now and someone should look. The same line
 * with a hundred good entries appended after it is history: the writer plainly recovered, readers
 * already drop the line, and nothing can be done. Recent ones warn; old ones are stated and left.
 *
 * The measure is HOW MANY GOOD ENTRIES FOLLOW IT, not how far back it sits in the file. A line
 * count cannot tell the difference: the first version of this counted a fixed window of trailing
 * lines, which called two June-era lines at the head of a 58-line log "happening NOW" simply
 * because the whole file fitted inside the window. Entries-after is scale-free. */
export const MALFORMED_SETTLED_AFTER = 20;

export function journalCounts() {
  const files = journalFiles();
  const seen = new Map();
  let lines = 0, entries = 0, malformed = 0, malformedRecent = 0;
  for (const f of files) {
    const base = path.basename(f);
    const node = journalNodeOf(base);
    // A month-archive is closed history — journalAppend only ever renames INTO one.
    const archived = /-\d{4}-\d{2}(\.\d+)?\.jsonl$/.test(base);
    let dup = seen.get(node);
    if (!dup) seen.set(node, dup = new Set());
    try {
      const all = fs.readFileSync(f, 'utf8').split('\n');
      // Good entries following each position, so "did the writer recover after this" is answerable
      // without a second pass per malformed line.
      const goodAfter = new Array(all.length + 1).fill(0);
      for (let i = all.length - 1; i >= 0; i--) {
        let ok = false;
        const t = all[i].trim();
        if (t) { try { JSON.parse(t); ok = true; } catch {} }
        goodAfter[i] = goodAfter[i + 1] + (ok ? 1 : 0);
      }
      for (let i = 0; i < all.length; i++) {
        const line = all[i].trim();
        if (!line) continue;
        lines++;
        if (dup.has(line)) continue;
        dup.add(line);
        try { JSON.parse(line); entries++; }
        catch {
          malformed++;
          if (!archived && goodAfter[i + 1] < MALFORMED_SETTLED_AFTER) malformedRecent++;
        }
      }
    } catch {}
  }
  let distinct = 0;
  for (const s of seen.values()) distinct += s.size;
  return { files: files.length, lines, entries, malformed, malformedRecent, duplicate: lines - distinct };
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
    concurrent: nodes.filter(g => g.concurrent.length > 1)
      .map(g => ({ node: g.node, versions: g.concurrent, by: g.concurrentBy })),
  };
}

/* ── Is the mesh actually syncing? ──
 *
 * The incident this exists for: one node's sync had been failing every 60 seconds for **228
 * commits** of the other nodes' history. Its launchd job ran, wrote a line to a log file, exited
 * non-zero, and was restarted a minute later to fail identically. Nothing else in hubd looked at
 * that log, so `hub status`, `hub brief` and `hub doctor` all reported a healthy hub the whole
 * time — a hub they were reading from a copy that had stopped receiving anyone else's work.
 *
 * A sync loop that keeps retrying is indistinguishable from a working one unless somebody counts
 * the commits. So doctor counts them, from git rather than from the log: the log says whatever the
 * script chose to say, and in this case the script's own diagnosis was wrong. */
export function meshStatus() {
  if (!fs.existsSync(path.join(HUB, '.git'))) return null;
  const branch = sh('git rev-parse --abbrev-ref HEAD', HUB) || 'main';
  const remotes = sh('git remote', HUB).split('\n').filter(Boolean);
  if (!remotes.includes('origin')) return { branch, remote: null };
  const counts = sh(`git rev-list --left-right --count origin/${branch}...HEAD`, HUB).split(/\s+/);
  const behind = parseInt(counts[0], 10), ahead = parseInt(counts[1], 10);
  // The script's last word, quoted rather than trusted: worth showing a human, but the counts
  // above are what decides whether anything is wrong.
  let lastError = null;
  try {
    const log = fs.readFileSync(path.join(HUB, '.mesh-sync.log'), 'utf8').split('\n').filter(l => l.trim());
    for (let i = log.length - 1; i >= 0 && i > log.length - 40; i--) {
      if (/mesh-sync: (REFUSED|.*failed)/.test(log[i])) { lastError = log[i].trim(); break; }
    }
  } catch {}
  return {
    branch, remote: 'origin',
    behind: Number.isFinite(behind) ? behind : null,
    ahead: Number.isFinite(ahead) ? ahead : null,
    lastError,
  };
}

/* Which PEER has gone quiet in the mesh.
 *
 * meshStatus above answers "am I in sync", and only this node can ask it. The failure it cannot see
 * is the one that matters most: another node whose pull has been aborting for days. Pine sat 77
 * commits behind on a single card conflict — its own doctor said so, and nobody was running its
 * doctor. From any other node the evidence was already there and unread: mesh-sync commits as the
 * node it runs on, so a peer that stopped pushing stops appearing in the shared history.
 *
 * Only real participants are judged — a node that has never committed here is an absorbed log or a
 * legacy name, not a machine that went quiet — and only while the mesh itself is moving, so a
 * weekend when nobody worked does not light up every row. Case-insensitive, because mesh-sync took
 * the raw hostname ("Pine") before it normalised it, and those commits are still in the history. */
export function meshNodes({ staleHours = 6, scan = 800 } = {}) {
  if (!fs.existsSync(path.join(HUB, '.git'))) return [];
  const last = new Map();                       // node (lowercased) -> newest commit ISO
  let newest = null;
  for (const line of sh(`git log -${scan} --format=%cI%x09%cn`, HUB).split('\n')) {
    const [iso, name] = line.split('\t');
    if (!iso || !name) continue;
    if (!newest) newest = iso;
    const k = name.trim().toLowerCase();
    if (!last.has(k)) last.set(k, iso);
  }
  if (!newest) return [];
  const newestMs = new Date(newest).getTime();
  // A mesh nobody has touched in a while is not evidence about any single node.
  if (Date.now() - newestMs > staleHours * 3600000) return [];
  const known = new Set();
  try {
    // The same node-from-filename rules the log readers use, so "a node" means one thing here.
    for (const f of fs.readdirSync(HUB)) {
      const node = /^journal\..+\.jsonl$/.test(f) ? journalNodeOf(f)
        : /^tasks\..+\.events\.jsonl$/.test(f) ? taskEventNodeOf(f) : '';
      if (node) known.add(node.toLowerCase());
    }
  } catch {}
  const out = [];
  for (const node of known) {
    const iso = last.get(node);
    if (!iso) continue;                         // never a committer here: absorbed or legacy, not quiet
    const ageH = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
    if (ageH >= staleHours) out.push({ node, lastCommit: iso, ageHours: ageH });
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

/* Two tracked paths that differ only by case. On Linux they are two files; on macOS and Windows
 * they are one, and git cannot check out the second without overwriting the first — so the merge
 * refuses, every time, forever. That is what actually stopped the sync above.
 *
 * The pairs got there honestly. Queue files used to be named from the raw hostname while journals
 * went through JOURNAL_NODE, which lowercases; unifying them on JOURNAL_NODE was correct and was
 * argued carefully at the time, including why no message would be stranded (readers match
 * <role>.<anything>.queue.md, so the old files are still read). What nobody examined was what two
 * spellings of one node would mean to a case-insensitive filesystem three nodes away.
 *
 * Read from git, not from the directory: on the filesystem where this matters, the collision is
 * invisible by definition — both names resolve to the same file. Only the index has both.
 *
 * And read the REMOTE's tree as well as this hub's index. The pair that blocks a merge usually
 * arrived from another node and is not tracked here yet — which is the whole failure: the node
 * cannot pull the commits that would give it the second name, so looking only at its own index
 * finds nothing wrong with a hub that cannot sync. */
export function caseCollisions() {
  if (!fs.existsSync(path.join(HUB, '.git'))) return [];
  const branch = sh('git rev-parse --abbrev-ref HEAD', HUB) || 'main';
  const files = [
    ...sh('git ls-files', HUB).split('\n'),
    ...sh(`git ls-tree -r --name-only origin/${branch}`, HUB).split('\n'),
  ].filter(Boolean);
  const byLower = new Map();
  for (const f of files) {
    const k = f.toLowerCase();
    let s = byLower.get(k);
    if (!s) byLower.set(k, s = new Set());
    s.add(f);
  }
  return [...byLower.entries()]
    .filter(([, paths]) => paths.size > 1)
    .map(([lower, paths]) => ({ lower, paths: [...paths].sort() }))
    .sort((a, b) => (a.lower < b.lower ? -1 : 1));
}

/** Print the report; returns the number of warnings (0 = healthy). */
export function runDoctor() {
  let warnings = 0;

  // hub base
  const projFiles = (() => { try { return fs.readdirSync(PROJ).filter(f => f.endsWith('.md')); } catch { return []; } })();
  const resFiles = (() => { try { return fs.readdirSync(RESOURCES).filter(f => f.endsWith('.md')); } catch { return []; } })();
  // Through loadTasks(), never the raw cache file: doctor is where a human checks the hub against
  // their own expectations, and reading tasks.json directly meant reporting whatever the last
  // writer left there — on one hub, 977 open tasks from a fold that 0.9.2 had already fixed.
  const allTasks = (() => { try { return loadTasks().tasks || []; } catch { return []; } })();
  const openTasks = allTasks.filter(t => t.status === 'open').length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const overdueTasks = allTasks.filter(t => t.status === 'open' && t.deadline && t.deadline < todayStr).length;
  const claimsDb = loadClaims();
  const active = activeClaims(claimsDb.claims);
  const expired = claimsDb.claims.filter(c => !active.includes(c)).length;

  // Entries a reader actually sees, not lines on disk — a mesh merge can duplicate lines without
  // anything erroring, and this count used to report the inflated one. Both are printed.
  // Only a malformed line that is still ARRIVING is actionable. An old one cannot be repaired at
  // all — editing it rewrites an append-only file and trips the sync guard on every peer — so
  // warning about it forever just teaches a reader to skip the warnings. State it, don't nag.
  const jc = journalCounts();
  if (jc.malformedRecent) warnings++;

  console.log('hub base:');
  console.log('  path:     ' + HUB + '  (via ' + HUB_VIA + ')');
  console.log('  projects: ' + projFiles.length);
  console.log('  resources:' + resFiles.length);
  console.log('  tasks:    ' + openTasks + ' open' + (overdueTasks ? ', ' + overdueTasks + ' overdue' : ''));
  console.log('  claims:   ' + active.length + ' active, ' + expired + ' expired');
  console.log('  journal:  ' + jc.files + ' file(s), ' + jc.entries + ' entries' +
    (jc.malformed ? ', ' + jc.malformed + ' malformed' + (jc.malformedRecent ? '  WARNING' : '') : ''));
  if (jc.malformedRecent)
    console.log('            ' + jc.malformedRecent + ' of them with fewer than ' + MALFORMED_SETTLED_AFTER +
      ' good entries after them in a live log - a writer is tearing writes NOW');
  else if (jc.malformed)
    console.log('            all of them old: dropped on read, and not repairable without ' +
      'rewriting an append-only log');

  // Duplicated log lines are invisible by construction: git reports a clean merge, the file stays
  // valid JSONL, and append-only was never broken. Readers drop the repeats, so say so out loud
  // rather than quietly serving a corrected number over files that keep growing.
  const dupGroups = logDuplication();
  if (dupGroups.length) {
    const dupTotal = dupGroups.reduce((n, g) => n + g.duplicate, 0);
    console.log('  logs:     ' + dupTotal + ' duplicate line(s) in ' + dupGroups.length +
      ' node log(s) - dropped on read, still on disk');
    for (const g of dupGroups.slice(0, 6))
      console.log('            ' + g.kind + '/' + g.node + ': ' + g.lines + ' lines, ' + g.distinct + ' distinct' +
        (g.files.length > 1 ? ' (' + g.files.length + ' files)' : ''));
    console.log('            cause: merge=union in the hub git repo keeps both sides of a hunk and never dedups');
  }

  // Which hubd wrote into this hub. Nothing anywhere could answer that until 0.9.4 stamped it on
  // the journal line, so the block is deliberately explicit that it starts empty rather than
  // printing a reassuring nothing.
  const skew = versionSkew();
  if (!skew.stamped) {
    console.log('  writers:  no version stamps yet - recorded from 0.9.4 on, as each node upgrades');
  } else {
    console.log('  writers:  ' + skew.nodes.filter(g => g.last).map(g => g.node + ' ' + g.last).join(' - ') +
      (skew.nodes.some(g => !g.last) ? ' - unstamped: ' + skew.nodes.filter(g => !g.last).map(g => g.node).join(', ') : ''));
    /* Report the observation, not a remedy inferred from it. "upgrade that node" was wrong on
     * this hub the day it shipped: two nodes whose packages were ALREADY current simply had not
     * written since, and doctor told a human to go and upgrade what was done. A node that
     * upgraded and stayed quiet is indistinguishable, from here, from one that never upgraded —
     * so the honest line is what the log says, and the caveat is stated once, out loud.
     *
     * The `ahead` direction is different and keeps its verdict: a stamp newer than this build
     * cannot be produced by anything but newer code, so "this copy is older than the mesh" is
     * observed, not guessed. */
    for (const n of skew.ahead) {
      warnings++;
      console.log('            WARNING ' + n.node + ' wrote with ' + n.v + ' (' + n.at + '); this install is ' +
        VERSION + ' - THIS copy is older than the mesh');
    }
    for (const n of skew.behind) {
      warnings++;
      console.log('            WARNING ' + n.node + ' last wrote with ' + n.v + ' (' + n.at + '); this install is ' + VERSION);
    }
    if (skew.behind.length)
      console.log('            a node that upgraded but has not written since reads the same as one that' +
        ' did not - check before upgrading');
    /* Two versions interleaving is observed; "two installs" was a guessed cause, and the guess was
     * wrong on this hub. The resident MCP server kept writing the version it had imported while a
     * fresh CLI wrote the current one from the same single install. Print the agent names instead:
     * a process that predates the upgrade is restartable, and the remedy for it is not the remedy
     * for two copies on disk. */
    for (const n of skew.concurrent) {
      warnings++;
      console.log('            WARNING ' + n.node + ': ' + n.versions.join(' and ') + ' both writing recently');
      for (const v of n.versions) {
        const who = (n.by || {})[v] || [];
        if (who.length) console.log('              ' + v + ': ' + who.join(', '));
      }
      console.log('              usually a long-lived process, not a second install: upgrading the package on');
      console.log('              disk does not reach a server that already imported it - restart those agents.');
      console.log('              `hub version` on that node prints the path it resolved, if it IS two copies.');
    }
  }

  /* Whether this node can see the fleet's liveness at all. Belongs beside `writers:` because it
   * answers the same shape of question one layer up: that block says which hubd wrote here, this
   * one says whose agents are observable from here. A blind spot is reported as a blind spot -
   * the alternative is what cost 92 hours, an orchestrator reading a neighbour's absent heartbeat
   * as a dead worker. */
  const pres = runPresence({});
  const covLine = (pres.coverage || []).map(c => c.self
    ? c.node + ' (here, ' + c.agents + ')'
    : c.snapshot === null ? c.node + ' SILENT'
    : c.node + ' ' + c.snapshotAgeMin + 'm' + (c.stale ? ' STALE' : '') + ' (' + c.agents + ')');
  if (covLine.length) {
    console.log('  fleet:    ' + covLine.join(' - ') + (pres.blindTo ? '  WARNING' : ''));
    if (pres.blindTo) {
      warnings++;
      console.log('            no registry at all from ' + pres.blindTo.join(', ') + ' - a role running there is');
      console.log('            invisible here, which is NOT the same as dead. Each node publishes');
      console.log('            presence.<node>.json on heartbeat; a node on hubd < 0.9.13 never will.');
    }
    /* Not a warning: an idle node refreshes on heartbeat, so an old snapshot is what a quiet
     * machine looks like. Stated, not flagged - the rows from it stand on their own last_seen. */
    if (pres.laggingBehind) console.log('            ' + pres.lagNote);
  }

  // A retrying sync loop looks exactly like a working one from inside the hub. One node's had
  // been failing every 60 seconds for 228 commits of everyone else's history while every hubd
  // report called the hub healthy, so the divergence is counted from git and printed here.
  const mesh = meshStatus();
  if (mesh && mesh.remote) {
    const stuck = mesh.behind > 0 || mesh.ahead > 0;
    console.log('  mesh:     ' + mesh.remote + '/' + mesh.branch + ': ' +
      (stuck ? mesh.behind + ' behind, ' + mesh.ahead + ' ahead  WARNING' : 'in sync'));
    if (stuck) {
      warnings++;
      console.log('            this hub is not receiving the other nodes\' work - the sync is not completing');
      if (mesh.lastError) console.log('            sync says: ' + mesh.lastError);
    }
    /* The half only a PEER can see. A node whose pull keeps aborting knows it — its own doctor says
     * so — and nobody is running its doctor; from here it simply stops appearing in the shared
     * history. One node sat 77 commits behind on a single card conflict that way. */
    const quiet = meshNodes();
    if (quiet.length) {
      warnings++;
      console.log('  peers:    ' + quiet.length + ' node(s) have stopped appearing in the mesh  WARNING');
      for (const n of quiet.slice(0, 5))
        console.log('            ' + n.node + ': last commit ' + n.lastCommit.slice(0, 16).replace('T', ' ') + ' (' + n.ageHours + 'h ago)');
      if (quiet.length > 5) console.log('            ... and ' + (quiet.length - 5) + ' more');
      console.log('            that node is writing locally and not reaching anyone. On it: hub doctor');
      console.log('            (a conflicted card or queue aborts every pull until a human resolves it)');
    }
  }
  /* Conflict markers are not a broken file to a reader — they are content. A card gets read; a
   * QUEUE gets DELIVERED, which is why queues were the worse omission: 83 marker lines were found
   * committed across eight queue files on one mesh, 57 in one file, every one handed to a worker
   * as the text of a message. The remedy differs per kind, so it is named per kind — sending a
   * reader to `hub card resolve` for a queue is the same mistake as 0.9.7's "upgrade that node". */
  const conflicted = conflictedFiles({ queueRoot: resolveQueueRoot() });
  if (conflicted.length) {
    warnings++;
    const byKind = {};
    for (const c of conflicted) (byKind[c.kind] = byKind[c.kind] || []).push(c.file);
    console.log('  markers:  ' + conflicted.length + ' file(s) still hold git conflict markers - a reader');
    console.log('            serves those as CONTENT, and a queue DELIVERS them');
    for (const [kind, files] of Object.entries(byKind)) {
      console.log('            ' + files.length + ' ' + kind + '(s) - fix with: hub ' +
        (kind === 'queue' ? 'queue' : 'card') + ' resolve');
      for (const f of files.slice(0, 4)) console.log('              ' + path.relative(HUB, f));
      if (files.length > 4) console.log('              ... and ' + (files.length - 4) + ' more');
    }
  }

  const collisions = caseCollisions();
  if (collisions.length) {
    warnings++;
    console.log('  paths:    ' + collisions.length + ' path pair(s) differ only by case');
    for (const c of collisions.slice(0, 6)) console.log('            ' + c.paths.join('  +  '));
    if (collisions.length > 6) console.log('            ... and ' + (collisions.length - 6) + ' more');
    // Worth spelling out, because the obvious remedies do not work: a case-insensitive
    // filesystem holds ONE file for the pair, git maps it to one index entry, and the other can
    // never be satisfied. `git add -A` stages nothing, the commit is empty, and any merge that
    // has to write the unsatisfiable path refuses. There is no local fix.
    console.log('            a case-insensitive filesystem (macOS, Windows) holds one file for the pair,');
    console.log('            so one index entry stays dirty forever and no merge can write it.');
    console.log('            committing or stashing cannot clear it - one of each pair must leave the mesh.');
  }

  // A freeze somebody forgot looks exactly like a mesh that works: local writes succeed, nothing
  // errors, and peers simply never hear from this node again. Stated always, warned about once it
  // has outlived any plausible operation.
  const info = readFreeze();
  if (info) {
    const ageH = info.since ? Math.floor((Date.now() - parseTs(info.since).getTime()) / 3600000) : null;
    const stale = ageH !== null && ageH >= 6;
    if (stale) warnings++;
    console.log('');
    console.log('mesh: FROZEN' + (stale ? '  WARNING' : '') + ' — this node neither sends nor receives');
    console.log('  since ' + (info.since || '?') + (ageH !== null ? ' (' + ageH + 'h)' : '') +
      ' by ' + (info.by || '?') + ': ' + (info.why || 'no reason recorded'));
    console.log('  hub unfreeze' + (stale ? '   — longer than any operation should take; if the work is done, unfreeze' : ''));
  }

  // Node-local files: the ones nothing ignores on this node, the lines only this node's exclude file
  // has, and the ones git tracks anyway (an ignore line does not untrack a file, so those still travel).
  {
    const loose = unignoredNodeLocal(), missing = gitignoreMissing(), tracked = trackedNodeLocal();
    if (loose.length || missing.length || tracked.length) console.log('');
    if (loose.length) {
      warnings++;
      console.log('gitignore: NOT IGNORED here  WARNING — ' + loose.join(' ') + ' — a git add -A (mesh-sync runs one) would commit them');
      console.log('  the next writing hub command adds them to .git/info/exclude: this node only, never synced');
    } else if (missing.length) {
      console.log('gitignore: ' + missing.join(' ') + ' ignored by .git/info/exclude only — `hub init ' + HUB + '` adds them to .gitignore');
      console.log('  for every node; that is a tracked change, so make it on one node, not on all of them at once');
    }
    if (tracked.length) {
      warnings++;
      console.log('gitignore: TRACKED anyway  WARNING — ' + tracked.join(' ') + ' travel to every peer on each sync');
      console.log('  untrack on ONE node (keeps its copy):  git -C "' + HUB + '" rm -r -q --cached -- ' + tracked.map(t => t.replace(/\/$/, '')).join(' ') + ' && git -C "' + HUB + '" commit -q -m "untrack node-local files"');
      console.log('  every peer\'s next pull then deletes its own copy (for .mesh-freeze: unfreezes a node frozen by accident);');
      console.log('  a peer that changed the file meanwhile stops on a modify/delete conflict — do it while the others are quiet');
    }
  }

  // team root
  const { root: teamRoot, via: teamVia } = resolveQueueRootInfo();
  console.log('');
  console.log('team root:');
  console.log('  path: ' + teamRoot + '  (via ' + teamVia + ')');
  if (teamRoot !== HUB) console.log('  note: team root ≠ hub base (' + HUB + ') — queues and AGENTS.md here, everything else there. One directory wanted? Set HUBD_TEAM_DIR alone (it is then the base too), or HUBD_DIR alone.');

  // presence
  const hasAgents = fs.existsSync(path.join(teamRoot, 'AGENTS.md'));
  const hasInbox  = fs.existsSync(path.join(teamRoot, 'INBOX.md'));
  const hasQueues = fs.existsSync(path.join(teamRoot, 'queues'));
  console.log('  AGENTS.md: ' + (hasAgents ? 'yes' : 'no' + '  hint: run hub init'));
  console.log('  INBOX.md:  ' + (hasInbox  ? 'yes' : 'no' + '  hint: run hub init'));
  console.log('  queues/:   ' + (hasQueues ? 'yes' : 'no' + '  hint: run hub init'));

  // locks
  const lockFiles = (() => {
    try { return fs.readdirSync(HUB).filter(f => f.endsWith('.lock')).map(f => path.join(HUB, f)); }
    catch { return []; }
  })();
  if (lockFiles.length) {
    console.log('');
    console.log('locks:');
    const nowMs = Date.now();
    for (const lf of lockFiles) {
      try {
        const ageSec = Math.floor((nowMs - fs.statSync(lf).mtimeMs) / 1000);
        const stale = ageSec > 30;
        if (stale) warnings++;
        console.log('  ' + path.basename(lf) + '  age ' + ageSec + 's' + (stale ? '  WARNING stale lock (auto-stolen on next write)' : ''));
      } catch {}
    }
  }

  // queues
  if (hasQueues) {
    const qdir = path.join(teamRoot, 'queues');
    const qstateDir = path.join(teamRoot, '.qstate');
    const shards = listShards(qdir);
    if (shards.length) {
      console.log('');
      console.log('queues:');
      const nowMs = Date.now();
      const fanoutRoles = new Set(subscriberRoles(teamRoot));
      for (const { file: qf, role } of shards) {
        // Files are per-host: <role>.<node>.queue.md (legacy <role>.queue.md still read).
        // The offset is keyed by the FULL filename (.qstate/<file>.offset — lib/queue.mjs
        // offPath) and the waiter marker by the bare ROLE. Both used to be derived from
        // filename-minus-suffix, i.e. read paths that never exist — doctor showed offset 0
        // and pending = size on a fully-consumed queue, and never saw a live waiter.
        const sz = (() => { try { return fs.statSync(path.join(qdir, qf)).size; } catch { return 0; } })();
        const { off } = readCursor(path.join(qstateDir, qf + '.offset'));
        const pending = Math.max(0, sz - off);
        const beyondSize = off > sz;   // counted once, by the out-of-band trims below
        let line = '  ' + qf + ':  size ' + sz + 'B, offset ' + off + ', pending ' + pending + 'B';
        if (fanoutRoles.has(role)) line += '  (broadcast role — subscribers keep their own cursors under .qstate/<subscriber>/)';
        if (beyondSize) line += '  offset beyond file size (the file shrank: see the cursors past the end below)';

        // live waiter check — the marker is per role, not per file
        const w = readJson(path.join(qstateDir, role + '.waiter'));
        if (w && nowMs - new Date(w.since).getTime() < 10000 && pidAlive(w.pid)) line += '  live waiter: pid ' + w.pid;

        console.log(line);
      }
      /* Work dispatched to a role with nobody on the other end. The ghost roll-up below needs
       * 30 days, which is right for "archive this" and useless for "did anything happen": two
       * roles here were sent work twice in one afternoon and it just sat, and the only thing
       * that noticed was a third agent writing "REPEATED ESCALATION" in prose hours later.
       *
       * The caveat is printed, not implied. Cursors and presence are both node-local and never
       * mesh-synced, so this says "nothing HERE took these" — a consumer on another machine is
       * invisible from this one. */
      /* A cursor this user cannot write: delivery is stopped and every other reading looks fine.
       * Four live roles held 12-43 KB of undelivered orders for a day this way, while each wait
       * answered NO_CHANGES and each send answered "delivered" (task maple-98). First in the
       * block because it is the only queue condition that is losing work right now. */
      const inventory = queueInventory({ root: teamRoot });
      const stalledQ = inventory.filter(x => x.stalled);
      if (stalledQ.length) {
        warnings++;
        console.log('  ' + stalledQ.length + ' queue cursor(s) THIS USER CANNOT WRITE — delivery is stopped  WARNING');
        for (const s of stalledQ.slice(0, 6))
          console.log('    ' + s.file + ' (' + s.stalled + ')' + (s.messages ? ': ' + s.messages + ' message(s) in the file' : ''));
        if (stalledQ.length > 6) console.log('    ... and ' + (stalledQ.length - 6) + ' more');
        console.log('    a wait on these roles can only answer NO_CHANGES; nothing sent to them will ever arrive.');
        console.log('    hint: fix ownership of ' + path.join(teamRoot, '.qstate') + ' — on a fleet node the hub dir is shared,');
        console.log('          so: chgrp -R <group> "' + teamRoot + '" && chmod -R g+rwX "' + teamRoot + '"');
      }
      /* Queue files trimmed outside hubd. Legitimate — the files had grown past fifteen thousand
       * lines and hubd offers no compaction — but until 0.9.9 a trim silently re-delivered
       * everything that survived it, because a shrunken file reset the cursor to zero. The
       * watermark handles that now; this line is how the missing operation stops being invisible. */
      const trims = outOfBandTrims({ root: teamRoot });
      if (trims.length) {
        warnings++;
        console.log('  ' + trims.length + ' cursor(s) point past the end of their queue — trimmed outside hubd  WARNING');
        for (const t of trims.slice(0, 5))
          console.log('    ' + t.file + (t.subscriber ? ' [' + t.subscriber + ']' : '') + ': cursor ' + t.cursor +
            ' > size ' + t.size + (t.hasMark ? ', resumes at the watermark' : ', NO watermark — will restart from 0'));
        if (trims.length > 5) console.log('    ... and ' + (trims.length - 5) + ' more');
      }
      /* One number covered two unrelated situations and read as the alarming one. 2811 messages
       * "nothing here has taken" sounds like 2811 pieces of dropped work; 2700 of them were in
       * queues somebody had written to WITHIN THE DAY, which a dead role does not do. Presence is
       * node-local, and a reader on another node shows here only through its read mark — one on a
       * hubd from before read marks leaves none — so a queue being fed here and drained on Pine
       * could look identical from this machine to one addressed to nobody. The caveat that said so
       * was one line under a list of six, after the scary total.
       *
       * So split on the only evidence available locally: is anything still ARRIVING. Still-fed
       * queues are reported as unverifiable-from-here, not as backlog. Gone-quiet ones are the
       * short list actually worth a decision, and that list is printed whole — it was the tail
       * that got truncated before, which is exactly backwards. */
      const stranded = strandedQueues({ root: teamRoot });
      const STRANDED_QUIET_DAYS = 7;
      const quiet = stranded.filter(s => (s.ageDays ?? 0) >= STRANDED_QUIET_DAYS);
      const fed = stranded.filter(s => (s.ageDays ?? 0) < STRANDED_QUIET_DAYS);
      if (quiet.length) {
        warnings++;
        const msgs = quiet.reduce((n, s) => n + s.messages, 0);
        console.log('  ' + msgs + ' message(s) in ' + quiet.length + ' queue(s) nobody took, and nothing new has' +
          ' arrived in ' + STRANDED_QUIET_DAYS + 'd  WARNING');
        for (const s of quiet)
          console.log('    ' + s.role + (s.node ? ' (' + s.node + ')' : '') + ': ' + s.messages +
            ' msg, newest ' + (s.newest || 'n/a') + ', ' + s.ageDays + 'd old');
        console.log('    a role still being written to is elsewhere in this block; these are the ones to staff or retire');
      }
      if (fed.length) {
        const msgs = fed.reduce((n, s) => n + s.messages, 0);
        console.log('  ' + msgs + ' message(s) in ' + fed.length + ' queue(s) no node has read, still being written to');
        for (const s of fed.slice(0, 4))
          console.log('    ' + s.role + (s.node ? ' (' + s.node + ')' : '') + ': ' + s.messages +
            ' msg, newest ' + (s.newest || 'n/a'));
        if (fed.length > 4) console.log('    ... and ' + (fed.length - 4) + ' more');
        console.log('    NOT a backlog yet: presence is node-local, and a reader on a hubd from before read marks');
        console.log('    leaves no mark in the mesh. Check on the node that runs the role before touching these.');
      }
      /* A send to a role that already holds HUBD_QUEUE_MAX_MSGS / HUBD_QUEUE_MAX_BYTES unread is
       * refused. Said here at 80%, counted the way the send counts it, so the reader gets looked at
       * before its senders start failing rather than after. */
      const nearFull = queuesNearFull({ root: teamRoot });
      if (nearFull.length) {
        warnings++;
        const lim = queueLimits();
        console.log('  ' + nearFull.length + ' queue(s) at 80%+ of the send limit (' + (lim.msgs || 'no') + ' messages / ' +
          (lim.bytes || 'no') + ' bytes unread)  WARNING');
        for (const q of nearFull.slice(0, 6))
          console.log('    ' + q.role + ': ' + q.msgs + ' msg, ' + q.bytes + 'B unread' + (q.full ? '  — FULL, sends to it are refused' : ''));
        if (nearFull.length > 6) console.log('    ... and ' + (nearFull.length - 6) + ' more');
        console.log('    their readers are behind or stopped: hub queue status <role>, then look on the node that runs it');
      }
      // Reader namespaces nobody has used in a week: dead sessions of a broadcast role, each one
      // listed as a reader "behind" in `hub queue status` forever. Housekeeping, not a fault — no
      // message is at risk — so it is stated with its remedy and not counted as a warning.
      const idleNs = subscriberNamespaces({ root: teamRoot, days: 7 }).filter(n => n.stale);
      if (idleNs.length) {
        console.log('  ' + idleNs.length + ' reader namespace(s) idle 7d+ (dead sessions): ' +
          idleNs.slice(0, 6).map(n => (n.tap ? '__watchall__/' : '') + n.name).join(', ') + (idleNs.length > 6 ? ', …' : '') +
          '  hint: hub queue gc --apply (moves them to .qstate/_archive/)');
      }
      // Ghost roll-up: files nobody ever consumed, nobody is present for, and that are not a
      // human's queue. They inflate every pending number in the hub until they are archived.
      const ghosts = inventory.filter(x => x.ghost);
      if (ghosts.length) {
        warnings++;
        console.log('  ' + ghosts.length + ' ghost queue(s) — never consumed, no agent present, older than 30d  WARNING');
        console.log('    ' + ghosts.slice(0, 8).map(g => g.file.replace(/\.queue\.md$/, '')).join(', ') +
          (ghosts.length > 8 ? ', …' : '') + '  hint: hub queue gc  (dry run; --apply archives)');
      }
    }
  }

  // roles vs queues coherence (informational): a role with no queue can't be sent work; a queue with no role is orphaned
  const roleNames = (() => { try { return fs.readdirSync(path.join(teamRoot, 'roles')).filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => f.replace('.md', '')); } catch { return []; } })();
  if (roleNames.length) {
    // Parse the ROLE out of per-host filenames (<role>.<node>.queue.md) — filename-minus-
    // suffix would compare "worker.pine" against role files and flag every real queue
    // as orphaned. Same regex as the queues section above; Set dedupes across nodes.
    const qNames = [...new Set(listShards(path.join(teamRoot, 'queues')).map(s => s.role))];
    const rolesNoQueue = roleNames.filter(r => !qNames.includes(r));
    const queuesNoRole = qNames.filter(q => !roleNames.includes(q));
    if (rolesNoQueue.length || queuesNoRole.length) {
      console.log('');
      console.log('roles/queues:');
      if (rolesNoQueue.length) console.log('  roles without a queue: ' + rolesNoQueue.join(', '));
      if (queuesNoRole.length) console.log('  queues without a role: ' + queuesNoRole.join(', '));
    }
  }

  // Near-duplicate project slugs: a mid-flight rename leaves the old slug holding its own
  // separate backlog, so asking about one name answers about half the project. Detection only —
  // which of the two is canonical is the owner's call, and merging is not this command's job.
  {
    const slugsWithWork = new Set([...projFiles.map(f => f.replace(/\.md$/, '')), ...allTasks.map(t => t.project).filter(Boolean)]);
    const aliased = new Set(Object.keys(projectAliases()));
    const pairs = [];
    const list = [...slugsWithWork].sort();
    for (const a of list) for (const b of list) {
      if (a >= b || aliased.has(a) || aliased.has(b)) continue;
      if (b.startsWith(a + '-') || a.startsWith(b + '-')) pairs.push([a, b]);
    }
    if (pairs.length) {
      console.log('');
      console.log('project slugs:');
      for (const [a, b] of pairs) {
        const na = allTasks.filter(t => t.project === a && t.status === 'open').length;
        const nb = allTasks.filter(t => t.project === b && t.status === 'open').length;
        console.log(`  "${a}" (${na} open) and "${b}" (${nb} open) look like one project under two names`);
      }
      console.log('  hint: if they are, point the old one at the canonical one in ' +
        path.join(HUB, 'project-aliases.json') + '  e.g. {"' + pairs[0][0] + '": "' + pairs[0][1] + '"}' +
        ' — reads then resolve both ways and new tasks land on the canonical slug (nothing is renamed on disk)');
    }
  }

  // A card holding one section twice: writers reach only the first, readers see both and cannot
  // tell which is live (task maple-112).
  {
    const doubled = [];
    for (const f of projFiles) {
      let t = ''; try { t = fs.readFileSync(path.join(PROJ, f), 'utf8'); } catch { continue; }
      const is = cardSectionIssues(t);
      if (is.length) doubled.push({ slug: f.replace(/\.md$/, ''), is });
    }
    if (doubled.length) {
      warnings++;
      console.log('');
      console.log('cards: ' + doubled.length + ' card(s) hold a section twice — writes reach only the first  WARNING');
      for (const d of doubled.slice(0, 8)) console.log('  ' + d.slug + ': ' + d.is.map(i => i.key
        ? i.headings.map(h => '## ' + h).join(' + ') : '## ' + i.heading + ' x' + i.count).join('; '));
      if (doubled.length > 8) console.log('  ... and ' + (doubled.length - 8) + ' more');
      console.log('  hint: hub cards merge-sections  (dry run; --apply --by <you> folds them into the live section)');
    }
  }

  // rules source — the one the board shows too (HUB wins, team-root fallback)
  const rulesSource = rulesFilePath(teamRoot);
  console.log('');
  console.log('rules source: ' + (rulesSource || 'none found'));

  // typed-edge graph hygiene: a [[link]] whose target has no card (informational, not a failure —
  // external refs like [[cloudflare]] are fine; this just surfaces what to turn into a resource card)
  try {
    const dangling = runGraph().dangling;
    if (dangling.length) {
      console.log('');
      console.log('links: ' + dangling.length + ' dangling (target has no card)');
      for (const d of dangling.slice(0, 8)) console.log('  ' + d.from + ' —' + d.rel + '→ ' + d.to);
    }
  } catch {}

  // sections i18n: one source (sections.json) drives both card scaffold and report routing.
  // Flag the deprecated split files — if they disagree, the report writes to a heading the
  // card scaffold doesn't use → duplicate sections (the exact drift 0.2.0 removes).
  {
    const hasNew = fs.existsSync(path.join(HUB, 'sections.json'));
    const hasTpl = fs.existsSync(path.join(HUB, 'card-template.md'));
    const hasRep = fs.existsSync(path.join(HUB, 'report-sections.json'));
    if (hasTpl || hasRep) {
      console.log('');
      console.log('sections: ' + (hasNew ? 'sections.json present (authoritative)' : 'using legacy/defaults'));
      if (hasTpl) console.log('  note: card-template.md is deprecated — fold its headings into sections.json (one source for scaffold + report routing)');
      if (hasRep && !hasNew) console.log('  note: rename report-sections.json → sections.json (it now drives the card scaffold too)');
    }
  }

  // protocol: HUBD.md is (re)materialised by ensureProtocol() on every writing hub run; surface its version
  {
    const pv = (() => { try { return (fs.readFileSync(path.join(HUB, 'HUBD.md'), 'utf8').match(/hubd-protocol v([0-9][0-9A-Za-z.\-]*)/) || [])[1]; } catch { return null; } })();
    console.log('');
    if (!pv) { warnings++; console.log('protocol: HUBD.md missing — run `hub upgrade` (agents read it for hub mechanics)'); }
    else if (pv !== VERSION) { warnings++; console.log('protocol: HUBD.md v' + pv + ' ≠ installed hub v' + VERSION + ' — run `hub upgrade`'); }
    else console.log('protocol: HUBD.md v' + pv + ' (current)');
  }

  // append-only guard: task event logs only grow. A destructive "migration" that
  // strips fields rewrites them — catch it on git-tracked hubs (every user's doctor).
  if (fs.existsSync(path.join(HUB, '.git'))) {
    const removed = sh("git diff --numstat HEAD -- '*.events.jsonl'", HUB).split('\n').reduce((s, l) => s + (parseInt(l.split('\t')[1], 10) || 0), 0);
    if (removed) {
      warnings++;
      console.log('');
      console.log('event logs:  WARNING ' + removed + ' line(s) removed/changed in tasks.*.events.jsonl');
      console.log('  append-only — migrations ADD events, never strip fields. Restore: git checkout -- "*.events.jsonl"');
    }
  }

  // environment: what an upgrade needs that is NOT in the code — a variable in a
  // client config, a role declared in the hub, a protocol section worth re-reading.
  // Same list the agents get from hub_whatsnew; doctor is where a human sees it.
  {
    const env = envChecks();
    if (env.total) {
      console.log('');
      console.log('environment: ' + env.total + ' item(s)');
      for (const it of env.items) {
        // Only count what is fixable IN THE HUB as a doctor warning. doctor inspects the
        // hub; an unset variable in some MCP client's config is not the hub's fault and
        // must not fail `hub doctor` in a shell or a CI step that never uses that client.
        // It is still printed, and it is still HIGH in the agent-facing list.
        if (it.actor === 'agent') warnings++;
        console.log(`  ${it.severity.toUpperCase().padEnd(4)} [${it.actor}] ${it.what}`);
        console.log(`       → ${it.remedy}`);
      }
      if (env.total > env.items.length) console.log(`  … and ${env.total - env.items.length} more`);
    }
  }

  console.log('');
  console.log(warnings ? 'doctor: ' + warnings + ' warning(s)' : 'doctor: ok');
  return warnings;
}
