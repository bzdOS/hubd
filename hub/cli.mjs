#!/usr/bin/env node
/**
 * hubd CLI — the human interface to the hub.
 * Imports the same core functions as the MCP server; never starts an MCP process.
 * Usage: node cli.mjs <cmd>  |  alias hub='node <path>/cli.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  HUB, PROJ, JOURNAL_NODE, VERSION, now, parseTs, slugify, sh, cardPath, digestOf, requireAuthor, runSync,
  runCardSet, runReport, runReflect, runStatus, runSectionAdd, runTaskAdd, runTaskList, runTaskUpdate, runTaskGet,
  runTaskRetag, TASK_CATS, runClaim, runClaimCheck, runRelease, runInbox, runTrajectory,
  runResourceSet, runResourceList, runResourceGet, runGraph, sectionsConfig, ensureProtocol, harvestPrompt,
  runLint, runAudit, runNext, runAgenda, runRules, runOperatorGet, journalTail, journalAppend, activeClaims,
  CONFLICT_RE, runHeartbeat, runPresence, ownerWaiting, runWhereAmI, HUB_GITIGNORE, ensureLocalIgnores,
  trackedNodeLocal, freezeFile, readFreeze, setReadOnly,
} from './lib/core.mjs';
import { conflictedFiles, resolveQueueConflicts, resolveCardConflicts } from './lib/conflicts.mjs';
import { CARD_ATTR, CARD_DRIVER, installCardDriver, removeCardDriver } from './lib/cardmerge.mjs';
import { runUsageAdd, runUsage } from './lib/usage.mjs';
import { runCardsCompact, runCardsMergeSections, runCardsMerge } from './lib/cards.mjs';
import { runRecall } from './lib/recall.mjs';
import { WINDOW_DAYS, journalStamp, watchPass } from './lib/watch.mjs';
import { runAbsorb } from './lib/absorb.mjs';
import { runBoard } from './lib/board.mjs';
import { startServer } from './lib/serve.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { runHubGc } from './lib/gc.mjs';
import { renderPrompt, templateNames, lineDiff } from './lib/prompts.mjs';
import { runSenseEvents, runSenseVerdict, runSenseBrief, senseConf, senseConfig, loadSenseState, checkBranch, escalationsPath } from './lib/sense.mjs';
import { secretsRoot, setSecret, getSecret, secretPath, listSecrets, removeSecret, auditModes, backupSecret, restoreSecret, verifyBackups, backupDir } from './lib/secrets.mjs';
import { roleWork, assertRole, briefWithQueues, queueSendChecked, queueWait, queueWaitAll, resolveQueueRoot, queueSummaryForBrief, runQueueGc, queueLedger } from './lib/queue.mjs';

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
function writeAllSync(fd, text, strict = false) {
  const buf = Buffer.from(String(text));
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(fd, buf, off, buf.length - off); }
    catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); continue; }  // pipe full, slow reader
      // The reader went away — writing more is pointless, not an error. Unless the caller has to
      // know what reached it: hub watch marks an entry seen only once it was written.
      if (e.code === 'EPIPE' && !strict) return;
      throw e;
    }
  }
}
console.log = (...a) => writeAllSync(1, a.join(' ') + '\n');
console.error = (...a) => writeAllSync(2, a.join(' ') + '\n');
console.warn = console.error;
function done(code = 0) {
  if (code === 0) checkFlags();
  process.exit(code);
}
/* Unknown flags are reported on exit; a command that does not exit soon (hub watch --follow)
 * checks them before it settles in, or a typo would run for days unreported. */
function checkFlags() {
  if (knownFlags) {
    const unknowns = [];
    for (const a of args) {
      // Only flag patterns: --foo or -x (single letter). Values like "- starts with"
      // or negative numbers are not flags. Triple-dash --- is also skipped (comments).
      const isFlag = (a.startsWith('--') && a.length > 2) || (/^-[a-zA-Z]$/.test(a));
      if (isFlag && !a.startsWith('---') && !knownFlags.has(a)) {
        unknowns.push(a);
      }
    }
    if (unknowns.length) {
      console.error('Error: unknown flag' + (unknowns.length > 1 ? 's' : '') + ': ' + unknowns.join(', ') +
        '.  Run hub with no arguments for the commands and their flags, or pass text that starts with "-" through --text or stdin.');
      process.exit(1);
    }
  }
}
function die(msg) { console.error('Error: ' + msg); done(1); }

// Known flags for the current command — populated by getFlag/getFlags when they match,
// plus globally-declared flags that any command may use. Truly unknown flags (typos like
// --houurs or --digset) are caught by done() on exit.
let knownFlags = new Set();

// Pre-declare every flag used ANYWHERE in the CLI. Typos won't be here → caught.
// This is broad but safe: the alternative (per-command declaration) is ~25 manual edits
// with the same end result for the bugs that matter — silent misbehavior from typos.
declareFlags(
  '--json', '--apply', '--force', '--private', '--alive', '--here', '--help',
  '--set', '--from-now', '--once', '--all',
  // getFlag/getFlags auto-register their flags on match, but when a flag is absent
  // (not matched), it would be reported as unknown. Pre-declaring prevents that.
  '--hours', '-h', '--days', '--project', '-p', '-i', '-d',
  '--needs', '--resource', '--cat', '--tag', '--assignee', '--by', '--from',
  '--limit', '-n', '--status', '--text', '-m',
  '--replace', '--with', '--as', '--port',
  '--role', '--type', '--address', '--os', '--provider', '--why', '--digest',
  '--agent', '--cwd', '--note', '--seconds', '--tokens-in', '--tokens-out', '--ttl',
  '--model', '--task', '--timeout', '-k', '-q', '-t', '--link', '--cost',
  '--src', '--stale-days', '--addr', '--append', '--append-line',
  '--attr', '--state', '--turn', '--turn-started', '--empty', '--silent', '--exit-reason', '--tasks',
  '--vars', '--out', '--check', '--remove', '--reflect', '--since', '--level', '--follow', '--interval',
);

function getFlag(name) {
  const i = args.indexOf(name);
  if (i !== -1) knownFlags.add(name);
  return i !== -1 ? (args[i + 1] ?? true) : null;
}
// repeatable flag: every `--name value` occurrence, plus comma-splitting (so
// `--resource a,b --resource c` → [a,b,c]). For task↔resource links, --link, etc.
function getFlags(name) {
  const out = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === name && typeof args[i + 1] === 'string') {
      knownFlags.add(name);
      for (const part of String(args[i + 1]).split(',')) { const v = part.trim(); if (v) out.push(v); }
    }
  return out;
}

// Check that no unrecognised --flags remain in args after command processing.
// Boolean flags (--json, --verbose, --apply, etc.) must be pre-declared via
// declareFlags() so they are not reported as unknown.
function declareFlags(...names) { for (const n of names) knownFlags.add(n); }

/* Positional arguments from index `from` on, with every flag and its value skipped wherever
 * they sit. `hub queue send` read its body as args[3] — so `hub queue send hv --from bzdos
 * "text"` delivered a block whose body was the word "--from", `--text "..."` delivered
 * "--text", and each reported success. Measured on three roles and two nodes (task
 * maple-63); two orchestrators had already declared the queue channel unreliable and
 * moved to duplicating everything into the journal, which is the architecture bending around
 * a parser. Flags a command does not know are an error, not a guess: guessing whether an
 * unknown flag takes a value is how a body gets swallowed as one. */
function positionals(from, { values = [], booleans = [] } = {}) {
  const vals = new Set(values), bools = new Set(booleans);
  const out = [];
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (a.length > 1 && a.startsWith('-')) {
      if (vals.has(a)) { i++; continue; }
      if (bools.has(a)) continue;
      throw new Error(`unknown flag ${a} — known here: ${[...values, ...booleans].join(' ') || '(none)'}. If it is text that starts with "-", pass it through --text or stdin.`);
    }
    out.push(a);
  }
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
  '#   NEXT: redeploy vm1 under 0.1.8',
  '#   DONE: 42, 43',
  '#   EOF',
].join('\n');

