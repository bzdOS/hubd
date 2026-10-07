// setup.mjs — `hub setup`: hubd into a harness's config by one command, tried first, read back after.
// claude and gemini are stand-ins here that write their files the way the real ones do, and refuse
// to add a name they already hold, as claude does; HOME is a throwaway folder.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, ok, mktmp, cli, core, done } from './_h.mjs';

const S = await import(path.join(REPO, 'hub/lib/setup.mjs'));
const T = mktmp(), BIN = path.join(T, 'bin'), HOME = path.join(T, 'home'), HUB = path.join(T, 'hub'), WORK = path.join(T, 'work');
const LOG = path.join(T, 'calls.log');
const NOBIN = path.join(T, 'nobin');   // a PATH with no harness on it
for (const d of [BIN, HOME, HUB, WORK, NOBIN]) fs.mkdirSync(d, { recursive: true });

const fake = (name, file) => fs.writeFileSync(path.join(BIN, name), `#!${process.execPath}
const fs = require('fs'), path = require('path'), os = require('os');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, ${JSON.stringify(name)} + ' ' + a.join(' ') + '\\n');
const s = a[a.indexOf(${JSON.stringify(name === 'claude' ? '--scope' : '-s')}) + 1];
const file = ${file};
const conf = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const servers = conf.mcpServers || (conf.mcpServers = {});
if (a[0] === 'mcp' && a[1] === 'remove') {
  const n = a[a.length - 1];
  if (!servers[n]) { console.error('No MCP server named ' + n); process.exit(1); }
  delete servers[n];
} else if (a[0] === 'mcp' && a[1] === 'add') {
  const rest = a.slice(2), env = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--scope' || rest[i] === '-s') i++;
    else if (rest[i] === '-e') { const [k, ...v] = rest[++i].split('='); env[k] = v.join('='); }
    else if (rest[i] !== '--') pos.push(rest[i]);
  }
  const [n, command, ...args] = pos;
  if (${name === 'claude'} && rest[rest.indexOf(n) + 1] !== '-e' && rest[rest.indexOf(n) + 1] !== '--') process.exit(3);
  if (servers[n]) { console.error('MCP server ' + n + ' already exists'); process.exit(1); }
  servers[n] = ${name === 'claude' ? "{ type: 'stdio', command, args, env }" : '{ command, args, env }'};
} else process.exit(2);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(conf, null, 2));
`, { mode: 0o755 });
fake('claude', "s === 'project' ? path.join(process.cwd(), '.mcp.json') : path.join(os.homedir(), '.claude.json')");
fake('gemini', "path.join(s === 'project' ? process.cwd() : os.homedir(), '.gemini', 'settings.json')");

const PATH = BIN + path.delimiter + process.env.PATH;
const ENV = { HOME, PATH, XDG_CONFIG_HOME: undefined, HUBD_DIR: undefined, HUBD_TEAM_DIR: undefined, HUBD_NODE: undefined, HUBD_AGENT: undefined, PROJECT_HUB_DIR: undefined };
const setup = (argv, env = {}) => cli(['setup', ...argv], { env: { ...ENV, ...env }, cwd: WORK });
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const calls = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : [];
const SERVER = { command: process.execPath, args: [path.join(REPO, 'hub/index.mjs')] };
const want = (agent, extra = {}) => ({ ...SERVER, env: { HUBD_AGENT: agent, HUBD_DIR: HUB, HUBD_TEAM_DIR: HUB, ...extra } });
const CLAUDE = path.join(HOME, '.claude.json');

