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
  HUB, PROJ, HISTORY, JOURNAL, CLAIMS, setHubBase,
  now, parseTs, slugify, sh, cardPath, readCard,
  runSync, runCardSet, runReport, runStatus, runGet, runSearch,
  runTaskAdd, runTaskList, runTaskUpdate,
  runBrief, runClaim, runRelease, runKanban,
  journalTail, journalSince, journalFiles,
  loadClaims, activeClaims, journalAppend,
} from './lib/core.mjs';
import { queueSend, queueWait, resolveQueueRoot, resolveQueueRootInfo } from './lib/queue.mjs';

const __filename = fileURLToPath(import.meta.url);

const args = process.argv.slice(2);
const cmd = args[0];

/* ── helpers ── */
function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n - 2) + '… ' : s + ' '.repeat(n - s.length); }
function die(msg) { console.error('Error: ' + msg); process.exit(1); }

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
  return lines.join('\n');
}

/* ── init ── */

const AGENTS_MD = `# AGENTS.md — Team Constitution

Every agent reads this file at the start of each session.

## What this file is

The rules every agent on this team must follow. If you are an agent waking up
in this repository, read this file first, then tail INBOX.md, then check your
role queue.

## Session-start ritual

1. Read AGENTS.md (this file).
2. Read the top ~20 lines of INBOX.md to catch up on recent activity.
3. Check your role queue: hub queue wait <your-role> --timeout 10

## Reporting

Before stopping or handing off, append a handoff entry to INBOX.md describing
what you did and what is left. Use the format:

  YYYY-MM-DD HH:MM | <role> | done: <summary> | next: <suggestion>

Use "hub report" for per-project journal entries that go into the structured log.

## Queues

One live waiting session per role at a time (single-consumer contract).
Send a message:   hub queue send <role> "<text>" --from <your-role>
Receive:          hub queue wait <role>

## Claims (soft locks)

Before editing a shared area, claim it:   hub claim <proj> <area>
Release when done:                        hub release <id>
This prevents two agents from clobbering the same file simultaneously.

## Full org template

Roles, projects, onboarding files and recipes live in the hubd-company/
directory of the hubd repository. Use it as a starting point for your team.
`;

const INBOX_MD = `# INBOX — team journal

Newest entries on top — prepend your handoff before you stop.
Agents: read this on wake-up, write a handoff entry before stopping.
`;

