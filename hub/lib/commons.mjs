/* commons.mjs — `hubd commons`: the public commons, reached through a guard that knows this hub.
 *
 * A commons server refuses what gives anyone away: a home path, an e-mail address, a key. It
 * cannot know the names that give THIS writer away, the projects, nodes, agents, hosts and
 * addresses of the hub the same agent also works in, and an agent connected to both copies them
 * from one into the other sooner or later: a task id in an attempt, a role name as its handle, a
 * project name in a search. This proxy runs where those names are. It speaks MCP over stdio to the
 * agent and forwards to the commons, and every argument of every call, a search as much as a
 * write, is checked against this hub first. A hit is refused here, and nothing is sent.
 *
 * The private words come from the hub as it is on disk, read only: nothing here writes to it.
 * A name that is an ordinary word (a project called "history", a node called "maple") is let
 * through once the commons' own texts use it, since saying it there tells nobody anything; a name
 * with a dash or a digit in it, an address, a path and what this machine is called never are.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { HUB, JOURNAL_NODE, TASK_ID_PREFIX, VERSION, leakIn } from './core.mjs';

export const COMMONS_URL = 'https://mcp.hubd.net';
export const COMMONS_KEY = 'hubd-commons-public';

const MIN = 4;
// Names that say nothing about who uses them: harness and model names, and the words every team
// names a role or a project after.
const COMMON_NAMES = new Set(('claude claude-code codex gemini opencode cursor copilot sonnet opus haiku fable '
  + 'agent agents owner operator human user users admin root main master default local localhost node nodes '
  + 'test tests testing demo docs home work team data server client core prod staging hub hubd mail chat task '
  + 'tasks notes misc inbox worker workers unknown general personal history video devops executor advisor '
  + 'architect orchestrator tester reviewer auditor planner harvest channels consulting research commons public private '
  + 'system runner frontend backend windows linux macos freebsd docker caddy nginx cloudflare postgres redis grafana').split(' '));
// Hosts everyone names: a card pointing at a repository there does not make the host private.
const PUBLIC_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'npmjs.com', 'pypi.org', 'arxiv.org', 'wikipedia.org',
  'google.com', 'cloudflare.com', 'x.com', 'twitter.com', 'youtube.com', 'example.com', 'example.org'];
const FILE_EXT = new Set('py sh js mjs ts txt tsv csv md json jsonl yml yaml toml ini cfg conf log plist html css xml lock patch diff c h rs go'.split(' '));

export const privateWordsFile = (hub = HUB) => path.join(hub, 'private-words');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const plain = (w) => /^[\p{L}\p{N}]+$/u.test(w);
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
// the registrable part, near enough: a host's last two labels
const domainOf = (h) => h.split('.').slice(-2).join('.');
const underHost = (h, d) => h === d || h.endsWith('.' + d);

/* What gives this hub away, as { words: Map<word, {source, soft}>, prefixes: Map<prefix, source> }.
 * A soft word is one the commons may already use (see above); the rest are refused whatever the
 * commons says. `prefixes` are task-id prefixes: "<prefix>-<n>" is refused even when the prefix
 * alone is too short to be a word. */