function claimRemaining(c) {
  const ms = parseTs(c.since).getTime() + (c.ttlMin ?? 240) * 60000 - Date.now();
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
    // The count said how far behind; it never said what OF. One line each, oldest first.
    for (const b of (data.buttonItems || [])) {
      lines.push(`  ${String(b.ageDays).padStart(3)}d ${b.role} ← ${b.from}${b.task ? ' #' + b.task : ''}: ${b.subject}`);
    }
  }
  // A decision on the board that only the owner may move — a different wait from the queue above,
  // and the one that was actually rotting when this was written.
  const ow = data.ownerWaiting;
  if (ow && ow.count > 0) {
    lines.push(`OWNER'S OWN (${ow.count} open task(s) nobody else can move` +
      (ow.oldestDays != null ? `, oldest ${ow.oldestDays}d` : '') +
      (ow.overdue ? `, ${ow.overdue} past deadline` : '') + '):');
    for (const t of ow.items) {
      lines.push(`  ${t.ageDays == null ? '  ?' : String(t.ageDays).padStart(3)}d #${t.id} [${t.project || '?'}]` +
        (t.overdueDays != null ? ` ⏰+${t.overdueDays}d` : '') + ` ${t.text}`);
    }
  }
  // The audit, riding on a call somebody was going to make anyway (see runReview).
  const rv = data.review;
  if (rv && rv.findings && rv.findings.length) {
    lines.push(`RULES BROKEN (${rv.total} finding(s) in ${rv.kinds} kind(s); lint ${rv.lint}, audit ${rv.audit}):`);
    for (const f of rv.findings) {
      lines.push(`  [${f.severity}] ${f.id}${f.alsoLikeThis ? ` (+${f.alsoLikeThis} more like it)` : ''}: ${f.what}`);
      lines.push(`     rule: ${f.law}${f.lawSince ? ' (recorded ' + f.lawSince + ')' : f.lawDeclared ? '' : '  ← engine default; declare yours in rules.json → laws'}`);
    }
    if (rv.hint) lines.push('  ' + rv.hint);
    for (const n of rv.notes) lines.push('  note: ' + n);
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

const GITIGNORE_ENTRY = HUB_GITIGNORE.join('\n') + '\n';

/* ── commands ──
 * Every command registers here and runs from the one dispatch at the end of the file, after every
 * declaration in it: a name nobody registered is an error, and `hub --help` lists what is (a test
 * holds the help and the table together). `when` picks a subcommand that has a handler of its own;
 * the handlers of one name are tried in the order they were registered. */
const COMMANDS = new Map();   // name -> [{ when, run }]
function command(names, when, run) {
  if (!run) { run = when; when = null; }
  for (const n of [].concat(names)) {
    if (!COMMANDS.has(n)) COMMANDS.set(n, []);
    COMMANDS.get(n).push({ when, run });
  }
}

/* Until 0.9.4 there was no way to ask hubd its own version, and the omission had a price: the
 * global `hub` on the machine that develops hubd sat nine releases behind for weeks, and reading
 * `npm ls -g` was the only way to find out. A read-only command (see the dispatch), so asking a
 * possibly-wrong install what it is never writes anything.
 *
 * The path is printed with the number because "which version" and "which copy" are one question:
 * a stale global install and a live source checkout are both called `hub`, and they answer
 * differently. Whichever one printed this line is the one your shell has been running. */
command(['version', '--version', '-v'], () => {
  console.log('hubd ' + VERSION);
  console.log('  running:  ' + __filename);
  console.log('  node:     ' + process.version);
  console.log('  hub base: ' + HUB);
  done(0);
});

command('upgrade', () => {
  const r = ensureProtocol(true);
  if (!r.ok) die('could not materialise HUBD.md (protocol source missing?)');
  console.log(r.wrote ? `HUBD.md → v${r.version}` + (r.from ? ` (was v${r.from})` : ' (new)') : `HUBD.md already current (v${r.version})`);
  console.log('  agents read it for hub mechanics; team rules stay in AGENTS.md');
  done(0);
});

command('init', () => {
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

  // .gitignore: created whole when absent; an existing one is kept and completed with the node-local
  // lines it lacks (a hub made before a line existed would otherwise never get it)
  const giPath = path.join(targetDir, '.gitignore');
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, GITIGNORE_ENTRY, 'utf8');
    console.log('  created .gitignore');
  } else {
    const gi = fs.readFileSync(giPath, 'utf8');
    const missing = HUB_GITIGNORE.filter(e => !gi.split('\n').map(l => l.trim()).includes(e));
    if (missing.length) fs.appendFileSync(giPath, (gi && !gi.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
    console.log('  exists, kept .gitignore' + (missing.length ? ' — added ' + missing.join(' ') : ''));
  }

  console.log('');
  console.log('Next steps:');
  console.log('  Connect an agent:  claude mcp add --scope user hubd -- npx -y @bzdos/hubd');
  console.log('  Check setup:       hub doctor');
  console.log('  Full org template: hubd-company/ in the hubd repository');
  done(0);
});

command('doctor', () => done(runDoctor() ? 1 : 0));


command('status', () => {
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
});

command('brief', () => {
  const hours = parseInt(getFlag('--hours') || getFlag('-h') || '48');
  console.log(formatBrief(briefWithQueues({ hours }), hours));
  done(0);
});

command('inbox', () => {
  const hours = parseInt(getFlag('--hours') || '72');
  const r = runInbox({ hours });
  if (r.empty) { console.log('inbox: clear — nothing needs a decision'); done(0); }
  const P = (title, rows, fmt) => { if (rows.length) { console.log(`\n## ${title} (${rows.length})`); for (const x of rows) console.log('  ' + fmt(x)); } };
  P('BLOCKED', r.blocked, x => `${x.ts} [${x.project}/${x.agent}] ${x.text}`);
  P('OVERDUE', r.overdue, x => `#${x.id} [${x.project}] due ${x.deadline}${x.assignee ? ' @' + x.assignee : ''} — ${x.text}`);
  P('UNASSIGNED', r.unassigned, x => `#${x.id} [${x.project}] ${x.importance || ''} — ${x.text}`);
  P('STALE CLAIMS', r.staleClaims, x => `${x.project}/${x.area} @${x.agent} since ${x.since} (ttl ${x.ttlMin}m, expired)`);
  done(0);
});

command(['plan', 'trajectory'], () => {
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
});

/* `hub whereami [cwd]` — state, not narrative: the first command after a context compaction, and
 * the one an editor's session-start hook runs. Everything hub_context returns, plus the git-side
 * inventory (subjects, diff stat, untracked with their first line, fresh mtimes) and the project's
 * own inventory script if the .hubd marker names one. Read-only, no network. */
command(['whereami', 'where'], () => {
  const target = args[1] && !args[1].startsWith('-') ? path.resolve(args[1]) : process.cwd();
  const af = getFlag('--agent');
  let w;
  try { w = runWhereAmI({ cwd: target, agent: typeof af === 'string' ? af : (process.env.HUBD_AGENT || undefined) }); }
  catch (e) { die(e.message); }
  if (args.includes('--json')) { console.log(JSON.stringify(w, null, 1)); done(0); }
  const L = (s = '') => console.log(s);
  L(`project:  ${w.project || '(none)'}  via ${w.via}${w.guessed ? '  GUESSED' : ''}   root ${w.root}`);
  if (w.hint) L(`  hint:   ${w.hint}`);
  if (w.project) {
    L(`digest:   ${w.digestSetAt ? `set ${w.digestSetAt}${w.digestSetBy ? ' by ' + w.digestSetBy : ''} (${w.digestAgeDays}d ago)` : 'no set-stamp'}${w.digestStale ? `  STALE: journal moved on ${w.digestStale.daysBehind}d further` : ''}`);
    for (const l of String(w.digest || '(none)').split('\n')) L('  ' + l);
    L(`tasks:    ${w.openTasks.length} open` + (w.openTasks.length ? '' : ''));
    for (const t of w.openTasks.slice(0, 6)) L(`  #${t.id}${t.assignee ? ' @' + t.assignee : ''} ${String(t.text).slice(0, 100)}`);
    if (w.openTasks.length > 6) L(`  … ${w.openTasks.length - 6} more (hub task list -p ${w.project})`);
    L(`claims:   ${w.activeClaims.length ? w.activeClaims.map(c => `${c.area} — ${c.agent} since ${c.since}`).join('; ') : 'none'}`);
    L(`here:     ${w.presenceHere.length ? w.presenceHere.map(p => `${p.agent}${p.status ? ' (' + p.status + ')' : ''} ${p.last_seen}`).join('; ') : 'nobody else heartbeating under this root'}`);
    if (w.claimsTouched && w.claimsTouched.touched.length) {
      L(`WARNING:  files changed in the last ${w.claimsTouched.minutes} min inside another agent's claim:`);
      for (const t of w.claimsTouched.touched) L(`  ${t.area} — ${t.agent}: ${t.files.join(', ')}${t.more ? ` +${t.more}` : ''}`);
    }
    L('journal:');
    for (const e of w.journalTail) L(`  ${e.ts} [${e.agent}] ${e.kind}: ${String(e.text).slice(0, 120)}`);
    if (!w.journalTail.length) L('  (nothing yet — FACT:/DECIDE: at the moment of the finding, not at the end)');
  }
  if (w.git) {
    L(`git:      ${w.git.branch}  ${w.git.dirty}`);
    for (const c of w.git.commits) L(`  ${c}`);
    if (w.git.dirtyFiles.length) { L('  modified:'); for (const f of w.git.dirtyFiles) L(`    ${f}`); }
    if (w.git.untracked.length) { L('  untracked (does it already exist?):'); for (const u of w.git.untracked) L(`    ${u.file}  ${u.firstLine}`); }
    if (w.git.recent.length) { L(`  changed in the last 30 min:`); for (const f of w.git.recent) L(`    ${f}`); }
  } else L('git:      not a git checkout');
  if (w.localInventory) {
    if (w.localInventory.missing) L(`inventory: ${w.localInventory.script} named in .hubd but not found`);
    else { L(`inventory (${w.localInventory.script}):`); for (const l of w.localInventory.output.split('\n')) L('  ' + l); if (w.localInventory.truncated) L('  … output truncated at 4 KB'); }
  }
  done(0);
});

command('log', () => {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const n = parseInt(getFlag('-n') || '20');
  // --json: the entries as-is. Scripts were regex-parsing the text line and losing
  // everything a one-line render drops (fleet head_sense.py, 2026-09-27).
  if (args.includes('--json')) { console.log(JSON.stringify(journalTail(proj, n))); done(0); }
  for (const e of journalTail(proj, n)) {
    console.log(`${e.ts} [${e.project}/${e.agent}] ${e.kind}: ${e.text}`);
  }
  done(0);
});

/* hub watch: the journal's new entries, each once, to a named cursor (lib/watch.mjs says why a
 * byte offset cannot do this on a synced hub). One pass and exit, or --follow. */
command('watch', () => {
  const usage = 'Usage: hub watch --as <name> [-p <project>] [--since 1h|<time>] [--follow [--interval <s>]] [--private] [--json]';
  const flag = (n) => { const v = getFlag(n); if (v === true) die(`${n} needs a value\n${usage}`); return v; };
  const name = flag('--as') || process.env.HUBD_SUBSCRIBER;
  if (!name) die('hub watch needs a cursor name: --as <name> (or HUBD_SUBSCRIBER). The same name on the next run goes on where this one stopped.\n' + usage);
  const project = flag('--project') ?? flag('-p');
  const since = flag('--since');
  const json = args.includes('--json'), follow = args.includes('--follow');
  const iv = flag('--interval');
  const interval = iv == null ? 5 : Number(iv);
  if (!(interval > 0)) die(`--interval: "${iv}" is not a number of seconds above 0`);
  if (iv != null && !follow) die('--interval paces --follow; one pass has nothing to pace');
  const line = (e) => json ? JSON.stringify(e) : `${e.ts} [${e.project}/${e.agent}] ${e.kind}${e.to ? ' → ' + e.to : ''}: ${e.text}`;
  const emit = (e) => writeAllSync(1, line(e) + '\n', true);
  const memo = {};
  const pass = (first) => {
    let r;
    try { r = watchPass({ name, project, since: first ? since : null, includePrivate: args.includes('--private'), emit, memo }); }
    catch (e) { if (e.code === 'EPIPE') process.exit(0); die(e.message); }
    if (r.created) console.error(since
      ? `watch ${r.name}: a new cursor, from ${r.from} (at most ${WINDOW_DAYS} days back)`
      : `watch ${r.name}: a new cursor; entries written from now on are shown. --since 1h on a new cursor starts earlier.`);
    return r;
  };
  // A pass is synchronous, so a handled signal lands between passes, after the pass marked what
  // it wrote. Unhandled, it would end the process mid-pass and the next run would show those again.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(0));
  if (!follow) { pass(true); done(0); }
  checkFlags();
  // A pass reads every journal file in the window, so a follower passes again only when one of
  // them changed.
  let stamp = journalStamp();
  pass(true);
  const tick = () => {
    const now = journalStamp();
    if (now !== stamp) { stamp = now; pass(false); }
    setTimeout(tick, interval * 1000);
  };
  setTimeout(tick, interval * 1000);
});

command('report', () => {
  const pf = getFlag('-p');
  const proj = (typeof pf === 'string') ? pf : 'general';
  const kind = getFlag('-k') || 'note';
  const agent = authorOrDie('--agent');
  let text = (args[1] && !args[1].startsWith('-')) ? args[1] : getFlag('-m');
  if ((!text || text === true) && !process.stdin.isTTY) {           // batch piped via stdin (heredoc)
    try { text = fs.readFileSync(0, 'utf8'); } catch {}
  }
  // --reflect: the turn's reflection as fields, inline JSON (when it starts with `{`) or a file.
  const rfArg = getFlag('--reflect');
  if (rfArg === true) die('--reflect needs a value: {"goal": …} or a file holding it');
  let reflect;
  if (rfArg) {
    const inline = rfArg.trimStart().startsWith('{');
    let src = rfArg;
    if (!inline) { try { src = fs.readFileSync(rfArg, 'utf8'); } catch (e) { die(`--reflect ${rfArg}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); } }
    try { reflect = JSON.parse(src); } catch (e) { die(`--reflect${inline ? '' : ' ' + rfArg}: not JSON (${e.message})`); }
  }
  if (typeof text !== 'string') text = '';
  if (!text.trim() && !reflect) {                                    // no input → print the skeleton
    console.log(REPORT_TEMPLATE);
    done(0);
  }
  let r;
  try { r = runReport({ project: proj, agent, text, kind, reflect, private: args.includes('--private'), force: args.includes('--force') }); }
  catch (e) { die(e.message); }   // a strict refusal is a message to read, not a stack trace
  const parts = [];
  if (r.nextReplaced) console.error(`  next step replaced — was${r.nextReplaced.by ? ' (' + r.nextReplaced.by + (r.nextReplaced.at ? ', ' + r.nextReplaced.at : '') + ')' : ''}: ${r.nextReplaced.text}`);
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
  if (r.reflect) parts.push(`reflection (${r.reflect.level}${r.reflect.source === 'text' ? ', read from the text' : ''})`);
  console.log(`Reported to ${r.project}: ` + (parts.length ? parts.join(', ') : 'nothing recognized — use DECIDE:/FACT:/COMM:/NEXT:/DONE: prefixes (hub report with no input shows the template)'));
  if (r.reflect && r.reflect.problems) console.error('  reflection filed, off the rules: ' + r.reflect.problems.join('; ') + ' (the lists: prompts/meta/fragments/reflect.md)');
  if (r.doneMissed && r.doneMissed.length) console.error('  warning: NOT closed (no such task): #' + r.doneMissed.join(' #') + ' — check the id with `hub task list`');
  const onlyNote = r.note && !r.reflect && !r.decisions && !r.facts && !r.hypos && !r.comms && !r.next && !r.done.length && !r.tasks.length;
  if (onlyNote) console.error('  hint: a note-only report is usually coordination — "I\'m on it" is a `hub claim`, not a report (see HUBD.md).');
  done(0);
});

command('decide', () => {
  const what = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!what) die('Usage: hub decide "<decision>" --why "<why>" -p <proj>');
  const why = getFlag('--why');
  const pf = getFlag('-p'); const proj = (typeof pf === 'string') ? pf : 'general';
  const r = runReport({ project: proj, by: authorOrDie('--by'), text: `DECIDE: ${what}${typeof why === 'string' ? ' | ' + why : ''}` });
  console.log(`Decided on ${r.project}: +${r.decisions} → ## Decisions`);
  done(0);
});

command('next', () => {
  const what = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!what) die('Usage: hub next "<the one next action>" -p <proj>');
  const pf = getFlag('-p'); const proj = (typeof pf === 'string') ? pf : 'general';
  let r;
  try { r = runReport({ project: proj, by: authorOrDie('--by'), text: `NEXT: ${what}`, force: args.includes('--force') }); }
  catch (e) { die(e.message); }
  console.log(`Next step set on ${r.project}`);
  if (r.nextReplaced) console.error(`  replaced — was${r.nextReplaced.by ? ' (' + r.nextReplaced.by + (r.nextReplaced.at ? ', ' + r.nextReplaced.at : '') + ')' : ''}: ${r.nextReplaced.text}`);
  done(0);
});

command('task', () => {
  const sub = args[1];
  if (sub === 'add') {
    // A flag in the text slot is a misplaced argument, not a task: `hub task add -p x --by y`
    // once filed a task whose text was "-p", and that task is in the append-only log forever.
    let pos;
    try { pos = positionals(2, { values: ['-p', '-i', '-d', '--needs', '--resource', '--cat', '--tag', '--assignee', '--by'] }); }
    catch (e) { die(e.message + '\nUsage: hub task add "<text>" -p <proj> [-i high|med] [-d <date>] [--needs <ids>] [--resource <slug>] [--cat <cat>] [--tag <t>] [--assignee <who>] --by <who>'); }
    const text = pos[0];
    if (!text || text.startsWith('-')) die('Text required: hub task add "<text>" -p <proj>');
    if (pos.length > 1) die(`unexpected extra argument ${JSON.stringify(pos[1].slice(0, 40))} — quote the whole text as one argument`);
    const proj = getFlag('-p');
    if (!proj || typeof proj !== 'string') die('Project required: -p <proj>');
    const imp = getFlag('-i');
    const dl = getFlag('-d');
    const needsRaw = getFlag('--needs');
    // a dep may be a bare number (legacy id) or a node-scoped string like "pine-3"
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
    // bare number or node-scoped string (task #194) — runTaskUpdate compares by String();
    // read past flags in any order, so `hub task done --by x 42` closes 42, not "--by".
    let pos; try { pos = positionals(2, { values: ['--by'] }); } catch (e) { die(e.message + '\nUsage: hub task done <id> --by <you>'); }
    const id = pos[0];
    if (!id) die('Id required: hub task done <id>');
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
    let pos; try { pos = positionals(2, { booleans: ['--json'] }); } catch (e) { die(e.message + '\nUsage: hub task get <id> [--json]'); }
    const id = pos[0];
    if (!id) die('Id required: hub task get <id>');
    const r = runTaskGet({ id });
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
});

/* `hub claim check <path>` — is this file inside somebody's live claim? Exit 0 when free (or the
 * claim is your own, with --agent), exit 1 with one line per holder when it is not. Meant for an
 * editor hook that runs before a write, so the warning arrives BEFORE the edit; the claim stays
 * soft by constitution, so a hook should inform, not block. */
command('claim', () => args[1] === 'check', () => {
  const target = args[2] && !args[2].startsWith('-') ? args[2] : null;
  if (!target) die('Usage: hub claim check <path> [-p <proj>] [--agent <you>]');
  const pf = getFlag('-p'), af = getFlag('--agent');
  let r;
  try { r = runClaimCheck({ path: target, project: typeof pf === 'string' ? pf : undefined, agent: typeof af === 'string' ? af : (process.env.HUBD_AGENT || undefined) }); }
  catch (e) { die(e.message); }
  if (!r.project) { console.log(`free (no project resolves for ${target})`); done(0); }
  for (const h of r.holders) console.log(`${h.area} — ${h.agent} since ${h.since}${h.note ? ' (' + h.note + ')' : ''}`);
  if (r.holders.length) { console.error(`  ${r.rel} is inside ${r.holders.length} live claim(s) on ${r.project} — coordinate before editing (soft lock, not enforced)`); done(1); }
  console.log(`free — ${r.rel}` + (r.mine.length ? ` (your own claim: ${r.mine.map(m => m.area).join(', ')})` : '') + (r.unmatchable.length ? `; ${r.unmatchable.length} prose claim(s) on ${r.project} could not be matched: ${r.unmatchable.map(u => u.agent).join(', ')}` : ''));
  done(0);
});

command('claim', () => args.includes('--task'), () => {
  // Starting a task from a role's work queue: the claim is on task:<id>, the project is the task's.
  const task = getFlag('--task');
  if (typeof task !== 'string') die('Usage: hub claim --task <id> [-t min] [--note "<why>"] --agent <you>');
  const ttl = parseInt(getFlag('-t') || '240');
  const note = getFlag('--note');
  const res = runClaim({ task, agent: authorOrDie('--agent'), ttlMin: ttl, note: typeof note === 'string' ? note : undefined });
  if (res.warning) console.warn('⚠  ' + res.warning);
  console.log(`Started #${task}: ${res.claim.id} (until ${new Date(parseTs(res.claim.since).getTime() + ttl * 60000).toISOString().slice(0, 16).replace('T', ' ')})`);
  done(0);
});

command('claim', () => {
  const CU = 'Usage: hub claim <proj> <area> [-t min] [--note "<why>"] --agent <you>   |   hub claim --task <id> --agent <you>   |   hub claim check <path> [-p <proj>]';
  let pos;
  try { pos = positionals(1, { values: ['-t', '--agent', '--note'] }); } catch (e) { die(e.message + '\n' + CU); }
  const [proj, area] = pos;
  if (!proj || !area) die(CU);
  if (pos.length > 2) die(`unexpected extra argument ${JSON.stringify(pos[2].slice(0, 40))} — quote the area as one argument.\n${CU}`);
  const ttl = parseInt(getFlag('-t') || '240');
  const agent = authorOrDie('--agent');
  const note = getFlag('--note');
  const res = runClaim({ project: proj, area, agent, ttlMin: ttl, note: typeof note === 'string' ? note : undefined });
  if (res.warning) console.warn('⚠  ' + res.warning);
  console.log(`Lock: ${res.claim.id}` + (res.matchable ? '' : '  (prose area — `hub claim check` cannot match files against it; a glob would)'));
  done(0);
});

command('release', () => {
  const id = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const task = getFlag('--task');
  if (!id && typeof task !== 'string') die('Usage: hub release <id>   |   hub release --task <id> --agent <you>');
  const res = id ? runRelease({ id }) : runRelease({ task, agent: authorOrDie('--agent') });
  console.log(`Locks released: ${res.removed}`);
  done(0);
});

command('heartbeat', () => {
  const agent = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!agent) die('Usage: hub heartbeat <agent> [--role <role>] [--status <text>] [--task <id>] [--cwd <path>] [--ttl <min>]\n' +
    '         [--state turn|waiting|exit] [--turn <n>] [--turn-started <ts|now>] [--empty <n>] [--silent <n>] [--exit-reason <text>]');
  const task = getFlag('--task');
  const ttl = getFlag('--ttl');
  const str = (f) => (typeof getFlag(f) === 'string' ? getFlag(f) : undefined);
  let res; try { res = runHeartbeat({
    agent, role: str('--role'), status: str('--status'),
    task_id: (typeof task === 'string') ? task : undefined,
    cwd: str('--cwd'),
    ttlMin: (typeof ttl === 'string') ? parseInt(ttl, 10) : undefined,
    state: str('--state'), turn: str('--turn'), turn_started: str('--turn-started'),
    empty_count: str('--empty'), silent_count: str('--silent'), exit_reason: str('--exit-reason'),
  }); } catch (e) { die(e.message); }
  console.log(`Heartbeat: ${res.agent} -> ${res.presence}`);
  done(0);
});

command('presence', () => {
  const roleFlag = getFlag('--role');
  const data = runPresence({ role: (typeof roleFlag === 'string') ? roleFlag : undefined, aliveOnly: args.includes('--alive') });
  // --json: the same object hub_presence returns. The table truncates names and
  // statuses to 11-18 columns, so fleet tooling read presence/*.json behind the
  // hub's back instead — and re-implemented the cross-node merge doing it.
  if (args.includes('--json')) { console.log(JSON.stringify(data)); done(0); }
  /* Coverage prints even when the agent list is empty, and that is the point: "no presence
   * records" used to be the whole answer on a machine that simply is not where the fleet runs. */
  const cov = (data.coverage || []).map(c => c.self
    ? `${c.node} (here, ${c.agents})`
    : c.snapshot === null ? `${c.node} SILENT`
    : `${c.node} ${c.snapshotAgeMin}m${c.stale ? ' STALE' : ''} (${c.agents})`);
  if (cov.length) console.log('  seen from: ' + cov.join(' · '));
  if (data.note) console.log('  ⚠ ' + data.note);
  if (data.lagNote) console.log('  · ' + data.lagNote);
  if (!data.agents.length) { console.log('(no presence records)'); done(0); }
  for (const p of data.agents) {
    const mark = p.alive ? '●' : '○';
    const where = p.observedOn ? (p.live ? '' : '←' + p.observedOn) : '';
    const also = p.alsoOn && p.alsoOn.length ? ' +' + [...new Set(p.alsoOn)].join(',') : '';
    // a structured state reads as "<state> <minutes in it>"; the free-text status is the fallback
    const since = p.state_since ? Math.max(0, Math.round((Date.now() - parseTs(p.state_since).getTime()) / 60000)) : null;
    const st = p.state ? p.state + (since != null ? ' ' + since + 'm' : '') : (p.status || '·');
    console.log(`  ${mark} ${pad(p.agent, 18)}${pad(p.role || '·', 11)}${pad(st, 11)}${p.last_seen}  ${where}${also}`);
    if (p.elsewhere) console.log(`      ⚠ writes into ${p.elsewhere}, not this hub — same machine, two hubs`);
  }
  console.log(`(${data.agents.length} agents, generated ${data.generated})`);
  done(0);
});

/* `hub card resolve` — the one file in a hub that can conflict, resolved the way a human
 * resolves it. Bullet-list hunks are unioned (two nodes appending facts have not disagreed);
 * prose hunks are left alone and named, because if both sides rewrote a digest, one of them
 * meant to replace the other and choosing would be inventing a decision. Exits non-zero while
 * anything is left, so a script cannot mistake a partial resolution for a finished one. */
/* freeze/unfreeze: the stop-cock for the mesh on THIS node.
 *
 * Every dangerous operation on a hub directory — a purge, a history rewrite, an absorb, a restore —
 * starts with "stop the sync first", and until now that meant remembering which of launchd, cron and
 * two systemd timers this particular node uses, under time pressure. Twice it was not remembered,
 * and a sync mid-operation spread a half-finished state to every peer.
 *
 * Node-local and gitignored on purpose: you freeze the machine you are about to work on. A
 * mesh-wide freeze would have to travel by sync, and unfreezing would then need the sync it just
 * stopped. The marker records who, when and why, because a freeze somebody forgot is itself a
 * silent stall — `hub doctor` reports it, and after six hours calls it a warning. */
command(['freeze', 'unfreeze'], () => {
  if (cmd === 'unfreeze') {
    const info = readFreeze();
    if (!info) { console.log('Not frozen — mesh-sync on this node is running normally.'); done(0); }
    fs.unlinkSync(freezeFile());
    console.log('Unfrozen. mesh-sync runs again on its next tick' +
      (info.since ? ' (was frozen since ' + info.since + (info.by ? ' by ' + info.by : '') + ')' : '') + '.');
    console.log('Run it once now to catch up:  sh "$(npm root -g)/@bzdos/hubd/scripts/mesh-sync.sh"');
    done(0);
  }
  const pos = positionals(1, { values: ['--by'], booleans: [] });
  const why = pos.join(' ').trim();
  if (!why) die('say why: hub freeze "purging duplicate queue blocks" --by dev-hubd\n' +
    '  the reason is what tells the next person (or the next you) whether it is safe to unfreeze.');
  const by = getFlag('--by') || process.env.HUBD_AGENT || null;
  if (!by) die('--by required (or set HUBD_AGENT): a freeze stops every peer from receiving this node\'s work.');
  requireAuthor(by, '--by');
  const info = readFreeze();
  if (info) {
    console.log('Already frozen since ' + (info.since || '?') + ' by ' + (info.by || '?') + ': ' + (info.why || '?'));
    console.log('Leaving that one in place — hub unfreeze when the work is done.');
    done(0);
  }
  // The marker must stay on this node: ignored (in .git/info/exclude, which never travels, so a
  // .gitignore from before the line existed cannot let it out), and not tracked from an older mistake.
  ensureLocalIgnores();
  const trackedMarker = trackedNodeLocal().includes('.mesh-freeze');
  fs.writeFileSync(freezeFile(), JSON.stringify({ by, why, since: now(), node: JOURNAL_NODE, pid: process.pid }, null, 1) + '\n', 'utf8');
  console.log('Frozen: mesh-sync on this node will skip every run until you unfreeze.');
  console.log('  ' + freezeFile());
  if (trackedMarker) {
    console.log('WARNING: .mesh-freeze is TRACKED in this hub\'s git — a commit made here by hand would carry the freeze');
    console.log('  to every peer. hub doctor says how to untrack it; until then, commit nothing by hand in this directory.');
  }
  console.log('Local writes still work and stay local. Back up before you touch anything:');
  console.log('  tar czf ~/hub-backup-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.tgz -C "' + path.dirname(HUB) + '" "' + path.basename(HUB) + '"');
  console.log('Other writers on this directory are NOT stopped by this — check them too:  hub doctor');
  done(0);
});

// absorb: fold a hub base written in isolation into this one, as a new node. Dry run by default —
// the plan (id map, unread queue blocks, cards kept aside) is the thing to read before --apply.
command('absorb', () => {
  let pos;
  try { pos = positionals(1, { values: ['--as', '--by'], booleans: ['--apply', '--force', '--json'] }); } catch (e) { die(e.message); }
  if (!pos[0]) die('usage: hub absorb <dir> --as <node-label> [--apply --by <you>] [--force] [--json]');
  let r;
  try { r = runAbsorb({ from: pos[0], as: getFlag('--as'), by: getFlag('--by') || process.env.HUBD_AGENT || null, apply: args.includes('--apply'), force: args.includes('--force') }); }
  catch (e) { die(e.message); }
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 1)); done(0); }
  console.log((r.apply ? 'Absorbed ' : 'Would absorb ') + r.from + ' as node ' + r.as + (r.apply ? '' : '  (dry run - add --apply --by <you>)'));
  for (const w of r.warnings) console.log('  WARNING forced past: ' + w);
  console.log('  tasks:    ' + r.tasks.added + ' added in ' + r.tasks.events + ' event(s) from ' + (r.tasks.files.join(', ') || 'no file') +
    (r.apply ? '  -> ' + r.tasksVisible + ' visible after fold' : ''));
  const ids = Object.entries(r.tasks.idMap);
  if (ids.length) console.log('  ids:      ' + ids.slice(0, 6).map(([o, n]) => o + ' -> ' + n).join(', ') + (ids.length > 6 ? ', ... (' + ids.length + ' total, all in the manifest)' : ''));
  console.log('  journal:  ' + r.journal.entries + ' entr(y/ies) from ' + (r.journal.files.join(', ') || 'no file'));
  if (r.usage.entries) console.log('  usage:    ' + r.usage.entries + ' entr(y/ies)');
  if (r.malformed) console.log('  malformed lines dropped: ' + r.malformed);
  console.log('  queues:   ' + r.queues.length + ' file(s) kept under absorbed/' + r.as + '/queues/ - never re-delivered');
  for (const u of r.unread) console.log('    UNREAD  ' + u.file + ': ' + u.blocks + ' block(s), ' + u.bytes + ' B' + (u.everRead ? '' : ' (never had a reader here)') + '  -> re-send on purpose if it still matters');
  for (const c of r.cards) console.log('  card      ' + c.slug + ' -> ' + c.kept + (c.kept.startsWith('absorbed/') ? '  (slug exists here; fold the digest by hand)' : ''));
  for (const c of r.resources) console.log('  resource  ' + c.slug + ' -> ' + c.kept);
  if (r.skipped.length) console.log('  not absorbed (node-local or generated): ' + r.skipped.join(', '));
  console.log((r.apply ? 'Wrote ' : 'Would write ') + r.writes.length + ' new file(s); nothing here is rewritten.' +
    (r.apply ? ' Next mesh-sync carries them to every peer. Move the source away so nothing falls back to it.' : ''));
  done(0);
});

// cards compact: bring cards that grew before the cap existed back under it. Dry by default.
command('cards', () => args[1] === 'compact', () => {
  const apply = args.includes('--apply');
  const by = getFlag('--by') || process.env.HUBD_AGENT || null;
  if (apply && !by) die('--by required to apply (or set HUBD_AGENT): the move is journaled.');
  const r = runCardsCompact({ apply, by });
  console.log((apply ? 'Compacted' : 'Would compact') + ' against ' + r.limits.sectionBytes + 'B per section' +
    (apply ? '' : '  (dry run — add --apply --by <you>)'));
  if (!r.cards.length) { console.log('  every card is already inside the limit.'); done(0); }
  for (const c of r.cards) {
    if (c.skipped) { console.log('  skip  ' + c.slug + ': ' + c.skipped); continue; }
    console.log('  ' + c.slug + ': ' + c.before + 'B' + (c.after != null ? ' -> ' + c.after + 'B' : ''));
    for (const s of (c.moved || c.sections)) {
      console.log('      ' + (s.section || '') + ': ' + (s.entries != null
        ? s.entries + ' oldest entr(y/ies), ' + s.bytes + 'B moved to projects/history/' + c.slug + '.md'
        : s.bytes + 'B, ' + s.over + 'B over — oldest entries would move to projects/history/' + c.slug + '.md'));
    }
  }
  console.log(apply
    ? 'Nothing was deleted: every moved entry is in projects/history/<slug>.md, which syncs with the mesh.'
    : 'Nothing written. The overflow would be MOVED to history, never dropped — FACT:/HYPO:/COMM: live only in the card.');
  done(0);
});

// cards merge-sections: fold doubled sections (same heading twice, or one key under two locales)
// into the live one. Dry by default.
command('cards', () => args[1] === 'merge-sections', () => {
  const apply = args.includes('--apply');
  const by = getFlag('--by') || process.env.HUBD_AGENT || null;
  if (apply && !by) die('--by required to apply (or set HUBD_AGENT): the merge is journaled.');
  const r = runCardsMergeSections({ apply, by });
  if (!r.cards.length) { console.log('No card holds a section twice.'); done(0); }
  const what = (i) => i.key ? `${i.key}: ${i.headings.map(h => '## ' + h).join(' + ')}` : `## ${i.heading} x${i.count}`;
  for (const c of r.cards) {
    console.log('  ' + c.slug + ': ' + c.issues.map(what).join('; ') + (c.skipped ? '  — skipped: ' + c.skipped : ''));
    for (const m of (c.merged || [])) console.log('      → ## ' + m.section + ' (' + m.mode + ')');
  }
  console.log(apply
    ? 'Merged. Lists were concatenated in file order; a second next step went to projects/history/<slug>.md, never dropped.'
    : 'Nothing written (dry run — add --apply --by <you>). Lists would be concatenated into the section writers reach; a second next step would move to history.');
  done(0);
});

// cards merge: merge two project cards that describe the same project under different slugs.
// Creates an alias b → a in project-aliases.json; archives b.md to projects/history/.
// Dry by default.
command('cards', () => args[1] === 'merge', () => {
  const from = args[2];  // the duplicate slug to fold
  const into = args[3];  // the canonical slug to keep
  if (!from || !into) die('cards merge <duplicate> <canonical> [--apply --by <you>]: folds <duplicate>.md into <canonical>.md');
  const apply = args.includes('--apply');
  const by = getFlag('--by') || process.env.HUBD_AGENT || null;
  if (apply && !by) die('--by required to apply (or set HUBD_AGENT): the merge is journaled.');
  const r = runCardsMerge({ from, into, apply, by });
  console.log(`  ${from}.md → ${into}.md  (alias created${r.aliasExisted ? ' — was already aliased' : ''})`);
  for (const s of r.sections) console.log(`      ${s.heading}: ${s.count} line(s) ${s.moved ? 'moved' : 'in destination already, skipped'}`);
  console.log(r.applied
    ? `Merged. ${from} is now an alias of ${into} and ${from}.md has been archived to projects/history/.`
    : 'Nothing written (dry run — add --apply --by <you>).');
  done(0);
});

command('card', () => args[1] === 'resolve', () => {
  const targets = args.slice(2).filter(a => !a.startsWith('-'));
  const files = targets.length
    ? targets.map(t => (t.includes('/') || t.endsWith('.md') ? path.resolve(t) : cardPath(t)))
    // Cards and resources only: a queue conflict wants block union with theirs appended, which is
    // `hub queue resolve`. Running the card resolver over one would union its LISTS and leave the
    // message blocks alone, which is not a resolution of anything.
    : conflictedFiles().filter(c => c.kind !== 'queue').map(c => c.file);
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
});

// card merge-driver: merge cards by ## section on this node (hub/lib/cardmerge.mjs says why).
command('card', () => args[1] === 'merge-driver', () => {
  const rel = (f) => path.relative(HUB, f);
  try {
    if (args.includes('--remove')) {
      const r = removeCardDriver(HUB);
      console.log(r.had ? 'Card merge driver removed from ' + HUB + '; the hub\'s own .gitattributes decides how cards merge here.'
        : 'No card merge driver installed in ' + HUB + '.');
      done(0);
    }
    const r = installCardDriver(HUB, { script: path.join(path.dirname(__filename), '..', 'scripts', 'card-merge.mjs') });
    console.log((r.was === r.driver ? 'Card merge driver already installed in ' : r.was ? 'Card merge driver repointed in ' : 'Card merge driver installed in ') + HUB);
    console.log('  ' + rel(r.attrFile) + (r.attrAdded ? '   + ' : '   has ') + CARD_ATTR);
    console.log('  git config           merge.' + CARD_DRIVER + '.driver = ' + r.driver);
    if (r.was && r.was !== r.driver) console.log('  (was: ' + r.was + ')');
  } catch (e) { die(e.message); }
  console.log('This node only: nothing here travels with the mesh, so run it on every node that syncs.');
  console.log('Different ## sections changed on two nodes now merge cleanly. One section changed on both keeps');
  console.log('both versions under a marker line for a person to review. If node or hubd moves, cards fall back');
  console.log('to a union merge until this is run again.');
  done(0);
});

command('card', () => {
  const slug = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!slug) die('Usage: hub card <slug> -m "<digest>"  |  hub card resolve [slug...]');
  const digest = getFlag('-m') || getFlag('--digest');
  // Patch instead of replace: --replace "<old>" --with "<new>" (repeatable, paired in order) and
  // --append-line "<line>" edit only what is named and leave the rest of the digest byte-for-byte.
  const froms = [], tos = [];
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--replace' && typeof args[i + 1] === 'string') froms.push(args[++i]);
    else if (args[i] === '--with' && typeof args[i + 1] === 'string') tos.push(args[++i]);
  }
  if (froms.length !== tos.length) die(`--replace and --with come in pairs (${froms.length} --replace, ${tos.length} --with)`);
  const appendLine = getFlag('--append-line');
  const patching = froms.length || typeof appendLine === 'string';
  if (!patching && (!digest || typeof digest !== 'string')) die('Usage: hub card <slug> -m "<digest>"\n       hub card <slug> --replace "<old>" --with "<new>" [--replace ... --with ...] [--append-line "<line>"]');
  const by = authorOrDie('--by');
  let res;
  try {
    res = runCardSet(patching
      ? { project: slug, by, replace: froms.map((from, i) => ({ from, to: tos[i] })), appendLine: typeof appendLine === 'string' ? appendLine : undefined }
      : { project: slug, digest, by });
  } catch (e) { die(e.message); }
  console.log(`Card ${res.patched ? 'patched' : 'set'}: ${res.project} → ${res.card}`);
  if (res.patched) console.log(res.digest.split('\n').map(l => '  ' + l).join('\n'));
  done(0);
});

