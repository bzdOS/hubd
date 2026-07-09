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
  now, parseTs, slugify, sh, cardPath, readCard,
  runSync, runCardSet, runReport, runStatus, runGet, runSearch,
  runTaskAdd, runTaskList, runTaskUpdate,
  runBrief, runClaim, runRelease, runKanban,
  runResourceSet, runResourceList, runResourceGet, runGraph,
  sectionsConfig, ensureProtocol, VERSION, harvestPrompt,
  journalTail, journalSince, journalFiles,
  loadClaims, activeClaims, journalAppend,
} from './lib/core.mjs';
import { queueSend, queueWait, queueWaitAll, resolveQueueRoot, resolveQueueRootInfo } from './lib/queue.mjs';

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

const GITIGNORE_ENTRY = '.qstate/\nHUBD.md\n';

// Keep the agent-facing protocol (HUBD.md) current for this hub on every run — cheap when
// already current (a stat + version compare); rewrites only after a hubd version change.
try { ensureProtocol(); } catch {}

if (cmd === 'upgrade') {
  const r = ensureProtocol(true);
  if (!r.ok) die('could not materialise HUBD.md (protocol source missing?)');
  console.log(r.wrote ? `HUBD.md → v${r.version}` + (r.from ? ` (was v${r.from})` : ' (new)') : `HUBD.md already current (v${r.version})`);
  console.log('  agents read it for hub mechanics; team rules stay in AGENTS.md');
  process.exit(0);
}

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
  const resFiles = (() => { try { return fs.readdirSync(RESOURCES).filter(f => f.endsWith('.md')); } catch { return []; } })();
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
  console.log('  resources:' + resFiles.length);
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
  const pf = getFlag('-p');
  const proj = (typeof pf === 'string') ? pf : 'general';
  const kind = getFlag('-k') || 'note';
  const agent = getFlag('--agent') || process.env.USER || 'cli';
  let text = (args[1] && !args[1].startsWith('-')) ? args[1] : getFlag('-m');
  if ((!text || text === true) && !process.stdin.isTTY) {           // batch piped via stdin (heredoc)
    try { text = fs.readFileSync(0, 'utf8'); } catch {}
  }
  if (!text || typeof text !== 'string' || !text.trim()) {           // no input → print the skeleton
    console.log(REPORT_TEMPLATE);
    process.exit(0);
  }
  const r = runReport({ project: proj, agent, text, kind });
  const parts = [];
  if (r.decisions) parts.push(r.decisions + ' decision' + (r.decisions > 1 ? 's' : ''));
  if (r.facts) parts.push(r.facts + ' fact' + (r.facts > 1 ? 's' : ''));
  if (r.hypos) parts.push(r.hypos + ' hypothesis');
  if (r.comms) parts.push(r.comms + ' comm' + (r.comms > 1 ? 's' : ''));
  if (r.next) parts.push('next set');
  if (r.done.length) parts.push('closed #' + r.done.join(' #'));
  if (r.tasks.length) parts.push('new task #' + r.tasks.join(' #'));
  if (r.note) parts.push('note');
  console.log(`Reported to ${r.project}: ` + (parts.length ? parts.join(', ') : 'nothing recognized — use DECIDE:/FACT:/COMM:/NEXT:/DONE: prefixes (hub report with no input shows the template)'));
  const onlyNote = r.note && !r.decisions && !r.facts && !r.hypos && !r.comms && !r.next && !r.done.length && !r.tasks.length;
  if (onlyNote) console.error('  hint: a note-only report is usually coordination — "I\'m on it" is a `hub claim`, not a report (see HUBD.md).');
  process.exit(0);
}

if (cmd === 'decide') {
  const what = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!what) die('Usage: hub decide "<decision>" --why "<why>" -p <proj>');
  const why = getFlag('--why');
  const pf = getFlag('-p'); const proj = (typeof pf === 'string') ? pf : 'general';
  const r = runReport({ project: proj, by: getFlag('--by') || process.env.USER || 'cli', text: `DECIDE: ${what}${typeof why === 'string' ? ' | ' + why : ''}` });
  console.log(`Decided on ${r.project}: +${r.decisions} → ## Decisions`);
  process.exit(0);
}

