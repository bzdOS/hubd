#!/usr/bin/env node
/**
 * hubd CLI — the human interface to the hub.
 * Imports the same core functions as the MCP server; never starts an MCP process.
 * Usage: node cli.mjs <cmd>  |  alias hub='node <path>/cli.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  HUB, PROJ, HISTORY, JOURNAL, CLAIMS, RESOURCES, setHubBase,
  now, parseTs, slugify, sh, cardPath, readCard, digestOf, projectAliases,
  runSync, runCardSet, runReport, runStatus, runGet, runSearch, runSectionAdd,
  runTaskAdd, runTaskList, runTaskUpdate, runTaskGet, runTaskRetag, TASK_CATS,
  runBrief, runClaim, runRelease, runKanban, runInbox, runTrajectory,
  runResourceSet, runResourceList, runResourceGet, runGraph,
  sectionsConfig, ensureProtocol, VERSION, harvestPrompt, runLint, runAudit, runNext, runAgenda, runRecall, runUsage, runUsageAdd, runRules, runOperatorGet,
  journalTail, journalSince, journalCounts, logDuplication, versionSkew, meshStatus, caseCollisions,
  conflictedFiles, resolveCardConflicts,
  loadClaims, activeClaims, journalAppend, loadTasks,
  runHeartbeat, runPresence, envChecks,
} from './lib/core.mjs';
import { secretsRoot, setSecret, getSecret, secretPath, listSecrets, removeSecret, auditModes, backupSecret, restoreSecret, verifyBackups, backupDir } from './lib/secrets.mjs';
import { queueSend, queueWait, queueWaitAll, resolveQueueRoot, resolveQueueRootInfo, queueSummaryForBrief, buttonsSummary, subscriberRoles, queueInventory, strandedQueues, runQueueGc, queueLedger } from './lib/queue.mjs';

const __filename = fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const cmd = args[0];

/* ── helpers ── */
function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n - 2) + '… ' : s + ' '.repeat(n - s.length); }
/* Writing to a PIPE is asynchronous in Node, and a pipe buffers 64KB — so process.exit()
 * straight after a large console.log throws away whatever has not drained yet. `hub task
 * list --json` on a real base is ~300KB: redirected to a FILE (a synchronous write) it was
 * whole, but piped into jq it arrived cut mid-token at exactly 65536 bytes, with nothing to
 * tell the reader it had been truncated. Machine-readable output that silently loses its
 * tail is worse than none.
 *
 * The fix belongs on the WRITE, not on the exit: deferring the exit until a drain callback
 * would make every `done()` return to its caller and let the code after it run (it did —
 * `task list --json` then printed the human table right after the JSON). So stdout and
 * stderr are written synchronously here, and exiting stays instantaneous everywhere. */
function writeAllSync(fd, text) {
  const buf = Buffer.from(String(text));
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(fd, buf, off, buf.length - off); }
    catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); continue; }  // pipe full, slow reader
      if (e.code === 'EPIPE') return;   // reader went away — writing more is pointless, not an error
      throw e;
    }
  }
}
console.log = (...a) => writeAllSync(1, a.join(' ') + '\n');
console.error = (...a) => writeAllSync(2, a.join(' ') + '\n');
console.warn = console.error;
function done(code = 0) { process.exit(code); }
function die(msg) { console.error('Error: ' + msg); done(1); }

// rulesFile:start
//   purpose: locate the team constitution (AGENTS.md). HUB (the real instance) wins; the team-root
//     (HUBD_TEAM_DIR / cwd walk-up / fallback) is only a secondary location. ONE source — used by
//     both `hub doctor` and the board's Rules, so they can never diverge or re-introduce a hardcode.
// rulesFile:end
function rulesFile() {
  for (const p of [path.join(HUB, 'AGENTS.md'), path.join(resolveQueueRoot(), 'AGENTS.md')]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function getFlag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? true) : null;
}
// repeatable flag: every `--name value` occurrence, plus comma-splitting (so
// `--resource a,b --resource c` → [a,b,c]). For task↔resource links, --link, etc.
function getFlags(name) {
  const out = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === name && typeof args[i + 1] === 'string')
      for (const part of String(args[i + 1]).split(',')) { const v = part.trim(); if (v) out.push(v); }
  return out;
}

// Skeleton printed by `hub report` with no input — make structure the default path.
const REPORT_TEMPLATE = [
  '# Session report — one item per line, then pipe back in (heredoc) or pass with -m.',
  '# Each prefix routes into the project card; unprefixed lines become a NOTE.',
  '# Do NOT list files/commits — "what changed" is read from git by `hub brief`.',
  '',
  'DECIDE: <what> | <why>        # → ## Decisions  (repeat for each decision)',
  'FACT:   <reusable fact learned>   # → ## Facts & hypotheses',
  'HYPO:   <belief, not yet proven>  # → ## Facts & hypotheses',
  'COMM:   <what went out / queued>  # → ## Communication',
  'NEXT:   <the single next action>  # → ## Next step (set)',
  'DONE:   <task-ids, comma-sep>     # closes tasks',
  'TASK:   <new task text>           # opens a task',
  'NOTE:   <one-line anything-else>',
  '',
  '# Example:  hub report -p hubd <<EOF',
  '#   DECIDE: ship docs in the release | npm README drifted',
  '#   FACT: registry JWT expires in minutes',
  '#   NEXT: redeploy myvm under 0.1.8',
  '#   DONE: 42, 43',
  '#   EOF',
].join('\n');

function claimRemaining(c) {
  const ms = parseTs(c.since).getTime() + c.ttlMin * 60000 - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

function formatBrief(data, hours) {
  const today = new Date().toISOString().slice(0, 10);
  const overdueN = data.tasksOpen.filter(t => t.deadline && t.deadline < today).length;
  const lines = [`── HUB BRIEF · ${data.generated} ──────────────────`];
  lines.push(`TASKS (${data.tasksOpen.length} open${overdueN ? `, ${overdueN} overdue` : ''}):`);
  if (!data.tasksOpen.length) {
    lines.push('  no open tasks');
  } else {
    for (const t of data.tasksOpen) {
      const od = t.deadline && t.deadline < today;
      const mark = od ? '‼' : t.importance === 'high' ? '!' : ' ';
      const dl = t.deadline ? (od ? `  ⏰${t.deadline} OVERDUE` : `  ⏰${t.deadline}`) : '';
      const ass = t.assignee ? `  @${t.assignee}` : '';
      const tx = t.text || '';
      const txt = tx.length > 42 ? tx.slice(0, 40) + '…' : tx;
      lines.push(` ${mark} #${t.id} [${t.project || '?'}] ${txt}${dl}${ass}`);
    }
  }
  lines.push(`JOURNAL (${hours}h):`);
  if (!data.journalRecent.length) {
    lines.push('  no entries');
  } else {
    for (const e of data.journalRecent) {
      lines.push(` ${(e.ts || '').slice(5, 16)} [${e.project || '?'}/${e.agent || '?'}] ${e.kind || 'note'}: ${(e.text || '').slice(0, 60)}`);
    }
  }
  lines.push('LOCKS:');
  if (!data.activeClaims.length) {
    lines.push('  no active locks');
  } else {
    for (const c of data.activeClaims) {
      lines.push(` [${c.project}] ${c.area} — ${c.agent}, ${claimRemaining(c)}`);
    }
  }
  if (data.staleCards.length) {
    lines.push('STALE CARDS: ' + data.staleCards.map(c => `${c.project} (${c.daysAgo}d)`).join(', '));
  }
  if (data.staleDigests && data.staleDigests.length) {
    lines.push('DIGEST BEHIND ITS JOURNAL: ' + data.staleDigests.map(c => `${c.project} (${c.daysBehind}d)`).join(', '));
  }
  if (data.queues && data.queues.length) {
    lines.push('QUEUES:');
    for (const q of data.queues) {
      const seen = q.lastSeen ? `agent last-seen ${q.lastSeen}` : 'no agent seen';
      const tag = q.isButton ? ' 🔘' : '';
      // A fanout role has no single pending count (per-reader cursors) — say so
      // instead of printing the shared cursor's phantom backlog.
      if (q.fanout) lines.push(`  broadcast ${q.role}${tag} (per-reader cursors) — ${seen}`);
      // "never consumed" is a different fact from "nobody home right now": messages sit in a
      // role no consumer has EVER opened, so this is not backlog to work off, it is a role to
      // staff or archive (hub queue gc).
      else lines.push(`  ${q.pending} queued for ${q.role}${tag}${q.oldestWaiting ? ` (oldest ${q.oldestWaiting})` : ''} — ${seen}${q.neverRead ? ', never consumed' : ''}`);
    }
    const ghosts = data.queues.filter(q => q.neverRead && q.pending > 0).length;
    if (ghosts) lines.push(`  (${ghosts} never-consumed role(s) — hub queue gc to see/archive them)`);
  }
  if (data.buttons && data.buttons.count > 0) {
    lines.push(`BUTTONS: ${data.buttons.count} waiting (oldest ${data.buttons.oldestDays}d) — ${data.buttons.items.map(b => b.role).join(', ')}`);
  }
  return lines.join('\n');
}

/* ── init ── */

const AGENTS_MD = `# AGENTS.md — Team Constitution

Your team's rules: roles, project policy, who decides what. This file is YOURS to
write and own. hubd MECHANICS — how to report, claim, queue, the card sections,
resources — live in HUBD.md, which the tool regenerates to match the installed
version. Read HUBD.md for "how"; do not copy its mechanics here (they would go stale).

## Session-start ritual

1. Read AGENTS.md (this file) + HUBD.md (hub mechanics, auto-maintained).
2. Read the top ~20 lines of INBOX.md to catch up.
3. Check your role queue: hub queue wait <your-role> --timeout 10

## The one rule worth repeating: pick the right channel

Report SUBSTANCE, not play-by-play. "I'm on it / in progress" is a transient
\`hub claim\`; a decision / fact / shipped thing / blocker is a durable \`hub report\`;
a trivial step is nothing. Full ritual and prefixes are in HUBD.md.

## Roles & policy

Define your roles, their queues, and decision rights here. Conflicts are resolved
per the rules you write in this section. (Full org template: hubd-company/ in the
hubd repository.)
`;

const INBOX_MD = `# INBOX — team journal

Newest entries on top — prepend your handoff before you stop.
Agents: read this on wake-up, write a handoff entry before stopping.
`;

const QUEUES_README_MD = `# queues/

One file per role PER HOST: \`<role>.<node>.queue.md\` — created on first send.
Each machine appends only to its own file, so mesh-synced nodes never conflict.
(The legacy shared \`<role>.queue.md\` is still read, never written.)

## Message block format

\`\`\`
## YYYY-MM-DD HH:MM \xb7 from <sender>
<message text>
\`\`\`

## Sending and receiving

\`\`\`
hub queue send <role> "<text>" --from <your-role>
hub queue wait <role>
\`\`\`

## Delivery

A role is a competing-worker queue by default: run ONE live \`hub queue wait\`
per role — a message goes to exactly one reader. Roles listed in
\`subscriber-roles.json\` (in the team root, next to this folder) broadcast
instead: every waiting session keeps its own cursor and sees every message.

## State

Read offsets live in \`.qstate/\` — one \`<file>.offset\` per queue file, plus
per-subscriber cursors under \`.qstate/<subscriber>/\`.
Do not commit \`.qstate/\` — it is local consumer state.
`;

const SPEC_TEMPLATE = `# SPEC_<name> — <one-line goal>

*Assignment for <role>. The executor appends "## Report" (what was done,
deviations, test output); the cto appends "## Acceptance".*

## 30-second context
<why this exists, what it serves; link the PRD or project card>

## Constraints
<what must hold: compatibility, performance, what NOT to touch>

## Data / interfaces (verbatim)
<exact signatures, file paths, formats — no paraphrase>

## Structure
<the approach: files to add/change, in order>

## Acceptance tests (numbered)
1. <observable, checkable outcome>
2. <...>

## What NOT to do
<out of scope; tempting-but-wrong; leave for later>
`;

const GITIGNORE_ENTRY = '.qstate/\nHUBD.md\npresence/\n';

/* Until 0.9.4 there was no way to ask hubd its own version, and the omission had a price: the
 * global `hub` on the machine that develops hubd sat nine releases behind for weeks, and reading
 * `npm ls -g` was the only way to find out. Answered BEFORE ensureProtocol() below, so asking a
 * possibly-wrong install what it is never writes anything.
 *
 * The path is printed with the number because "which version" and "which copy" are one question:
 * a stale global install and a live source checkout are both called `hub`, and they answer
 * differently. Whichever one printed this line is the one your shell has been running. */
if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  console.log('hubd ' + VERSION);
  console.log('  running:  ' + __filename);
  console.log('  node:     ' + process.version);
  console.log('  hub base: ' + HUB);
  done(0);
}