command(['resource', 'res'], () => {
  const sub = args[1];
  if (sub === 'set') {
    const slug = args[2] && !args[2].startsWith('-') ? args[2] : null;
    if (!slug) die('Usage: hub resource set <slug> [-m "<note>"] [--type host] [--addr <ip/url>] [--os <o>] [--provider <p>] [--status live] [--link <rel>:<slug> ...] [--attr <key>=<value> ...]');
    const edges = {};                                    // --link rel:slug  (rel = runs_on|depends_on|deploys_to|part_of|exposes|connects|...)
    for (const l of getFlags('--link')) {
      const mm = String(l).match(/^([A-Za-z0-9_-]+)[:=](.+)$/);
      if (mm) (edges[mm[1]] = edges[mm[1]] || []).push(mm[2]);
      else die('--link expects <rel>:<slug>, got: ' + l);
    }
    // --attr key=value, repeatable; not comma-split like --link, a value may hold a comma
    const attrs = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--attr') continue;
      const mm = String(args[i + 1] ?? '').match(/^([^=]+)=(.*)$/);
      if (!mm) die('--attr expects <key>=<value> (empty value removes the key), got: ' + (args[i + 1] ?? ''));
      attrs[mm[1]] = mm[2];
    }
    let res; try { res = runResourceSet({
      slug, type: getFlag('--type'), address: getFlag('--addr') || getFlag('--address'),
      os: getFlag('--os'), provider: getFlag('--provider'), status: getFlag('--status'),
      digest: (typeof (getFlag('-m') || getFlag('--digest')) === 'string') ? (getFlag('-m') || getFlag('--digest')) : null,
      edges, attrs, by: authorOrDie('--by'),
    }); } catch (e) { die(e.message); }
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
});

