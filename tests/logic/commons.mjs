// commons.mjs — `hubd commons`: the public commons through a guard that knows the private hub.
// What the guard knows, what it lets through, that a refusal sends nothing, and hub doctor's notice.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { REPO, ok, mktmp, cli, freePort, reap, done } from './_h.mjs';

const lib = await import(path.join(REPO, 'hub/lib/commons.mjs'));
const w = (dir, f, text) => { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

// ── a private hub, as it is on disk ──
const P = mktmp();
w(P, 'projects/zebrafish.md', '---\nslug: zebrafish\n---\n# zebrafish\n\n- slug: zebrafish\n- path: /opt/zebra/lab\n');
w(P, 'projects/lattice.md', '# lattice\n');
w(P, 'projects/history.md', '# history\n');
w(P, 'resources/lab-box.md', '---\nkind: resource\naddress: https://ops.zebra-lab.net, 203.0.113.7:22, lab-box:/srv/zebra/data, see run.sh; repo github.com/someone/x\n---\n# lab-box\n');
w(P, 'journal.quokka.jsonl', '{"ts":"2026-10-01 10:00","agent":"zeb-runner","text":"x"}\n{"ts":"2026-10-01 10:01","agent":"claude","text":"y"}\n');
w(P, 'tasks.quokka.events.jsonl', '{"ts":"2026-10-01 10:00","node":"quokka","ev":"add","id":"qkz-12","t":{"id":"qkz-12","by":"ann-on-quokka"}}\n');
w(P, 'private-words', '# mine\nMarmalade Street\n-lattice\n');

const v = lib.privateVocabulary({ hub: P, upstream: 'https://mcp.example.net' });
const has = (x) => v.words.has(x);
ok(has('zebrafish') && has('/opt/zebra/lab'), 'vocabulary: a project and its path');
ok(has('lab-box') && has('ops.zebra-lab.net') && has('203.0.113.7') && has('/srv/zebra/data'), 'vocabulary: a resource, and the host, IP and path in its address');
ok(!has('run.sh') && !has('github.com'), 'vocabulary: a file name and a public host in an address are not private');
ok(has('quokka') && v.prefixes.has('quokka') && v.prefixes.has('qkz'), 'vocabulary: the node from a log name, and task-id prefixes');
ok(has('zeb-runner') && has('ann-on-quokka') && !has('claude'), 'vocabulary: agent names and authors, but not a harness name');
ok(has('marmalade street') && !v.words.get('marmalade street').soft, 'vocabulary: a line in private-words, never let through');
ok(!has('lattice') && has('zebrafish'), 'vocabulary: "-word" in private-words leaves a name out');
ok(!has('history'), 'vocabulary: an everyday word as a project name is left out');

// ── the guard ──
const pub = lib.publicWords(['Find a quokka-free tiling; zebrafish are not involved.'], ['pub-1', 'pub-2']);
const check = lib.makeGuard(v, pub);
const hit = (s) => (check(s) || {}).word || null;
ok(hit('see qkz-12 for details') === 'qkz-12' && hit('qkz') === null, 'guard: a private task id, though its prefix is too short to be a word');
ok(hit('ran by zeb-runner') === 'zeb-runner' && hit('ZEB-RUNNER here') === 'ZEB-RUNNER', 'guard: an agent name, any case');
ok(hit('tried on 203.0.113.7 last night') === '203.0.113.7', 'guard: an address from a card');
ok(hit('we met on Marmalade Street') === 'Marmalade Street', 'guard: a phrase from private-words');
ok(hit('zebrafish') === null, 'guard: an ordinary word the commons already uses goes through');
ok(hit('quokka') === null && hit('quokka-3') === 'quokka-3', 'guard: a node name the commons uses goes through, its task ids do not');
ok(hit('pub-2 builds on pub-1') === null, 'guard: the commons\' own ids go through');
ok(hit('lab-boxes') === null && hit('zeb-runners') === null, 'guard: a name inside a longer word is not a hit');
ok((check('write to me@example.org') || {}).source === 'an email address', 'guard: the server\'s shapes are checked here too');
const nested = lib.checkArgs({ by: 'ann', artifacts: ['https://e.org/x', 'notes from zeb-runner'] }, check);
ok(nested && nested.arg === 'artifacts' && nested.word === 'zeb-runner', 'guard: every string at any depth, named by its argument');

// ── the proxy against a commons: what reaches the server ──
const C = mktmp();
const KEY = 'commons-public-key-0001';
const port = await freePort(), tapPort = await freePort();
const srvEnv = { ...process.env, HUBD_DIR: C, HUBD_TEAM_DIR: C, HUBD_MULTITENANT: '1', HUBD_COMMONS: KEY, HUBD_NODE: 'pub' };
delete srvEnv.HUBD_AGENT; delete srvEnv.HUBD_TOOLS;
const srv = reap(spawn(process.execPath, [path.join(REPO, 'hub/index.mjs'), '--http', String(port)], { env: srvEnv, stdio: ['ignore', 'ignore', 'pipe'] }));
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('http server did not start')), 8000);
  srv.stderr.on('data', (d) => { if (String(d).includes('serving MCP over HTTP')) { clearTimeout(to); resolve(); } });
});
const rpc = async (method, params) => (await (await fetch(`http://127.0.0.1:${port}/`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const seeded = JSON.parse((await rpc('tools/call', { name: 'hub_task_add', arguments: { project: 'tilings', text: 'Tile the plane; zebrafish welcome.', by: 'seed' } })).content[0].text).id;

// everything the proxy sends passes a tap that keeps a copy
const sent = [];
const tap = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    sent.push(body);
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers.authorization }, body });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(await r.text());
  });
});
await new Promise((resolve) => tap.listen(tapPort, '127.0.0.1', resolve));