// Keep the agent-facing protocol (HUBD.md) current for this hub on every run — cheap when
// already current (a stat + version compare); rewrites only after a hubd version change.
try { ensureProtocol(); } catch {}

if (cmd === 'upgrade') {
  const r = ensureProtocol(true);
  if (!r.ok) die('could not materialise HUBD.md (protocol source missing?)');
  console.log(r.wrote ? `HUBD.md → v${r.version}` + (r.from ? ` (was v${r.from})` : ' (new)') : `HUBD.md already current (v${r.version})`);
  console.log('  agents read it for hub mechanics; team rules stay in AGENTS.md');
  done(0);
}

if (cmd === 'init') {
  const pathArg = args.filter(a => !a.startsWith('-'))[1] ?? null;
  const targetDir = pathArg ? path.resolve(pathArg) : process.cwd();

  if (pathArg && !fs.existsSync(targetDir)) {
    die('Folder not found: ' + targetDir);
  }

  /* `init` scaffolds a TEAM folder into a directory, and with no argument that directory is the
   * cwd — which is right when you deliberately cd into a fresh folder, and wrong in the one case
   * it actually happens: standing in a source checkout. Then AGENTS.md, INBOX.md, queues/ and
   * specs/ appear in somebody's repo, ready to be committed by accident. This project's own
   * .gitignore carries /queues/ and /INBOX.md entries — that is the scar of this exact misroute,
   * papered over instead of fixed, and it happened again while healthchecking 0.9.0.
   *
   * Same shape of guard as resolveQueueRootInfo's misroute warning: a checkout is a repo with a
   * .git and no hub DATA in it. Refuse, name both the safe alternatives, and let --here override —
   * a deliberate "yes, scaffold my repo root" stays one flag away. */
  const looksLikeCheckout = !pathArg && !args.includes('--here') &&
    fs.existsSync(path.join(targetDir, '.git')) &&
    !['sections.json', 'tasks.json', 'claims.json', 'HUBD.md'].some(f => fs.existsSync(path.join(targetDir, f))) &&
    !fs.readdirSync(targetDir).some(f => /^journal.*\.jsonl$/.test(f));
  if (looksLikeCheckout) {
    die('refusing to scaffold a team into ' + targetDir + ' — it looks like a source checkout ' +
      '(.git present, no hub data). A team folder is not a code repo.\n' +
      '  hub init <folder>   scaffold there\n' +
      '  hub init ' + HUB + '   scaffold your hub base\n' +
      '  hub init --here     do it here anyway');
  }
  console.log('scaffolding a team folder in ' + targetDir);

  function ensureFile(relName, content) {
    const full = path.join(targetDir, relName);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(full)) {
      console.log('  exists, kept ' + relName);
    } else {
      fs.writeFileSync(full, content, 'utf8');
      console.log('  created ' + relName);
    }
  }

  ensureFile('AGENTS.md', AGENTS_MD);
  ensureFile('INBOX.md', INBOX_MD);
  ensureFile('queues/README.md', QUEUES_README_MD);
  ensureFile('specs/SPEC_template.md', SPEC_TEMPLATE);

  // .gitignore: only create if entirely absent; if present but missing entry, hint
  const giPath = path.join(targetDir, '.gitignore');
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, GITIGNORE_ENTRY, 'utf8');
    console.log('  created .gitignore');
  } else {
    const gi = fs.readFileSync(giPath, 'utf8');
    if (!gi.includes('.qstate/')) {
      console.log('  exists, kept .gitignore');
      console.log('  hint: add .qstate/ to .gitignore');
    } else {
      console.log('  exists, kept .gitignore');
    }
  }

  console.log('');
  console.log('Next steps:');
  console.log('  Connect an agent:  claude mcp add --scope user hubd -- npx -y @bzdos/hubd');
  console.log('  Check setup:       hub doctor');
  console.log('  Full org template: hubd-company/ in the hubd repository');
  done(0);
}

/* ── doctor ── */