command('secret', () => {
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
});

command('graph', () => {
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
  if (!froms.length) console.log('(no relationships yet — add edges in card frontmatter, e.g. runs_on: [[vm1]], or: hub resource set vm1 --link runs_on:hubd)');
  for (const f of froms) {
    console.log(label(f));
    for (const e of byFrom[f]) console.log(`  └─ ${e.rel} → ${label(e.to)}`);
  }
  if (data.dangling.length) {
    console.log('\n⚠ dangling (target has no card — create it or it stays a note):');
    for (const d of data.dangling) console.log(`  ${d.from} —${d.rel}→ ${d.to}`);
  }
  done(0);
});

command('section', () => {
  // `hub section add <proj> <section> "<text>"` — one line into one section, everything else
  // in the card untouched. Sits next to `hub sections` (which lists the vocabulary).
  const SU = 'Usage: hub section add <project> <section> "<text>" --by <you> [--src <where it came from>] [--set]';
  if (args[1] !== 'add') die(SU);
  let pos; try { pos = positionals(2, { values: ['--by', '--src'], booleans: ['--set'] }); } catch (e) { die(e.message + '\n' + SU); }
  const [project, section, text] = pos;
  if (!project || !section || !text) die(SU);
  if (pos.length > 3) die(`unexpected extra argument ${JSON.stringify(pos[3].slice(0, 40))} — quote the text as one argument.\n${SU}`);
  const src = getFlag('--src');
  let r;
  try {
    r = runSectionAdd({ project, section, text, by: authorOrDie('--by'),
      provenance: typeof src === 'string' ? src : undefined, mode: args.includes('--set') ? 'set' : 'append' });
  } catch (e) { die(e.message); }
  console.log(`${r.project} → ## ${r.section}${r.created ? '  (section created — check the name if you expected it to exist)' : ''}`);
  done(0);
});