// ── the author is refused at the install, not at the first write
for (const [a, why] of [['dev-<project>', /placeholder/], ['claude', /names a model/], ['dev shop', /space/]]) {
  const r = setup(['--harness', 'opencode', '--agent', a, '--hub', HUB]);
  ok(r.code === 1 && why.test(r.stderr) && !fs.existsSync(path.join(HOME, '.config')), `setup: --agent "${a}" is refused and nothing is written (exit ${r.code})`);
}
{
  const r = setup(['--harness', 'claude'], { HUBD_AGENT: 'dev-env' });
  ok(r.code === 1 && /--agent <name> is required/.test(r.stderr) && /owner's choice/.test(r.stderr), 'setup: without --agent, off a terminal, it refuses, and HUBD_AGENT in the shell is not taken for it');
  const n = setup(['--agent', 'dev-shop']);
  ok(n.code === 1 && /--harness/.test(n.stderr), 'setup: without --harness it names the ones it knows');
  const u = setup(['--harness', 'zed', '--agent', 'dev-shop']);
  ok(u.code === 1 && /claude, gemini, opencode/.test(u.stderr) && /--prompt/.test(u.stderr), 'setup: a harness with no row is refused, and pointed at --prompt');
  const h = setup(['--harness', 'opencode', '--agent', 'dev-shop', '--hub', path.join(T, 'nope')]);
  ok(h.code === 1 && /is not a folder; hub init/.test(h.stderr), 'setup: --hub that is not a folder is refused: a server answers for it all the same, empty');
  const two = setup(['--harness', 'claude', '--agent', 'dev-shop', '--print', '--check']);
  ok(two.code === 1 && /give one/.test(two.stderr), 'setup: two runs at once are refused');
}

// ── claude, through its own command
{
  fs.writeFileSync(CLAUDE, JSON.stringify({ numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'x', args: [], env: {} } } }));
  const orig = fs.readFileSync(CLAUDE, 'utf8');
  const r = setup(['--harness', 'claude', '--agent', 'dev-shop', '--hub', HUB]);
  const e = json(CLAUDE).mcpServers.hubd;
  ok(r.code === 0 && e && e.type === 'stdio' && JSON.stringify({ command: e.command, args: e.args, env: e.env }) === JSON.stringify(want('dev-shop')),
    `setup claude: the entry runs this install by its path, with the author and the hub (exit ${r.code})`);
  ok(calls().join('|') === `claude mcp add --scope user hubd -e HUBD_AGENT=dev-shop -e HUBD_DIR=${HUB} -e HUBD_TEAM_DIR=${HUB} -- ${SERVER.command} ${SERVER.args[0]}`,
    `setup claude: written by claude mcp add, the name before -e (got ${calls()})`);
  ok(/probe: +hubd \S+ answered: (\d+) tools; hub_status: 0 projects/.test(r.stdout) && +r.stdout.match(/answered: (\d+) tools/)[1] > 30,
    'setup claude: the server was tried first, and the line says how many tools it has');
  ok(/agent: +dev-shop/.test(r.stdout) && /connects as dev-shop/.test(r.stdout), 'setup claude: it shows the name the agent will sign with');
  ok(fs.readFileSync(CLAUDE + '.hubd-backup', 'utf8') === orig && json(CLAUDE).numStartups === 7 && json(CLAUDE).mcpServers.other,
    'setup claude: a backup of the file as it was, and the rest of the file kept');

  fs.writeFileSync(LOG, '');
  const again = setup(['--harness', 'claude', '--agent', 'dev-shop', '--hub', HUB]);
  ok(again.code === 0 && /unchanged/.test(again.stdout) && calls().length === 0, 'setup claude again: unchanged, claude not called');

  const other = setup(['--harness', 'claude', '--agent', 'reviewer-shop', '--hub', HUB]);
  ok(other.code === 0 && json(CLAUDE).mcpServers.hubd.env.HUBD_AGENT === 'reviewer-shop' && /changed in/.test(other.stdout) &&
    calls().map(c => c.split(' ').slice(0, 3).join(' ')).join('|') === 'claude mcp remove|claude mcp add',
    'setup claude with another author: the entry is changed, by remove then add, never a second one');
  ok(fs.readFileSync(CLAUDE + '.hubd-backup', 'utf8') === orig, 'setup claude: the backup is still the file from before the first change');

  const chk = setup(['--harness', 'claude', '--check']);
  ok(chk.code === 0 && /parses and holds "hubd"/.test(chk.stdout) && /agent: +reviewer-shop/.test(chk.stdout) && /answered: \d+ tools/.test(chk.stdout),
    'setup --check: the config read back, and the server it names tried');

  fs.writeFileSync(LOG, '');
  const un = setup(['--harness', 'claude', '--uninstall']);
  ok(un.code === 0 && !json(CLAUDE).mcpServers.hubd && json(CLAUDE).mcpServers.other && calls().join('|') === 'claude mcp remove --scope user hubd',
    'setup --uninstall: removed by claude mcp remove, the other server kept');
  const un2 = setup(['--harness', 'claude', '--uninstall']);
  ok(un2.code === 0 && /nothing to remove/.test(un2.stdout), 'setup --uninstall again: nothing to remove, exit 0');
  const none = setup(['--harness', 'claude', '--check']);
  ok(none.code === 1 && /no "hubd" entry/.test(none.stdout), 'setup --check with no entry: exit 1');

  const proj = setup(['--harness', 'claude', '--scope', 'project', '--agent', 'dev-shop', '--hub', HUB]);
  ok(proj.code === 0 && json(path.join(WORK, '.mcp.json')).mcpServers.hubd.env.HUBD_AGENT === 'dev-shop', 'setup claude --scope project: .mcp.json in the folder it was run in');
  const bad = setup(['--harness', 'claude', '--scope', 'local', '--agent', 'dev-shop']);
  ok(bad.code === 1 && /takes user or project/.test(bad.stderr), 'setup: a scope the harness has no row for is refused');

  const noBin = setup(['--harness', 'claude', '--agent', 'dev-x', '--hub', HUB], { PATH: NOBIN });
  ok(noBin.code === 1 && /claude is not on PATH/.test(noBin.stderr) && json(CLAUDE).mcpServers.hubd === undefined,
    'setup claude without claude: refused, and its file is not touched by hand');
}

