// setup.mjs — `hub setup`: hubd put into a harness's MCP config by one command, and checked there.
//
// Until it the first contact was a config edit by hand: `claude mcp add` for Claude Code, a JSON
// block for opencode, another for Gemini CLI, each with the author and the hub's folders typed into
// it. MCP cannot do it: until hubd is in the config there is no MCP to ask. So it is a CLI, and the
// harnesses it knows are a table here. A harness with a command of its own for adding a server is
// configured through that command, which outlives a change of the harness's file format; one
// without is a JSON file merged here, with a backup made before the first change.
//
// The server is tried before anything is written: a config that names a server which does not
// answer costs a restart to find out. And the entry is read back after: the harness's command
// reporting success is not the same as its file holding the entry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, requireAuthor } from './core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NAME = 'hubd';

const envArgs = (flag, env) => Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);

/* One row per harness: where its config lives at each scope, which object in that file holds the
 * servers by name, how hubd's entry looks there and back, and, when it has them, its own commands
 * for adding and removing a server. */
export const HARNESSES = {
  claude: {
    label: 'Claude Code', bin: 'claude', scopes: ['user', 'project'],
    file: (scope, cwd) => scope === 'project' ? path.join(cwd, '.mcp.json') : path.join(os.homedir(), '.claude.json'),
    servers: 'mcpServers',
    entry: (s) => ({ type: 'stdio', command: s.command, args: s.args, env: s.env }),
    spec: (e) => ({ command: e.command, args: e.args || [], env: e.env || {} }),
    // -e takes several values, so the name goes before it, and `--` ends them
    add: (scope, s) => ['mcp', 'add', '--scope', scope, NAME, ...envArgs('-e', s.env), '--', s.command, ...s.args],
    remove: (scope) => ['mcp', 'remove', '--scope', scope, NAME],
    // ~/.claude.json is Claude Code's own state as well as its config: only claude writes it
    nativeOnly: true,
    restart: 'start a new Claude Code session: one already running keeps the servers it started with',
    rules: ['claude-code.md', 'CLAUDE.md'],
  },
  gemini: {
    label: 'Gemini CLI', bin: 'gemini', scopes: ['user', 'project'],
    file: (scope, cwd) => path.join(scope === 'project' ? cwd : os.homedir(), '.gemini', 'settings.json'),
    servers: 'mcpServers',
    entry: (s) => ({ command: s.command, args: s.args, env: s.env }),
    spec: (e) => ({ command: e.command, args: e.args || [], env: e.env || {} }),
    add: (scope, s) => ['mcp', 'add', '-s', scope, ...envArgs('-e', s.env), NAME, s.command, ...s.args],
    remove: (scope) => ['mcp', 'remove', '-s', scope, NAME],
    restart: 'restart gemini',
    rules: ['agents-md.md', 'GEMINI.md'],
  },
  opencode: {
    label: 'opencode', scopes: ['user', 'project'],
    file: (scope, cwd) => scope === 'project' ? path.join(cwd, 'opencode.json')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json'),
    servers: 'mcp',
    fresh: { $schema: 'https://opencode.ai/config.json' },
    entry: (s) => ({ type: 'local', command: [s.command, ...s.args], enabled: true, environment: s.env }),
    spec: (e) => ({ command: (e.command || [])[0], args: (e.command || []).slice(1), env: e.environment || {} }),
    restart: 'restart opencode',
    rules: ['agents-md.md', 'AGENTS.md'],
  },
  // oh-my-pi adds a server only from inside a session (/mcp add), so its file is merged here
  omp: {
    label: 'oh-my-pi', scopes: ['user', 'project'],
    file: (scope, cwd) => path.join(scope === 'project' ? path.join(cwd, '.omp') : ompAgentDir(), 'mcp.json'),
    servers: 'mcpServers',
    fresh: { $schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json' },
    entry: (s) => ({ type: 'stdio', command: s.command, args: s.args, env: s.env }),
    spec: (e) => ({ command: e.command, args: e.args || [], env: e.env || {} }),
    restart: 'run /mcp reload in an omp session that is running, or start a new one',
    rules: ['agents-md.md', 'AGENTS.md'],
  },
};

/* The folder omp reads its user config from, found as omp finds it: a named profile (OMP_PROFILE,
 * else PI_PROFILE) has one of its own, and PI_CODING_AGENT_DIR moves only the default profile's.
 * Written anywhere else, the entry would sit in a file this omp never opens. */
function ompAgentDir(env = process.env) {
  const base = path.join(os.homedir(), env.PI_CONFIG_DIR || '.omp');
  const profile = String((env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE) || '').trim();
  if (profile && profile !== 'default') return path.join(base, 'profiles', profile, 'agent');
  return env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(base, 'agent');
}

/* What the harness runs. A copy of hubd that is on this machine starts in a fraction of the time
 * npx takes to ask the registry, and the harness starts it every session, so a local one is written
 * by its path: this one, unless it sits in npx's cache (`npx -p @bzdos/hubd hub setup`), which is
 * cleaned without asking; else a `hubd` on PATH outside that cache. With neither, npx with this
 * version pinned: an unpinned one would run whatever was published last, on the next session. */
export function serverCommand({ root = ROOT, pathEnv = process.env.PATH, node = process.execPath } = {}) {
  const cached = (p) => p.split(path.sep).includes('_npx');
  const self = path.join(root, 'hub', 'index.mjs');
  if (!cached(self)) return { command: node, args: [self], via: 'this install' };
  for (const d of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    let real;
    try { real = fs.realpathSync(path.join(d, NAME)); } catch { continue; }
    if (real.endsWith('.mjs') && !cached(real)) return { command: node, args: [real], via: 'the hubd on PATH' };
  }
  return { command: 'npx', args: ['-y', `@bzdos/hubd@${VERSION}`], via: 'npx, this version' };
}

/* The author, and the hub this shell uses. --hub names one folder for the base and the team, as
 * HUBD_TEAM_DIR alone would; without it the variables set here go along, as `hub init` prints them:
 * without them the agent would connect to ~/.hubd, not to the hub this shell works in. */
export function serverEnv({ agent, hub, env = process.env }) {
  const out = { HUBD_AGENT: agent };
  if (hub) { out.HUBD_DIR = hub; out.HUBD_TEAM_DIR = hub; }
  for (const k of ['HUBD_DIR', 'HUBD_TEAM_DIR', 'HUBD_NODE']) if (!out[k] && env[k]) out[k] = env[k];
  return out;
}

/* Refused here rather than at the first write, a day later, in a session that cannot fix it: a
 * model's name and an empty one, as every write refuses them, and also what a pasted line still
 * holds when its placeholder was not filled in (`dev-<project>`). */
export function checkAgent(v) {
  const a = requireAuthor(v);
  if (/[<>{}\s]|^-/.test(a)) throw new Error(`agent "${a}" is a placeholder, or has a space in it: give the name itself, e.g. dev-shop`);
  return a;
}

const q = (v) => /^[\w@%+=:,./-]+$/.test(v) ? v : "'" + String(v).replace(/'/g, "'\\''") + "'";
const sorted = (o) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, String(o[k])]));
const sameSpec = (a, b) => !!a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && sorted(a.env) === sorted(b.env);

