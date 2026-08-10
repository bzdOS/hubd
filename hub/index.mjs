#!/usr/bin/env node
/**
 * hubd MCP server — stdio JSON-RPC 2.0, zero dependencies.
 * Architecture: dumb server, smart agents. All logic lives in lib/core.mjs.
 */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import {
  runSync, runCardSet, runReport, runStatus, runGet, runSearch, runSectionAdd,
  runTaskAdd, runTaskList, runTaskUpdate, runTaskGet,
  runBrief, runClaim, runRelease, runKanban, setHubBase, HUB,
  runResourceSet, runResourceList, runResourceGet, runGraph,
  ensureProtocol, harvestPrompt, runOnboarding, runWhatsNew, runInbox, runContext,
  runHeartbeat, runPresence, runTrajectory, requireAuthor, envChecks, capOutput, runAudit, runLint,
} from './lib/core.mjs';
import { queueSend, queueWait, queueWaitAll, queueSummaryForBrief, buttonsSummary } from './lib/queue.mjs';
import { sessionId } from './lib/session.mjs';

const TOOLS = [
  { name: 'hub_sync',
    description: 'Sync a project folder into the hub. Collects git facts automatically; pass digest (your own summary of state/next steps) and the card is rewritten.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute path to the project folder' },
      name: { type: 'string', description: 'Project name (default: folder name)' },
      digest: { type: 'string', description: 'Agent-written summary: status, recent work, next steps, blockers' },
      agent: { type: 'string', description: 'the function you are performing, e.g. "dev-hubd". NOT which model you are — that is read from the transcript, and many sessions share a model. NOT a queue role either: a role is a mailbox (see hub_queue_wait), this is who is at it.' },
    }, required: ['path', 'agent'] } },

  { name: 'hub_card_set',
    description: 'Create or update a project card from just a name and a digest — no folder needed (unlike hub_sync). Use it to capture a project that is not a local git checkout, e.g. when harvesting a dialog. Preserves any hand-written frontmatter and Facts.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'project name or slug' },
      digest: { type: 'string', description: 'the card digest: 3-6 lines of current state' },
      by: { type: 'string', description: 'the function you are performing, e.g. "dev-hubd". NOT which model you are — that is read from the transcript, and many sessions share a model. NOT a queue role either: a role is a mailbox (see hub_queue_wait), this is who is at it.' },
    }, required: ['project', 'digest', 'by'] } },

  { name: 'hub_section_add',
    description: 'Append ONE line to ONE section of a project card, leaving everything around it untouched. This is how Gates / Metrics / Market and any hand-written section get written by a tool at all — hub_card_set only writes the digest, and the report router only reaches Decisions / Facts / Communication / Next step. For those four, a normal hub_report with DECIDE:/FACT:/COMM:/NEXT: is still the right call; use this for the rest. The section is created if missing (you get created:true back — check it, a typo is how a card grows two nearly identical headings).',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' },
      section: { type: 'string', description: 'a key from hub sections (gates, metrics, market, ...) or the literal heading as it appears in the card' },
      text: { type: 'string', description: 'one line; it is stamped with the date' },
      provenance: { type: 'string', description: 'where this came from — a URL, a file, a command, a person. Recorded next to the line so a later reader can re-check it.' },
      mode: { type: 'string', enum: ['append', 'set'], description: 'default append. `set` REPLACES the section body — right for "the one next action", wrong for anything cumulative.' },
      by: { type: 'string', description: 'the function you are performing, e.g. "dev-hubd".' },
    }, required: ['project', 'section', 'text', 'by'] } },

  { name: 'hub_report',
    description: 'Append a session report to the shared journal: what was done / broken / blocked.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, agent: { type: 'string' },
      text: { type: 'string' },
      kind: { type: 'string', enum: ['done', 'broken', 'blocked', 'note'], description: 'default: note' },
    }, required: ['project', 'agent', 'text'] } },

  { name: 'hub_status', description: 'Snapshot of every project at once: the latest digest of each, when it was last synced, and its open-task count, plus the most recent shared-journal entries. A project whose card has fallen behind its OWN journal carries digestStale {daysBehind, lastJournal} — the card still reads fresh while the work moved on. Best for orienting at the start of a session. For a deadline-sorted to-do list use hub_brief; for one project in depth use hub_get.',
    inputSchema: { type: 'object', properties: {
      staleDays: { type: 'integer', description: 'digest counts as behind after N days of journal it does not reflect, default 7' },
    } } },

  { name: 'hub_get', description: 'Everything about ONE project: its full card (digest + facts), recent journal entries for it, and any active soft-locks. Use after hub_status or hub_search points you at a project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'project slug or name' } }, required: ['project'] } },

  { name: 'hub_context',
    description: 'Auto-resolve which hub project YOUR working directory belongs to — call this at session start instead of hub_status/hub_get when you already know your cwd. Checks, most to least certain: a .hubd marker file (repo root, first line = project slug) · a project card\'s recorded sync path · the repo folder name as a last-resort guess (returned with guessed:true — never silently trust a name coincidence). Returns {project, via, root, guessed, digest, openTasks, activeClaims}; project is null with a hint if nothing matched.',
    inputSchema: { type: 'object', properties: {
      cwd: { type: 'string', description: "Absolute path to YOUR OWN current working directory — this cannot be inferred by the server (it may serve many agents in many directories), so pass it explicitly." },
    }, required: ['cwd'] } },

  { name: 'hub_search', description: 'Full-text search across every project card and the entire journal, archived months included. Returns each matching line with its location. START HERE whenever you know a keyword, a task id or a name but not which project owns it — searching once beats guessing project × status against hub_task_list, which is how sessions have actually wasted calls. Also the way to find where something was discussed or decided.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'plain-text substring, case-insensitive' } }, required: ['query'] } },

  { name: 'hub_task_add',
    description: 'Add a task to the shared cross-project backlog.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, text: { type: 'string' },
      importance: { type: 'string', enum: ['high', 'med', 'normal'], description: 'default normal' },
      deadline: { type: 'string', description: 'YYYY-MM-DD, optional' },
      cat: { type: 'string', description: 'one of technical | communicative | decision | chore. Anything else is kept — as a tag, not a category: the four values are the axis every by-type number is counted on, so it stays closed.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'free-form labels — the open vocabulary next to the closed cat one' },
      assignee: { type: 'string', description: 'agent name or owner, optional' },
      by: { type: 'string', description: 'the function you are performing, e.g. "dev-hubd". NOT which model you are — that is read from the transcript, and many sessions share a model. NOT a queue role either: a role is a mailbox (see hub_queue_wait), this is who is at it.' },
      depends_on: { type: 'array', items: { type: ['integer', 'string'] }, description: 'task ids this task waits on (bare number or a node-scoped id like "planck-3")' },
      resources: { type: 'array', items: { type: 'string' }, description: 'resource slugs this task touches (host/vm/service/...) — a structured link task → resource, not prose' },
    }, required: ['project', 'text', 'by'] } },

  { name: 'hub_task_get',
    description: 'ONE task by id, plus what it is blocked by and what it blocks. Use this when you know the id — do NOT go guessing project × status combinations with hub_task_list. Know a keyword but not the id? hub_search first.',
    inputSchema: { type: 'object', properties: {
      id: { type: ['integer', 'string'], description: 'bare number or a node-scoped id like "planck-3"' },
    }, required: ['id'] } },

  { name: 'hub_task_list',
    description: 'List backlog tasks. Filter by project and/or status; page with limit/offset. `total` is always the full matching count, so a page never reads as the whole backlog. Looking for ONE task you can name? hub_task_get by id, or hub_search by keyword — both beat listing and scanning.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'all'] },
      limit: { type: 'integer', description: 'page size' },
      offset: { type: 'integer', description: 'skip this many, for paging through a long backlog' },
    } } },

  { name: 'hub_task_update',
    description: 'Update a task: close it (status=done), reassign, reprioritise, edit text/deadline/cat.',
    inputSchema: { type: 'object', properties: {
      id: { type: ['integer', 'string'], description: 'bare number or a node-scoped id like "planck-3"' }, status: { type: 'string', enum: ['open', 'done'] },
      importance: { type: 'string', enum: ['high', 'med', 'normal'] },
      text: { type: 'string' }, deadline: { type: 'string' },
      cat: { type: 'string', description: 'technical | communicative | decision | chore — anything else is kept as a tag instead' },
      tags: { type: 'array', items: { type: 'string' }, description: 'free-form labels; replaces the task\'s tag list' },
      assignee: { type: 'string' }, by: { type: 'string' },
      depends_on: { type: 'array', items: { type: ['integer', 'string'] }, description: 'task ids this task waits on' },
      resources: { type: 'array', items: { type: 'string' }, description: 'resource slugs this task touches' },
    }, required: ['id', 'by'] } },

  { name: 'hub_audit',
    description: 'Compare what the hub DECLARES with what actually happened, and turn each disagreement into an incident somebody owns. Checks: a money bet whose gate date passed with no decision since · a project whose share of the journal contradicts the MODE its card declares · owner buttons nobody pressed · a card that stopped following its own journal · tasks with no project. Read-only by default; `apply` files one incident task per finding and writes ONE report. Every finding quotes the rule it enforces with the date that rule was written (HUB/rules.json -> laws), because an engine\'s opinion carries no weight and your own past decision does. Findings are keyed, so a weekly run never files the same incident twice. NOT a dashboard: the numbers it prints (attention share, close rates) are a thermometer and are never filed as violations.',
    inputSchema: { type: 'object', properties: {
      days: { type: 'integer', description: 'window for the attention/close-rate numbers, default 7' },
      staleButtonDays: { type: 'integer', description: 'an owner button older than this is a finding, default 7' },
      apply: { type: 'boolean', description: 'file the incidents (requires by). Default false — look first.' },
      by: { type: 'string', description: 'required with apply: the function you are performing, e.g. "auditor-weekly"' },
    } } },

  { name: 'hub_lint',
    description: 'Every rule that CAN be checked, checked — the difference between a rule the hub enforces and one that is only written down somewhere. Reports a money bet whose gate has no date, and a human-owned communicative task with no prep it depends on (the owner would have to both prepare and decide). Each finding says whether the instance actually enforces it (HUB/rules.json -> strict, opt-in and empty by default) and quotes the local rule if one is declared. Read-only, never files anything.',
    inputSchema: { type: 'object', properties: {
      projects: { type: 'array', items: { type: 'string' }, description: 'restrict to these project slugs' },
    } } },

  { name: 'hub_brief',
    description: 'Morning brief across all projects: open tasks (deadlines first), journal since N hours, stale cards, cards whose digest trails their own journal (staleDigests — the misleading kind of stale), active claims, per-role queue depth with last-seen agent (broadcast roles are flagged fanout instead of a depth — their cursors are per-reader), and a buttons rollup ("N buttons waiting, oldest X days" — pending items in a human-owner queue, see HUB/owner-roles.json).',
    inputSchema: { type: 'object', properties: {
      hours: { type: 'integer', description: 'journal window, default 48' },
      staleDays: { type: 'integer', description: 'card considered stale after N days, default 7' },
    } } },

  { name: 'hub_kanban',
    description: 'The board as data: open tasks split into queued (unassigned) and in-progress (assigned), plus done-in-the-last-day and recent journal — the same view the read-only web kanban renders. Each task carries blocked and overdue flags.',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'hub_claim',
    description: 'Soft-lock a work area so other agents see it (e.g. area="public/index.html"). Not enforced — informational.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, area: { type: 'string' }, agent: { type: 'string' },
      ttlMin: { type: 'integer', description: 'default 240' }, note: { type: 'string' },
    }, required: ['project', 'area', 'agent'] } },

  { name: 'hub_release',
    description: 'Release a soft-lock. Pass id, or project+area+agent.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' },
      project: { type: 'string' }, area: { type: 'string' }, agent: { type: 'string' },
    } } },

  { name: 'hub_heartbeat',
    description: 'Record that an agent is alive — call it each work cycle (right after hub_report, before the next hub_queue_wait) so MCP/headless agents show up in hub_presence the same way screen-scraped ones do, no human bridge needed. Overwrites this agent\'s one presence record; freshness is judged at read time from ttlMin (default 15min), the same pattern hub_claim uses.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'your stable identity, e.g. your agent name' },
      role: { type: 'string', description: 'the queue role you work under, e.g. "hubd" — lets hub_brief pair queue depth with who is listening' },
      status: { type: 'string', description: 'free text, e.g. "working" / "waiting" / "blocked"' },
      task_id: { type: ['integer', 'string'], description: 'the task/id you are currently on, optional' },
      cwd: { type: 'string', description: 'your absolute working directory, optional' },
      ttlMin: { type: 'integer', description: 'minutes before this record counts as stale, default 15' },
    }, required: ['agent'] } },

  { name: 'hub_presence',
    description: 'The fleet roster: every agent that has called hub_heartbeat, each flagged alive/stale from its own ttlMin. hub_brief\'s queue section pairs with this ("N queued for role X, agent last-seen T") — visibility into delivery without screen-scraping to check who is even listening.',
    inputSchema: { type: 'object', properties: {
      role: { type: 'string', description: 'filter to agents heartbeating under this role' },
      aliveOnly: { type: 'boolean', description: 'drop stale (TTL-expired) records, default false' },
    } } },

  { name: 'hub_resource_set',
    description: 'Create or update a resource — an infrastructure/topology entity: host, vm, service, endpoint, or provider. Structured attributes (type, address, os, provider, status) and typed relationships go in fields, NOT prose. Use this instead of describing infra inside a card digest.',
    inputSchema: { type: 'object', properties: {
      slug: { type: 'string', description: 'resource id, e.g. "myvm" or "board.hubd.net"' },
      type: { type: 'string', description: 'host | vm | service | endpoint | provider | ... (open vocabulary)' },
      address: { type: 'string', description: 'ip / hostname / url, optional' },
      os: { type: 'string' },
      provider: { type: 'string', description: 'libvirt | cloudflare | bare-metal | ...' },
      status: { type: 'string', description: 'live | down | planned | retired' },
      digest: { type: 'string', description: 'one-line description (keep prose minimal)' },
      edges: { type: 'object', description: 'typed relationships, merged with existing: {"runs_on":["hubd"],"depends_on":["postgres"]}. Values are target slugs.', additionalProperties: { type: 'array', items: { type: 'string' } } },
      by: { type: 'string', description: 'who is writing' },
    }, required: ['slug', 'by'] } },

  { name: 'hub_resource_list',
    description: 'List resource cards (hosts, vms, services, endpoints, providers). Optionally filter by type.',
    inputSchema: { type: 'object', properties: { type: { type: 'string' } } } },

  { name: 'hub_resource_get',
    description: 'One resource card plus its inbound and outbound typed relationships.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },

  { name: 'hub_graph',
    description: 'The typed relationship graph across projects AND resources: who runs where, what depends on / deploys to / exposes what. Edges are frontmatter [[links]] keyed by relation (runs_on, depends_on, deploys_to, exposes, part_of, ...). Returns nodes, edges, and dangling links. Filter by project or type.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'only edges touching this project/resource slug' },
      type: { type: 'string', description: 'only edges touching a node of this type' },
    } } },

  { name: 'hub_onboarding',
    description: 'One-time orientation for an agent that has never worked with this hub before: what hubd is, which channel to use for what (claim vs task vs report vs queue — the #1 mistake), how to write a report. Call this FIRST, before anything else, the first time you connect.',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'hub_whatsnew',
    description: 'Personalized "what did I miss" — journal activity since YOUR OWN last hub_whatsnew call (tracked per agent name), not a fixed time window like hub_brief. Call this at the start of a session/sweep instead of re-reading hub_status/hub_brief from scratch; a never-seen agent gets a 24h window on its first call.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'your stable identity, e.g. "orchestrator" or your agent name — reused across calls to compute the delta' },
      hours: { type: 'integer', description: 'fallback window in hours if this agent has no prior checkpoint yet, default 24' },
    }, required: ['agent'] } },

  { name: 'hub_inbox',
    description: 'What needs a DECISION right now, distilled from hubd data (not a time window like hub_brief): blocked reports, overdue open tasks, unassigned open tasks, and claim locks whose TTL expired but were never released. Returns {empty:true} when nothing needs attention — poll this instead of re-reading hub_status/hub_brief every cycle.',
    inputSchema: { type: 'object', properties: {
      hours: { type: 'integer', description: 'window for blocked-report scan, default 72' },
    } } },

  { name: 'hub_trajectory',
    description: 'Deterministic dependency-graph plan over tasks\' depends_on — the probable trajectory as a critical PATH, not an ML forecast. Returns: ready (doable now, no open deps), blocked (with waitingOn ids), layers (Kahn topo-order — what unlocks when), criticalPath (longest dependency chain = ordering bound), cycles (dependency loops to fix). Use to see "given deps, what is the actual order / what is the critical path to a milestone". Weight is task-count now; weighted by real durations once logd records them.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'optional: restrict the graph to one project' },
    } } },

  { name: 'hub_queue_send',
    description: 'Append a message to a role\'s queue (queues/<role>.<node>.queue.md) for cross-agent/cross-node handoffs. Delivered to whoever calls hub_queue_wait (or `hub queue wait`) for that role, here or on a mesh-synced peer node.',
    inputSchema: { type: 'object', properties: {
      role: { type: 'string', description: 'queue/role to deliver to, e.g. "dev" or "owner"' },
      text: { type: 'string' },
      from: { type: 'string', description: 'who is sending — the function you are performing, e.g. "dev-hubd" or "orchestrator". NOT which model you are, and NOT the target role. Required like every other write: the delivered block says "from <sender>" forever.' },
      task: { type: ['integer', 'string'], description: 'the task id this message is ABOUT, if any. Stamped into the delivered block and handed back to the consumer, so a reply (a blocker, a HOLD, a result) can be reported onto the task instead of being lost with the message. An id matching no task comes back as taskKnown:false — the ref is still recorded.' },
    }, required: ['role', 'text', 'from'] } },

  { name: 'hub_queue_wait',
    description: 'Block until new content lands in <role>\'s queue (this node\'s file plus any mesh-synced peer files for that role), then return it — a real long-poll, not a snapshot you have to re-poll. Returns {changed:false} if nothing arrives within timeout. If a delivered block names a task (see hub_queue_send), the ids come back as `tasks` — report the outcome onto those tasks, or the message is the only place the blocker ever existed. Local/stdio only (not available on the shared HTTP server). Use this instead of a sleep-and-recheck loop when waiting on an agent to report back via hub_queue_send.',
    inputSchema: { type: 'object', properties: {
      role: { type: 'string' },
      timeout: { type: 'integer', description: 'seconds to block, default 45, max 540. The default is deliberately short: MCP clients abort a tool call on their own timeout (commonly ~60s) and hubd cannot see that limit. Raise it only if you know your client tolerates a longer call.' },
    }, required: ['role'] } },

  { name: 'hub_queue_wait_all',
    description: 'Subscribe to EVERY role\'s queue at once and block until new content lands in ANY of them — for an orchestrator reacting to whichever agent reports first, instead of calling hub_queue_wait per role or ssh-ing into each host to poll. Returns {changed:true, events:[{role,node,text}, ...]} tagging which role/node each event came from, or {changed:false} on timeout. Uses its own offset bookkeeping — does NOT consume/steal messages from a role\'s own hub_queue_wait consumer, it only taps. Local/stdio only.',
    inputSchema: { type: 'object', properties: {
      timeout: { type: 'integer', description: 'seconds to block, default 45, max 540. The default is deliberately short: MCP clients abort a tool call on their own timeout (commonly ~60s) and hubd cannot see that limit. Raise it only if you know your client tolerates a longer call.' },
    } } },
];