if (cmd === 'doctor') {
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
  console.log('  path:     ' + HUB);
  console.log('  projects: ' + projFiles.length);
  console.log('  resources:' + resFiles.length);
  console.log('  tasks:    ' + openTasks + ' open' + (overdueTasks ? ', ' + overdueTasks + ' overdue' : ''));
  console.log('  claims:   ' + active.length + ' active, ' + expired + ' expired');
  console.log('  journal:  ' + jc.files + ' file(s), ' + jc.entries + ' entries' +
    (jc.malformed ? ', ' + jc.malformed + ' malformed' + (jc.malformedRecent ? '  WARNING' : '') : ''));
  if (jc.malformedRecent)
    console.log('            ' + jc.malformedRecent + ' of them in the last ' + 200 +
      ' lines of a live log - a writer is tearing writes NOW');
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
    for (const n of skew.concurrent) {
      warnings++;
      console.log('            WARNING ' + n.node + ': ' + n.versions.join(' and ') +
        ' both writing recently - two installs on one node');
    }
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
  }
  // Conflict markers in a card are not a broken file to a reader — they are content. readCard
  // returns them, hub_context hands them to an agent, and the agent reads two contradictory
  // versions of the project as though both were true.
  const conflicted = conflictedFiles();
  if (conflicted.length) {
    warnings++;
    console.log('  cards:    ' + conflicted.length + ' file(s) still hold git conflict markers - a reader');
    console.log('            serves those as CONTENT. Fix with: hub card resolve');
    for (const f of conflicted.slice(0, 6)) console.log('            ' + path.relative(HUB, f));
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

  // team root
  const { root: teamRoot, via: teamVia } = resolveQueueRootInfo();
  console.log('');
  console.log('team root:');
  console.log('  path: ' + teamRoot + '  (via ' + teamVia + ')');
  if (teamRoot !== HUB) console.log('  note: team root ≠ hub base (' + HUB + ') — set HUBD_TEAM_DIR to pin it if this is not intended');

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
    const qfiles = (() => { try { return fs.readdirSync(qdir).filter(f => f.endsWith('.queue.md')); } catch { return []; } })();
    if (qfiles.length) {
      console.log('');
      console.log('queues:');
      const nowMs = Date.now();
      const fanoutRoles = new Set(subscriberRoles(teamRoot));
      for (const qf of qfiles) {
        // Files are per-host: <role>.<node>.queue.md (legacy <role>.queue.md still read).
        // The offset is keyed by the FULL filename (.qstate/<file>.offset — lib/queue.mjs
        // offPath) and the waiter marker by the bare ROLE. Both used to be derived from
        // filename-minus-suffix, i.e. read paths that never exist — doctor showed offset 0
        // and pending = size on a fully-consumed queue, and never saw a live waiter.
        const role = (qf.match(/^(.+?)(?:\.[^.]+)?\.queue\.md$/) || [, qf.replace('.queue.md', '')])[1];
        const qfull = path.join(qdir, qf);
        const sz = (() => { try { return fs.statSync(qfull).size; } catch { return 0; } })();
        const off = (() => {
          try { return parseInt(fs.readFileSync(path.join(qstateDir, qf + '.offset'), 'utf8').trim(), 10) || 0; }
          catch { return 0; }
        })();
        const pending = Math.max(0, sz - off);
        const beyondSize = off > sz;
        if (beyondSize) warnings++;
        let line = '  ' + qf + ':  size ' + sz + 'B, offset ' + off + ', pending ' + pending + 'B';
        if (fanoutRoles.has(role)) line += '  (broadcast role — subscribers keep their own cursors under .qstate/<subscriber>/)';
        if (beyondSize) line += '  WARNING offset beyond file size (file truncated or recreated; offset will reset)';

        // live waiter check — the marker is per role, not per file
        const waiterFile = path.join(qstateDir, role + '.waiter');
        try {
          const w = JSON.parse(fs.readFileSync(waiterFile, 'utf8'));
          const ageMsW = nowMs - new Date(w.since).getTime();
          if (ageMsW < 10000) {
            let alive = false;
            try { process.kill(w.pid, 0); alive = true; } catch (e) { if (e.code === 'EPERM') alive = true; }
            if (alive) line += '  live waiter: pid ' + w.pid;
          }
        } catch {}

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
      const stranded = strandedQueues({ root: teamRoot });
      if (stranded.length) {
        warnings++;
        const msgs = stranded.reduce((n, s) => n + s.messages, 0);
        console.log('  ' + msgs + ' message(s) in ' + stranded.length +
          ' queue(s) nothing here has taken, with no agent present for the role  WARNING');
        for (const s of stranded.slice(0, 6))
          console.log('    ' + s.role + (s.node ? ' (' + s.node + ')' : '') + ': ' + s.messages +
            ' msg, newest ' + (s.newest || 'n/a') + ', ' + s.ageDays + 'd old');
        if (stranded.length > 6) console.log('    ... and ' + (stranded.length - 6) + ' more');
        console.log('    cursors and presence are per-node: a consumer on another machine does not show up here');
      }
      // Ghost roll-up: files nobody ever consumed, nobody is present for, and that are not a
      // human's queue. They inflate every pending number in the hub until they are archived.
      const ghosts = queueInventory({ root: teamRoot }).filter(x => x.ghost);
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
    // suffix would compare "worker.planck" against role files and flag every real queue
    // as orphaned. Same regex as the queues section above; Set dedupes across nodes.
    const qNames = (() => { try { return [...new Set(fs.readdirSync(path.join(teamRoot, 'queues')).filter(f => f.endsWith('.queue.md')).map(f => (f.match(/^(.+?)(?:\.[^.]+)?\.queue\.md$/) || [, f.replace('.queue.md', '')])[1]))]; } catch { return []; } })();
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

  // rules source — shared rulesFile() (HUB wins, team-root fallback)
  const rulesSource = rulesFile();
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

  // protocol: HUBD.md is (re)materialised by ensureProtocol() on every hub run; surface its version
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
  if (warnings) {
    console.log('doctor: ' + warnings + ' warning(s)');
    done(1);
  } else {
    console.log('doctor: ok');
    done(0);
  }
}

/* ── command dispatch ── */

if (cmd === 'status') {
  const data = runStatus();
  console.log(pad('slug', 26) + pad('synced', 22) + pad('open', 6) + 'digest');
  console.log('─'.repeat(90));
  for (const p of data.projects) {
    // The marker leads the digest instead of riding the `synced` column: that column is
    // padded to 22 and already truncates "<date> by <author>", so a suffix there would be
    // cut off exactly when it matters. A card 33 days behind its own journal otherwise
    // looks perfectly fresh in every column on screen.
    const lag = p.digestStale ? `⚠${p.digestStale.daysBehind}d behind · ` : '';
    console.log(pad(p.project, 26) + pad(p.synced, 22) + pad(p.openTasks, 6) + lag + (p.digest.split('\n')[0] || '').slice(0, 40));
  }
  done(0);
}

if (cmd === 'brief') {
  const hours = parseInt(getFlag('--hours') || getFlag('-h') || '48');
  const queues = queueSummaryForBrief({ root: resolveQueueRoot() });
  console.log(formatBrief({ ...runBrief({ hours }), queues, buttons: buttonsSummary(queues) }, hours));
  done(0);
}

if (cmd === 'inbox') {
  const hours = parseInt(getFlag('--hours') || '72');
  const r = runInbox({ hours });
  if (r.empty) { console.log('inbox: clear — nothing needs a decision'); done(0); }
  const P = (title, rows, fmt) => { if (rows.length) { console.log(`\n## ${title} (${rows.length})`); for (const x of rows) console.log('  ' + fmt(x)); } };
  P('BLOCKED', r.blocked, x => `${x.ts} [${x.project}/${x.agent}] ${x.text}`);
  P('OVERDUE', r.overdue, x => `#${x.id} [${x.project}] due ${x.deadline}${x.assignee ? ' @' + x.assignee : ''} — ${x.text}`);
  P('UNASSIGNED', r.unassigned, x => `#${x.id} [${x.project}] ${x.importance || ''} — ${x.text}`);
  P('STALE CLAIMS', r.staleClaims, x => `${x.project}/${x.area} @${x.agent} since ${x.since} (ttl ${x.ttlMin}m, expired)`);
  done(0);
}

if (cmd === 'plan' || cmd === 'trajectory') {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : (getFlag('-p') || null);
  const r = runTrajectory({ project: proj });
  const label = (id) => { const t = r.ready.concat(r.blocked).find(x => String(x.id) === String(id)); return `#${id}${t ? ' ' + (t.text || '').slice(0, 40) : ''}`; };
  console.log(`── TRAJECTORY${proj ? ' · ' + proj : ''} · ${r.generated} ──  open ${r.counts.open} · ready ${r.counts.ready} · blocked ${r.counts.blocked} · depth ${r.counts.depth}${r.counts.cyclic ? ' · ⚠cyclic ' + r.counts.cyclic : ''}`);
  console.log(`\nREADY NOW (${r.ready.length}):`);
  for (const t of r.ready) console.log(`  #${t.id} [${t.project}] ${t.importance === 'high' ? '! ' : ''}${(t.text || '').slice(0, 70)}`);
  if (r.criticalPath.length) console.log(`\nCRITICAL PATH (${r.criticalPath.length}): ` + r.criticalPath.map(id => '#' + id).join(' → '));
  if (r.layers.length > 1) { console.log('\nUNLOCK ORDER (topo layers):'); r.layers.forEach((l, i) => console.log(`  L${i}: ${l.map(id => '#' + id).join(' ')}`)); }
  if (r.blocked.length) { console.log(`\nBLOCKED (${r.blocked.length}):`); for (const b of r.blocked) console.log(`  #${b.id} ← waiting on ${b.waitingOn.map(id => '#' + id).join(',')} — ${(b.text || '').slice(0, 50)}`); }
  if (r.cycles.length) console.log(`\n⚠ CYCLES (fix these deps): ${r.cycles.map(id => '#' + id).join(' ')}`);
  done(0);
}

if (cmd === 'log') {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const n = parseInt(getFlag('-n') || '20');
  for (const e of journalTail(proj, n)) {
    console.log(`${e.ts} [${e.project}/${e.agent}] ${e.kind}: ${e.text}`);
  }
  done(0);
}

if (cmd === 'report') {
  const pf = getFlag('-p');
  const proj = (typeof pf === 'string') ? pf : 'general';
  const kind = getFlag('-k') || 'note';
  const agent = authorOrDie('--agent');
  let text = (args[1] && !args[1].startsWith('-')) ? args[1] : getFlag('-m');
  if ((!text || text === true) && !process.stdin.isTTY) {           // batch piped via stdin (heredoc)
    try { text = fs.readFileSync(0, 'utf8'); } catch {}
  }
  if (!text || typeof text !== 'string' || !text.trim()) {           // no input → print the skeleton
    console.log(REPORT_TEMPLATE);
    done(0);
  }
  let r;
  try { r = runReport({ project: proj, agent, text, kind, private: args.includes('--private') }); }
  catch (e) { die(e.message); }   // a strict refusal is a message to read, not a stack trace
  const parts = [];
  if (r.decisions) parts.push(r.decisions + ' decision' + (r.decisions > 1 ? 's' : ''));
  if (r.facts) parts.push(r.facts + ' fact' + (r.facts > 1 ? 's' : ''));
  if (r.hypos) parts.push(r.hypos + ' hypothesis');
  if (r.comms) parts.push(r.comms + ' comm' + (r.comms > 1 ? 's' : ''));
  if (r.next) parts.push('next set');
  if (r.done.length) parts.push('closed #' + r.done.join(' #'));
  if (r.doneAlready && r.doneAlready.length) parts.push('already closed #' + r.doneAlready.join(' #'));
  if (r.private) parts.push('PRIVATE (journal.life.jsonl, local only, never synced)');
  if (r.tasks.length) parts.push('new task #' + r.tasks.join(' #'));
  if (r.note) parts.push('note');
  console.log(`Reported to ${r.project}: ` + (parts.length ? parts.join(', ') : 'nothing recognized — use DECIDE:/FACT:/COMM:/NEXT:/DONE: prefixes (hub report with no input shows the template)'));
  if (r.doneMissed && r.doneMissed.length) console.error('  warning: NOT closed (no such task): #' + r.doneMissed.join(' #') + ' — check the id with `hub task list`');
  const onlyNote = r.note && !r.decisions && !r.facts && !r.hypos && !r.comms && !r.next && !r.done.length && !r.tasks.length;
  if (onlyNote) console.error('  hint: a note-only report is usually coordination — "I\'m on it" is a `hub claim`, not a report (see HUBD.md).');
  done(0);
}

if (cmd === 'decide') {
  const what = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!what) die('Usage: hub decide "<decision>" --why "<why>" -p <proj>');
  const why = getFlag('--why');
  const pf = getFlag('-p'); const proj = (typeof pf === 'string') ? pf : 'general';
  const r = runReport({ project: proj, by: authorOrDie('--by'), text: `DECIDE: ${what}${typeof why === 'string' ? ' | ' + why : ''}` });
  console.log(`Decided on ${r.project}: +${r.decisions} → ## Decisions`);
  done(0);
}

if (cmd === 'next') {
  const what = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!what) die('Usage: hub next "<the one next action>" -p <proj>');
  const pf = getFlag('-p'); const proj = (typeof pf === 'string') ? pf : 'general';
  const r = runReport({ project: proj, by: authorOrDie('--by'), text: `NEXT: ${what}` });
  console.log(`Next step set on ${r.project}`);
  done(0);
}