function which(bin, pathEnv = process.env.PATH) {
  for (const d of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try { return text.trim() ? JSON.parse(text) : {}; }
  catch (e) { throw new Error(`${file} does not parse as JSON (${e.message}). hub setup changes only a file it can read whole; hub setup --print shows the entry to add by hand`); }
}

/* opencode also reads opencode.jsonc, and a file with comments in it is not one to rewrite: the
 * comments would go. Such a config gets the entry printed, to add by hand. */
function configFile(h, scope, cwd) {
  const file = h.file(scope, cwd);
  if (h.servers === 'mcp' && fs.existsSync(file.replace(/\.json$/, '.jsonc')))
    throw new Error(`${file.replace(/\.json$/, '.jsonc')} is there, and a file with comments is not one hub setup rewrites; hub setup --print shows the entry to add to it`);
  return file;
}

function readEntry(h, scope, cwd) {
  const file = configFile(h, scope, cwd);
  const conf = readConfig(file);
  const e = conf && conf[h.servers] && conf[h.servers][NAME];
  return { file, conf, entry: e || null, spec: e ? h.spec(e) : null };
}

// A copy of the file as it was before hub setup first changed it; a later run keeps that one.
function backup(file) {
  const b = file + '.hubd-backup';
  if (!fs.existsSync(file) || fs.existsSync(b)) return null;
  fs.copyFileSync(file, b);
  return b;
}

// Written whole or not at all, through a symlink to where the file really is, with its mode kept.
function writeConfig(file, conf) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const mode = fs.existsSync(real) ? fs.statSync(real).mode & 0o777 : 0o644;
  const tmp = real + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n');
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, real);
}