if (cmd === 'next') {
  const what = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!what) die('Usage: hub next "<the one next action>" -p <proj>');
  const pf = getFlag('-p'); const proj = (typeof pf === 'string') ? pf : 'general';
  const r = runReport({ project: proj, by: getFlag('--by') || process.env.USER || 'cli', text: `NEXT: ${what}` });
  console.log(`Next step set on ${r.project}`);
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
    const resources = getFlags('--resource');   // structured link task → resource(s)
    const cat = getFlag('--cat');
    const assignee = getFlag('--assignee');
    const t = runTaskAdd({ project: proj, text, importance: imp || 'normal', deadline: dl || null, cat: cat || null, assignee: assignee || null, by: 'cli', depends_on, resources });
    console.log(`Task #${t.task.id} added: ${t.task.text}` + (resources.length ? `  [${resources.map(r => '⛬' + r).join(' ')}]` : ''));
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
      const res = (t.resources && t.resources.length) ? ' ' + t.resources.map(r => '⛬' + r).join(' ') : '';
      console.log(`${mark} #${t.id} [${t.project}]${dl}${ass}${res} ${t.text}`);
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
      edges, by: getFlag('--by') || process.env.USER || 'cli',
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
  process.exit(0);
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
  process.exit(0);
}

if (cmd === 'sections') {
  console.log('section key      heading   (single source for card scaffold + report routing)');
  for (const s of sectionsConfig()) console.log('  ' + pad(s.key, 16) + s.heading);
  console.log('\nlocalise in ONE file → HUB/sections.json  (merged by key onto the defaults)');
  console.log('  e.g. { "decisions": "<your heading>", "next": {"heading":"...","hint":"..."} }');
  process.exit(0);
}

if (cmd === 'harvest') {
  const p = harvestPrompt();
  if (!p) die('HARVEST.md not found in this hubd package');
  console.log(p);   // paste-able Harvest Protocol prompt — ships with the code, not the repo
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
    if (!role) die('Usage: hub queue wait <role|*> [--timeout <N>]');
    const timeoutRaw = getFlag('--timeout');
    const timeout = timeoutRaw ? parseInt(String(timeoutRaw), 10) : 540;
    if (role === '*') {
      // Subscribe to every role's queue at once — a supervisory tap, own
      // offset namespace, never steals a message from a role's own consumer.
      queueWaitAll({ timeout }).then(result => {
        if (result.changed) {
          for (const e of result.events) console.log(`## from queue ${e.role}${e.node ? '.' + e.node : ''}\n${e.text}`);
          process.exit(0);
        } else {
          console.log('NO_CHANGES');
          process.exit(2);
        }
      }).catch(e => die(e.message));
    } else {
      queueWait(role, { timeout }).then(result => {
        if (result.changed) {
          console.log(result.text);
          process.exit(0);
        } else {
          console.log('NO_CHANGES');
          process.exit(2);
        }
      }).catch(e => die(e.message));
    }
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
    '  upgrade                          refresh HUBD.md (the agent protocol) to the installed version',
    '  status                           project table',
    '  brief [-h <hours>]               morning brief',
    '  log [project] [-n 20]            journal tail',
    '  report [-p <proj>]               structured report → card sections (no input prints the template)',
    '    DECIDE:/FACT:/HYPO:/COMM:/NEXT:/DONE:/TASK:/NOTE: lines, via stdin (heredoc) or -m',
    '  decide "<what>" --why "<why>" -p <proj>   append a decision to ## Decisions',
    '  next "<the one next action>" -p <proj>    set ## Next step',
    '  task add "<text>" -p <proj> [-i high|med] [-d YYYY-MM-DD] [--needs 1,2] [--resource <slug>]',
    '  task done <id>',
    '  task list [-p proj]',
    '  card <slug> -m "<digest>"        set a project card without a folder',
    '  resource set <slug> [-m "<note>"] [--type host|vm|service|endpoint|provider] [--addr <a>] [--status live] [--link <rel>:<slug>]',
    '  resource list [--type <t>]       infra/topology cards (hosts, vms, services, ...)',
    '  resource get <slug>              one resource + its in/out relationships',
    '  graph [-p <proj>] [--type <t>]   typed relationship graph (runs_on/depends_on/deploys_to/...)',
    '  sections                         card section keys → headings (localise via HUB/sections.json)',
    '  harvest                          print the Harvest Protocol prompt (also served as an MCP prompt)',
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