command(['now', 'whatnext'], () => {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : (getFlag('-p') || null);
  const r = runNext({ project: proj || undefined, assignee: getFlag('--assignee') || undefined });
  if (!r.task) { console.log('nothing to do: ' + r.why); done(0); }
  const t = r.task;
  console.log(`#${t.id} [${t.project}]${t.deadline ? ' \u23f0' + t.deadline : ''}${t.assignee ? ' @' + t.assignee : ''}`);
  console.log(t.text);
  console.log(`\nwhy: ${r.why}`);
  console.log(`(${r.eligible} ready, ${r.blockedCount} blocked` + (r.runnerUp ? `; next after it: #${r.runnerUp.id}` : '') + ')');
  done(0);
});

command('agenda', () => {
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
});

/* `hub sense <head> [events|check|verdict|brief|status]` — a head's sensor (lib/sense.mjs).
 * The events contract is the one a loop already relies on: exit 0 and text = wake the head with
 * this text, 1 = no events, anything above 1 = the sensor failed. So this command never goes
 * through done(): an unknown flag there exits 1, which would read as "nothing happened". */
command('sense', () => {
  const head = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const sub = args[2] && !args[2].startsWith('-') ? args[2] : 'events';
  const fail = (m) => { console.error('Error: ' + m); process.exit(3); };
  if (!head) fail('Usage: hub sense <head> [events | check <branch> | verdict <branch> accept|reject <text> | brief | status] [--json]');
  const bad = args.slice(1).filter(x => /^--?[A-Za-z]/.test(x) && x !== '--json');
  if (bad.length) fail('unknown flag ' + bad[0] + ' (hub sense takes only --json)');
  try {
    if (sub === 'events') {
      const r = runSenseEvents(head);
      if (args.includes('--json')) console.log(JSON.stringify(r)); else if (r.text) console.log(r.text);
      process.exit(r.code);
    }
    if (sub === 'check') {
      const br = args[3]; if (!br) fail('Usage: hub sense <head> check <branch>');
      const conf = senseConf(head); if (!conf) fail(`no head "${head}" in the role registry`);
      const [okv, txt] = checkBranch(conf, br);
      console.log(txt); process.exit(okv === false ? 1 : 0);
    }
    if (sub === 'verdict') {
      const [br, v, ...rest] = args.slice(3);
      if (!br || !v || !rest.length) fail('Usage: hub sense <head> verdict <branch> accept|reject "<text>"');
      const r = runSenseVerdict(head, br, v, rest.join(' '));
      console.log(r.text); process.exit(r.code);
    }
    if (sub === 'brief') { console.log(runSenseBrief(head)); process.exit(0); }
    if (sub === 'status') { console.log(JSON.stringify({ conf: senseConf(head), config: senseConfig(), state: loadSenseState(head), escalations: escalationsPath() }, null, 1)); process.exit(0); }
    fail('hub sense: events | check | verdict | brief | status');
  } catch (e) { fail(e.message); }
});

/* `hub board` — the tracks, and what waits for the owner, as text. Same data as the Tracks view of
 * `hub serve`; lists are cut at --limit rows each (default 8) and say how many they left out. */
