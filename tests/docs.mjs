// docs.mjs — the examples in docs/start and docs/scenarios, run as the pages show them, and what
// they print compared with the output the pages show.
//
//   node tests/docs.mjs                # the tutorials as one run, then each scenario
//   node tests/docs.mjs start 03 08    # the tutorials, and scenarios 3 and 8
//   node tests/docs.mjs 03 --write     # put what the run printed into each output block that differs
//   node tests/docs.mjs 03 --keep      # leave the run's /tmp/hub-* folders for a look
//   node tests/docs.mjs 03 --log F     # and the whole run's output in F
//
// A scenario is one run: its `bash` blocks, in order, in one shell. The seven tutorials are one run
// too, since each continues the last. A `text` block right after a bash block is what that block
// must print. An `sh` block is for a real machine and is not run. A `json` block is what an MCP tool
// answered; the ones tests/docs-mcp.json lists are called at that point, as the agent named there.
//
// Before the two sides are compared, what differs from one run to the next is masked on both:
// times and dates, ages in minutes, uuids, commit hashes, version numbers, the width of aligned
// columns, blank lines before and after. A line that is only `…` stands for lines the page leaves
// out, and a line that ends in `…` for any line it begins. A json block need only hold its own
// fields, with their values, somewhere in the answer.
//
// Not in npm test: the pages write to fixed folders under /tmp, start servers on fixed ports, and
// use curl, jq, python3, openssl and uuidgen. Here `hub` and `hubd` are this checkout's,
// `npm root -g` finds this checkout, `claude` is a stand-in that does nothing, HOME is a throwaway
// folder, and TZ is UTC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');

if (process.argv[2] === '--mcp') await mcp(JSON.parse(process.argv[3]));