/* Per-tool output budgets (see capOutput in lib/core.mjs). Order matters: the FIRST key of a
 * plan is cut first when the payload is still too large, so every plan leads with its journal
 * or its most repetitive list and ends with the things a caller asked the tool for. A tool
 * absent from this table is already small by construction (single card, one record, counts). */
const OUTPUT_PLANS = {
  hub_brief:      [['journalRecent', 30], ['queues', 40], ['staleCards', 20], ['staleDigests', 20], ['activeClaims', 20], ['tasksOpen', 40]],
  hub_status:     [['recentJournal', 10], ['projects', 60]],
  hub_get:        [['journal', 15], ['claims', 20]],
  hub_whatsnew:   [['entries', 50]],
  hub_search:     [['hits', 40]],
  hub_inbox:      [['blocked', 25], ['staleClaims', 25], ['overdue', 25], ['unassigned', 25]],
  hub_kanban:     [['inbox', 30], ['doneToday', 30], ['queued', 60], ['inProgress', 60]],
  hub_task_list:  [['tasks', 100]],
  hub_trajectory: [['layers', 30], ['blocked', 60], ['ready', 60]],
  hub_graph:      [['edges', 200], ['dangling', 50]],
  hub_presence:   [['agents', 60]],
  hub_audit:      [['findings', 40]],
  hub_lint:       [['findings', 40]],
  hub_resource_list: [['resources', 100]],
};