export function privateVocabulary({ hub = HUB, upstream = COMMONS_URL } = {}) {
  const words = new Map(), prefixes = new Map();
  const userFile = privateWordsFile(hub);
  const userLines = read(userFile).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const except = new Set(userLines.filter(l => l.startsWith('-')).map(l => l.slice(1).trim().toLowerCase()));
  const upHost = hostOf(upstream), upDomain = upHost ? domainOf(upHost) : '';

  const add = (raw, source, soft) => {
    const w = String(raw ?? '').trim().toLowerCase();
    if (w.length < MIN || w.length > 120 || COMMON_NAMES.has(w) || except.has(w) || words.has(w)) return;
    words.set(w, { source, soft: soft ?? plain(w) });
  };
  const addName = (raw, source) => {
    const s = String(raw ?? '').trim();
    if (!s || /["\\\n]/.test(s)) return;
    add(s, source);
    if (s.includes('@')) for (const part of s.split('@')) add(part, source);
  };
  const addPrefix = (p, source) => {
    p = String(p).toLowerCase();
    if (p.length >= 3 && !COMMON_NAMES.has(p) && !except.has(p) && !prefixes.has(p)) prefixes.set(p, source);
  };
  const addPath = (p, source) => { p = p.replace(/[.,;:)]+$/, ''); if (p.length >= 8) add(p, source, false); };
  const addHost = (h, source) => {
    h = h.toLowerCase().replace(/\.$/, '');
    const last = h.split('.').pop();
    if (!/^[a-z]{2,6}$/.test(last) || FILE_EXT.has(last)) return;
    if (upDomain && underHost(h, upDomain)) return;
    if (PUBLIC_HOSTS.some(d => underHost(h, d))) return;
    add(h, source, true);
  };
  // an address is free text: URLs, IPs, host:port, paths, a node name before a colon
  const addAddress = (text, source) => {
    let s = String(text);
    for (const m of s.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,;)]+/gi)) addHost(hostOf(m[0]), source);
    s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,;)]+/gi, ' ');
    for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g))
      if (!/^(?:127\.|0\.0\.0\.0$)/.test(m[1])) add(m[1], source, false);
    for (const m of s.matchAll(/(?<![\w.~-])~?\/[\w.~-]+(?:\/[\w.~-]+)*/g)) if (m[0].split('/').filter(Boolean).length >= 2) addPath(m[0], source);
    for (const m of s.matchAll(/(?<![\w./-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?![\w-])/gi)) addHost(m[1], source);
  };

  // what you wrote down yourself comes first and is never let through
  for (const l of userLines) if (!l.startsWith('-')) add(l, 'a word in ' + userFile, false);

  const projects = path.join(hub, 'projects'), resources = path.join(hub, 'resources');
  for (const f of list(projects)) if (f.endsWith('.md')) {
    add(f.slice(0, -3), 'a project in your hub');
    const p = (read(path.join(projects, f)).match(/^- path:\s*(\S.*)$/m) || [])[1];
    if (p && /^[~/]/.test(p.trim())) addPath(p.trim().split(/\s/)[0], 'a project path in your hub');
  }
  for (const f of list(resources)) if (f.endsWith('.md')) {
    add(f.slice(0, -3), 'a resource in your hub');
    const a = (read(path.join(resources, f)).match(/^address:\s*(.+)$/m) || [])[1];
    if (a) addAddress(a.replace(/&lt;|&gt;/g, ' '), 'an address in a resource card of your hub');
  }

  // nodes are in the names of the logs each one writes; agents, authors and ids inside them
  const logs = [];
  for (const f of list(hub)) {
    const m = f.match(/^journal\.(.+?)(?:-\d{4}-\d{2}(?:\.\d+)?)?\.jsonl$/) || f.match(/^tasks\.(.+)\.events\.jsonl$/) || f.match(/^presence\.(.+)\.json$/);
    if (m) { add(m[1], 'a node of your hub'); addPrefix(m[1], 'a node of your hub'); }
    if (m || f === 'tasks.json' || f === 'journal.jsonl') logs.push(path.join(hub, f));
  }
  for (const f of logs) {
    const text = read(f);
    for (const m of text.matchAll(/"(?:agent|by|assignee)":"([^"\\]{1,80})"/g)) addName(m[1], 'an agent name in your hub');
    for (const m of text.matchAll(/"id":"([a-z0-9_-]+?)-\d+"/gi)) addPrefix(m[1], 'a task id in your hub');
  }

  // this machine
  const host = os.hostname().toLowerCase();
  add(host, 'the name of this machine', false);
  add(host.split('.')[0], 'the name of this machine', false);
  add(JOURNAL_NODE, 'the node name of this machine', false);
  addPrefix(JOURNAL_NODE, 'the node name of this machine');
  addPrefix(TASK_ID_PREFIX, 'the task-id prefix of this machine');
  try { add(os.userInfo().username, 'your user name', false); } catch {}
  add(os.homedir(), 'your home directory', false);
  return { words, prefixes, file: userFile };
}

/* The commons' own words: what its instructions, tool descriptions and problems already say, and
 * the prefixes of its task ids. A soft private word found here is let through. */