if (cmd === 'task') {
  const sub = args[1];
  if (sub === 'add') {
    const text = args[2];
    if (!text) die('Text required: hub task add "<text>" -p <proj>');
    const proj = getFlag('-p');
    if (!proj || typeof proj !== 'string') die('Project required: -p <proj>');
    const imp = getFlag('-i');
    const dl = getFlag('-d');
    const needsRaw = getFlag('--needs');
    // a dep may be a bare number (legacy id) or a node-scoped string like "planck-3"
    // (task #194) — normalize pure-numeric strings to numbers (matches historical
    // depends_on shape) and pass anything else through unchanged, instead of
    // dropping it.
    const depends_on = needsRaw ? String(needsRaw).split(',').map(s => s.trim()).filter(Boolean).map(s => { const n = parseInt(s, 10); return String(n) === s ? n : s; }) : [];
    const resources = getFlags('--resource');   // structured link task → resource(s)
    const cat = getFlag('--cat');
    const tags = getFlags('--tag');
    const assignee = getFlag('--assignee');
    const t = runTaskAdd({ project: proj, text, importance: imp || 'normal', deadline: dl || null, cat: cat || null, tags, assignee: assignee || null, by: authorOrDie('--by'), depends_on, resources });
    const moved = cat && !t.task.cat;   // off-enum cat landed in tags — say so, don't swallow it
    console.log(`Task #${t.task.id} added: ${t.task.text}` + (resources.length ? `  [${resources.map(r => '⛬' + r).join(' ')}]` : '')
      + ((t.task.tags || []).length ? `  #${t.task.tags.join(' #')}` : '')
      + (moved ? `  (cat "${cat}" is not one of ${TASK_CATS.join('/')} — kept as a tag)` : ''));
  } else if (sub === 'done') {
    const id = args[2];   // bare number or node-scoped string (task #194) — runTaskUpdate compares by String()
    if (!id || id.startsWith('-')) die('Id required: hub task done <id>');
    const r = runTaskUpdate({ id, status: 'done', by: authorOrDie('--by') });
    console.log(r.noop === 'already-done'
      ? `Task #${id} was already closed${r.closedAt ? ' ' + r.closedAt : ''} — nothing changed`
      : `Task #${id} closed`);
    if (r.resourceHint) console.error('  note: ' + r.resourceHint);
  } else if (sub === 'list') {
    const proj = getFlag('-p');
    const st = getFlag('--status');
    const data = runTaskList({ project: proj || undefined, status: (typeof st === 'string') ? st : 'open' });
    if (args.includes('--json')) { console.log(JSON.stringify(data)); done(0); }
    for (const t of data.tasks) {
      const dl = t.deadline ? ` ⏰${t.deadline}` : '';
      const ass = t.assignee ? ` @${t.assignee}` : '';
      const mark = t.importance === 'high' ? '!' : t.importance === 'med' ? '~' : ' ';
      const res = (t.resources && t.resources.length) ? ' ' + t.resources.map(r => '⛬' + r).join(' ') : '';
      console.log(`${mark} #${t.id} [${t.project}]${dl}${ass}${res} ${t.text}`);
    }
    console.log(`(${data.count} tasks)`);
  } else if (sub === 'get') {
    const id = args[2];
    if (!id || id.startsWith('-')) die('Id required: hub task get <id>');
    let r; try { r = runTaskGet({ id }); } catch (e) { die(e.message); }
    const t = r.task;
    console.log(`#${t.id} [${t.project}] ${t.status}${t.importance ? ' · ' + t.importance : ''}${t.deadline ? ' · ⏰' + t.deadline : ''}${t.assignee ? ' · @' + t.assignee : ''}`);
    console.log(t.text);
    if (t.cat || (t.tags || []).length) console.log(`cat: ${t.cat || '—'}${(t.tags || []).length ? '   tags: #' + t.tags.join(' #') : ''}`);
    if ((t.resources || []).length) console.log('resources: ' + t.resources.map(x => '⛬' + x).join(' '));
    if (t.note) console.log('note: ' + t.note);
    console.log(`created ${t.created || '?'} by ${t.by || '?'}${t.done ? ' · closed ' + t.done : ''}`);
    for (const [label, rows] of [['blocked by', r.blockedBy], ['blocks', r.blocks]]) {
      if (rows.length) console.log(`${label}: ` + rows.map(x => `#${x.id} (${x.status})`).join(', '));
    }
  } else if (sub === 'retag') {
    const apply = args.includes('--apply');
    const r = runTaskRetag({ apply, by: apply ? authorOrDie('--by') : undefined });
    if (!r.count) { console.log(`Categories are clean: every cat is one of ${TASK_CATS.join('/')}`); done(0); }
    for (const x of r.tasks) console.log(`  #${x.id} [${x.project}] cat "${x.cat}" → tag #${x.tag}`);
    console.log(apply
      ? `Moved ${r.moved}/${r.count} off-enum categories into tags${r.failed.length ? ' (failed: #' + r.failed.join(' #') + ')' : ''}`
      : `${r.count} task(s) carry an off-enum cat. Re-run with --apply --by <you> to move them into tags (append-only, nothing is rewritten).`);
  } else {
    die('task subcommands: add, get, done, list, retag');
  }
  done(0);
}

if (cmd === 'claim') {
  const proj = args[1], area = args[2];
  if (!proj || !area) die('Usage: hub claim <proj> <area> [-t min]');
  const ttl = parseInt(getFlag('-t') || '240');
  const agent = authorOrDie('--agent');
  const res = runClaim({ project: proj, area, agent, ttlMin: ttl });
  if (res.warning) console.warn('⚠  ' + res.warning);
  console.log(`Lock: ${res.claim.id}`);
  done(0);
}

if (cmd === 'release') {
  const id = args[1];
  if (!id) die('Usage: hub release <id>');
  const res = runRelease({ id });
  console.log(`Locks released: ${res.removed}`);
  done(0);
}

if (cmd === 'heartbeat') {
  const agent = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!agent) die('Usage: hub heartbeat <agent> [--role <role>] [--status <text>] [--task <id>] [--cwd <path>] [--ttl <min>]');
  const task = getFlag('--task');
  const ttl = getFlag('--ttl');
  const res = runHeartbeat({
    agent, role: (typeof getFlag('--role') === 'string') ? getFlag('--role') : undefined,
    status: (typeof getFlag('--status') === 'string') ? getFlag('--status') : undefined,
    task_id: (typeof task === 'string') ? task : undefined,
    cwd: (typeof getFlag('--cwd') === 'string') ? getFlag('--cwd') : undefined,
    ttlMin: (typeof ttl === 'string') ? parseInt(ttl, 10) : undefined,
  });
  console.log(`Heartbeat: ${res.agent} -> ${res.presence}`);
  done(0);
}

if (cmd === 'presence') {
  const roleFlag = getFlag('--role');
  const data = runPresence({ role: (typeof roleFlag === 'string') ? roleFlag : undefined, aliveOnly: args.includes('--alive') });
  if (!data.agents.length) { console.log('(no presence records)'); done(0); }
  for (const p of data.agents) {
    const mark = p.alive ? '●' : '○';
    console.log(`  ${mark} ${pad(p.agent, 18)}${pad(p.role || '·', 11)}${pad(p.status || '·', 11)}${p.last_seen}`);
  }
  console.log(`(${data.agents.length} agents, generated ${data.generated})`);
  done(0);
}

/* `hub card resolve` — the one file in a hub that can conflict, resolved the way a human
 * resolves it. Bullet-list hunks are unioned (two nodes appending facts have not disagreed);
 * prose hunks are left alone and named, because if both sides rewrote a digest, one of them
 * meant to replace the other and choosing would be inventing a decision. Exits non-zero while
 * anything is left, so a script cannot mistake a partial resolution for a finished one. */
if (cmd === 'card' && args[1] === 'resolve') {
  const targets = args.slice(2).filter(a => !a.startsWith('-'));
  const files = targets.length
    ? targets.map(t => (t.includes('/') || t.endsWith('.md') ? path.resolve(t) : cardPath(t)))
    : conflictedFiles();
  if (!files.length) { console.log('No conflicted cards.'); done(0); }
  let left = 0, touched = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { console.log('  skip  ' + f + ' (unreadable)'); continue; }
    const r = resolveCardConflicts(text);
    if (!r.resolved && !r.unresolved.length) { console.log('  clean ' + path.basename(f)); continue; }
    if (r.resolved) { fs.writeFileSync(f, r.text, 'utf8'); touched++; }
    console.log('  ' + path.basename(f) + ': ' + r.resolved + ' list hunk(s) unioned' +
      (r.unresolved.length ? ', ' + r.unresolved.length + ' left for you' : ''));
    for (const u of r.unresolved) {
      left++;
      console.log('      still conflicted in "' + u.section + '" (' + u.ours + ' line(s) vs ' + u.theirs + ') - prose, not a list');
    }
  }
  console.log(touched ? 'Rewrote ' + touched + ' card(s). Review, then commit.' : 'Nothing rewritten.');
  if (left) console.log('note: ' + left + ' hunk(s) need a human — hubd will not pick which side replaces the other.');
  done(left ? 1 : 0);
}

if (cmd === 'card') {
  const slug = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!slug) die('Usage: hub card <slug> -m "<digest>"  |  hub card resolve [slug...]');
  const digest = getFlag('-m') || getFlag('--digest');
  if (!digest || typeof digest !== 'string') die('Digest required: hub card <slug> -m "<digest>"');
  const by = authorOrDie('--by');
  const res = runCardSet({ project: slug, digest, by });
  console.log(`Card set: ${res.project} → ${res.card}`);
  done(0);
}

if (cmd === 'resource' || cmd === 'res') {
  const sub = args[1];
  if (sub === 'set') {
    const slug = args[2] && !args[2].startsWith('-') ? args[2] : null;
    if (!slug) die('Usage: hub resource set <slug> [-m "<note>"] [--type host] [--addr <ip/url>] [--os <o>] [--provider <p>] [--status live] [--link <rel>:<slug> ...]');
    const edges = {};                                    // --link rel:slug  (rel = runs_on|depends_on|deploys_to|part_of|exposes|connects|...)
    for (const l of getFlags('--link')) {
      const mm = String(l).match(/^([A-Za-z0-9_-]+)[:=](.+)$/);
      if (mm) (edges[mm[1]] = edges[mm[1]] || []).push(mm[2]);
      else die('--link expects <rel>:<slug>, got: ' + l);
    }
    const res = runResourceSet({
      slug, type: getFlag('--type'), address: getFlag('--addr') || getFlag('--address'),
      os: getFlag('--os'), provider: getFlag('--provider'), status: getFlag('--status'),
      digest: (typeof (getFlag('-m') || getFlag('--digest')) === 'string') ? (getFlag('-m') || getFlag('--digest')) : null,
      edges, by: authorOrDie('--by'),
    });
    console.log(`Resource set: ${res.resource} → ${res.card}`);
  } else if (sub === 'list') {
    const data = runResourceList({ type: (typeof getFlag('--type') === 'string') ? getFlag('--type') : undefined });
    for (const r of data.resources) console.log(`  ${pad(r.slug, 22)}${pad(r.type, 11)}${pad(r.status || '·', 9)}${r.address || ''}`);
    console.log(`(${data.count} resources)`);
  } else if (sub === 'get') {
    const slug = args[2];
    if (!slug || slug.startsWith('-')) die('Usage: hub resource get <slug>');
    const data = runResourceGet({ slug });
    process.stdout.write(data.card.endsWith('\n') ? data.card : data.card + '\n');
    if (data.out.length) { console.log('→ out:'); for (const e of data.out) console.log(`   ${e.rel} → ${e.to}`); }
    if (data.in.length) { console.log('← in:'); for (const e of data.in) console.log(`   ${e.from} —${e.rel}→`); }
  } else {
    die('resource subcommands: set, list, get');
  }
  done(0);
}