// Every capped tool advertises the same escape hatch, injected in ONE place so that adding a
// plan above can never leave a tool whose output is trimmed with no documented way out.
for (const name of Object.keys(OUTPUT_PLANS)) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) continue;
  t.inputSchema = t.inputSchema || { type: 'object', properties: {} };
  t.inputSchema.properties = t.inputSchema.properties || {};
  t.inputSchema.properties.full = { type: 'boolean', description: 'return everything, uncapped. By default long lists are trimmed to fit an agent context and what was left out is reported in `truncated`.' };
}

const DISPATCH = {
  hub_sync: runSync, hub_card_set: runCardSet, hub_report: runReport, hub_status: (a) => runStatus(a),
  hub_section_add: runSectionAdd,
  hub_get: runGet, hub_search: runSearch, hub_context: runContext,
  hub_task_add: runTaskAdd, hub_task_list: runTaskList, hub_task_update: runTaskUpdate, hub_task_get: runTaskGet,
  // queues: HUB captured synchronously here, same reasoning as hub_queue_send/wait below —
  // a plain string value, not a live reference, so a concurrent HTTP request repointing
  // HUB can't retarget an in-flight call.
  hub_brief: (a) => {
    const queues = queueSummaryForBrief({ root: HUB });
    return { ...runBrief(a), queues, buttons: buttonsSummary(queues) };
  },
  // queues are read HERE and handed in: lib/queue.mjs imports core, so core cannot read them
  // itself without closing an import cycle (see runAudit).
  hub_audit: (a) => runAudit({ ...a, queues: queueSummaryForBrief({ root: HUB }) }),
  hub_lint: runLint,
  hub_kanban: runKanban, hub_claim: runClaim, hub_release: runRelease,
  hub_heartbeat: runHeartbeat, hub_presence: runPresence,
  hub_resource_set: runResourceSet, hub_resource_list: runResourceList, hub_resource_get: runResourceGet, hub_graph: runGraph,
  // session: over HTTP the process-derived session id is the SERVER's own, one value
  // for every remote caller — keying whatsnew checkpoints on it would make the whole
  // team share one "what did I miss". Null there; the agent label becomes the key.
  hub_onboarding: () => runOnboarding(),
  hub_whatsnew: (a) => runWhatsNew({ ...a, session: SERVE_MODE === 'http' ? null : sessionId(), transport: SERVE_MODE }),
  hub_inbox: runInbox, hub_trajectory: runTrajectory,
  // root: HUB is captured HERE, synchronously, at call time — a plain string value,
  // not a live reference — so it stays correct even if a later concurrent request
  // repoints the HUB global while hub_queue_wait's promise is still pending.
  // from: required like every other author (was `|| 'mcp'` — a transport name, i.e. a
  // placeholder); an omitted from is filled by the HUBD_AGENT floor in withAuthorFloor.
  hub_queue_send: (a) => {
    // Validate the task ref but never refuse the send: the message is the urgent thing, a
    // mistyped id is a warning the caller can act on immediately.
    let taskKnown;
    if (a.task != null && a.task !== '') { try { runTaskGet({ id: a.task }); taskKnown = true; } catch { taskKnown = false; } }
    return { file: queueSend(a.role, a.text, { from: a.from, root: HUB, task: a.task }),
      ...(taskKnown === undefined ? {} : { task: a.task, taskKnown }) };
  },
  // subscriber: resolved from THIS process, never from the caller's arguments — the
  // model cannot forget it or invent a different one mid-loop. Null on an unknown
  // client, and then the cursor stays shared per node exactly as before.
  hub_queue_wait: (a) => queueWait(a.role, { timeout: Math.min(a.timeout || 45, 540), root: HUB, subscriber: sessionId() }),
  hub_queue_wait_all: (a) => queueWaitAll({ timeout: Math.min(a.timeout || 45, 540), root: HUB, subscriber: sessionId() }),
};