command('board', () => {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : getFlag('-p');
  const daysF = getFlag('--days');
  const lim = parseInt(String(getFlag('--limit') || '8'), 10) || 8;
  const r = runBoard({ project: typeof proj === 'string' ? proj : undefined, days: typeof daysF === 'string' ? daysF : undefined, all: args.includes('--all') });
  if (args.includes('--json')) { console.log(JSON.stringify(r)); done(0); }
  const hm = (ts) => String(ts || '').replace('T', ' ').slice(5, 16);
  const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const list = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`  ${title} (${rows.length})`);
    for (const x of rows.slice(0, lim)) console.log('    ' + fmt(x));
    if (rows.length > lim) console.log(`    … ${rows.length - lim} more (--limit)`);
  };
  const stateOf = (s) => s.kind === 'turn' ? `turn ${s.minutes ?? '?'}m${s.turn != null ? ' #' + s.turn : ''}`
    : s.kind === 'waiting' ? `waiting ${s.minutes ?? '?'}m` : s.kind === 'silent' ? `SILENT ${s.minutes}m`
    : s.kind === 'exit' ? `exit${s.reason ? ': ' + s.reason : ''}` : s.kind === 'alive' && s.minutes != null ? `alive, seen ${s.minutes}m ago` : s.kind;
  const who = (t) => t.assignee ? ` @${t.assignee}${t.assigneeKnown ? (t.assigneeOff ? ' (off)' : '') : ' (not a role)'}` : '';
  if (!r.registry.roles) console.log('(no roles declared — tracks are projects with open work; declare roles: hub resource set <role> --type role --attr rank=head|worker ...)');
  for (const t of r.tracks) {
    console.log(`\n── ${t.project}${t.heads.length ? ' · head ' + t.heads.join(', ') : ''} · done ${r.days}d ${t.counts.done} · next ${t.counts.next} · blocked ${t.counts.blocked}`);
    for (const w of t.rows) {
      const step = w.lastStep ? `${hm(w.lastStep.ts)} ${cut(w.lastStep.text, 70)}` : '·';
      console.log(`    ${w.state.kind === 'silent' || w.state.kind === 'unseen' ? '○' : w.state.kind === 'off' ? '-' : '●'} ${pad(w.role, 18)}${pad(w.rank, 7)}${pad(stateOf(w.state), 16)}${pad(w.task ? '#' + w.task : '', 14)}${step}`);
    }
    list('DONE', t.done, x => `${hm(x.done)}  #${x.id}  ${cut(x.title, 60)}${x.acceptance ? '  ← ' + (x.acceptance.agent || '') + ': ' + cut(x.acceptance.text, 60) : ''}`);
    list('NEXT', t.next, x => `#${x.id}  ${cut(x.title, 70)}${who(x)}${x.deadline ? ' ⏰' + x.deadline : ''}`);
    list('BLOCKED', t.blocked, x => `#${x.id}  ${cut(x.title, 60)}  ← waits on ${x.waitingOn.map(d => '#' + d.id).join(' ') || '?'}`);
    list('DECISIONS', t.decisions, x => `${hm(x.ts)}  ${x.verdict.toUpperCase()} ${x.sha.slice(0, 10)}${x.branch ? ' ' + x.branch : ''}${x.agent ? '  (' + x.agent + ')' : ''}`);
    for (const sn of t.sense || []) console.log(`  SENSOR ${sn.head} (${sn.node}): ${sn.pending.length ? sn.pending.join(' ') : 'nothing standing'}${sn.last ? ' · last woke ' + hm(sn.last.ts) : ''}`);
  }
  const w = r.waiting;
  console.log(`\n── WAITING FOR YOU`);
  list('owner queue', w.queue, x => `${x.role}  ${x.ageDays ?? '?'}d  from ${x.from}${x.task ? ' #' + x.task : ''}  ${cut(x.subject, 80)}`);
  list('your tasks', w.tasks, x => `#${x.id} [${x.project}]${x.deadline ? ' ⏰' + x.deadline : ''}${x.ready ? '' : ' (blocked)'}  ${cut(x.title, 70)}`);
  list('owner-go', w.ownerGo, x => `#${x.id} [${x.project}]  ${cut(x.title, 70)}${who(x)}`);
  list(`escalations to ${r.registry.fleet.join(', ') || 'the fleet'} (${r.days}d)`, [...w.escalations].reverse(), x => `${hm(x.ts)}  ${x.from}${x.task ? ' #' + x.task : ''}  ${cut(x.subject, 80)}`);
  list('answers', [...w.answers].reverse(), x => `${hm(x.ts)}  → ${x.role}${x.task ? ' #' + x.task : ''}  ${cut(x.subject, 80)}`);
  if (!w.queue.length && !w.tasks.length && !w.ownerGo.length && !w.escalations.length) console.log('  nothing');
  if (r.unknownAssignees.length) console.log(`\n  ⚠ open work on names that are not roles: ${r.unknownAssignees.join(', ')}  (hub lint)`);
  done(0);
});

command('recall', () => {
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
});

command('reflect', () => {
  const usage = 'Usage: hub reflect --project <project> [--since 7d|12h|<time>] [--level turn|head|fleet] [--json]';
  const flag = (n) => { const v = getFlag(n); if (v === true) die(`${n} needs a value\n${usage}`); return v; };
  const project = flag('--project') ?? flag('-p');
  if (!project) die(usage);
  let r;
  try { r = runReflect({ project, since: flag('--since') ?? undefined, level: flag('--level') ?? undefined }); }
  catch (e) { die(e.message); }
  if (args.includes('--json')) { console.log(JSON.stringify(r)); done(0); }
  const nz = (o) => Object.entries(o).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
  const roles = Object.keys(r.roles);
  console.log(`${r.project}: ${r.reflections} reflection(s) since ${r.since}${r.level ? ', level ' + r.level : ''}` +
    (roles.length ? `, from ${roles.length} role(s)` : ''));
  for (const role of roles) {
    const p = r.roles[role];
    console.log(`  ${role}  ${p.reflections}: ${nz(p.result)} · obstacles: ${nz(p.obstacle)}`);
  }
  const obs = Object.entries(r.obstacles).filter(([k, o]) => o.count && k !== 'none');
  if (obs.length) console.log('\nobstacles');
  for (const [k, o] of obs) {
    console.log(`  ${k} ${o.count}`);
    for (const f of o.facts) console.log(`    ${f.ts} ${f.role}: ${f.fact.slice(0, 200)}`);
  }
  if (r.rules.length) console.log('\nrules proposed more than once');
  for (const g of r.rules) console.log(`  ×${g.count} ${g.rule.slice(0, 200)}  (${g.roles.join(', ')}; last ${g.last})`);
  if (r.decisions.length) console.log('\ndecisions');
  for (const d of r.decisions) console.log(`  ${d.ts} ${d.role} ${d.verdict}${d.reason ? ' (' + d.reason + ')' : ''}: ${d.rule.slice(0, 200)}`);
  done(0);
});

command('usage', () => {
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
});

command('rules', () => {
  const app = getFlag('--append');
  if (typeof app === 'string') {
    const r = runRules({ append: app, by: authorOrDie('--by'), teamRoot: resolveQueueRoot() });
    console.log(`amended ${r.file}:\n  ${r.appended}`);
    done(0);
  }
  const r = runRules({ teamRoot: resolveQueueRoot() });
  if (!r.exists) { console.log(r.hint); done(1); }
  console.log(r.text);
  done(0);
});

command('operator', () => {
  const r = runOperatorGet();
  if (!r.exists) { console.log(r.hint + '\n\nsuggested sections:\n' + r.scaffold); done(1); }
  console.log(r.card);
  done(0);
});

command('audit', () => {
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
});

command('lint', () => {
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
});

command('sections', () => {
  console.log('section key      heading   (single source for card scaffold + report routing)');
  for (const s of sectionsConfig()) console.log('  ' + pad(s.key, 16) + s.heading);
  console.log('\nlocalise in ONE file → HUB/sections.json  (merged by key onto the defaults)');
  console.log('  e.g. { "decisions": "<your heading>", "next": {"heading":"...","hint":"..."} }');
  done(0);
});

command('harvest', () => {
  const p = harvestPrompt();
  if (!p) die('HARVEST.md not found in this hubd package');
  console.log(p);   // paste-able Harvest Protocol prompt — ships with the code, not the repo
  done(0);
});

/* A role's rules from prompts/meta (lib/prompts.mjs). Exit 1 means only "--check found the file
 * different from the render", so a loop can tell stale rules from a broken template or a missing
 * variable, which exit 2 and write nothing. */