if (cmd === 'secret') {
  const sub = args[1];
  const teamRoot = (() => { try { return resolveQueueRoot(); } catch { return null; } })();
  const name = args[2];
  try {
    if (sub === 'set') {
      if (!name) die('Usage: hub secret set <name>   (value is read from stdin)');
      // stdin only. A value in argv is visible in `ps` to every user on the box
      // and lands in the typist's shell history; there is no flag for it on
      // purpose.
      const value = fs.readFileSync(0);   // Buffer: a binary secret must survive
      if (!value.length) die('nothing on stdin — pipe the value in, e.g. `printf %s "$V" | hub secret set NAME`');
      const { file, bytes } = setSecret(name, value, { teamRoot });
      console.log(`stored ${name} (${bytes} bytes, 0600) at ${file}`);
      console.log('NOT encrypted at rest: this is a 0600 file outside the replicated hub, nothing more.');
      done(0);
    } else if (sub === 'get') {
      if (!name) die('Usage: hub secret get <name>');
      process.stdout.write(getSecret(name, { teamRoot }));   // Buffer, written raw
      done(0);
    } else if (sub === 'path') {
      if (!name) die('Usage: hub secret path <name>');
      console.log(secretPath(name, { teamRoot }));
      done(0);
    } else if (sub === 'list' || sub === undefined) {
      const rows = listSecrets({ teamRoot });
      console.log(`secrets in ${secretsRoot()} (outside the hub, never replicated):`);
      if (!rows.length) console.log('  (none)');
      for (const r of rows) console.log(`  ${r.name}  ${r.bytes} bytes  ${r.mode}  ${r.modified}`);
      const bad = auditModes({ teamRoot });
      for (const b of bad) console.log(`  ! ${b.path} is ${b.mode}, want ${b.want}`);
      done(bad.length ? 1 : 0);
    } else if (sub === 'backup') {
      const names = name ? [name] : listSecrets({ teamRoot }).map(r => r.name).filter(n => n !== 'backup-passphrase');
      if (!names.length) die('nothing to back up');
      for (const n of names) {
        const { file, bytes } = backupSecret(n, { teamRoot });
        console.log(`  ${n} -> ${file} (${bytes} bytes, AES-256)`);
      }
      console.log(`\nThese ride the hub's replication, so they survive losing this disk.`);
      console.log(`They do NOT survive losing this machine unless the passphrase is also`);
      console.log(`kept somewhere else — it lives only in ${secretsRoot()}, outside the hub`);
      console.log(`on purpose. A backup whose key exists in exactly one place is a backup`);
      console.log(`of nothing.`);
      done(0);
    } else if (sub === 'restore') {
      if (!name) die('Usage: hub secret restore <name>');
      const { file, bytes } = restoreSecret(name, { teamRoot });
      console.log(`restored ${name} (${bytes} bytes) to ${file}`);
      done(0);
    } else if (sub === 'verify') {
      const rows = verifyBackups({ teamRoot });
      console.log(`encrypted backups in ${backupDir(teamRoot)}:`);
      if (!rows.length) console.log('  (none)');
      let bad = 0;
      for (const r of rows) {
        console.log(`  ${r.name}: ${r.status}`);
        if (/FAIL|DIFFERS/.test(r.status)) bad++;
      }
      done(bad ? 1 : 0);
    } else if (sub === 'rm') {
      if (!name) die('Usage: hub secret rm <name>');
      console.log(removeSecret(name, { teamRoot }) ? `removed ${name}` : `no secret named ${name}`);
      done(0);
    } else {
      die('secret subcommands: set <name> (stdin), get <name>, path <name>, list, backup [name], restore <name>, verify, rm <name>');
    }
  } catch (e) { die(e.message); }
}

if (cmd === 'graph') {
  const pf = getFlag('-p') || getFlag('--project');
  const data = runGraph({
    project: (typeof pf === 'string') ? pf : undefined,
    type: (typeof getFlag('--type') === 'string') ? getFlag('--type') : undefined,
  });
  const label = (s) => {
    const n = data.nodes[s];
    if (!n) return s + ' ⚠missing';
    const meta = [n.type && n.type !== 'project' ? n.type : null, n.address].filter(Boolean).join('·');
    return s + (meta ? ` (${meta})` : '');
  };
  const byFrom = {};
  for (const e of data.edges) (byFrom[e.from] = byFrom[e.from] || []).push(e);
  const froms = Object.keys(byFrom).sort();
  if (!froms.length) console.log('(no relationships yet — add edges in card frontmatter, e.g. runs_on: [[myvm]], or: hub resource set myvm --link runs_on:hubd)');
  for (const f of froms) {
    console.log(label(f));
    for (const e of byFrom[f]) console.log(`  └─ ${e.rel} → ${label(e.to)}`);
  }
  if (data.dangling.length) {
    console.log('\n⚠ dangling (target has no card — create it or it stays a note):');
    for (const d of data.dangling) console.log(`  ${d.from} —${d.rel}→ ${d.to}`);
  }
  done(0);
}

if (cmd === 'section') {
  // `hub section add <proj> <section> "<text>"` — one line into one section, everything else
  // in the card untouched. Sits next to `hub sections` (which lists the vocabulary).
  if (args[1] !== 'add') die('Usage: hub section add <project> <section> "<text>" --by <you> [--src <where it came from>] [--set]');
  const [, , project, section, text] = args;
  if (!project || !section || !text) die('Usage: hub section add <project> <section> "<text>" --by <you> [--src <where it came from>] [--set]');
  const src = getFlag('--src');
  let r;
  try {
    r = runSectionAdd({ project, section, text, by: authorOrDie('--by'),
      provenance: typeof src === 'string' ? src : undefined, mode: args.includes('--set') ? 'set' : 'append' });
  } catch (e) { die(e.message); }
  console.log(`${r.project} → ## ${r.section}${r.created ? '  (section created — check the name if you expected it to exist)' : ''}`);
  done(0);
}

if (cmd === 'now' || cmd === 'whatnext') {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : (getFlag('-p') || null);
  const r = runNext({ project: proj || undefined, assignee: getFlag('--assignee') || undefined });
  if (!r.task) { console.log('nothing to do: ' + r.why); done(0); }
  const t = r.task;
  console.log(`#${t.id} [${t.project}]${t.deadline ? ' \u23f0' + t.deadline : ''}${t.assignee ? ' @' + t.assignee : ''}`);
  console.log(t.text);
  console.log(`\nwhy: ${r.why}`);
  console.log(`(${r.eligible} ready, ${r.blockedCount} blocked` + (r.runnerUp ? `; next after it: #${r.runnerUp.id}` : '') + ')');
  done(0);
}

if (cmd === 'agenda') {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : (getFlag('-p') || null);
  const r = runAgenda({ project: proj || undefined });
  const P = (title, rows, fmt) => { if (rows.length) { console.log(`\n${title} (${rows.length}):`); for (const x of rows) console.log('  ' + fmt(x)); } };
  console.log(`\u2500\u2500 AGENDA${proj ? ' \u00b7 ' + proj : ''} \u00b7 ${r.generated} \u2500\u2500  ready ${r.counts.eligible} \u00b7 blocked ${r.counts.blocked}`);
  const line = (x) => `#${x.id} [${x.project}]${x.deadline ? ' \u23f0' + x.deadline : ''}${x.assignee ? ' @' + x.assignee : ''} ${x.text}`;
  P('OVERDUE', r.overdue, line);
  P('DUE SOON', r.dueSoon, line);
  P('OWNER BUTTONS (only a human can press)', r.ownerButtons, line);
  P('AGENT WORK, READY NOW', r.agentReady, line);
  P('BLOCKED', r.blocked, x => line(x) + '  \u2190 waits on #' + x.waitingOn.join(' #'));
  if (!r.counts.eligible && !r.counts.blocked) console.log('\nnothing open');
  done(0);
}

if (cmd === 'recall') {
  const q = args[1] && !args[1].startsWith('-') ? args[1] : getFlag('-q');
  if (!q || typeof q !== 'string') die('Usage: hub recall "<what do we know about X>" [--limit N] [--stale-days N]');
  let r;
  try { r = runRecall({ query: q, limit: parseInt(String(getFlag('--limit') || '20'), 10), staleDays: parseInt(String(getFlag('--stale-days') || '30'), 10) }); }
  catch (e) { die(e.message); }
  if (args.includes('--json')) { console.log(JSON.stringify(r)); done(0); }
  console.log(`recall "${r.query}" \u2014 ${r.total} hit(s), top ${r.hits.length}`);
  for (const h of r.hits) {
    console.log(`\n[${h.kind}] ${h.where}${h.asOf ? '  as of ' + h.asOf : ''}${h.stale ? `  \u26a0 ${h.ageDays}d old \u2014 was true then, verify` : ''}`);
    console.log('  ' + h.text.replace(/\n+/g, ' ').slice(0, 220));
  }
  if (r.hint) console.log('\n' + r.hint);
  done(0);
}

if (cmd === 'usage') {
  if (args[1] === 'add') {
    let r;
    try {
      r = runUsageAdd({
        agent: authorOrDie('--agent'), project: getFlag('-p') || undefined, task: getFlag('--task') || undefined,
        seconds: getFlag('--seconds'), tokensIn: getFlag('--tokens-in'), tokensOut: getFlag('--tokens-out'),
        costUsd: getFlag('--cost'), model: getFlag('--model') || undefined,
      });
    } catch (e) { die(e.message); }
    const x = r.recorded;
    console.log(`recorded for ${x.agent}${x.project ? ' [' + x.project + ']' : ''}${x.task ? ' #' + x.task : ''}: ` +
      [x.seconds !== null ? x.seconds + 's' : null, (x.tokensIn || x.tokensOut) ? ((x.tokensIn || 0) + (x.tokensOut || 0)) + ' tokens' : null,
       x.costUsd !== null ? '$' + x.costUsd : null].filter(Boolean).join(', '));
    done(0);
  }
  const days = parseInt(String(getFlag('--days') || '7'), 10);
  const r = runUsage({ days, project: getFlag('-p') || undefined });
  if (args.includes('--json')) { console.log(JSON.stringify(r)); done(0); }
  console.log(`\u2500\u2500 USAGE \u00b7 ${days}d${r.project ? ' \u00b7 ' + r.project : ''} \u2500\u2500`);
  console.log(`SUPPLIED by callers (${r.supplied.calls} report(s)): ${Math.round(r.supplied.seconds / 60)} min \u00b7 ` +
    `${r.supplied.tokensIn + r.supplied.tokensOut} tokens \u00b7 $${r.supplied.costUsd}`);
  for (const [p, v] of Object.entries(r.supplied.byProject).sort((x, y) => y[1].costUsd - x[1].costUsd).slice(0, 10)) {
    console.log(`  ${p}: ${Math.round(v.seconds / 60)} min \u00b7 ${v.tokens} tokens \u00b7 $${Math.round(v.costUsd * 100) / 100}`);
  }
  console.log(`MEASURED by the hub: ${r.measured.tasksClosed} task(s) closed` +
    (r.measured.medianDaysToClose !== null ? `, median ${r.measured.medianDaysToClose}d open-to-close` : ''));
  console.log('note: ' + r.note);
  done(0);
}