// Tools that touch the server's own filesystem / run subprocesses, or block for a
// long time. Safe when the daemon runs locally for one owner (stdio); a hole (or a
// resource-exhaustion risk, for the blocking wait) on a shared network server where
// a remote agent could point `path` at the host's disk or hold a connection open for
// minutes. Disabled over HTTP.
const LOCAL_ONLY_TOOLS = new Set(['hub_sync', 'hub_queue_wait', 'hub_queue_wait_all']);

function toolsFor(mode) {
  return mode === 'http' ? TOOLS.filter(t => !LOCAL_ONLY_TOOLS.has(t.name)) : TOOLS;
}

// Nudge state: has THIS connection called hub_onboarding / hub_whatsnew yet.
// stdio-only by construction (see call site below) — a module-level boolean is
// correct there because one stdio process serves exactly one agent session. It
// would be WRONG over HTTP, where one process serves many tenants concurrently
// and a shared flag would leak "tenant A onboarded" into tenant B's responses;
// hub_onboarding/hub_whatsnew themselves stay available over HTTP (their own
// state is file-backed per agent name), only the auto-nudge is skipped there.
let onboarded = false, whatsnewChecked = false;

// Fill agent/by/from from HUBD_AGENT when the caller left them out. All three are
// filled because tools disagree on which one they read (queue send reads `from`),
// and an unread extra key is ignored.
//
// The floor carries a per-session suffix, because HUBD_AGENT lives in a server's
// config — i.e. it is per MACHINE, and every session on that host would otherwise
// write under one name. That reproduces exactly the flaw requireAuthor refuses in
// "claude": one label many sessions, nothing to tell them apart afterwards. It also
// breaks two tools mechanically, because there the author is not a label but an
// identity key: runClaim treats an equal name as the same holder and reports no
// conflict, so two sessions would both "hold" one area and the soft lock would stop
// locking; and presence keeps one file per name, last write wins, so a fleet of
// sessions would collapse into a single record.
//
// The suffix is short and derived from the same process-resolved session id the queue
// cursors use, so it is stable for a client's whole life and survives a server
// respawn. An explicit argument is never touched — a caller that names its own
// function still writes exactly that.
let floorCache;
function authorFloor() {
  if (floorCache !== undefined) return floorCache;
  // Over HTTP one process serves many agents (or tenants): HUBD_AGENT is the server
  // owner's env, and the session suffix would derive from the server's own parent —
  // one name for every caller, exactly the "one label, many sessions" collapse the
  // floor exists to prevent. No floor there; HTTP callers say who they are
  // explicitly (the tool schemas require it).
  if (SERVE_MODE === 'http') return (floorCache = '');
  const base = (process.env.HUBD_AGENT || '').trim();
  if (!base) return (floorCache = '');
  // The floor is held to the same rule as an argument, or it would launder a refused
  // name into an accepted one: HUBD_AGENT=claude would arrive as "claude-<session>",
  // which passes the check while still naming a model. A misconfigured floor is no
  // floor — callers then get the error that explains what to put there.
  try { requireAuthor(base, 'HUBD_AGENT'); }
  catch (e) { process.stderr.write('warning: HUBD_AGENT ignored — ' + e.message + '\n'); return (floorCache = ''); }
  const sess = sessionId();
  if (!sess) return (floorCache = base);
  let h = 0;
  for (const ch of sess) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return (floorCache = `${base}-${h.toString(36).padStart(4, '0').slice(-4)}`);
}

