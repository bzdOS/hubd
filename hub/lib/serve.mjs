/* serve.mjs — `hub serve`: the owner's board in a browser, read-only.
 *
 * The page is serve.html, sent as it is: plain static text, so its script is written like any
 * other file (it used to be a template literal inside cli.mjs, where every backslash in the
 * client code was eaten before the browser saw it). Everything it shows comes from the JSON
 * endpoints below, which call the same engine functions as the CLI and the MCP server.
 *
 * With HUBD_MULTITENANT=1 each request names its workspace with ?t=<token>, and the hub base is
 * repointed to that tenant's directory for the request (core is synchronous, so a request cannot
 * interleave with another).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { HUB, setHubBase, ensureHubDirs, tenantKey, now, parseTs, journalSinceMs, sparklineData, runKanban, rulesFilePath } from './core.mjs';
import { runBoard } from './board.mjs';
import { resolveQueueRoot } from './queue.mjs';

export function startServer(port) {
  const HTML = fs.readFileSync(new URL('./serve.html', import.meta.url), 'utf8');

  function getRules() {
    const own = path.join(HUB, 'AGENTS.md');
    const p = MT ? (fs.existsSync(own) ? own : null) : rulesFilePath(resolveQueueRoot());
    if (p) { try { return { text: fs.readFileSync(p, 'utf8') }; } catch {} }
    return { text: 'No AGENTS.md found. Run "hub init" to scaffold a team folder, or create ~/.hubd/AGENTS.md to define team rules.' };
  }

  const MT = process.env.HUBD_MULTITENANT === '1';
  const TENANTS = path.join(HUB, 'tenants');
  const HOST = process.env.HUBD_HTTP_HOST || '127.0.0.1';
  const tenantDir = (url) => {
    const t = url.searchParams.get('t') || '';
    if (/^[0-9a-f]{40}$/.test(t)) return path.join(TENANTS, t);
    if (t.length >= 16) return path.join(TENANTS, tenantKey(t));
    return null;
  };

  // Journal entries at or after ?ts= (inclusive), through the same reader as every other view:
  // one timestamp parser, torn lines skipped the same way.
  function apiJournalSince(query) {
    const cutoff = query.get('ts') ? parseTs(query.get('ts')).getTime() : 0;
    return { entries: Number.isFinite(cutoff) ? journalSinceMs(cutoff) : [] };
  }

  function apiSparkline() { return { months: sparklineData() }; }

  const handler = (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'method not allowed' })); }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (MT) {
        const dir = tenantDir(url);
        if (!dir) { res.writeHead(401); return res.end(JSON.stringify({ error: 'open with ?t=<token>' })); }
        if (!fs.existsSync(dir)) {
          if (url.pathname === '/api/kanban') return res.end(JSON.stringify({ queued: [], inProgress: [], doneToday: [], inbox: [], generated: now() }));
          if (url.pathname === '/api/sparkline') return res.end(JSON.stringify({ months: [] }));
          if (url.pathname === '/api/journal-since') return res.end(JSON.stringify({ entries: [] }));
          if (url.pathname === '/api/board') return res.end(JSON.stringify({ days: 7, registry: { roles: 0, heads: 0, fleet: [] }, tracks: [], allTracks: [],
            waiting: { queue: [], tasks: [], ownerGo: [], escalations: [], answers: [] }, unknownAssignees: [], generated: now() }));
          if (url.pathname === '/api/rules') return res.end(JSON.stringify({ text: 'No workspace yet for this token — connect an agent and create work first.' }));
          res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' }));
        }
        setHubBase(dir); ensureHubDirs();
      }
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
      if (url.pathname === '/api/kanban') return res.end(JSON.stringify(runKanban({})));
      if (url.pathname === '/api/rules') return res.end(JSON.stringify(getRules()));
      if (url.pathname === '/api/sparkline') return res.end(JSON.stringify(apiSparkline()));
      if (url.pathname === '/api/journal-since') return res.end(JSON.stringify(apiJournalSince(url.searchParams)));
      // A tenant's queues are its own directory; the default resolution could reach the operator's.
      if (url.pathname === '/api/board') return res.end(JSON.stringify(runBoard({
        days: url.searchParams.get('days') || undefined, project: url.searchParams.get('project') || undefined,
        all: url.searchParams.get('all') === '1', queueRoot: MT ? HUB : undefined })));
      res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  };

  const server = http.createServer(handler);
  server.listen(port, HOST, () => {
    console.log('hubd kanban  http://' + HOST + ':' + port + (MT ? '  (multi-tenant — open with ?t=<token>)' : ''));
    console.log('  Tracks: roles, done, next, waiting for you   Live: kanban   History: sparkline + event playback');
    console.log('Ctrl+C to stop');
  });
}