function runNative(h, argv, cwd) {
  const r = spawnSync(h.bin, argv, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const why = (r.error ? r.error.message : (r.stderr || r.stdout || '')).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${h.bin} ${argv.slice(0, 2).join(' ')} failed (exit ${r.status ?? '-'}): ${why}`);
  }
}

/* The server started as the harness will start it, with none of this shell's HUBD_* variables, and
 * asked what a session asks first: initialize, tools/list, hub_status, which only reads. It runs
 * as one session, hub-setup, so the hub keeps one record of the probes, not one per run. */
export function probe(s, { timeoutMs = s.command === 'npx' ? 180000 : 30000 } = {}) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HUBD_') && k !== 'PROJECT_HUB_DIR'));
    let child, buf = '', err = '', settled = false, version = '', tools = 0;
    const tail = () => err.trim() ? ': ' + err.trim().split('\n').slice(-2).join(' | ') : '';
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer in ${timeoutMs / 1000}s` + tail() }), timeoutMs);
    try { child = spawn(s.command, s.args, { env: { ...env, ...s.env, HUBD_SESSION: 'hub-setup' }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: e.message }); }
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    // close, not exit: by then its stderr has been read to the end, and the reason is in it
    child.on('close', (code) => finish({ ok: false, error: `the server exited (${code ?? 'signal'})` + tail() }));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.error) return finish({ ok: false, error: m.error.message || JSON.stringify(m.error) });
        if (m.id === 1) {
          version = (m.result && m.result.serverInfo && m.result.serverInfo.version) || '';
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list' });
        } else if (m.id === 2) {
          tools = ((m.result && m.result.tools) || []).length;
          send({ id: 3, method: 'tools/call', params: { name: 'hub_status', arguments: {} } });
        } else if (m.id === 3) {
          const r = m.result || {};
          const text = ((r.content || [])[0] || {}).text || '';
          let projects = null;
          try { projects = JSON.parse(text).projects.length; } catch {}
          finish(r.isError || projects === null ? { ok: false, version, tools, error: 'hub_status: ' + text.slice(0, 200) } : { ok: true, version, tools, projects });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hub-setup', version: VERSION } } });
  });
}

// An empty hub answers as a full one does, so the line says how many projects it holds.
const probeLine = (p) => p.ok
  ? `  probe:   hubd ${p.version} answered: ${p.tools} tools; hub_status: ${p.projects} project${p.projects === 1 ? '' : 's'}`
  : `  probe:   FAILED, ${p.error}`;

// The block a client's rules file gets, as prompts/<client>.md holds it.
export function rulesBlock(file) {
  const src = fs.readFileSync(path.join(ROOT, 'prompts', file), 'utf8');
  const m = src.match(/^```markdown\n([\s\S]*?)^```/m);
  return m ? m[1].trimEnd() : '';
}

/* For a harness hub setup has no row for, or an agent asked to do it from inside one: what to
 * add, where, and how to tell it worked. Not the main path, since a model editing a config is
 * neither repeatable nor tested, but the only one for a harness nobody has written a row for. */
export function bootstrapPrompt({ harness, scope, spec }) {
  const h = HARNESSES[harness];
  const label = h ? h.label : harness;
  const [prompt, rules] = h ? h.rules : ['agents-md.md', 'AGENTS.md'];
  const env = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join(', ');
  const how = h && h.add
    ? [`   ${label} has a command for it; run it as it is:`, `     ${h.bin} ${h.add(scope, spec).map(q).join(' ')}`]
    : h
      ? [`   In ${h.file(scope, '<project folder>')}, under "${h.servers}", it is:`,
         ...JSON.stringify({ [NAME]: h.entry(spec) }, null, 2).split('\n').map(l => '     ' + l)]
      : [`   Use ${label}'s own command for adding an MCP server if it has one. If it has none,`,
         '   edit its config file: copy the file first, and leave the rest of it as it is.'];
  return [
    `Set up the hubd MCP server in ${label} and check that it answers.`,
    '',
    `1. Add a stdio MCP server named "${NAME}" to ${label}'s config, at ${scope} scope:`,
    `     command: ${spec.command}`,
    `     args:    ${JSON.stringify(spec.args)}`,
    `     env:     ${env}`,
    ...how,
    `   If a server named "${NAME}" is there already, change that one; do not add a second.`,
    `2. Do not change HUBD_AGENT: it is the name this agent signs its work with, and the owner chose it.`,
    `3. Tell me to restart ${label}. After the restart call the hub_status tool: it answers with the hub's projects.`,
    `4. Add this block to ${rules} in the project folder:`,
    '',
    rulesBlock(prompt),
    '',
  ].join('\n');
}

/* The command. `mode` is install (the default), print, prompt, verify, check or uninstall. Returns
 * the exit code; a refusal is thrown, as the engine's are. */