function withAuthorFloor(args) {
  const floor = authorFloor();
  if (!floor) return args;
  const out = { ...args };
  for (const k of ['agent', 'by', 'from']) if (out[k] == null || String(out[k]).trim() === '') out[k] = floor;
  return out;
}

// One line: the count and where the list is. An upgrade can require something outside
// the code — a variable in this client's config, a role declared in the hub — and
// nothing used to say so; the agent found out by having a call rejected, or never.
// Deliberately not the list itself: a dump on every tool result is noise, and noise is
// how a notice stops being read. Recomputed at most every 5 minutes (was: once per
// process) — a long-lived server otherwise kept nagging about a condition fixed an
// hour ago, and stayed silent about one that appeared after startup, until a restart.
let envNudgeLine = null, envNudgeAt = 0;
function envNudge() {
  if (envNudgeAt && Date.now() - envNudgeAt < 5 * 60000) return envNudgeLine;
  envNudgeAt = Date.now();
  let n = null;
  try {
    const env = envChecks();
    if (env.total) n = `⚠ environment: ${env.total} item(s) need attention (${env.items[0].id}${env.total > 1 ? ', …' : ''}) — hub_whatsnew lists them with what to do.`;
  } catch {}
  return (envNudgeLine = n);
}

function nudges(name) {
  if (name === 'hub_onboarding' || name === 'hub_whatsnew') return [];
  const n = [];
  if (!onboarded) n.push({ type: 'text', text: '💡 New here? Call hub_onboarding first (one-time — how this hub works: claim vs task vs report vs queue).' });
  if (!whatsnewChecked) n.push({ type: 'text', text: '💡 Call hub_whatsnew({agent:"<you>"}) to see what changed since you last checked in, instead of re-reading from scratch.' });
  const e = envNudge();
  if (e) n.push({ type: 'text', text: e });
  return n;
}

