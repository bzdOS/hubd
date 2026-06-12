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
  runSync, runCardSet, runReport, runStatus, runGet, runSearch,
  runTaskAdd, runTaskList, runTaskUpdate,
  runBrief, runClaim, runRelease, runKanban, setHubBase, HUB,
} from './lib/core.mjs';

const TOOLS = [
  { name: 'hub_sync',
    description: 'Sync a project folder into the hub. Collects git facts automatically; pass digest (your own summary of state/next steps) and the card is rewritten.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute path to the project folder' },
      name: { type: 'string', description: 'Project name (default: folder name)' },
      digest: { type: 'string', description: 'Agent-written summary: status, recent work, next steps, blockers' },
      agent: { type: 'string', description: 'Who is syncing (e.g. claude-cowork, cursor, executor)' },
    }, required: ['path'] } },

  { name: 'hub_card_set',
    description: 'Create or update a project card from just a name and a digest — no folder needed (unlike hub_sync). Use it to capture a project that is not a local git checkout, e.g. when harvesting a dialog. Preserves any hand-written frontmatter and Facts.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'project name or slug' },
      digest: { type: 'string', description: 'the card digest: 3-6 lines of current state' },
      by: { type: 'string', description: 'who is writing' },
    }, required: ['project', 'digest'] } },

  { name: 'hub_report',
    description: 'Append a session report to the shared journal: what was done / broken / blocked.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, agent: { type: 'string' },
      text: { type: 'string' },
      kind: { type: 'string', enum: ['done', 'broken', 'blocked', 'note'], description: 'default: note' },
    }, required: ['project', 'agent', 'text'] } },

  { name: 'hub_status', description: 'Snapshot of every project at once: the latest digest of each, when it was last synced, and its open-task count, plus the most recent shared-journal entries. Best for orienting at the start of a session. For a deadline-sorted to-do list use hub_brief; for one project in depth use hub_get.',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'hub_get', description: 'Everything about ONE project: its full card (digest + facts), recent journal entries for it, and any active soft-locks. Use after hub_status or hub_search points you at a project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'project slug or name' } }, required: ['project'] } },

  { name: 'hub_search', description: 'Full-text search across every project card and the entire journal, archived months included. Returns each matching line with its location. Use to find where something was discussed or decided.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'plain-text substring, case-insensitive' } }, required: ['query'] } },

  { name: 'hub_task_add',
    description: 'Add a task to the shared cross-project backlog.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, text: { type: 'string' },
      importance: { type: 'string', enum: ['high', 'med', 'normal'], description: 'default normal' },
      deadline: { type: 'string', description: 'YYYY-MM-DD, optional' },
      cat: { type: 'string', enum: ['technical', 'communicative', 'decision', 'chore'], description: 'task category, optional' },
      assignee: { type: 'string', description: 'agent name or owner, optional' },
      by: { type: 'string', description: 'who adds' },
      depends_on: { type: 'array', items: { type: 'integer' }, description: 'task ids this task waits on' },
    }, required: ['project', 'text'] } },

  { name: 'hub_task_list',
    description: 'List backlog tasks. Filter by project and/or status.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, status: { type: 'string', enum: ['open', 'done', 'all'] },
    } } },

  { name: 'hub_task_update',
    description: 'Update a task: close it (status=done), reassign, edit text/deadline/cat.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'integer' }, status: { type: 'string', enum: ['open', 'done'] },
      text: { type: 'string' }, deadline: { type: 'string' }, cat: { type: 'string', enum: ['technical', 'communicative', 'decision', 'chore'] },
      assignee: { type: 'string' }, by: { type: 'string' },
      depends_on: { type: 'array', items: { type: 'integer' }, description: 'task ids this task waits on' },
    }, required: ['id'] } },

  { name: 'hub_brief',
    description: 'Morning brief across all projects: open tasks (deadlines first), journal since N hours, stale cards, active claims.',
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
];

const DISPATCH = {
  hub_sync: runSync, hub_card_set: runCardSet, hub_report: runReport, hub_status: () => runStatus(),
  hub_get: runGet, hub_search: runSearch,
  hub_task_add: runTaskAdd, hub_task_list: runTaskList, hub_task_update: runTaskUpdate,
  hub_brief: runBrief, hub_kanban: runKanban, hub_claim: runClaim, hub_release: runRelease,
};

// Tools that touch the server's own filesystem / run subprocesses. Safe when the
// daemon runs locally for one owner (stdio); a hole on a shared network server,
// where a remote agent could point `path` at the host's disk. Disabled over HTTP.
const LOCAL_ONLY_TOOLS = new Set(['hub_sync']);

function toolsFor(mode) {
  return mode === 'http' ? TOOLS.filter(t => !LOCAL_ONLY_TOOLS.has(t.name)) : TOOLS;
}

// Pure: turn one JSON-RPC message into a response object (or null for a
// notification that needs no reply). Transport-agnostic — stdio and HTTP both
// route through here, so the protocol behaves identically on either.
function handleMessage(msg, mode = 'stdio') {
  const { id, method, params } = msg;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'hubd', version: VERSION },
    instructions: 'Shared sync point for all project folders and agents. Call hub_report after each work session; hub_status to see everything; hub_brief gives a morning overview. Create work with hub_task_add.' } };
  if (String(method).startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolsFor(mode) } };
  if (method === 'tools/call') {
    const name = params?.name;
    if (mode === 'http' && LOCAL_ONLY_TOOLS.has(name))
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + name + ' is disabled on a shared server (no server-side filesystem access). Use task/journal tools.' }], isError: true } };
    const fn = DISPATCH[name];
    if (!fn) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: unknown tool: ' + name }], isError: true } };
    try {
      const r = fn(params?.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }], isError: false } };
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
  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const r = handleMessage(msg, 'stdio');
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
    req.on('end', () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      setHubBase(tenant);                          // route this request to its workspace; dispatch below is synchronous
      if (Array.isArray(parsed)) {
        const out = parsed.map((m) => handleMessage(m, 'http')).filter(Boolean);
        return sendJson(res, 200, out);
      }
      const r = handleMessage(parsed, 'http');
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

if (httpPortArg) serveHttp(httpPortArg); else serveStdio();