// what the private hub holds, name, size and time, to show the proxy left it as it was
const tree = (d) => fs.readdirSync(d, { recursive: true }).sort().map(f => { const st = fs.statSync(path.join(d, f)); return `${f} ${st.size} ${st.mtimeMs}`; }).join('\n');
const hubBefore = tree(P);
const proxy = reap(spawn(process.execPath, [path.join(REPO, 'hub/index.mjs'), 'commons', '--url', `http://127.0.0.1:${tapPort}/`, '--key', KEY],
  { env: { ...process.env, HUBD_DIR: P, HUBD_TEAM_DIR: P }, stdio: ['pipe', 'pipe', 'pipe'] }));
const waiting = new Map();
readline.createInterface({ input: proxy.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise((resolve, reject) => {
  const id = ++n, to = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000);
  waiting.set(id, (m) => { clearTimeout(to); resolve(m); });
  proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => { const r = (await ask('tools/call', { name, arguments: args })).result; return { err: r.isError, text: r.content[0].text }; };

const init = await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
ok(/public board of unsolved problems/.test(init.result.instructions) && /local guard/.test(init.result.instructions), 'proxy: the commons\' instructions, and a line on the guard');
const tools = (await ask('tools/list', {})).result.tools;
ok(tools.length > 5 && tools.every(t => t.description.startsWith('PUBLIC (the commons at 127.0.0.1)')), 'proxy: every tool is marked public');

const listed = await call('hub_task_list', {});   // the first call: the guard reads the commons' own words
ok(!listed.err && /Tile the plane/.test(listed.text), 'proxy: a clean read goes through');
const before = sent.length;
const bad = await call('hub_attempt', { task: seeded, outcome: 'dead', lens: 'greedy', tried: 'ran it as in qkz-12', why: 'stalls', by: 'ann' });
ok(bad.err && /refused here, and nothing was sent/.test(bad.text) && /"qkz-12", a task id in your hub/.test(bad.text), 'proxy: a write with a private task id is refused, and says which');
const badBy = await call('hub_attempt', { task: seeded, outcome: 'dead', lens: 'greedy', tried: 'ran it', why: 'stalls', by: 'zeb-runner' });
ok(badBy.err && /zeb-runner/.test(badBy.text), 'proxy: an agent name as the handle is refused');
const search = await call('hub_search', { query: 'marmalade street' });
ok(search.err && /private-words/.test(search.text), 'proxy: a read is checked too, a search included');
ok(sent.length === before && !sent.some(b => /qkz-12|zeb-runner|marmalade/i.test(b)), 'proxy: nothing of the refused calls reached the server');

const good = await call('hub_attempt', { task: seeded, outcome: 'lead', lens: 'zebrafish tiles', tried: 'tiled a 9x9 patch', next: 'go to 20x20', by: 'ann' });
ok(!good.err && JSON.parse(good.text).id === `${seeded}.1`, 'proxy: a clean attempt goes through, with a word the commons already uses');
const got = await call('hub_task_get', { id: seeded });
ok(!got.err && !/_origin/.test(got.text) && JSON.parse(got.text).attempts.length === 1, 'proxy: the thread reads back, with no _origin from the server');
ok((await ask('ping', {})).result && (await ask('prompts/list', {})).result, 'proxy: ping answered here, the rest forwarded');

// the server alone, without the proxy: a commons answer carries no _origin, and no file of the server
const direct = (await rpc('tools/call', { name: 'hub_task_get', arguments: { id: seeded } })).content[0].text;
ok(!/_origin/.test(direct), 'server: a commons answer carries no _origin');
const who = { agent: 'ann', by: 'ann', project: 'tilings', task: seeded };
const every = {
  hub_onboarding: {}, hub_status: {}, hub_get: { project: 'tilings' }, hub_search: { query: 'plane' }, hub_kanban: {},
  hub_whatsnew: who, hub_task_list: {}, hub_task_get: { id: seeded }, hub_task_add: { project: 'tilings', text: 'Another one.', by: 'ann' },
  hub_attempt: { task: seeded, outcome: 'dead', lens: 'brute force', tried: 'all 4x4', why: 'none tile', by: 'ann' },
  hub_claim: { ...who, ttlMin: 5 }, hub_heartbeat: who, hub_presence: {}, hub_release: who,
};
const serverDir = [C, fs.realpathSync(C)];
const leaky = [];
for (const [name, args] of Object.entries(every)) {
  const text = (await rpc('tools/call', { name, arguments: args })).content[0].text;
  if (serverDir.some(d => text.includes(d))) leaky.push(name);
}
const wrong = (await rpc('tools/call', { name: 'hub_get', arguments: { project: 'nope' } })).content[0].text;
ok(Object.keys(every).length === 14 && !leaky.length && !serverDir.some(d => wrong.includes(d)),
  `server: none of the commons tools answers with a path of the server, an error included (leaky: ${leaky.join(', ') || 'none'})`);
proxy.stdin.end(); tap.close(); srv.kill();
await new Promise((resolve) => proxy.exitCode !== null ? resolve() : proxy.on('exit', resolve));
ok(tree(P) === hubBefore, 'proxy: the private hub is left as it was, HUBD.md included');

// ── hub doctor: a client with both, and nothing between them ──
const HOME = mktmp(), CWD = mktmp();
const local = { type: 'stdio', command: 'npx', args: ['-y', '@bzdos/hubd'] };
const commonsHttp = { type: 'http', url: 'https://mcp.hubd.net', headers: { Authorization: 'Bearer hubd-commons-public' } };
const conf = (servers, projects) => fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: servers, projects }));
conf({ hubd: local, 'hubd-commons': commonsHttp });
ok(lib.directCommons({ home: HOME, cwd: CWD }).length === 1, 'doctor: a direct commons beside a hubd is found');
conf({ 'hubd-commons': commonsHttp });
ok(lib.directCommons({ home: HOME, cwd: CWD }).length === 0, 'doctor: a direct commons alone is not (there is no hub to leak)');
conf({ hubd: local, 'hubd-commons': { type: 'stdio', command: 'npx', args: ['-y', '@bzdos/hubd', 'commons'] } });
ok(lib.directCommons({ home: HOME, cwd: CWD }).length === 0, 'doctor: the guarded proxy is not a direct connection');
conf({ hubd: local }, { [CWD]: { mcpServers: { pub: { type: 'http', url: 'https://example.net/mcp', headers: { authorization: 'Bearer my-commons-key-0001' } } } } });
const found = lib.directCommons({ home: HOME, cwd: CWD });
ok(found.length === 1 && found[0].scope === 'local', 'doctor: a commons of its own, by its key, in a project\'s local scope');
const d = cli(['doctor'], { env: { HOME, HUBD_DIR: P, HUBD_TEAM_DIR: P }, cwd: CWD });
ok(/client entry reaches the public commons directly/.test(d.out) && /claude mcp add -s local pub -- npx -y @bzdos\/hubd commons/.test(d.out),
  'doctor: prints the entry and the command that puts the guard in front');

done();