// Turn one JSON-RPC message into a response object (or null for a notification
// that needs no reply). Transport-agnostic — stdio and HTTP both route through
// here, so the protocol behaves identically on either. async because hub_queue_wait
// blocks; every other tool is still synchronous internally, so `await fn(...)`
// resolves on the next microtask with no observable delay for them.
async function handleMessage(msg, mode = 'stdio') {
  const { id, method, params } = msg;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
    serverInfo: { name: 'hubd', version: VERSION },
    instructions: 'Shared sync point for all project folders and agents. New here? Call hub_onboarding first. In a project folder? Call hub_context({cwd:"<your absolute cwd>"}) to auto-resolve which project this is and its digest, instead of hub_get. Returning? Call hub_whatsnew instead of re-reading hub_status from scratch. Working a queue in a loop? Call hub_heartbeat after each hub_report so you show up in hub_presence instead of being invisible between waits. hub_brief gives a morning overview. Create work with hub_task_add.' } };
  if (String(method).startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolsFor(mode) } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [
    { name: 'harvest', description: 'Harvest this dialog into the hub — projects, tasks, decisions, links, open questions (the Harvest Protocol). No need to fetch HARVEST.md.' },
  ] } };
  if (method === 'prompts/get') {
    if (params?.name === 'harvest') {
      const text = harvestPrompt() || 'HARVEST.md not found in this hubd package.';
      return { jsonrpc: '2.0', id, result: { description: 'Harvest this dialog into the hub', messages: [{ role: 'user', content: { type: 'text', text } }] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown prompt: ' + params?.name } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (mode === 'http' && LOCAL_ONLY_TOOLS.has(name))
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + name + ' is disabled on a shared server (no server-side filesystem access). Use task/journal tools.' }], isError: true } };
    const fn = DISPATCH[name];
    if (!fn) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: unknown tool: ' + name }], isError: true } };
    try {
      // HUBD_AGENT is the floor for attribution: it is set by whoever configured this
      // server, so "the caller forgot to say who it is" degrades to a real name from
      // the config instead of to a placeholder. An explicit argument always wins, so a
      // session that knows its own function can still be more specific than the floor.
      const argv = withAuthorFloor(params?.arguments || {});
      const r = await fn(argv);
      if (name === 'hub_onboarding') onboarded = true;
      if (name === 'hub_whatsnew') whatsnewChecked = true;
      const extra = mode === 'stdio' ? nudges(name) : [];
      // One choke point for every tool's size, so no new tool can forget it.
      const capped = OUTPUT_PLANS[name] ? capOutput(r, OUTPUT_PLANS[name], { full: !!argv.full }) : r;
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(capped, null, 1) }, ...extra], isError: false } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
}