if (cmd === 'rules') {
  const app = getFlag('--append');
  if (typeof app === 'string') {
    let r; try { r = runRules({ append: app, by: authorOrDie('--by'), teamRoot: resolveQueueRoot() }); } catch (e) { die(e.message); }
    console.log(`amended ${r.file}:\n  ${r.appended}`);
    done(0);
  }
  const r = runRules({ teamRoot: resolveQueueRoot() });
  if (!r.exists) { console.log(r.hint); done(1); }
  console.log(r.text);
  done(0);
}

if (cmd === 'operator') {
  const r = runOperatorGet();
  if (!r.exists) { console.log(r.hint + '\n\nsuggested sections:\n' + r.scaffold); done(1); }
  console.log(r.card);
  done(0);
}

if (cmd === 'audit') {
  const days = parseInt(String(getFlag('--days') || '7'), 10);
  const apply = args.includes('--apply');
  const queues = queueSummaryForBrief({ root: resolveQueueRoot() });
  let r;
  try { r = runAudit({ days, apply, queues, by: apply ? authorOrDie('--by') : undefined }); }
  catch (e) { die(e.message); }
  console.log(`── AUDIT · ${r.generated} · window ${days}d ──`);
  for (const n of r.notes) console.log('  note: ' + n);
  const N = r.numbers;
  console.log(`\nNUMBERS (a thermometer, not a verdict):`);
  console.log(`  journal entries: ${N.journalEntries} · open tasks: ${N.openTasks}`);
  console.log(`  attention share: ` + (Object.entries(N.attentionShare).map(([p, n]) => `${p} ${Math.round((n / (N.journalEntries || 1)) * 100)}%`).join(' · ') || 'none'));
  console.log(`  closed by category: ` + (Object.entries(N.closedByCat).map(([k, v]) => `${k} ${v.closed}`).join(' · ') || 'none'));
  console.log(`  closed by assignee: ` + (N.closedByAssignee.map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'));
  if (!r.findings.length) { console.log('\nno findings — declarations and behaviour agree'); done(0); }
  console.log(`\nFINDINGS (${r.findings.length}):`);
  for (const f of r.findings) {
    const mark = f.severity === 'high' ? '!' : f.severity === 'med' ? '~' : ' ';
    console.log(` ${mark} [${f.id}] ${f.what}`);
    console.log(`     rule: ${f.law}${f.lawSince ? ' (recorded ' + f.lawSince + ')' : f.lawDeclared ? '' : '  ← engine default; declare yours in rules.json → laws'}`);
    console.log(`     fix:  ${f.fix}`);
  }
  if (apply) {
    console.log(`\nfiled ${r.filed.length} incident(s)` + (r.filed.length ? ': #' + r.filed.map(x => x.task).join(' #') : '') +
      (r.skipped.length ? `; ${r.skipped.length} already open (deduped by key)` : ''));
    console.log('one report written to project "general"');
  } else {
    console.log('\nnothing filed. Re-run with --apply --by <you> to turn each finding into an incident task (a key already open is never filed twice).');
  }
  done(r.findings.length ? 1 : 0);
}

if (cmd === 'lint') {
  const r = runLint({});
  for (const n of r.notes) console.log('note: ' + n);
  if (!r.findings.length) {
    console.log('lint: nothing to report' + (r.enforced.length ? '  (enforced: ' + r.enforced.join(', ') + ')' : '  (no rule is enforced — see rules.json → strict)'));
    done(0);
  }
  for (const f of r.findings) {
    console.log(`${f.enforced ? '!' : ' '} [${f.id}] ${f.what}`);
    console.log(`    rule: ${f.law}${f.lawSince ? ' (' + f.lawSince + ')' : ''}${f.lawDeclared ? '' : '  ← not declared locally; add it to rules.json → laws so an incident can quote YOU'}`);
    console.log(`    fix:  ${f.fix}`);
  }
  console.log(`\n${r.findings.length} finding(s). Enforced: ${r.enforced.length ? r.enforced.join(', ') : 'none'} — turn a rule on in ${path.join(HUB, 'rules.json')} → strict.`);
  done(1);
}

if (cmd === 'sections') {
  console.log('section key      heading   (single source for card scaffold + report routing)');
  for (const s of sectionsConfig()) console.log('  ' + pad(s.key, 16) + s.heading);
  console.log('\nlocalise in ONE file → HUB/sections.json  (merged by key onto the defaults)');
  console.log('  e.g. { "decisions": "<your heading>", "next": {"heading":"...","hint":"..."} }');
  done(0);
}

if (cmd === 'harvest') {
  const p = harvestPrompt();
  if (!p) die('HARVEST.md not found in this hubd package');
  console.log(p);   // paste-able Harvest Protocol prompt — ships with the code, not the repo
  done(0);
}

// Who is running this command. Was `--agent || $USER || 'cli'`, which recorded 41
// 'cli' and 19 'root' entries — the shell user, not the function doing the work, and
// agents shell out to this CLI too, so "it came from a terminal" never meant "a human
// did it". Now the caller says so explicitly, or HUBD_AGENT does it for them.
function authorOrDie(flag) {
  const v = (getFlag(flag) || process.env.HUBD_AGENT || '').trim();
  if (!v) die(`${flag} required (or set HUBD_AGENT): the function doing this, e.g. "dev-hubd"`);
  return v;
}

if (cmd === 'gc') {
  let removed = 0;
  const nowMs = Date.now();
  try {
    for (const f of fs.readdirSync(HUB)) {
      const full = path.join(HUB, f);
      if (f.endsWith('.lock')) {                       // stale locks (live ones are stolen after 30s)
        try { if (nowMs - fs.statSync(full).mtimeMs > 60000) { fs.unlinkSync(full); console.log('  removed stale lock ' + f); removed++; } } catch {}
      } else if (f.startsWith('tasks.json.bak')) {     // ONLY the generated task-cache backup — never a user .bak file
        try { fs.unlinkSync(full); console.log('  removed backup ' + f); removed++; } catch {}
      }
    }
  } catch (e) { die('cannot read hub dir: ' + e.message); }
  // Per-subscriber cursor dirs accumulate one per session and nothing else ever removes
  // them. Only sweep dirs untouched for a week: an idle but live session must keep its
  // cursor, or it silently resumes at the tail and skips whatever arrived meanwhile.
  // Shared cursors sit as plain files in .qstate and are never touched here.
  // Two levels, because subscribers live in two places: .qstate/<subscriber>/ for a
  // role's own readers, and .qstate/__watchall__/<subscriber>/ for fleet taps — the
  // latter is where an orchestrator's cursor goes, so skipping __watchall__ outright
  // would exempt the busiest kind from the sweep entirely.
  const sweepCursors = (dir, label) => {
    let n = 0;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = path.join(dir, d.name);
      if (d.name === '__watchall__' && label === '') { n += sweepCursors(full, '__watchall__/'); continue; }
      let newest = 0;
      for (const f of fs.readdirSync(full)) {
        try { newest = Math.max(newest, fs.statSync(path.join(full, f)).mtimeMs); } catch {}
      }
      if (newest && nowMs - newest > 7 * 86400000) {
        try { fs.rmSync(full, { recursive: true, force: true }); console.log('  removed stale cursor ' + label + d.name); n++; } catch {}
      }
    }
    return n;
  };
  try { removed += sweepCursors(path.join(resolveQueueRoot(), '.qstate'), ''); } catch {}
  // Session records in .env-state.json accumulate the same way cursor dirs do — one per
  // session that was told about a protocol change — so they go by the same rule.
  try {
    const esf = path.join(HUB, '.env-state.json');
    const st = JSON.parse(fs.readFileSync(esf, 'utf8'));
    const keep = {}, before = Object.keys(st.sessions || {}).length;
    for (const [sid, rec] of Object.entries(st.sessions || {})) {
      const at = rec && rec.at ? new Date(rec.at).getTime() : 0;
      if (at && nowMs - at <= 7 * 86400000) keep[sid] = rec;
    }
    if (before !== Object.keys(keep).length) {
      st.sessions = keep;
      fs.writeFileSync(esf, JSON.stringify(st, null, 1));
      const n = before - Object.keys(keep).length;
      console.log('  removed ' + n + ' stale session record(s)'); removed += n;
    }
  } catch {}
  console.log(removed ? `gc: removed ${removed} item(s)` : 'gc: nothing to clean');
  done(0);
}

if (cmd === 'sync') {
  const pathArg = args[1] && !args[1].startsWith('-') ? args[1] : '.';
  const dir = path.resolve(pathArg);
  if (!fs.existsSync(dir)) die('Folder not found: ' + dir);
  const slug = slugify(path.basename(dir));
  const cardFile = path.join(PROJ, slug + '.md');
  let oldDigest = '';
  if (fs.existsSync(cardFile)) {
    oldDigest = digestOf(fs.readFileSync(cardFile, 'utf8')) || '';
  }
  const flagDigest = getFlag('-m') || getFlag('--digest');
  if (flagDigest && typeof flagDigest === 'string') {   // non-interactive (scriptable) sync
    const res = runSync({ path: dir, digest: flagDigest, agent: authorOrDie('--agent') });
    console.log(`Synced: ${res.project} → ${res.card}`);
    done(0);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = oldDigest ? `[Enter = keep: "${oldDigest.slice(0, 60)}…"]` : '[new digest]';
  rl.question(`Digest ${hint}: `, (answer) => {
    rl.close();
    const digest = answer.trim() || oldDigest || undefined;
    const res = runSync({ path: dir, digest, agent: authorOrDie('--agent') });
    console.log(`Synced: ${res.project} → ${res.card}`);
    done(0);
  });
  // async readline keeps process alive until callback
}

else if (cmd === 'install-hook') {
  const dir = path.resolve(args[1] || '.');
  const hooksDir = path.join(dir, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) die('Not a git repo: no .git/hooks in ' + dir);
  const hookFile = path.join(hooksDir, 'post-commit');
  const block = `# hubd >>>\nnode "${__filename}" _commit-hook "$(git rev-parse --show-toplevel)" &\n# <<< hubd\n`;
  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, 'utf8');
    if (existing.includes('# hubd >>>')) {
      console.log('Hook already installed (idempotent)');
    } else {
      fs.appendFileSync(hookFile, '\n' + block);
      console.log('Block appended to existing hook');
    }
  } else {
    fs.writeFileSync(hookFile, '#!/bin/sh\n' + block);
  }
  fs.chmodSync(hookFile, 0o755);
  console.log('Hook: ' + hookFile);
  done(0);
}