// ── gemini: its own command when it is there, its file when it is not
{
  const G = path.join(HOME, '.gemini', 'settings.json');
  fs.writeFileSync(LOG, '');
  const r = setup(['--harness', 'gemini', '--agent', 'dev-shop', '--hub', HUB]);
  ok(r.code === 0 && JSON.stringify(json(G).mcpServers.hubd) === JSON.stringify(want('dev-shop')) && /^gemini mcp add -s user -e HUBD_AGENT=dev-shop .* hubd /.test(calls()[0]),
    `setup gemini: by gemini mcp add, into ~/.gemini/settings.json (exit ${r.code}) ${calls()}`);
  fs.rmSync(G);
  fs.writeFileSync(G, JSON.stringify({ theme: 'Dracula' }));
  const f = setup(['--harness', 'gemini', '--agent', 'dev-shop', '--hub', HUB], { PATH: NOBIN });
  ok(f.code === 0 && json(G).theme === 'Dracula' && JSON.stringify(json(G).mcpServers.hubd) === JSON.stringify(want('dev-shop')),
    'setup gemini without gemini on PATH: merged into its file, the rest kept');
}

// ── opencode: a file, merged
{
  const O = path.join(HOME, '.config', 'opencode', 'opencode.json');
  const r = setup(['--harness', 'opencode', '--agent', 'dev-shop', '--hub', HUB]);
  const e = json(O).mcp.hubd;
  ok(r.code === 0 && json(O).$schema === 'https://opencode.ai/config.json' && e.type === 'local' && e.enabled === true &&
    JSON.stringify(e.command) === JSON.stringify([SERVER.command, ...SERVER.args]) && JSON.stringify(e.environment) === JSON.stringify(want('dev-shop').env),
    `setup opencode: a new file with the schema and a local entry (exit ${r.code})`);
  ok(!fs.existsSync(O + '.hubd-backup'), 'setup opencode: no backup of a file that was not there');

  fs.writeFileSync(O, JSON.stringify({ theme: 'tokyonight', mcp: { other: { type: 'remote', url: 'https://x' } } }, null, 2));
  fs.chmodSync(O, 0o600);
  const orig = fs.readFileSync(O, 'utf8');
  const m = setup(['--harness', 'opencode', '--agent', 'dev-shop', '--hub', HUB]);
  ok(m.code === 0 && json(O).theme === 'tokyonight' && json(O).mcp.other.url === 'https://x' && json(O).mcp.hubd && !json(O).$schema,
    'setup opencode: merged into a file that is there, the rest of it kept');
  ok((fs.statSync(O).mode & 0o777) === 0o600 && fs.readFileSync(O + '.hubd-backup', 'utf8') === orig, 'setup opencode: its mode kept, and a backup of it as it was');
  const st = fs.statSync(O).mtimeMs;
  const again = setup(['--harness', 'opencode', '--agent', 'dev-shop', '--hub', HUB]);
  ok(again.code === 0 && /unchanged/.test(again.stdout) && fs.statSync(O).mtimeMs === st, 'setup opencode again: unchanged, the file not rewritten');
  setup(['--harness', 'opencode', '--agent', 'qa-shop', '--hub', HUB]);
  ok(json(O).mcp.hubd.environment.HUBD_AGENT === 'qa-shop' && Object.keys(json(O).mcp).join() === 'other,hubd' && fs.readFileSync(O + '.hubd-backup', 'utf8') === orig,
    'setup opencode with another author: the one entry changed, the first backup kept');
  const un = setup(['--harness', 'opencode', '--uninstall']);
  ok(un.code === 0 && !json(O).mcp.hubd && json(O).mcp.other, 'setup opencode --uninstall: the entry gone, the rest kept');

  // a config kept elsewhere and linked in is changed where it is, and stays a link
  const real = path.join(T, 'dotfiles-opencode.json');
  fs.writeFileSync(real, '{}');
  fs.rmSync(O); fs.symlinkSync(real, O);
  setup(['--harness', 'opencode', '--agent', 'dev-shop', '--hub', HUB]);
  ok(fs.lstatSync(O).isSymbolicLink() && json(real).mcp.hubd, 'setup opencode: a linked config is written through the link');

  const broken = '{ "mcp": { "a": 1 }, }';
  fs.rmSync(O); fs.writeFileSync(O, broken);
  const b = setup(['--harness', 'opencode', '--agent', 'dev-x', '--hub', HUB]);
  ok(b.code === 1 && /does not parse as JSON/.test(b.stderr) && fs.readFileSync(O, 'utf8') === broken, 'setup opencode: a file that does not parse is refused and left as it was');
  const c = setup(['--harness', 'opencode', '--check']);
  ok(c.code === 1 && /does not parse/.test(c.stderr), 'setup --check: a config that does not parse fails the check');
  fs.writeFileSync(O.replace(/\.json$/, '.jsonc'), '{ // mine\n}');
  fs.rmSync(O);
  const j = setup(['--harness', 'opencode', '--agent', 'dev-x', '--hub', HUB]);
  ok(j.code === 1 && /comments/.test(j.stderr) && !fs.existsSync(O), 'setup opencode: next to an opencode.jsonc it writes nothing');
  ok(/"mcp"/.test(setup(['--harness', 'opencode', '--agent', 'dev-x', '--print']).stdout), 'setup opencode --print: the entry, to add by hand');
}