const QUEUES_README_MD = `# queues/

One file per role: \`<role>.queue.md\` — created on first send.

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

## State

Read offsets live in \`.qstate/\` (one \`<role>.offset\` file per role).
Do not commit \`.qstate/\` — it is local consumer state.
Single-consumer contract: only one live "hub queue wait" per role at a time.
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

const GITIGNORE_ENTRY = '.qstate/\n';

if (cmd === 'init') {
  const pathArg = args.filter(a => !a.startsWith('-'))[1] ?? null;
  const targetDir = pathArg ? path.resolve(pathArg) : process.cwd();

  if (pathArg && !fs.existsSync(targetDir)) {
    die('Folder not found: ' + targetDir);
  }

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
  process.exit(0);
}

/* ── doctor ── */

if (cmd === 'doctor') {
  let warnings = 0;

  // hub base
  const projFiles = (() => { try { return fs.readdirSync(PROJ).filter(f => f.endsWith('.md')); } catch { return []; } })();
  const allTasks = (() => { try { const db = JSON.parse(fs.readFileSync(path.join(HUB, 'tasks.json'), 'utf8')); return db.tasks || []; } catch { return []; } })();
  const openTasks = allTasks.filter(t => t.status === 'open').length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const overdueTasks = allTasks.filter(t => t.status === 'open' && t.deadline && t.deadline < todayStr).length;
  const claimsDb = loadClaims();
  const active = activeClaims(claimsDb.claims);
  const expired = claimsDb.claims.filter(c => !active.includes(c)).length;

  const jfiles = journalFiles();
  let totalJournalEntries = 0, malformedLines = 0;
  for (const f of jfiles) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
        try { JSON.parse(l); totalJournalEntries++; }
        catch { malformedLines++; warnings++; }
      }
    } catch {}
  }

  console.log('hub base:');
  console.log('  path:     ' + HUB);
  console.log('  projects: ' + projFiles.length);
  console.log('  tasks:    ' + openTasks + ' open' + (overdueTasks ? ', ' + overdueTasks + ' overdue' : ''));
  console.log('  claims:   ' + active.length + ' active, ' + expired + ' expired');
  console.log('  journal:  ' + jfiles.length + ' file(s), ' + totalJournalEntries + ' entries' +
    (malformedLines ? ', ' + malformedLines + ' malformed  WARNING' : ''));

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
      for (const qf of qfiles) {
        const role = qf.replace('.queue.md', '');
        const qfull = path.join(qdir, qf);
        const sz = (() => { try { return fs.statSync(qfull).size; } catch { return 0; } })();
        const off = (() => {
          try { return parseInt(fs.readFileSync(path.join(qstateDir, role + '.offset'), 'utf8').trim(), 10) || 0; }
          catch { return 0; }
        })();
        const pending = Math.max(0, sz - off);
        const beyondSize = off > sz;
        if (beyondSize) warnings++;
        let line = '  ' + role + ':  size ' + sz + 'B, offset ' + off + ', pending ' + pending + 'B';
        if (beyondSize) line += '  WARNING offset beyond file size (file truncated or recreated; offset will reset)';

        // live waiter check
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
    }
  }

  // roles vs queues coherence (informational): a role with no queue can't be sent work; a queue with no role is orphaned
  const roleNames = (() => { try { return fs.readdirSync(path.join(teamRoot, 'roles')).filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => f.replace('.md', '')); } catch { return []; } })();
  if (roleNames.length) {
    const qNames = (() => { try { return fs.readdirSync(path.join(teamRoot, 'queues')).filter(f => f.endsWith('.queue.md')).map(f => f.replace('.queue.md', '')); } catch { return []; } })();
    const rolesNoQueue = roleNames.filter(r => !qNames.includes(r));
    const queuesNoRole = qNames.filter(q => !roleNames.includes(q));
    if (rolesNoQueue.length || queuesNoRole.length) {
      console.log('');
      console.log('roles/queues:');
      if (rolesNoQueue.length) console.log('  roles without a queue: ' + rolesNoQueue.join(', '));
      if (queuesNoRole.length) console.log('  queues without a role: ' + queuesNoRole.join(', '));
    }
  }

  // rules source — shared rulesFile() (HUB wins, team-root fallback)
  const rulesSource = rulesFile();
  console.log('');
  console.log('rules source: ' + (rulesSource || 'none found'));

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

  console.log('');
  if (warnings) {
    console.log('doctor: ' + warnings + ' warning(s)');
    process.exit(1);
  } else {
    console.log('doctor: ok');
    process.exit(0);
  }
}

/* ── command dispatch ── */

if (cmd === 'status') {
  const data = runStatus();
  console.log(pad('slug', 26) + pad('synced', 22) + pad('open', 6) + 'digest');
  console.log('─'.repeat(90));
  for (const p of data.projects) {
    console.log(pad(p.project, 26) + pad(p.synced, 22) + pad(p.openTasks, 6) + (p.digest.split('\n')[0] || '').slice(0, 40));
  }
  process.exit(0);
}

if (cmd === 'brief') {
  const hours = parseInt(getFlag('--hours') || getFlag('-h') || '48');
  console.log(formatBrief(runBrief({ hours }), hours));
  process.exit(0);
}

if (cmd === 'log') {
  const proj = args[1] && !args[1].startsWith('-') ? args[1] : null;
  const n = parseInt(getFlag('-n') || '20');
  for (const e of journalTail(proj, n)) {
    console.log(`${e.ts} [${e.project}/${e.agent}] ${e.kind}: ${e.text}`);
  }
  process.exit(0);
}

if (cmd === 'report') {
  const text = args[1] && !args[1].startsWith('-') ? args[1] : getFlag('-m');
  const pf = getFlag('-p');
  const proj = (typeof pf === 'string') ? pf : 'general';
  if (!text || typeof text !== 'string') die('Text required: hub report "<text>" [-p <proj>] [-k done|broken|blocked|note]');
  const kind = getFlag('-k') || 'note';
  const agent = getFlag('--agent') || process.env.USER || 'cli';
  runReport({ project: proj, agent, text, kind });
  console.log(`Reported to ${slugify(proj)} journal (${kind})`);
  process.exit(0);
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
    const depends_on = needsRaw ? String(needsRaw).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
    const t = runTaskAdd({ project: proj, text, importance: imp || 'normal', deadline: dl || null, by: 'cli', depends_on });
    console.log(`Task #${t.task.id} added: ${t.task.text}`);
  } else if (sub === 'done') {
    const id = parseInt(args[2]);
    if (!id) die('Id required: hub task done <id>');
    runTaskUpdate({ id, status: 'done', by: 'cli' });
    console.log(`Task #${id} closed`);
  } else if (sub === 'list') {
    const proj = getFlag('-p');
    const data = runTaskList({ project: proj || undefined, status: 'open' });
    for (const t of data.tasks) {
      const dl = t.deadline ? ` ⏰${t.deadline}` : '';
      const ass = t.assignee ? ` @${t.assignee}` : '';
      const mark = t.importance === 'high' ? '!' : t.importance === 'med' ? '~' : ' ';
      console.log(`${mark} #${t.id} [${t.project}]${dl}${ass} ${t.text}`);
    }
    console.log(`(${data.count} tasks)`);
  } else {
    die('task subcommands: add, done, list');
  }
  process.exit(0);
}

if (cmd === 'claim') {
  const proj = args[1], area = args[2];
  if (!proj || !area) die('Usage: hub claim <proj> <area> [-t min]');
  const ttl = parseInt(getFlag('-t') || '240');
  const agent = getFlag('--agent') || process.env.USER || 'cli';
  const res = runClaim({ project: proj, area, agent, ttlMin: ttl });
  if (res.warning) console.warn('⚠  ' + res.warning);
  console.log(`Lock: ${res.claim.id}`);
  process.exit(0);
}