else if (cmd === '_commit-hook') {
  // Hidden command: invoked from the post-commit hook. Must never break a commit.
  try {
    const repoPath = args[1];
    if (!repoPath) done(0);
    const info = sh('git log -1 --format=%H%n%an%n%s', repoPath);
    const parts = info.split('\n');
    const sha = parts[0], author = parts[1], subject = parts.slice(2).join(' ').trim();
    if (!sha) done(0);
    journalAppend({ ts: now(), project: slugify(path.basename(repoPath)), agent: 'git:' + author, kind: 'done', text: sha.slice(0, 7) + ' ' + subject });
  } catch {}
  done(0);
}

else if (cmd === 'queue') {
  const sub = args[1];
  if (sub === 'send') {
    const role = args[2];
    const text = args[3];
    if (!role || !text) die('Usage: hub queue send <role> "<text>" --from <who>');
    // The sender is an author like any other write's (was `--from || 'unknown'`, the
    // one durable channel that skipped the rule) — flag, or the HUBD_AGENT floor.
    // --task ties the message to what it is ABOUT, so the reply is not orphaned from the
    // work. A ref that matches no task is flagged now, not discovered days later.
    const taskRef = getFlag('--task');
    let unknownTask = false;
    if (typeof taskRef === 'string') { try { runTaskGet({ id: taskRef }); } catch { unknownTask = true; } }
    let qfile;
    try { qfile = queueSend(role, text, { from: authorOrDie('--from'), task: typeof taskRef === 'string' ? taskRef : undefined }); }
    catch (e) { die(e.message); }
    console.log(`→ ${path.basename(qfile)} delivered` + (typeof taskRef === 'string' ? `  (about task #${taskRef})` : ''));
    if (unknownTask) console.error(`  warning: no task #${taskRef} in this hub — the reference was still recorded, check the id`);
    done(0);
  } else if (sub === 'wait') {
    const role = args[2];
    // A flag must not be consumed as the role. `hub queue wait --timeout 5`
    // otherwise waits on a queue literally named "--timeout" -- which exists as
    // soon as it is asked for, so it blocks forever and looks like a quiet queue
    // rather than a mistake.
    if (!role || role.startsWith('-')) die('Usage: hub queue wait <role|*> [--timeout <N>] [--as <subscriber>] [--from-now]');
    const timeoutRaw = getFlag('--timeout');
    const timeout = timeoutRaw ? parseInt(String(timeoutRaw), 10) : 540;
    const subscriber = getFlag('--as') || undefined;
    const fromNow = args.includes('--from-now');
    if (role === '*') {
      // Subscribe to every role's queue at once — a supervisory tap, own
      // offset namespace, never steals a message from a role's own consumer.
      queueWaitAll({ timeout }).then(result => {
        if (result.changed) {
          for (const e of result.events) console.log(`## from queue ${e.role}${e.node ? '.' + e.node : ''}\n${e.text}`);
          done(0);
        } else {
          console.log('NO_CHANGES');
          done(2);
        }
      }).catch(e => die(e.message));
    } else {
      // --as gives this caller its own cursor namespace, but only for a role
      // declared in subscriber-roles.json: fan-out has to be a property of the
      // ROLE, or any long-lived caller would silently turn a work queue into a
      // broadcast and two workers would both do the same task. Without it the
      // cursor stays shared per node, which is what a competing-worker queue
      // needs. This flag existed in the library from the start and had no way in
      // from the command line -- so the environment notice that says "declare the
      // role and every waiter gets its own cursor" could not actually be acted on
      // by anyone using the CLI, which is every supervisor and every monitor.
      queueWait(role, { timeout, subscriber, fromNow }).then(result => {
        if (result.changed) {
          console.log(result.text);
          if (result.tasks) console.log(`\n# about task(s): ${result.tasks.map(t => '#' + t).join(' ')} — report against them (DONE:/NOTE:) so the task carries the outcome`);
          done(0);
        } else {
          console.log('NO_CHANGES');
          done(2);
        }
      }).catch(e => die(e.message));
    }
  } else if (sub === 'monitor') {
    // `wait` answers "is there something right now, within N seconds"; a
    // supervisor needs "wake me when there is", which is a different question.
    // Looping `wait` from a shell script is how that was done before, and it
    // belonged here instead: the caller of a monitor is usually a process
    // supervisor or an agent runtime that treats EXIT as the signal, so a
    // timeout must not look like an event. This exits 0 only when there is real
    // content, and keeps waiting otherwise.
    const role = args[2];
    if (!role || role.startsWith('-')) die('Usage: hub queue monitor <role|*> [--timeout <N>] [--once] [--as <subscriber>] [--from-now]');
    const timeoutRaw = getFlag('--timeout');
    const timeout = timeoutRaw ? parseInt(String(timeoutRaw), 10) : 540;
    const once = args.includes('--once');
    const subscriber = getFlag('--as') || undefined;
    const fromNow = args.includes('--from-now');
    const waiter = role === '*'
      ? () => queueWaitAll({ timeout })
      : () => queueWait(role, { timeout, subscriber, fromNow });
    const render = (result) => {
      if (role === '*') {
        for (const e of result.events) console.log(`## from queue ${e.role}${e.node ? '.' + e.node : ''}\n${e.text}`);
      } else {
        console.log(result.text);
        if (result.tasks) console.log(`\n# about task(s): ${result.tasks.map(t => '#' + t).join(' ')} — report against them (DONE:/NOTE:) so the task carries the outcome`);
      }
    };
    const loop = () => waiter().then(result => {
      if (result.changed) { render(result); done(0); return; }
      if (once) { console.log('NO_CHANGES'); done(2); return; }
      loop();
    }).catch(e => die(e.message));
    loop();
  } else if (sub === 'status') {
    const role = args[2] && !args[2].startsWith('-') ? args[2] : undefined;
    const { roles } = queueLedger({ root: resolveQueueRoot(), role });
    if (!roles.length) { console.log(role ? `No queue files for role ${role}` : 'No queue files yet'); done(0); }
    if (args.includes('--json')) { console.log(JSON.stringify({ roles })); done(0); }
    for (const r of roles) {
      const tag = (r.isButton ? ' 🔘' : '') + (r.fanout ? ' (broadcast)' : '');
      console.log(`${r.role}${tag}: ${r.total} message(s) — ${r.delivered} delivered, ${r.pending} pending`);
      for (const f of r.files) {
        console.log(`    ${f.node || '(legacy, no node)'}: ${f.total} total, ${f.delivered} delivered, ${f.pending} pending` +
          (f.cursor === null ? '   no cursor — nobody has ever consumed this file' : `   cursor ${f.cursor}/${f.bytes}B`));
      }
      for (const rd of r.readers) console.log(`    reader ${rd.subscriber}: ${rd.delivered} delivered`);
    }
    done(0);
  } else if (sub === 'gc') {
    const days = parseInt(String(getFlag('--days') || '30'), 10);
    const apply = args.includes('--apply');
    const r = runQueueGc({ root: resolveQueueRoot(), days, apply });
    for (const g of r.ghosts) {
      console.log(`  ${g.file}  ${g.messages} msg, ${g.bytes}B, ${g.newest ? 'newest ' + g.newest : 'empty'}, ${g.ageDays}d, never read`);
    }
    if (apply) {
      console.log(r.count
        ? `Archived ${r.moved.length}/${r.count} ghost queue(s) → ${r.archive}${r.failed.length ? '  (failed: ' + r.failed.join(', ') + ')' : ''}`
        : `Nothing to archive at --days ${days}`);
      done(0);
    }
    console.log(r.count
      ? `${r.count} ghost queue(s) older than ${days}d, ${r.live} live. Nothing moved — re-run with --apply to archive them into queues/archive/ (moved, never deleted).`
      : `No ghost queues older than ${days}d: every queue file has a cursor, a present agent, or is newer.`);
    // Say what the threshold is hiding — the honest denominator, not just the catch.
    if (r.neverRead > r.count) {
      console.log(`  note: ${r.neverRead} of ${r.total} queue file(s) have never been consumed at all — ${r.neverRead - r.count} of them newer than ${days}d and left alone. Lower the bar with --days <N> once you know they are dead.`);
    }
    done(0);
  } else {
    die('queue subcommands: send, wait, monitor, gc');
  }
}

else if (cmd === 'serve') {
  const port = parseInt(getFlag('-p') || getFlag('--port') || '7777');
  startServer(port);
}