export function publicWords(texts = [], ids = []) {
  const words = new Set(), prefixes = new Set();
  for (const t of texts) for (const m of String(t ?? '').matchAll(/[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*/gu)) {
    const w = m[0].toLowerCase();
    words.add(w);
    if (w.includes('.')) for (const p of w.split('.')) words.add(p);
  }
  for (const id of ids) { const m = String(id).toLowerCase().match(/^(.+)-\d+(?:\.\d+)?$/); if (m) prefixes.add(m[1]); }
  return { words, prefixes };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* A checker built once from the two: check(text) is null, or { word, source } for the first
 * private name in it. A name matches whole, any case, not inside a longer word. */
export function makeGuard(vocab, pub = publicWords()) {
  const live = [...vocab.words].filter(([w, v]) => !(v.soft && pub.words.has(w))).map(([w]) => w);
  const pre = [...vocab.prefixes.keys()].filter(p => !pub.prefixes.has(p));
  const longest = (a, b) => b.length - a.length;
  const alts = [...pre.sort(longest).map(p => esc(p) + '-\\d+'), ...live.sort(longest).map(esc)];
  const re = alts.length ? new RegExp('(?<![\\p{L}\\p{N}])(?:' + alts.join('|') + ')(?![\\p{L}\\p{N}])', 'iu') : null;
  return (text) => {
    const s = String(text ?? '');
    const shape = leakIn(s);
    if (shape) return { word: null, source: shape };
    const m = re && s.match(re);
    if (!m) return null;
    const w = m[0].toLowerCase();
    if (vocab.words.has(w)) return { word: m[0], source: vocab.words.get(w).source };
    return { word: m[0], source: 'a task id in your hub' };
  };
}

// every string an argument holds, at any depth, with the name of the argument it came in
export function checkArgs(args, check) {
  const walk = (v, key) => {
    if (typeof v === 'string') { const hit = check(v); return hit ? { ...hit, arg: key } : null; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { const hit = walk(x, Array.isArray(v) ? key : k); if (hit) return hit; }
    return null;
  };
  return walk(args || {}, 'arguments');
}

export function refusal(hit, file) {
  if (!hit.word) return `refused here, and nothing was sent: ${hit.arg} carries ${hit.source}, and the commons is public and permanent. Say what you did, never who or where you are.`;
  return `refused here, and nothing was sent: ${hit.arg} carries "${hit.word}", ${hit.source}. The commons is public and permanent: say it without the name. `
    + `If the word gives nothing away after all, a line "-${hit.word.toLowerCase()}" in ${file} lets it through.`;
}

/* The proxy. Notifications stay here (a hubd server answers none of them), so does ping; the rest
 * goes to the commons as it came, once its arguments passed the guard. Tool descriptions are
 * marked public on the way back, so a model choosing between this server and its own hub sees
 * which one publishes. */
export function serveCommonsProxy({ url = process.env.HUBD_COMMONS_URL || COMMONS_URL, key = process.env.HUBD_COMMONS_KEY || COMMONS_KEY,
  hub = HUB, input = process.stdin, output = process.stdout } = {}) {
  const host = hostOf(url) || url;
  const NOTE = `PUBLIC (the commons at ${host}): what you send is public and permanent; your own work goes to your own hub, never here. `;
  const GUARD = 'This connection runs through a local guard: an argument carrying a name from your own hub (a project, node, agent, host or address) is refused before it is sent; say it without the name.';
  let seq = 0;
  const post = async (msg) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(msg), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  // the vocabulary is read again after a while, so a project made today is guarded today
  let vocab = null, vocabAt = 0;
  const vocabulary = () => {
    if (!vocab || Date.now() - vocabAt > 5 * 60000) { vocab = privateVocabulary({ hub, upstream: url }); vocabAt = Date.now(); }
    return vocab;
  };
  // the commons' own texts, read once: what it says, every tool's description, every open problem;
  // read again a minute later if the commons did not answer all of it
  let pub = null, pubAt = 0, learning = null, check = null, checkFor = null;
  const learn = () => {
    if (pub && (pub.ok || Date.now() - pubAt < 60000)) return pub;
    return learning || (learning = fetchPublic().finally(() => { learning = null; }));
  };
  const fetchPublic = async () => {
    let ok = true;
    const ask = async (method, params) => { try { return (await post({ jsonrpc: '2.0', id: 'guard-' + ++seq, method, params })).result; } catch { ok = false; return null; } };
    const init = await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hubd-commons-guard', version: VERSION } });
    const tools = await ask('tools/list', {});
    const tl = await ask('tools/call', { name: 'hub_task_list', arguments: { full: true } });
    let tasks = [];
    try { tasks = JSON.parse(tl.content[0].text).tasks || []; } catch { ok = false; }
    const texts = [init?.instructions, ...(tools?.tools || []).flatMap(t => [t.name, t.description]),
      ...tasks.flatMap(t => [t.text, t.project, ...(t.tags || [])])];
    pub = { ...publicWords(texts, tasks.map(t => t.id)), ok };
    pubAt = Date.now();
    return pub;
  };
  const guard = async () => {
    const v = vocabulary(), p = await learn();
    if (checkFor !== v || check?.pub !== p) { check = makeGuard(v, p); check.pub = p; checkFor = v; }
    return check;
  };

  const handle = async (msg) => {
    const { id, method, params } = msg || {};
    if (String(method).startsWith('notifications/')) return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    try {
      if (params && params.arguments) {
        const hit = checkArgs(params.arguments, await guard());
        if (hit) return method === 'tools/call'
          ? { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + refusal(hit, vocabulary().file) }], isError: true } }
          : { jsonrpc: '2.0', id, error: { code: -32602, message: refusal(hit, vocabulary().file) } };
      }
      const r = await post(msg);
      if (method === 'initialize' && r.result) r.result.instructions = [r.result.instructions, GUARD].filter(Boolean).join(' ');
      if (method === 'tools/list' && r.result && Array.isArray(r.result.tools))
        for (const t of r.result.tools) t.description = NOTE + (t.description || '');
      return r;
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `the commons at ${host} did not answer: ${e.message}` } };
    }
  };

  const out = (obj) => output.write(JSON.stringify(obj) + '\n');
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    if (Array.isArray(msg)) { const rs = (await Promise.all(msg.map(handle))).filter(Boolean); if (rs.length) out(rs); return; }
    const r = await handle(msg);
    if (r) out(r);
  });
  return rl;
}