command('prompts', () => {
  const fail = (m) => { console.error('Error: ' + m); process.exit(2); };
  const usage = 'hub prompts render <template> [--vars <json|file>] [--out <file> | --check <file>]';
  if (args[1] !== 'render') fail(`${usage}\n  templates: ${templateNames().join(', ')}`);
  let pos;
  try { pos = positionals(2, { values: ['--vars', '--out', '--check'] }); } catch (e) { fail(e.message); }
  if (pos.length !== 1) fail(`${usage}\n  templates: ${templateNames().join(', ')}`);
  const flag = (n) => { const v = getFlag(n); if (v === true) fail(`${n} needs a value`); return v; };
  const varsArg = flag('--vars'), out = flag('--out'), check = flag('--check');
  if (out && check) fail('--out and --check are two different runs: pick one');
  let vars = {};
  if (varsArg) {
    const inline = varsArg.trimStart().startsWith('{');
    let src = varsArg;
    if (!inline) { try { src = fs.readFileSync(varsArg, 'utf8'); } catch (e) { fail(`--vars ${varsArg}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); } }
    try { vars = JSON.parse(src); } catch (e) { fail(`--vars${inline ? '' : ' ' + varsArg}: not JSON (${e.message})`); }
  }
  let text;
  try { text = renderPrompt(pos[0], vars); } catch (e) { fail(e.message); }
  if (check) {
    let have = null;
    try { have = fs.readFileSync(check, 'utf8'); } catch {}
    if (have === text) { console.log(`${check}: matches the render of ${pos[0]}`); done(0); }
    if (have === null) { console.error(`${check}: missing — the render of ${pos[0]} has ${text.split('\n').length} lines`); process.exit(1); }
    console.error(`${check} differs from the render of ${pos[0]} (- only in the file, + only in the render):`);
    console.error(lineDiff(have, text).join('\n'));
    process.exit(1);
  }
  if (out) {
    const tmp = `${out}.tmp.${process.pid}`;
    try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, out); } catch (e) { try { fs.unlinkSync(tmp); } catch {} fail(`--out ${out}: ${e.message}`); }
    done(0);
  }
  writeAllSync(1, text);
  done(0);
});

// Who is running this command. Was `--agent || $USER || 'cli'`, which recorded 41
// 'cli' and 19 'root' entries — the shell user, not the function doing the work, and
// agents shell out to this CLI too, so "it came from a terminal" never meant "a human
// did it". Now the caller says so explicitly, or HUBD_AGENT does it for them.
function authorOrDie(flag) {
  const v = (getFlag(flag) || process.env.HUBD_AGENT || '').trim();
  if (!v) die(`${flag} required (or set HUBD_AGENT): the function doing this, e.g. "dev-hubd"`);
  return v;
}

command('gc', () => {
  /* The classes that are judged by name (lib/gc.mjs): listed first, moved only with --apply --by.
   * Nothing is ever unlinked from the mesh — a queue goes to queues/archive/ with its bytes intact,
   * which is the one deletion mesh-sync accepts. */
  const daysF = getFlag('--days');
  let g;
  try { g = runHubGc({ days: typeof daysF === 'string' ? parseInt(daysF, 10) : 14, apply: args.includes('--apply'), by: args.includes('--apply') ? authorOrDie('--by') : undefined }); }
  catch (e) { die(e.message); }
  if (args.includes('--json')) { console.log(JSON.stringify(g)); done(0); }
  for (const n of g.notes) console.log('  note: ' + n);
  const show = (title, rows, fmt) => { if (!rows.length) return; console.log(`\n${title} (${rows.length}):`); for (const x of rows) console.log('  ' + fmt(x)); };
  const L = g.local;
  show('this node\'s own litter (never synced)', [
    ...L.locks.map(f => 'stale lock ' + f), ...L.backups.map(f => 'task cache backup ' + f), ...L.tmp.map(f => 'stale tmp ' + f),
    ...L.readers.map(n => 'idle reader ' + n + ' → .qstate/_archive/'), ...(L.sessions ? [L.sessions + ' session record(s) older than 7d'] : []),
  ], x => x);
  show(`queues of no live role, untouched ${g.days}d+, that this node may archive`, g.queues, q => `${pad(q.file, 44)} ${pad(q.reason, 20)} ${pad(q.idleDays + 'd', 5)} ${pad(q.bytes + 'B', 8)} ${q.whose}`);
  show('left where they are', g.skipped, q => `${pad(q.file, 44)} ${q.why}`);
  show('dead waiter markers', g.waiters, w => `${w.file}  (pid ${w.pid ?? '?'})`);
  show(`presence of names that are not roles, ${g.days}d+ old`, g.presence, p => `${pad(p.agent, 30)} last ${p.lastSeen}`);
  show('environment notices whose cause is gone', g.env, e => `${e.kind}: ${e.value}`);
  show('open tasks on names that are not live roles — decide per project, gc never touches them', g.tasks,
    t => `${pad(t.assignee, 24)} ${pad(t.reason, 20)} ${t.count} task(s) in ${t.projects.join(', ')}`);
  const litter = L.locks.length + L.backups.length + L.tmp.length + L.readers.length + L.sessions;
  if (!g.apply) {
    if (g.queues.length || g.waiters.length || g.presence.length || g.env.length || litter) console.log(`\ndry run, nothing touched — apply with: hub gc --apply --by <you>${g.days !== 14 ? ' --days ' + g.days : ''}`);
    else console.log('\nnothing to clean');
  } else {
    console.log(`\narchived ${g.moved.length} queue file(s) to queues/archive/, removed ${g.waitersRemoved} waiter marker(s), archived ${g.presenceMoved} presence record(s), cleared ${g.envCleared} notice(s)`);
    console.log(`  local: removed ${g.localRemoved.removed} file(s), archived ${g.localRemoved.readers} idle reader(s), dropped ${g.localRemoved.sessions} session record(s)`);
    if (g.commit) console.log(`  one commit: ${g.commit} — mesh-sync carries it to every peer`);
    else if (g.moved.length) console.log(`  not committed${g.commitError ? ' (' + g.commitError + ')' : ''} — mesh-sync accepts the move on its next run, the bytes are in the archive`);
    for (const f of g.failed) console.log(`  FAILED ${f.file}: ${f.error}`);
  }
  done(0);
});

command('sync', () => {
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
});

command('install-hook', () => {
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
});

command('_commit-hook', () => {
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
});

/* A role's work queue as text: the tasks it should take, in order, each with what was said about
 * it. Offered = ready and not started by anyone; in progress = claimed, until the claim lapses. */
function printWork(role, r) {
  for (const k of r.skipped || []) console.log(`\n# held back: ${k.header.replace(/^## /, '')} — task ${k.tasks.map((t, i) => '#' + t + ' is ' + k.status[i]).join(', ')}`);
  const work = r.work || [];
  if (!work.length) { console.log(`\n# no ready tasks assigned to ${role}`); return; }
  for (const w of work) {
    console.log(`\n## task #${w.id} [${w.project}]${w.importance && w.importance !== 'normal' ? ' · ' + w.importance : ''}${w.deadline ? ' · due ' + w.deadline : ''} · ` +
      (w.claim ? `in progress: ${w.claim.agent} until ${w.claim.until}` : 'OFFERED — start with: hub claim --task ' + w.id + ' --agent ' + role + ' -t <min>'));
    console.log(w.text);
    for (const m of w.messages || []) console.log(`  > ${m.ts} from ${m.from}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  console.log(`\n# close a task only by its outcome (hub report DONE: <id>); cancelling it is closing it`);
}

command('queue', () => {
  const sub = args[1];
  if (sub === 'send') {
    const USAGE = 'Usage: hub queue send <role> "<text>" --from <who> [--task <id>]\n' +
      '       hub queue send <role> --text "<text>" --from <who>     (text may start with "-")\n' +
      '       hub queue send <role> - --from <who> < file             (text from stdin)';
    let pos;
    try { pos = positionals(2, { values: ['--from', '--agent', '--task', '--text'] }); } catch (e) { die(e.message + '\n' + USAGE); }
    const role = pos[0];
    const textFlag = getFlag('--text');
    let text = typeof textFlag === 'string' ? textFlag : pos[1];
    // A bare body that begins with "-" never gets here: positionals() has already refused it
    // as an unknown flag, which is what it is far more often than a message. --text and
    // stdin carry the real ones.
    if (typeof textFlag !== 'string' && text === '-') { try { text = fs.readFileSync(0, 'utf8'); } catch { text = ''; } }
    if (pos.length > 2) die(`unexpected extra argument ${JSON.stringify(pos[2].slice(0, 40))} — quote the whole text as one argument.\n${USAGE}`);
    if (!role || role.startsWith('-') || !text || !text.trim()) die(USAGE);
    // The sender is an author like any other write's (was `--from || 'unknown'`, the
    // one durable channel that skipped the rule) — flag, or the HUBD_AGENT floor.
    // --task ties the message to what it is ABOUT, so the reply is not orphaned from the
    // work. A ref that matches no task is flagged now, not discovered days later.
    const taskRef = getFlag('--task');
    // --agent is what every other write calls its author; senders reached for it and lost
    // their body to it. Accept it as the same thing.
    const fromFlag = typeof getFlag('--agent') === 'string' && typeof getFlag('--from') !== 'string' ? '--agent' : '--from';
    const sent = queueSendChecked(role, text, { from: authorOrDie(fromFlag), task: typeof taskRef === 'string' ? taskRef : undefined });
    console.log(`→ ${path.basename(sent.file)} delivered` + (typeof taskRef === 'string' ? `  (about task #${taskRef})` : ''));
    if (sent.taskKnown === false) console.error(`  warning: no task #${taskRef} in this hub — the reference was still recorded, check the id`);
    done(0);
  } else if (sub === 'wait') {
    const role = args[2];
    // A flag must not be consumed as the role. `hub queue wait --timeout 5`
    // otherwise waits on a queue literally named "--timeout" -- which exists as
    // soon as it is asked for, so it blocks forever and looks like a quiet queue
    // rather than a mistake.
    if (!role || role.startsWith('-')) die('Usage: hub queue wait <role|*> [--timeout <N>] [--as <subscriber>] [--from-now] [--tasks]');
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
      queueWait(role, { timeout, subscriber, fromNow, work: args.includes('--tasks') }).then(result => {
        if (result.changed) {
          if (result.text) console.log(result.text);
          if (result.tasks) console.log(`\n# about task(s): ${result.tasks.map(t => '#' + t).join(' ')} — report against them (DONE:/NOTE:) so the task carries the outcome`);
          if (result.work) printWork(role, result);
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
  } else if (sub === 'work') {
    // The work view without waiting on anything: what a supervisor reads to tell "idle with work
    // offered" from "nothing to do" in one call.
    const role = args[2];
    if (!role || role.startsWith('-')) die('Usage: hub queue work <role> [--json]');
    let work; try { assertRole(role); work = roleWork(role); } catch (e) { die(e.message); }
    if (args.includes('--json')) { console.log(JSON.stringify({ role, work, offered: work.filter(w => !w.claim).map(w => w.id) })); done(0); }
    printWork(role, { work });
    done(0);
  } else if (sub === 'status') {
    const role = args[2] && !args[2].startsWith('-') ? args[2] : undefined;
    const { roles } = queueLedger({ root: resolveQueueRoot(), role });
    if (!roles.length) { console.log(role ? `No queue files for role ${role}` : 'No queue files yet'); done(0); }
    if (args.includes('--json')) { console.log(JSON.stringify({ roles })); done(0); }
    for (const r of roles) {
      const tag = (r.isButton ? ' 🔘' : '') + (r.fanout ? ' (broadcast)' : '');
      console.log(`${r.role}${tag}: ${r.total} message(s) — ` + (r.fanout
        ? 'delivered PER READER; a broadcast role has no shared position'
        : `${r.delivered} delivered, ${r.pending} pending`));
      // Read positions are mesh-wide: this node's cursor or any node's read mark, whichever is further.
      const readAt = (f) => f.readTo === null ? '   nobody has read this file — no cursor here, no read mark from any node'
        : `   read to ${f.readTo}/${f.bytes}B ` + (f.readBy ? `on ${f.readBy}${f.readAt ? ' at ' + f.readAt : ''}` : 'here') +
          (f.readBy && f.cursor !== null && f.cursor < f.readTo ? ` (this node's cursor: ${f.cursor}B)` : '');
      for (const f of r.files) {
        console.log(`    ${f.node || '(legacy, no node)'}: ${f.total} total` +
          (r.fanout ? '' : `, ${f.delivered} delivered, ${f.pending} pending` + readAt(f)));
      }
      for (const rd of r.readers)
        console.log(`    reader ${rd.subscriber}${rd.on.length ? ' (on ' + rd.on.join(', ') + ')' : ''}: ${rd.delivered} delivered` +
          (rd.behind ? `, ${rd.behind} behind` : ''));
    }
    done(0);
  } else if (sub === 'resolve') {
    /* Queue files are append-only by contract but have no union merge, so two sides that both
     * appended really do conflict — one node came back after two days with five queue files
     * conflicted at once. Ours, then theirs-unique appended at the END: nothing is inserted
     * before existing content, so every byte cursor in the hub stays valid, including the ones on
     * other nodes this one cannot see. Strict time order is what that costs, and it costs nothing:
     * a reader walks forward from its cursor and every block carries its own timestamp. */
    const qdir = path.join(resolveQueueRoot(), 'queues');
    const named = args.slice(2).filter(a => !a.startsWith('-'));
    const files = (named.length ? named.map(n => (n.includes('/') ? path.resolve(n) : path.join(qdir, n)))
      : (() => { try { return fs.readdirSync(qdir).filter(f => f.endsWith('.queue.md')).map(f => path.join(qdir, f)); } catch { return []; } })());
    let touched = 0, left = 0;
    for (const f of files) {
      let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!CONFLICT_RE.test(text)) continue;
      const r = resolveQueueConflicts(text);
      if (r.malformed) {
        left++;
        console.log('  ' + path.basename(f) + ': ' + r.malformed + ' malformed hunk(s) left alone — look by hand');
      }
      if (!r.hunks) continue;
      fs.writeFileSync(f, r.text, 'utf8');
      touched++;
      console.log('  ' + path.basename(f) + ': ' + r.hunks + ' hunk(s), ' + r.carried +
        ' block(s) carried over from the other side');
    }
    console.log(touched ? 'Rewrote ' + touched + ' queue file(s). Review, then commit.' : 'No conflicted queue files.');
    done(left ? 1 : 0);
  } else if (sub === 'gc') {
    const days = parseInt(String(getFlag('--days') || '30'), 10);
    const apply = args.includes('--apply');
    const r = runQueueGc({ root: resolveQueueRoot(), days, apply });
    for (const g of r.ghosts) {
      console.log(`  ${g.file}  ${g.messages} msg, ${g.bytes}B, ${g.newest ? 'newest ' + g.newest : 'empty'}, ${g.ageDays}d, never read`);
    }
    for (const g of r.held) console.log(`  left: ${g.file}  ${g.why}`);
    for (const s of r.staleSubscribers) {
      console.log(`  reader ${s.tap ? '__watchall__/' : ''}${s.name}  last active ${s.lastActive || '?'} (${s.ageDays}d)`);
    }
    if (apply) {
      console.log(r.count
        ? `Archived ${r.moved.length}/${r.count} ghost queue(s) → ${r.archive}${r.failed.length ? '  (failed: ' + r.failed.join(', ') + ')' : ''}`
        : `Nothing to archive at --days ${days}`);
      if (r.staleSubscribers.length) console.log(`Archived ${r.subscribersArchived.length}/${r.staleSubscribers.length} idle reader namespace(s) → .qstate/_archive/` +
        (r.subscribersFailed.length ? '  (failed: ' + r.subscribersFailed.join(', ') + ')' : '') + ' — move one back to resume that reader where it stopped');
      done(0);
    }
    if (r.staleSubscribers.length) console.log(`${r.staleSubscribers.length} reader namespace(s) idle ${r.subscriberDays}d+ — --apply moves them to .qstate/_archive/ (never deleted).`);
    console.log(r.count
      ? `${r.count} ghost queue(s) older than ${days}d, ${r.live} live. Nothing moved — re-run with --apply to archive them into queues/archive/ (moved, never deleted).`
      : `No ghost queues older than ${days}d: every queue file has a cursor, a present agent, or is newer.`);
    // Say what the threshold is hiding — the honest denominator, not just the catch.
    if (r.neverRead > r.count) {
      console.log(`  note: ${r.neverRead} of ${r.total} queue file(s) have never been consumed at all — ${r.neverRead - r.count} of them newer than ${days}d and left alone. Lower the bar with --days <N> once you know they are dead.`);
    }
    done(0);
  } else {
    die('queue subcommands: send, wait, monitor, work, status, resolve, gc');
  }
});

command('serve', () => {
  const port = parseInt(getFlag('-p') || getFlag('--port') || '7777');
  startServer(port);
});

/* ── help, and the one dispatch ──
 * One line per command: its usage, then what it is for. `hub <cmd> --help` prints the lines of
 * that command. */
const HELP = [
  ['init [path]', 'scaffold a team folder (AGENTS.md, INBOX.md, queues/)'],
  ['version | --version | -v', 'installed hubd version, and which copy is answering'],
  ['doctor', 'check hub base, team root, locks, queues and writer versions'],
  ['upgrade', 'refresh HUBD.md (the agent protocol) to the installed version'],
  ['status', 'project table'],
  ['brief [-h <hours>]', 'morning brief'],
  ['inbox [--hours <N>]', 'what needs a decision now (blocked/overdue/unassigned/stale locks)'],
  ['now [project] [--assignee <who>]', 'the one next thing to do'],
  ['agenda [project]', 'the day, split by who can act'],
  ['plan [project]', 'dependency-graph trajectory: ready now · critical path · unlock order · cycles'],
  ['whereami [cwd] [--json]', 'where am I: project, digest age, tasks, claims, who is here, journal tail, git inventory — first command after a compaction'],
  ['log [project] [-n 20] [--json]', 'journal tail'],
  ['watch --as <name> [-p <proj>] [--since 1h] [--follow [--interval 5]] [--private] [--json]', 'new journal entries, each shown once to the cursor <name>',
    'one pass and exit, or --follow; a new cursor starts now unless --since; --json: one entry per line'],
  ['recall "<what do we know about X>" [--limit 20] [--stale-days N] [--json]', 'ranked, dated hits across cards, tasks and the journal'],
  ['report [-p <proj>] [--reflect <json|file>]', 'structured report → card sections (no input prints the template)',
    'DECIDE:/FACT:/HYPO:/COMM:/NEXT:/DONE:/TASK:/NOTE: lines, via stdin (heredoc) or -m; --reflect: the turn\'s reflection as checked fields'],
  ['reflect --project <proj> [--since 7d] [--level turn|head|fleet] [--json]', 'the reflection digest: results and obstacles per role, the latest facts, repeated rules'],
  ['decide "<what>" --why "<why>" -p <proj>', 'append a decision to ## Decisions'],
  ['next "<the one next action>" -p <proj>', 'set ## Next step'],
  ['task add "<text>" -p <proj> [-i high|med] [-d YYYY-MM-DD] [--needs 1,2] [--resource <slug>] --by <you>', 'a new task'],
  ['task done <id> --by <you>', 'close a task'],
  ['task list [-p proj] [--status open|done|all] [--json]', 'tasks'],
  ['task get <id> [--json]', 'one task, and where else its id appears'],
  ['task retag [--apply --by <you>]', 'move categories off the fixed list into tags (dry run without --apply)'],
  ['card <slug> -m "<digest>"', 'set a project card without a folder'],
  ['card <slug> --replace "<old>" --with "<new>" [--append-line "<line>"]', 'fix lines of a card, leave the rest byte-for-byte'],
  ['card resolve [slug...]', 'union the list hunks of a conflicted card, name the rest'],
  ['card merge-driver [--remove]', 'on this node, merge cards by ## section: no conflict, both versions kept and marked'],
  ['cards compact [--apply --by <you>]', 'move the overflow of over-long card sections into projects/history/ (dry run without --apply)'],
  ['cards merge <duplicate> <canonical> [--apply --by <you>]', 'merge two cards for the same project (dry run without --apply)'],
  ['cards merge-sections [--apply --by <you>]', 'fold a section a card holds twice (same heading, or two locales) into the live one'],
  ['section add <project> <section> "<text>" --by <you> [--src <where>] [--set]', 'write one section of a card'],
  ['sections', 'card section keys → headings (localise via HUB/sections.json)'],
  ['absorb <dir> --as <label> [--apply --by <you>]', 'fold a hub base written in isolation into this one, as a new node (dry run without --apply)'],
  ['freeze "<why>" --by <you>', 'stop mesh-sync on THIS node before operating on the hub dir'],
  ['unfreeze', 'let it sync again'],
  ['resource set <slug> [-m "<note>"] [--type host|vm|service|endpoint|provider|role] [--addr <a>] [--status live] [--link <rel>:<slug>] [--attr <k>=<v>]', 'a resource card'],
  ['resource list [--type <t>]', 'infra/topology cards (hosts, vms, services, roles, ...)'],
  ['resource get <slug>', 'one resource + its in/out relationships'],
  ['graph [-p <proj>] [--type <t>]', 'typed relationship graph (runs_on/depends_on/deploys_to/...)'],
  ['harvest', 'print the Harvest Protocol prompt (also served as an MCP prompt)'],
  ['prompts render <template> [--vars <json|file>] [--out <file> | --check <file>]', "a role's rules from prompts/meta; --check: exit 1 if the file differs"],
  ['claim <proj> <area> [-t min] [--note "<why>"] --agent <you>', 'soft lock'],
  ['claim --task <id> [-t min] --agent <you>', 'start a task: a claim on it while you work'],
  ['claim check <path> [-p <proj>] [--agent <you>]', 'who holds a claim over this path'],
  ['release <id> | release --task <id> --agent <you>', 'release a lock'],
  ['heartbeat <agent> [--role r] [--status s] [--task id] [--cwd path] [--ttl min]', 'record liveness'],
  ['presence [--role r] [--alive] [--json]', 'fleet roster (who has heartbeated, alive/stale)'],
  ['usage [--days 7] [-p <proj>] [--json]', 'what the work cost, measured and supplied'],
  ['usage add --agent <you> [--seconds N] [--tokens-in N] [--tokens-out N] [--cost <usd>] [--model m] [-p proj] [--task id]', 'record what a piece of work cost'],
  ['rules [--append "<rule>" --by <you>]', "the team's rules (AGENTS.md), or add one"],
  ['operator', "the operator's card"],
  ['lint', 'the hub against its rules; exit 1 on findings'],
  ['audit [--days 7] [--apply --by <you>]', 'declarations vs behaviour; --apply files each finding as an incident'],
  ['sync [path] [-m "<digest>"]', 'sync a project (-m = non-interactive)'],
  ['install-hook [path]', 'git post-commit hook'],
  ['gc [--days 14] [--json]', 'what has piled up, by class — dry: touches nothing'],
  ['gc --apply --by <you>', "archive it (moved, never deleted) and clear this node's litter"],
  ['secret set|get|path|list|rm|backup|restore|verify <name>', 'values kept outside the replicated hub'],
  ['queue send <role> "<text>" --from <who> [--task <id>]', 'address work to a role'],
  ['queue wait <role> [--timeout <N>] [--as <subscriber>] [--from-now] [--tasks]', 'block until real content, then exit 0'],
  ['queue monitor <role> [--timeout <N>] [--once] [--as <sub>] [--from-now]', 'the same, again and again'],
  ['queue work <role> [--json]', "the role's ready tasks, as its queue"],
  ['queue status [<role>] [--json]', 'per role and node: delivered and pending'],
  ['queue resolve [file...]', 'a conflicted queue file: ours in place, theirs appended'],
  ['queue gc [--days 30] [--apply]', 'archive queue files nobody ever read'],
  ['board [<project>] [--days 7] [--limit 8] [--all] [--json]', 'every track: roles, done, next, blocked, and what waits for you'],
  ['sense <head> [events|check <branch>|verdict <branch> accept|reject <text>|brief|status]', "a head's sensor: exit 0 = wake with this text, 1 = nothing"],
  ['serve [-p 7777]', 'read-only dashboard: tracks, kanban, history'],
];
const helpName = (usage) => usage.split(/[\s|]/)[0];

function printHelp(only) {
  const rows = only && HELP.some(h => helpName(h[0]) === only) ? HELP.filter(h => helpName(h[0]) === only) : HELP;
  const lines = rows === HELP ? ['hubd CLI', '', 'Usage: hub <command>   (hub <command> --help for its lines)', ''] : [];
  for (const [usage, what, ...more] of rows) {
    lines.push(usage.length < 33 ? '  ' + usage.padEnd(33) + what : '  ' + usage + '\n' + ' '.repeat(35) + what);
    for (const m of more) lines.push(' '.repeat(4) + m);
  }
  console.log(lines.join('\n'));
}

/* Commands that only read. They leave the hub byte-for-byte as they found it: no ensureProtocol(),
 * and the engine's read-only switch on, so a read does not rebuild the task cache or record an
 * environment baseline in passing either. A dry `hub gc` used to delete the stale tmp files it was
 * there to list, and any command at all appended to the tracked .gitignore — a mesh commit made by
 * `hub status`. tests/logic/readonly.mjs snapshots a hub around each of these. A command missing
 * from here still works; it just runs as a writer. */
function readOnlyRun() {
  const sub = args[1], dry = !args.includes('--apply');
  switch (cmd) {
    case undefined: case 'help': case '--help': case 'version': case '--version': case '-v':
    case 'doctor': case 'status': case 'brief': case 'inbox': case 'plan': case 'trajectory': case 'whereami': case 'where':
    case 'log': case 'presence': case 'graph': case 'now': case 'whatnext': case 'agenda': case 'board': case 'recall': case 'reflect':
    case 'operator': case 'lint': case 'sections': case 'harvest': case 'prompts':
      return true;
    case 'gc': case 'audit': case 'cards': case 'absorb': return dry;
    case 'usage': return sub !== 'add';
    case 'rules': return !args.includes('--append');
    case 'resource': case 'res': return sub === 'list' || sub === 'get';
    case 'task': return sub === 'list' || sub === 'get';
    case 'claim': return sub === 'check';
    case 'queue': return sub === 'status' || (sub === 'gc' && dry);
  }
  return args.includes('--help');
}

// A writing command keeps the agent-facing protocol (HUBD.md) current — cheap when already current
// (a stat + version compare), rewritten only after a hubd version change.
if (readOnlyRun()) setReadOnly(true);
else { try { ensureProtocol(); } catch {} }

if (!cmd || cmd === 'help' || cmd === '--help' || args.includes('--help')) {
  printHelp(cmd === 'help' ? args[1] : cmd === '--help' ? null : cmd);
  done(0);
}
{
  const handlers = COMMANDS.get(cmd);
  if (!handlers) die('Unknown command: ' + cmd + '. Run hub --help for the list.');
  const h = handlers.find(x => !x.when || x.when());
  if (!h) { printHelp(cmd); die(`hub ${cmd}: no such subcommand`); }
  // A refusal from the engine is a message to read, not a stack trace.
  try { h.run(); } catch (e) { die(e && e.message ? e.message : String(e)); }
}