else if (!cmd) {
  console.log([
    'hubd CLI',
    '',
    'Usage: hub <command>',
    '',
    '  init [path]                      scaffold a team folder (AGENTS.md, INBOX.md, queues/)',
    '  version | --version | -v         installed hubd version, and which copy is answering',
    '  doctor                           check hub base, team root, locks, queues and writer versions',
    '  upgrade                          refresh HUBD.md (the agent protocol) to the installed version',
    '  status                           project table',
    '  brief [-h <hours>]               morning brief',
    '  inbox [--hours <N>]              what needs a decision now (blocked/overdue/unassigned/stale locks)',
    '  plan [project]                   dependency-graph trajectory: ready now · critical path · unlock order · cycles',
    '  log [project] [-n 20]            journal tail',
    '  report [-p <proj>]               structured report → card sections (no input prints the template)',
    '    DECIDE:/FACT:/HYPO:/COMM:/NEXT:/DONE:/TASK:/NOTE: lines, via stdin (heredoc) or -m',
    '  decide "<what>" --why "<why>" -p <proj>   append a decision to ## Decisions',
    '  next "<the one next action>" -p <proj>    set ## Next step',
    '  task add "<text>" -p <proj> [-i high|med] [-d YYYY-MM-DD] [--needs 1,2] [--resource <slug>]',
    '  task done <id>',
    '  task list [-p proj] [--status open|done|all] [--json]',
    '  card <slug> -m "<digest>"        set a project card without a folder',
    '  card resolve [slug...]           union the list hunks of a conflicted card, name the rest',
    '  resource set <slug> [-m "<note>"] [--type host|vm|service|endpoint|provider] [--addr <a>] [--status live] [--link <rel>:<slug>]',
    '  resource list [--type <t>]       infra/topology cards (hosts, vms, services, ...)',
    '  resource get <slug>              one resource + its in/out relationships',
    '  graph [-p <proj>] [--type <t>]   typed relationship graph (runs_on/depends_on/deploys_to/...)',
    '  sections                         card section keys → headings (localise via HUB/sections.json)',
    '  harvest                          print the Harvest Protocol prompt (also served as an MCP prompt)',
    '  claim <proj> <area> [-t min]     soft lock',
    '  release <id>                     release a lock',
    '  heartbeat <agent> [--role r] [--status s] [--task id] [--cwd path] [--ttl min]   record liveness',
    '  presence [--role r] [--alive]    fleet roster (who has heartbeated, alive/stale)',
    '  sync [path] [-m "<digest>"]      sync a project (-m = non-interactive)',
    '  gc                               remove stale locks and old backups',
    '  install-hook [path]              git post-commit hook',
    '  queue send <role> "<text>" --from <who>',
    '  secret set|get|path|list|rm <name>   values kept outside the replicated hub',
    '  queue wait <role> [--timeout <N>] [--as <subscriber>]',
    '  queue monitor <role> [--timeout <N>] [--once] [--as <sub>] [--from-now]',
    '                                   block until real content, then exit 0',
    '  serve [-p 7777]                  read-only kanban dashboard',
  ].join('\n'));
  done(0);
}

else if (!['sync', 'install-hook', '_commit-hook', 'serve', 'queue'].includes(cmd)) {
  die('Unknown command: ' + cmd + '. Run hub with no arguments for help.');
}

/* ── web server (read-only kanban) ── */
function startServer(port) {
  const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hubd</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#FAFAF8;color:#16181A;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #E3E3DE}
h1{font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
#updated{color:#6B6B66;font-size:11px}
#btn-rules{background:none;border:1px solid #E8590C;color:#E8590C;font-family:inherit;font-size:11px;padding:4px 10px;cursor:pointer;letter-spacing:.04em;border-radius:1px}
#btn-rules:hover{background:#E8590C;color:#FAFAF8}
.board{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid #E3E3DE}
.col{border-right:1px solid #E3E3DE}
.col:last-child{border-right:none}
.col-head{padding:10px 14px;border-bottom:1px solid #E3E3DE;display:flex;justify-content:space-between;align-items:baseline}
.col-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.col-count{font-size:11px;color:#6B6B66}
.task{padding:10px 14px;border-bottom:1px solid #E3E3DE}
.task:last-child{border-bottom:none}
.task-text{font-size:12px;color:#16181A}
.task-blocked .task-text{color:#6B6B66}
.task-meta{font-size:11px;color:#6B6B66;margin-top:3px}
.empty{padding:14px;font-size:11px;color:#6B6B66;font-style:italic}
.act-head{padding:10px 14px;border-bottom:1px solid #E3E3DE;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.entry{padding:7px 14px;border-bottom:1px solid #E3E3DE;font-size:11px;display:grid;grid-template-columns:90px 90px 60px 1fr;gap:8px;align-items:baseline}
.entry:last-child{border-bottom:none}
.e-ts{color:#6B6B66}
.e-proj{font-weight:600}
.e-kind{color:#6B6B66}
#modal{display:none;position:fixed;inset:0;background:rgba(22,24,26,.55);z-index:100;align-items:flex-start;justify-content:center;padding-top:60px}
#modal.open{display:flex}
#modal-panel{background:#FAFAF8;border:1px solid #E3E3DE;width:640px;max-width:90vw;max-height:72vh;display:flex;flex-direction:column}
#modal-head{padding:10px 16px;border-bottom:1px solid #E3E3DE;display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
#modal-close{background:none;border:none;color:#6B6B66;font-size:18px;cursor:pointer;font-family:inherit;padding:0 2px;line-height:1}
#modal-body{padding:16px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:1.6;color:#16181A}
</style>
</head>
<body>
<header>
  <h1>hubd</h1>
  <div style="display:flex;align-items:center;gap:16px">
    <span id="updated"></span>
    <button id="btn-rules">&#9881; Rules</button>
  </div>
</header>
<div class="board">
  <div class="col">
    <div class="col-head"><span class="col-title">Queued</span><span class="col-count" id="cnt-q">0</span></div>
    <div id="col-q"></div>
  </div>
  <div class="col">
    <div class="col-head"><span class="col-title">In progress</span><span class="col-count" id="cnt-p">0</span></div>
    <div id="col-p"></div>
  </div>
  <div class="col">
    <div class="col-head"><span class="col-title">Done today</span><span class="col-count" id="cnt-d">0</span></div>
    <div id="col-d"></div>
  </div>
</div>
<div>
  <div class="act-head">Activity</div>
  <div id="activity"></div>
</div>
<div id="modal">
  <div id="modal-panel">
    <div id="modal-head">
      <span>Rules</span>
      <button id="modal-close">&#215;</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>
<script>
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
var todayP3=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
function taskEl(t){
  var blocked=t.blocked;
  var dlUrgent=t.deadline&&t.deadline<=todayP3;
  var h='<div class="task'+(blocked?' task-blocked':'')+'">'+
    '<div class="task-text">'+(blocked?'&#9939; ':'')+esc(t.text)+'</div>';
  var meta=[];
  if(t.assignee)meta.push('@'+esc(t.assignee));
  if(t.deadline)meta.push((dlUrgent?'<span style="color:#E8590C">':'')+esc(t.deadline)+(dlUrgent?'</span>':''));
  if(blocked&&t.depends_on&&t.depends_on.length)meta.push('<span style="color:#E8590C">needs #'+t.depends_on.map(function(id){return esc(String(id))}).join(', #')+'</span>');
  if(meta.length)h+='<div class="task-meta">'+meta.join(' &middot; ')+'</div>';
  return h+'</div>';
}
function renderCol(id,cntId,tasks){
  document.getElementById(cntId).textContent=tasks.length;
  document.getElementById(id).innerHTML=tasks.length?tasks.map(taskEl).join(''):'<div class="empty">no tasks</div>';
}
async function load(){
  try{
    var d=await fetch('/api/kanban'+location.search).then(function(r){return r.json()});
    renderCol('col-q','cnt-q',d.queued);
    renderCol('col-p','cnt-p',d.inProgress);
    renderCol('col-d','cnt-d',d.doneToday);
    document.getElementById('activity').innerHTML=d.inbox.length?d.inbox.map(function(e){
      return '<div class="entry">'+
        '<span class="e-ts">'+esc(e.ts.slice(5,16))+'</span>'+
        '<span class="e-proj">'+esc(e.project)+'</span>'+
        '<span class="e-kind">'+esc(e.kind)+'</span>'+
        '<span>'+esc((e.text||'').slice(0,120))+'</span></div>';
    }).join(''):'<div class="empty" style="padding:14px">no activity</div>';
    document.getElementById('updated').textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){document.getElementById('updated').textContent='error: '+e.message}
}
document.getElementById('btn-rules').onclick=function(){
  fetch('/api/rules'+location.search).then(function(r){return r.json()}).then(function(d){
    document.getElementById('modal-body').textContent=d.text;
    document.getElementById('modal').classList.add('open');
  });
};
document.getElementById('modal-close').onclick=function(){document.getElementById('modal').classList.remove('open')};
document.getElementById('modal').onclick=function(e){if(e.target===this)this.classList.remove('open')};
load();
setInterval(load,3000);
</script>
</body>
</html>`;

  function getRules() {
    const p = rulesFile();
    if (p) { try { return { text: fs.readFileSync(p, 'utf8') }; } catch {} }
    return { text: 'No AGENTS.md found. Run "hub init" to scaffold a team folder, or create ~/.hubd/AGENTS.md to define team rules.' };
  }

  // Multi-tenant board (HUBD_MULTITENANT=1): opened by link board.hubd.net/?t=<token>.
  // The token (or a 40-hex tenant id, which is safe to share) selects the workspace
  // to render. Read-only either way — this server is GET-only, no writes anywhere.
  const MT = process.env.HUBD_MULTITENANT === '1';
  const TENANTS = path.join(HUB, 'tenants');
  const HOST = process.env.HUBD_HTTP_HOST || '127.0.0.1';
  const tenantDir = (url) => {
    const t = url.searchParams.get('t') || '';
    if (/^[0-9a-f]{40}$/.test(t)) return path.join(TENANTS, t);
    if (t.length >= 16) return path.join(TENANTS, crypto.createHash('sha256').update(t).digest('hex').slice(0, 40));
    return null;
  };

  const handler = (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'method not allowed' }));
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(HTML);
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (MT) {
        const dir = tenantDir(url);
        if (!dir) { res.writeHead(401); return res.end(JSON.stringify({ error: 'open with ?t=<token>' })); }
        if (!fs.existsSync(dir)) {                  // read-only board: viewing must never create a tenant (disk-fill guard)
          if (url.pathname === '/api/kanban') return res.end(JSON.stringify({ queued: [], inProgress: [], doneToday: [], inbox: [], generated: now() }));
          if (url.pathname === '/api/rules') return res.end(JSON.stringify({ text: 'No workspace yet for this token — connect an agent and create work first.' }));
          res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' }));
        }
        setHubBase(dir);                           // point this request at its tenant; read below is synchronous
      }
      if (url.pathname === '/api/kanban') {
        return res.end(JSON.stringify(runKanban({})));
      }
      if (url.pathname === '/api/rules') {
        return res.end(JSON.stringify(getRules()));
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  };

  const server = http.createServer(handler);
  server.listen(port, HOST, () => {
    console.log(`hubd kanban  http://${HOST}:${port}${MT ? '  (multi-tenant — open with ?t=<token>)' : ''}`);
    console.log('Ctrl+C to stop');
  });
}