// ── --mcp '<calls>': the calls of one json block, made to this checkout's MCP server over stdio with
// the run's environment, each answer printed as the agent gets it. Exit 1 if a call failed.
async function mcp(calls) {
  const server = spawn(process.execPath, [path.join(REPO, 'hub/index.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  readline.createInterface({ input: server.stdout }).on('line', (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  server.on('exit', () => { for (const done of pending.values()) done({ error: { message: 'the server exited' } }); pending.clear(); });
  let n = 0;
  const ask = (method, params) => new Promise((resolve) => {
    pending.set(++n, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'docs.mjs', version: '0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  let failed = false;
  for (const [name, args] of calls) {
    const r = await ask('tools/call', { name, arguments: args });
    const res = r.result || {};
    if (r.error || res.isError) failed = true;
    console.log(`--> ${name} ${JSON.stringify(args)}`);
    console.log(r.error ? 'ERROR ' + r.error.message : (res.isError ? 'ERROR ' : '') + (res.content || []).map((c) => c.text).join('\n'));
  }
  server.stdin.end();
  server.kill();
  process.exit(failed ? 1 : 0);
}

// ── the pages
const SIDECAR = 'tests/docs-mcp.json';
const CALLS = JSON.parse(fs.readFileSync(path.join(REPO, SIDECAR), 'utf8'));

// Each fenced block of a page: its language, its body, where the body starts and ends in the
// page, and the line of its opening fence.
function parse(page) {
  const src = fs.readFileSync(path.join(REPO, page), 'utf8');
  const blocks = [];
  for (const m of src.matchAll(/^```(\w*)\n([\s\S]*?)^```[ \t]*$/gm)) {
    const start = m.index + 4 + m[1].length;
    blocks.push({ lang: m[1], body: m[2], start, end: start + m[2].length, line: src.slice(0, m.index).split('\n').length });
  }
  return { src, blocks };
}

const numbered = (dir) => fs.readdirSync(path.join(REPO, dir)).filter((f) => /^\d+-.*\.md$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map((f) => `${dir}/${f}`);
const UNITS = [
  { name: 'start', pages: numbered('docs/start') },
  ...numbered('docs/scenarios').map((p) => ({ name: path.basename(p, '.md'), pages: [p] })),
];

const args = process.argv.slice(2);
const WRITE = args.includes('--write'), KEEP = args.includes('--keep');
const LOG = args.includes('--log') ? path.resolve(args[args.indexOf('--log') + 1] || 'docs.log') : null;
const want = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--log');
const todo = want.length ? UNITS.filter((u) => want.some((w) => u.name === w || u.name.startsWith(w + '-'))) : UNITS;
if (!todo.length || want.some((w) => !UNITS.some((u) => u.name === w || u.name.startsWith(w + '-')))) {
  console.error(`docs: no such run in ${want.join(' ')}; runs: ${UNITS.map((u) => u.name).join(' ')}`);
  process.exit(2);
}
for (const page of Object.keys(CALLS)) {
  const json = fs.existsSync(path.join(REPO, page)) ? parse(page).blocks.filter((b) => b.lang === 'json').length : 0;
  const bad = Object.keys(CALLS[page]).filter((k) => !(k >= 1 && k <= json));
  if (bad.length) { console.error(`docs: ${SIDECAR} names json block ${bad.join(', ')} of ${page}, which has ${json}`); process.exit(2); }
}

// ── the stand-ins, and the environment every run starts from
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hubd-docs-'));
const BIN = path.join(TMP, 'bin'), HOME = path.join(TMP, 'home'), GLOBAL = path.join(TMP, 'lib/node_modules');
for (const d of [BIN, HOME, path.join(GLOBAL, '@bzdos')]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(REPO, path.join(GLOBAL, '@bzdos/hubd'));
const stub = (name, body) => fs.writeFileSync(path.join(BIN, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
stub('hub', `exec "${process.execPath}" "${REPO}/hub/hub.mjs" "$@"`);
stub('hubd', `exec "${process.execPath}" "${REPO}/hub/index.mjs" "$@"`);
stub('npm', `case "$*" in\n  "root -g") echo "${GLOBAL}" ;;\n  "i -g @bzdos/hubd"|"install -g @bzdos/hubd") ;;\n  *) echo "docs: not run here: npm $*" >&2; exit 1 ;;\nesac`);
stub('claude', ':');
stub('codex', ':');
const ENV = {
  ...process.env, PATH: BIN + path.delimiter + process.env.PATH, HOME, TZ: 'UTC',
  GIT_AUTHOR_NAME: 'oak', GIT_AUTHOR_EMAIL: 'oak@example.com', GIT_COMMITTER_NAME: 'oak', GIT_COMMITTER_EMAIL: 'oak@example.com',
};
for (const k of Object.keys(ENV)) if (k.startsWith('HUBD_') || k === 'PROJECT_HUB_DIR') delete ENV[k];
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// ── one run: a shell script of the unit's blocks, with a marker before each
const q = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const marker = (key) => `printf '\\n@@docs %s\\n' ${q(key)}`;

function script(unit) {
  const sh = ['exec 2>&1'];
  for (const page of unit.pages) {
    let json = 0;
    for (const b of parse(page).blocks) {
      if (b.lang === 'json') {
        const c = (CALLS[page] || {})[++json];
        if (c) sh.push(marker(`${page}:${b.line}`), `HUBD_AGENT=${q(c.agent)} ${q(process.execPath)} ${q(SELF)} --mcp ${q(JSON.stringify(c.calls))}`);
      }
      if (b.lang !== 'bash') continue;
      sh.push(marker(`${page}:${b.line}`));
      for (const line of b.body.replace(/\n$/, '').split('\n')) {
        sh.push(line);
        // a server started in the background: a reader waits for it without noticing, a script must
        const port = /\b(\d{4,5}) &$/.exec(line);
        if (port) sh.push(`for i in $(seq 50); do (: < /dev/tcp/127.0.0.1/${port[1]}) 2>/dev/null && break; sleep 0.1; done`);
      }
    }
  }
  sh.push(marker('end'), 'kill $(jobs -p) 2>/dev/null; wait');
  return sh.join('\n') + '\n';
}

// The folders under /tmp a unit writes, as its blocks name them: `/tmp/hub-s4-$n` names all of
// /tmp/hub-s4-*. Removed before the run and, unless --keep, after it.
function clean(unit) {
  const names = new Set();
  for (const page of unit.pages) for (const b of parse(page).blocks) if (b.lang === 'bash')
    for (const m of b.body.matchAll(/\/tmp\/(hub-[A-Za-z0-9._-]+)/g)) names.add(m[1]);
  const prefixes = [...names].filter((n) => n.endsWith('-') && n.length > 4);
  for (const e of fs.readdirSync('/tmp'))
    if (names.has(e) || prefixes.some((p) => e.startsWith(p))) fs.rmSync(path.join('/tmp', e), { recursive: true, force: true });
}

function run(unit) {
  const file = path.join(TMP, unit.name + '.sh');
  fs.writeFileSync(file, script(unit));
  return new Promise((resolve) => {
    // its own process group: a server a page started and never stopped goes with the run
    const p = spawn('bash', [file], { cwd: HOME, env: ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\n@@docs timeout\n'; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 600000);
    p.on('exit', () => { clearTimeout(timer); try { process.kill(-p.pid, 'SIGTERM'); } catch {} });
    p.on('close', () => resolve(out));
  });
}

// What each block printed, by "page:line". Bash's word on a background job it saw killed is left
// out: at a terminal it is a "[1]+ Terminated" line no page shows.
function sections(out) {
  out = out.split('\n').filter((l) => !/: line \d+: +\d+ (Terminated|Killed|Hangup)/.test(l)).join('\n');
  const parts = out.split(/\n@@docs (.+)\n/);
  const got = new Map();
  for (let i = 1; i < parts.length; i += 2) got.set(parts[i], parts[i + 1] || '');
  return got;
}

// ── the comparison
const tidy = (s) => s.replaceAll('/private/tmp/', '/tmp/').replaceAll(REPO, '…/@bzdos/hubd').replaceAll(process.execPath, '…/node')
  .split('\n').map((l) => l.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '');
const MASKS = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?( ?Z| \+0000)?/g, '<time>'],
  [/\b\d{2}-\d{2} \d{2}:\d{2}\b/g, '<time>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  [/\b\d{2}:\d{2}\b/g, '<hh:mm>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, '<hash>'],   // commits, a workspace's folder
  // About one short hash in 27 is all digits, and nothing tells it from a number but where it
  // stands: first on a line, as git log --oneline prints it, or after "commit".
  [/^(\s*)\d{7,40}(?= )/gm, '$1<hash>'],
  [/\b(commit:? )\d{7,40}\b/g, '$1<hash>'],
  [/\bv?\d+\.\d+\.\d+\b/g, '<version>'],
  [/\b\d+m\b/g, '<n>m'],
  [/ {2,}/g, ' '],
];
const mask = (s) => MASKS.reduce((t, [re, to]) => t.replace(re, to), tidy(s));
// The masks on the cases they exist for, before any page runs: a mask that misses passes every run
// that happens not to need it and fails the odd one that does.
for (const [s, want] of [
  ['  8641485 a shop', ' <hash> a shop'],
  ['  bde1637 a shop', ' <hash> a shop'],
  ['commit 8641485', 'commit <hash>'],
  ['Task #oak-1 added: set nofile to 1048576 in the load box image', 'Task #oak-1 added: set nofile to 1048576 in the load box image'],
  ['84 min · 1514000 tokens · $5.33', '84 min · 1514000 tokens · $5.33'],
]) if (mask(s) !== want) { console.log(`FAIL masks: ${JSON.stringify(s)} became ${JSON.stringify(mask(s))}, not ${JSON.stringify(want)}`); process.exit(1); }
const isGap = (l) => l.trim() === '…';
// a line the page cut short with … stands for any line it begins
const same = (doc, got) => doc === got || (doc.endsWith('…') && got.startsWith(doc.slice(0, -1).trimEnd()));

// A text block: the same lines, where a `…` line stands for any number of them.
function textMatches(doc, got) {
  const want = mask(doc).split('\n'), have = mask(got).split('\n');
  const segs = [[]];
  for (const l of want) isGap(l) ? segs.push([]) : segs.at(-1).push(l);
  const at = (seg, i) => i + seg.length <= have.length && seg.every((l, k) => same(l, have[i + k]));
  if (segs.length === 1) return want.length === have.length && at(want, 0);
  const first = segs[0], last = segs.at(-1);
  if (!at(first, 0)) return false;
  let i = first.length;
  for (const seg of segs.slice(1, -1)) {
    while (i + seg.length <= have.length && !at(seg, i)) i++;
    if (i + seg.length > have.length) return false;
    i += seg.length;
  }
  return have.length - last.length >= i && at(last, have.length - last.length);
}
// The same lines in another order: what a run does when it makes two things in the same minute
// that a reader makes minutes apart, and the hub lists same-minute ones by node.
const reordered = (doc, got) => {
  const a = mask(doc).split('\n').sort(), b = mask(got).split('\n').sort();
  return a.length === b.length && a.every((l, i) => l === b[i]);
};

// A json block: each "field": value it shows is in the answer; a string cut with … is a prefix.
function jsonMatches(doc, got) {
  if (/^ERROR /m.test(got)) return false;
  const have = mask(got).replace(/\s+/g, ' ');
  const pairs = [...mask(doc).replace(/^-->.*$/gm, '').matchAll(/"([^"\\]+)": ?("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g)];
  return pairs.length > 0 && pairs.every(([, k, v]) => have.includes(`"${k}": ${v.endsWith('…"') ? v.slice(0, -2) : v}`));
}

// The lines of a and b, - for a's only and + for b's, in order (a longest common subsequence).
function diff(a, b) {
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || L[i][j + 1] >= L[i + 1][j])) out.push('+ ' + b[j++]);
    else out.push('- ' + a[i++]);
  }
  return out;
}

// ── run each unit, compare each block, report
let failed = 0;
const width = Math.max(...todo.map((u) => u.name.length));
for (const unit of todo) {
  const t0 = Date.now();
  clean(unit);
  const raw = await run(unit);
  if (LOG) fs.appendFileSync(LOG, raw);
  const got = sections(raw);
  if (!KEEP) clean(unit);
  const problems = [];
  let compared = 0, written = 0, shuffled = 0;
  for (const page of unit.pages) {
    const { src, blocks } = parse(page);
    const edits = [];
    let json = 0;
    blocks.forEach((b, n) => {
      const key = `${page}:${b.line}`;
      if (b.lang === 'json' && (CALLS[page] || {})[++json]) {
        compared++;
        const out = got.get(key);
        if (out === undefined) problems.push(`${key}  the run never reached this block`);
        else if (!jsonMatches(b.body, out)) problems.push(`${key}  the answer lacks a field the page shows:\n` + tidy(out).split('\n').slice(0, 30).map((l) => '    ' + l).join('\n'));
      }
      if (b.lang !== 'bash') return;
      const out = got.get(key);
      if (out === undefined) { problems.push(`${key}  the run never reached this block`); return; }
      const next = blocks[n + 1];
      if (!next || next.lang !== 'text') {
        if (tidy(out)) problems.push(`${key}  printed what the page does not show:\n` + tidy(out).split('\n').slice(0, 15).map((l) => '    ' + l).join('\n'));
        return;
      }
      compared++;
      if (textMatches(next.body, out)) return;
      const abridged = next.body.split('\n').some(isGap);
      if (!abridged && reordered(next.body, out)) { shuffled++; return; }
      if (WRITE && !abridged) { edits.push([next.start, next.end, tidy(out) + '\n']); written++; return; }
      let d = diff(mask(next.body).split('\n'), mask(out).split('\n'));
      // an abridged block leaves lines out on purpose: what matters is the page's lines the run lacks
      if (abridged) d = d.filter((l, k) => (l.startsWith('- ') && !isGap(l.slice(2))) || (l.startsWith('+ ') && [d[k - 1], d[k + 1]].some((n) => n && n.startsWith('- ') && !isGap(n.slice(2)))));
      problems.push(`${key}  differs from the output at :${next.line}${abridged ? ' (abridged with …: fix by hand)' : ''}\n` +
        d.slice(0, 40).map((l) => '    ' + l).join('\n') + (d.length > 40 ? `\n    … ${d.length - 40} more` : ''));
    });
    if (edits.length) {
      let text = src;
      for (const [s, e, t] of edits.reverse()) text = text.slice(0, s) + t + text.slice(e);
      fs.writeFileSync(path.join(REPO, page), text);
    }
  }
  if (got.has('timeout')) problems.push('the run took longer than 10 minutes and was stopped');
  if (!got.has('end') && !got.has('timeout')) problems.push('the run stopped before its last block');
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  const note = (shuffled ? `, ${shuffled} in another order` : '') + (written ? `, ${written} rewritten` : '');
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${unit.name.padEnd(width)} ${secs}s  ${compared} outputs${note}`);
  for (const p of problems) console.log('  ' + p);
  if (problems.length) failed++;
}
process.exit(failed ? 1 : 0);