if (cmd === 'release') {
  const id = args[1];
  if (!id) die('Usage: hub release <id>');
  const res = runRelease({ id });
  console.log(`Locks released: ${res.removed}`);
  process.exit(0);
}

if (cmd === 'card') {
  const slug = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!slug) die('Usage: hub card <slug> -m "<digest>"');
  const digest = getFlag('-m') || getFlag('--digest');
  if (!digest || typeof digest !== 'string') die('Digest required: hub card <slug> -m "<digest>"');
  const by = getFlag('--by') || process.env.USER || 'cli';
  const res = runCardSet({ project: slug, digest, by });
  console.log(`Card set: ${res.project} → ${res.card}`);
  process.exit(0);
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
  console.log(removed ? `gc: removed ${removed} item(s)` : 'gc: nothing to clean');
  process.exit(0);
}

if (cmd === 'sync') {
  const pathArg = args[1] && !args[1].startsWith('-') ? args[1] : '.';
  const dir = path.resolve(pathArg);
  if (!fs.existsSync(dir)) die('Folder not found: ' + dir);
  const slug = slugify(path.basename(dir));
  const cardFile = path.join(PROJ, slug + '.md');
  let oldDigest = '';
  if (fs.existsSync(cardFile)) {
    const c = fs.readFileSync(cardFile, 'utf8');
    oldDigest = (c.split('## Digest')[1] || '').split('## Facts')[0].trim();
  }
  const flagDigest = getFlag('-m') || getFlag('--digest');
  if (flagDigest && typeof flagDigest === 'string') {   // non-interactive (scriptable) sync
    const res = runSync({ path: dir, digest: flagDigest, agent: 'cli' });
    console.log(`Synced: ${res.project} → ${res.card}`);
    process.exit(0);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = oldDigest ? `[Enter = keep: "${oldDigest.slice(0, 60)}…"]` : '[new digest]';
  rl.question(`Digest ${hint}: `, (answer) => {
    rl.close();
    const digest = answer.trim() || oldDigest || undefined;
    const res = runSync({ path: dir, digest, agent: 'cli' });
    console.log(`Synced: ${res.project} → ${res.card}`);
    process.exit(0);
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
  process.exit(0);
}

else if (cmd === '_commit-hook') {
  // Hidden command: invoked from the post-commit hook. Must never break a commit.
  try {
    const repoPath = args[1];
    if (!repoPath) process.exit(0);
    const info = sh('git log -1 --format=%H%n%an%n%s', repoPath);
    const parts = info.split('\n');
    const sha = parts[0], author = parts[1], subject = parts.slice(2).join(' ').trim();
    if (!sha) process.exit(0);
    journalAppend({ ts: now(), project: slugify(path.basename(repoPath)), agent: 'git:' + author, kind: 'done', text: sha.slice(0, 7) + ' ' + subject });
  } catch {}
  process.exit(0);
}

else if (cmd === 'queue') {
  const sub = args[1];
  if (sub === 'send') {
    const role = args[2];
    const text = args[3];
    if (!role || !text) die('Usage: hub queue send <role> "<text>" [--from <who>]');
    const from = getFlag('--from') || 'unknown';
    const qfile = queueSend(role, text, { from: typeof from === 'string' ? from : 'unknown' });
    console.log(`→ ${role}.queue.md delivered`);
    process.exit(0);
  } else if (sub === 'wait') {
    const role = args[2];
    if (!role) die('Usage: hub queue wait <role> [--timeout <N>]');
    const timeoutRaw = getFlag('--timeout');
    const timeout = timeoutRaw ? parseInt(String(timeoutRaw), 10) : 540;
    queueWait(role, { timeout }).then(result => {
      if (result.changed) {
        console.log(result.text);
        process.exit(0);
      } else {
        console.log('NO_CHANGES');
        process.exit(2);
      }
    }).catch(e => die(e.message));
  } else {
    die('queue subcommands: send, wait');
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
    '  doctor                           check hub base, team root, locks and queues',
    '  status                           project table',
    '  brief [-h <hours>]               morning brief',
    '  log [project] [-n 20]            journal tail',
    '  report "<text>" [-p <proj>] [-k done|broken|blocked|note]',
    '  task add "<text>" -p <proj> [-i high|med] [-d YYYY-MM-DD] [--needs 1,2]',
    '  task done <id>',
    '  task list [-p proj]',
    '  card <slug> -m "<digest>"        set a project card without a folder',
    '  claim <proj> <area> [-t min]     soft lock',
    '  release <id>                     release a lock',
    '  sync [path] [-m "<digest>"]      sync a project (-m = non-interactive)',
    '  gc                               remove stale locks and old backups',
    '  install-hook [path]              git post-commit hook',
    '  queue send <role> "<text>" [--from <who>]',
    '  queue wait <role> [--timeout <N>]',
    '  serve [-p 7777]                  read-only kanban dashboard',
  ].join('\n'));
  process.exit(0);
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