/* For `hub doctor`: an MCP entry that reaches a commons straight over HTTP, in a client config that
 * also runs a hubd of its own. Such an agent has both, and nothing between them. Read from the
 * Claude Code files (user, every project's local scope, and the project file here); a commons is
 * known by the default host or by "commons" in its key. */
export function directCommons({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const sources = [];
  const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const user = json(path.join(home, '.claude.json'));
  if (user) {
    sources.push({ where: '~/.claude.json', scope: 'user', servers: user.mcpServers || {} });
    for (const [dir, p] of Object.entries(user.projects || {})) if (p && p.mcpServers) sources.push({ where: `~/.claude.json, local to ${dir}`, scope: 'local', servers: p.mcpServers });
  }
  const proj = json(path.join(cwd, '.mcp.json'));
  if (proj) sources.push({ where: path.join(cwd, '.mcp.json'), scope: 'project', servers: proj.mcpServers || {} });
  const commonsHost = hostOf(COMMONS_URL);
  const direct = [], local = [];
  for (const s of sources) for (const [name, e] of Object.entries(s.servers || {})) {
    if (!e || typeof e !== 'object') continue;
    const url = e.url || e.httpUrl || e.serverUrl;
    const auth = Object.entries(e.headers || {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
    if (url && (hostOf(url) === commonsHost || /commons/i.test(String(auth)))) direct.push({ name, where: s.where, scope: s.scope, url });
    const cmd = [e.command, ...(e.args || [])].map(String).join(' ');
    if (!url && /hubd|hub[\\/]index\.mjs/.test(cmd) && !/\bcommons\b/.test(cmd)) local.push({ name, where: s.where });
  }
  return local.length ? direct : [];
}