// ── --print, --prompt and --verify write nothing
{
  const H2 = mktmp(), before = fs.readdirSync(H2).length;
  const p = setup(['--harness', 'claude', '--agent', 'dev-api', '--print'], { HOME: H2, HUBD_DIR: HUB });
  ok(p.code === 0 && p.stdout.trim() === `claude mcp add --scope user hubd -e HUBD_AGENT=dev-api -e HUBD_DIR=${HUB} -- ${SERVER.command} ${SERVER.args[0]}`,
    `setup --print: the command, with the HUBD_DIR this shell set (got ${p.stdout.trim()})`);
  const pr = setup(['--harness', 'claude', '--agent', 'dev-api', '--prompt'], { HOME: H2 });
  ok(pr.code === 0 && pr.stdout.includes('claude mcp add --scope user hubd -e HUBD_AGENT=dev-api') && pr.stdout.includes('## Hub protocol (hubd)') &&
    /CLAUDE\.md/.test(pr.stdout) && /Do not change HUBD_AGENT/.test(pr.stdout), 'setup --prompt: the command to run and the CLAUDE.md block');
  const any = setup(['--harness', 'zed', '--agent', 'dev-api', '--prompt'], { HOME: H2 });
  ok(any.code === 0 && /in zed/.test(any.stdout) && /own command for adding an MCP server/.test(any.stdout) && any.stdout.includes('## Coordination via hubd') && /AGENTS\.md/.test(any.stdout),
    'setup --prompt for a harness with no row: what to add and how, and the AGENTS.md block');
  const v = setup(['--harness', 'gemini', '--agent', 'dev-api', '--hub', HUB, '--verify'], { HOME: H2 });
  ok(v.code === 0 && /answered: \d+ tools/.test(v.stdout) && !/config:/.test(v.stdout), 'setup --verify: the server tried, nothing written');
  ok(fs.readdirSync(H2).length === before, 'setup --print, --prompt and --verify: HOME as it was');
  // the hub this shell uses is not the one being set up, and setup writes no hub: no HUBD.md, nothing
  const SH = mktmp();
  setup(['--harness', 'opencode', '--agent', 'dev-api', '--hub', HUB, '--verify'], { HOME: H2, HUBD_DIR: SH });
  ok(fs.readdirSync(SH).length === 0, 'setup: the hub of the shell it runs in is left as it was');
  const init = cli(['init', mktmp()], { env: { HOME: H2 } });
  ok(/^  Or, checked: +hub setup --harness claude\|gemini\|opencode --agent dev-<project>$/m.test(init.stdout), 'init: the next steps name hub setup');
}