export async function runSetup({ harness, agent, scope = 'user', hub = null, mode = 'install', cwd = process.cwd() }, log = console.log) {
  const known = Object.keys(HARNESSES).join(', ');
  const h = HARNESSES[harness];
  if (!h && mode !== 'prompt')
    throw new Error(`no harness "${harness}" here; hub setup knows ${known}. For another one, hub setup --harness ${harness} --agent <name> --prompt prints what an agent in it should do`);
  if (h && !h.scopes.includes(scope)) throw new Error(`--scope ${scope}: ${h.label} takes ${h.scopes.join(' or ')}`);

  if (mode === 'check' || mode === 'uninstall') return mode === 'check' ? check(h, scope, cwd, log) : uninstall(h, scope, cwd, log);

  agent = checkAgent(agent);
  // the hub is scaffolded first: a server pointed at a folder that is not there answers all the same, empty
  if (hub && !(fs.existsSync(hub) && fs.statSync(hub).isDirectory())) throw new Error(`--hub ${hub} is not a folder; hub init ${q(hub)} makes one`);
  const s = { ...serverCommand(), env: serverEnv({ agent, hub }) };
  const spec = { command: s.command, args: s.args, env: s.env };
  if (mode === 'prompt') { log(bootstrapPrompt({ harness, scope, spec })); return 0; }
  if (mode === 'print') {
    if (h.add) log(`${h.bin} ${h.add(scope, spec).map(q).join(' ')}`);
    else log(`# in ${h.file(scope, cwd)}, under "${h.servers}":\n` + JSON.stringify({ [h.servers]: { [NAME]: h.entry(spec) } }, null, 2));
    return 0;
  }

  const viaNative = !!(h.add && which(h.bin));
  if (h.nativeOnly && !viaNative) throw new Error(`${h.bin} is not on PATH. Install ${h.label} first, or run what hub setup --harness ${harness} --print shows`);
  log(`hub setup: ${h.label}, ${scope} scope`);
  log(`  agent:   ${agent}   (every record this agent writes is signed with it)`);
  log(`  server:  ${[spec.command, ...spec.args].map(q).join(' ')}   (${s.via})`);
  log(`  env:     ${Object.entries(spec.env).map(([k, v]) => q(`${k}=${v}`)).join(' ')}`);
  const p = await probe(spec);
  log(probeLine(p));
  if (!p.ok) { log('Nothing was written: the server has to answer first.'); return 1; }
  if (mode === 'verify') return 0;

  const before = readEntry(h, scope, cwd);
  if (sameSpec(before.spec, spec)) {
    log(`  config:  already in ${before.file}, unchanged`);
  } else {
    const saved = backup(before.file);
    if (viaNative) {
      if (before.entry) runNative(h, h.remove(scope), cwd);
      runNative(h, h.add(scope, spec), cwd);
    } else {
      const conf = before.conf || { ...(h.fresh || {}) };
      conf[h.servers] = { ...(conf[h.servers] || {}), [NAME]: h.entry(spec) };
      writeConfig(before.file, conf);
    }
    log(`  config:  ${before.entry ? 'changed in' : 'added to'} ${before.file}` + (viaNative ? ` (${h.bin} mcp ${before.entry ? 'remove, add' : 'add'})` : ''));
    if (saved) log(`  backup:  ${saved}`);
    const after = readEntry(h, scope, cwd);
    if (!sameSpec(after.spec, spec)) {
      log(`  readback: FAILED, ${after.file} does not hold the entry that was written`);
      return 1;
    }
  }
  log(`Next: ${h.restart}. It connects as ${agent}.`);
  return 0;
}

async function check(h, scope, cwd, log) {
  const { file, entry, spec } = readEntry(h, scope, cwd);
  if (!entry) { log(`no "${NAME}" entry in ${file}; hub setup --harness <id> --agent <name> adds one`); return 1; }
  log(`${h.label}, ${scope} scope: ${file} parses and holds "${NAME}"`);
  log(`  agent:   ${spec.env.HUBD_AGENT || '(none: every write will be refused)'}`);
  log(`  server:  ${[spec.command, ...spec.args].map(q).join(' ')}`);
  const p = await probe(spec);
  log(probeLine(p));
  return p.ok && spec.env.HUBD_AGENT ? 0 : 1;
}

function uninstall(h, scope, cwd, log) {
  const before = readEntry(h, scope, cwd);
  if (!before.entry) { log(`no "${NAME}" entry in ${before.file}; nothing to remove`); return 0; }
  const viaNative = !!(h.remove && which(h.bin));
  if (h.nativeOnly && !viaNative) throw new Error(`${h.bin} is not on PATH, and only it changes ${before.file}`);
  const saved = backup(before.file);
  if (viaNative) runNative(h, h.remove(scope), cwd);
  else {
    delete before.conf[h.servers][NAME];
    writeConfig(before.file, before.conf);
  }
  if (readEntry(h, scope, cwd).entry) { log(`still in ${before.file} after the removal`); return 1; }
  log(`removed "${NAME}" from ${before.file}` + (saved ? `; backup: ${saved}` : ''));
  return 0;
}