/* ── stdio transport (default; one owner, local) ── */
function serveStdio() {
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // async: a hub_queue_wait call can be in flight for minutes without blocking
  // the readline loop — other lines (other tool calls) keep being read and
  // processed concurrently; each writes its own JSON-RPC response (matched by
  // id) whenever its own promise settles, independent of call order.
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const r = await handleMessage(msg, 'stdio');
    if (r) out(r);
  });
}

/* ── HTTP transport (shared hub; MCP over Streamable HTTP, POST JSON) ──
 * Two modes. Single-tenant: one HUBD_TOKEN gates the server's own hub. Multi-tenant
 * (HUBD_MULTITENANT=1): every token is its own isolated workspace at tenants/<hash>,
 * auto-created on first request — no signup, the token IS the key (use a strong one,
 * e.g. a uuid). hub_sync is disabled in both. Binds to localhost unless HUBD_HTTP_HOST
 * is set — put TLS + the open port in front yourself. Zero deps: node stdlib only. */
async function serveHttp(port) {
  const http = await import('node:http');
  const crypto2 = await import('node:crypto');
  const MT = process.env.HUBD_MULTITENANT === '1';
  const SERVER_BASE = HUB;                         // base captured at startup
  const TENANTS = path.join(SERVER_BASE, 'tenants');
  const TOKEN = process.env.HUBD_TOKEN || '';
  if (!MT && (!TOKEN || TOKEN.length < 16)) {
    process.stderr.write('hubd --http: set HUBD_TOKEN to a secret of 16+ chars, or HUBD_MULTITENANT=1 (token = workspace).\n');
    process.exit(1);
  }
  const host = process.env.HUBD_HTTP_HOST || '127.0.0.1';
  const MAX_BODY = 512 * 1024;
  const sha = (s) => crypto2.createHash('sha256').update(s).digest('hex');

  // ── abuse guards (matter most on a public multi-tenant endpoint) ──
  // Without these, anyone can spray random tokens to mint unbounded tenant dirs
  // (disk-fill) or flood the server. Tunable via env; sane defaults.
  const fs2 = await import('node:fs');
  const RATE = parseInt(process.env.HUBD_RATE_LIMIT || '120', 10);   // POSTs/min per client IP
  const MAX_TENANTS = parseInt(process.env.HUBD_MAX_TENANTS || '1000', 10);
  const hits = new Map();                                            // ip -> { n, reset }
  const rateOk = (ip) => {
    const now = Date.now();
    if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    let e = hits.get(ip);
    if (!e || now > e.reset) { e = { n: 0, reset: now + 60000 }; hits.set(ip, e); }
    e.n++;
    return e.n <= RATE;
  };
  const known = new Set();                                           // existing tenant hashes
  if (MT) { try { for (const d of fs2.readdirSync(TENANTS, { withFileTypes: true })) if (d.isDirectory()) known.add(d.name); } catch {} }
  // Behind a TLS proxy the real client is in X-Forwarded-For; fall back to the socket.
  const clientIp = (req) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';

  // Map a request's Bearer token to the directory it may touch, or null to reject.
  const tenantFor = (header) => {
    const m = /^Bearer (.+)$/.exec(header || '');
    if (!m) return null;
    const tok = m[1];
    if (MT) return tok.length >= 16 ? path.join(TENANTS, sha(tok).slice(0, 40)) : null;
    const a = Buffer.from(tok), b = Buffer.from(TOKEN);
    return (a.length === b.length && crypto2.timingSafeEqual(a, b)) ? SERVER_BASE : null;
  };
  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true, server: 'hubd', version: VERSION, mode: MT ? 'multi-tenant' : 'single-tenant' });
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!rateOk(clientIp(req))) { res.writeHead(429, { 'retry-after': '60' }).end(); return; }
    const tenant = tenantFor(req.headers['authorization']);
    if (!tenant) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
    if (MT) {                                  // cap NEW tenant creation; existing tenants keep working
      const h = path.basename(tenant);
      if (!known.has(h)) {
        if (known.size >= MAX_TENANTS) { res.writeHead(403).end(); return; }
        known.add(h);
      }
    }
    let body = '', tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      // Every tool reachable over HTTP is still synchronous internally (LOCAL_ONLY_TOOLS
      // keeps hub_queue_wait off this transport), so setHubBase(tenant) here is never
      // at risk of being repointed mid-flight by a concurrent request's own setHubBase.
      setHubBase(tenant);
      if (Array.isArray(parsed)) {
        const results = await Promise.all(parsed.map((m) => handleMessage(m, 'http')));
        return sendJson(res, 200, results.filter(Boolean));
      }
      const r = await handleMessage(parsed, 'http');
      return sendJson(res, 200, r ?? {});
    });
  });
  server.listen(port, host, () => {
    process.stderr.write(`hubd serving MCP over HTTP on ${host}:${port} (${MT ? 'multi-tenant, token = workspace' : 'single-tenant'}, hub_sync disabled)\n`);
  });
}

const httpPortArg = (() => {
  const i = process.argv.indexOf('--http');
  if (i !== -1) return parseInt(process.argv[i + 1] || process.env.HUBD_HTTP_PORT || '8787', 10);
  if (process.env.HUBD_HTTP_PORT) return parseInt(process.env.HUBD_HTTP_PORT, 10);
  return null;
})();

// Which transport this process serves — set once, before any request is handled.
// The author floor and the environment checks read it: both describe THIS process's
// env, which is only the caller's environment on a local (stdio) transport.
const SERVE_MODE = httpPortArg ? 'http' : 'stdio';

try { ensureProtocol(); } catch {}   // materialise HUBD.md for this hub on daemon start
if (httpPortArg) serveHttp(httpPortArg); else serveStdio();