// ── the server: this install, else a hubd on PATH outside npx's cache, else npx pinned to this version
{
  const cache = path.join(T, '_npx', 'abc', 'node_modules', '@bzdos', 'hubd');
  ok(S.serverCommand({ root: REPO }).args[0] === path.join(REPO, 'hub/index.mjs'), 'server: a copy outside npx\'s cache runs itself');
  const npx = S.serverCommand({ root: cache, pathEnv: path.join(T, 'empty') });
  ok(npx.command === 'npx' && npx.args.join(' ') === `-y @bzdos/hubd@${core.VERSION}`, `server: from npx with no other copy, npx pinned to this version (got ${npx.args})`);
  const g = path.join(T, 'global'), gb = path.join(T, 'gbin'), cb = path.join(T, 'cbin');
  for (const d of [path.join(g, 'hub'), gb, path.join(cache, 'hub'), cb]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(g, 'hub', 'index.mjs'), ''); fs.writeFileSync(path.join(cache, 'hub', 'index.mjs'), '');
  fs.symlinkSync(path.join(cache, 'hub', 'index.mjs'), path.join(cb, 'hubd'));
  fs.symlinkSync(path.join(g, 'hub', 'index.mjs'), path.join(gb, 'hubd'));
  const glob = S.serverCommand({ root: cache, pathEnv: [cb, gb].join(path.delimiter) });
  ok(glob.args[0] === fs.realpathSync(path.join(g, 'hub', 'index.mjs')), 'server: from npx, the hubd on PATH that is not in the cache');
}
{
  const p = await S.probe({ command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'], env: {} });
  ok(!p.ok && /exited \(3\): boom/.test(p.error), `probe: a server that dies says so, with its last words (got ${p.error})`);
  ok(S.serverEnv({ agent: 'a', hub: null, env: { HUBD_TEAM_DIR: '/t', HUBD_NODE: 'oak', HOME: '/h' } }).HUBD_TEAM_DIR === '/t' &&
    S.serverEnv({ agent: 'a', hub: '/h2', env: { HUBD_DIR: '/x' } }).HUBD_DIR === '/h2', 'env: the hub this shell set goes along; --hub wins over it');
}

done();
