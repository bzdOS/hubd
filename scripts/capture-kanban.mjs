#!/usr/bin/env node
/**
 * Film the read-only kanban: build a throwaway demo hub, serve it, and capture the board as a
 * frame sequence while cards actually move.
 *
 *   node scripts/capture-kanban.mjs            # frames only, prints the ffmpeg line
 *   node scripts/capture-kanban.mjs --gif      # also assemble docs/media/kanban.gif (needs ffmpeg)
 *
 * Two things it deliberately does NOT do:
 *
 *   It does not fake motion. The board polls /api/kanban every 3s, so this edits the demo hub
 *   between frames and lets the page notice by itself — what you see is the product reacting to a
 *   real write, not a CSS animation.
 *
 *   It does not touch your hub. Everything happens in a temp directory with invented English
 *   projects, because the output gets published and a recording of a real hub leaks whatever is in it.
 *
 * Zero dependencies: Chrome is driven over the DevTools protocol through Node's global WebSocket.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'hub', 'cli.mjs');
const WORK = process.env.CAPTURE_DIR || path.join(os.tmpdir(), 'hubd-kanban-capture');
const HUB = path.join(WORK, 'demo-hub');
const FRAMES = path.join(WORK, 'frames');
const PORT = Number(process.env.BOARD_PORT || 7788);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const W = Number(process.env.WIDTH || 1280), H = Number(process.env.HEIGHT || 720);
const WANT_GIF = process.argv.includes('--gif');

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('no Chrome/Chromium found — set CHROME_PATH'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ENV = { ...process.env, HUBD_DIR: HUB, HUBD_TEAM_DIR: HUB, HUBD_NODE: 'demo', HUBD_AGENT: 'dev-demo' };
const hub = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: ENV, stdio: 'ignore' });

/* ── a day that never happened, in a hub that will be deleted ── */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(HUB, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });
hub('init', HUB);
hub('card', 'atlas', '-m', 'Public web app. Search rewrite shipped; onboarding funnel next.', '--by', 'product-atlas');
hub('card', 'relay', '-m', 'Message relay service. Backpressure fixed, 3 nodes live.', '--by', 'dev-relay');
hub('card', 'pinboard', '-m', 'Internal bookmarks tool. Feature-frozen, maintenance only.', '--by', 'dev-pinboard');
const TASKS = [
  ['Rewrite the onboarding funnel copy', 'atlas', 'high', null],
  ['Add rate-limit headers to the public API', 'relay', null, null],
  ['Drop the legacy export endpoint', 'pinboard', null, null],
  ['Audit third-party scripts on the landing page', 'atlas', null, null],
  ['Ship search result ranking v2', 'atlas', 'high', 'dev-atlas'],
  ['Backpressure on the ingest queue', 'relay', 'med', 'dev-relay'],
  ['Migrate CI to the new runner image', 'relay', null, 'sre-relay'],
  ['Fix the flaky login test', 'atlas', null, 'qa-atlas'],
  ['Cut release 2.4.1', 'relay', null, 'sre-relay'],
];
for (const [text, proj, imp, who] of TASKS) {
  hub('task', 'add', text, '-p', proj, ...(imp ? ['-i', imp] : []), ...(who ? ['--assignee', who] : []), '--by', 'product-' + proj);
}
hub('task', 'done', 'demo-8', '--by', 'qa-atlas');
hub('task', 'done', 'demo-9', '--by', 'sre-relay');

// The journal is written directly so the timeline reads like a worked day rather than one minute
// of scripting, and it stops before "now" so the live edits below land on top of it.
const day = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 10);
const JOURNAL = [
  ['09:12', 'atlas', 'dev-atlas', 'sync', 'synced with digest (3 new commits, +412/-96)'],
  ['09:41', 'relay', 'dev-relay', 'sync', 'synced with digest (1 new commit, +58/-12)'],
  ['10:27', 'atlas', 'product-atlas', 'task', '+ task #demo-1: Rewrite the onboarding funnel copy'],
  ['11:05', 'relay', 'dev-relay', 'note', 'ingest backpressure holds at 12k msg/s, testing 20k next'],
  ['11:48', 'atlas', 'dev-atlas', 'fact', 'search p95 dropped from 840ms to 210ms after the index rewrite'],
  ['12:20', 'pinboard', 'dev-pinboard', 'blocked', 'export endpoint still has one internal caller - waiting on a reply'],
  ['13:35', 'relay', 'sre-relay', 'claim', 'locked relay/ci for 240m'],
  ['14:10', 'atlas', 'dev-atlas', 'decision', 'ranking v2 ships behind a flag - two weeks of data beats one argument'],
  ['15:19', 'pinboard', 'dev-pinboard', 'task', '+ task #demo-3: Drop the legacy export endpoint'],
  ['16:04', 'atlas', 'qa-atlas', 'fact', 'the login test was racing the session cookie, not the server'],
  ['16:07', 'atlas', 'qa-atlas', 'task', '~ task #demo-8 -> done'],
  ['16:40', 'relay', 'sre-relay', 'done', 'release 2.4.1 cut and verified on all three nodes'],
  ['17:12', 'atlas', 'product-atlas', 'comm', 'onboarding rewrite brief sent to the copy queue'],
  ['17:55', 'relay', 'dev-relay', 'fact', 'new runner image cuts CI wall-clock from 9m to 4m'],
  ['18:30', 'atlas', 'dev-atlas', 'note', 'ranking flag wired, waiting on the 10% rollout decision'],
  ['19:08', 'atlas', 'product-atlas', 'task', '+ task #demo-4: Audit third-party scripts on the landing page'],
  ['20:02', 'relay', 'sre-relay', 'note', 'three nodes green, queue depth flat overnight'],
  ['20:15', 'atlas', 'dev-atlas', 'next', 'turn the ranking flag on for 10% of traffic'],
];
fs.writeFileSync(path.join(HUB, 'journal.demo.jsonl'),
  JOURNAL.map(([hm, project, agent, kind, text]) => JSON.stringify({ ts: `${day} ${hm}`, project, agent, kind, text })).join('\n') + '\n');

/* ── serve it, drive Chrome, shoot ── */
const server = spawn(process.execPath, [CLI, 'serve', '-p', String(PORT)], { env: ENV, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--window-size=${W},${H}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(WORK, 'chrome')}`, 'about:blank',
], { stdio: 'ignore' });
const bye = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', bye);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try {
    const page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page');
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.error('Chrome DevTools never came up'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise(res => { const n = ++seq; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: `http://localhost:${PORT}` });
await sleep(2500);

let n = 0;
const shot = async () => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(FRAMES, `f${String(n++).padStart(3, '0')}.png`), Buffer.from(r.data, 'base64'));
};
const scrollTo = (y) => cdp('Runtime.evaluate', { expression: `window.scrollTo(0,${y})` });
const edit = (call) => execFileSync(process.execPath, ['-e',
  `import(${JSON.stringify(path.join(REPO, 'hub/lib/core.mjs'))}).then(m=>m.${call})`], { env: ENV, stdio: 'ignore' });

for (let i = 0; i < 5; i++) { await shot(); await sleep(120); }                 // the board, still
edit(`runTaskUpdate({id:'demo-1',assignee:'dev-atlas',by:'product-atlas'})`);    // QUEUED -> IN PROGRESS
for (let i = 0; i < 10; i++) { await shot(); await sleep(420); }                 // the 3s poll lands in here
edit(`runTaskUpdate({id:'demo-6',status:'done',by:'dev-relay'})`);               // IN PROGRESS -> DONE TODAY
for (let i = 0; i < 10; i++) { await shot(); await sleep(420); }
const maxY = (await cdp('Runtime.evaluate', {
  expression: 'document.documentElement.scrollHeight - window.innerHeight', returnByValue: true })).result.value || 600;
for (let y = 0; y <= maxY; y += Math.max(40, Math.round(maxY / 14))) { await scrollTo(y); await sleep(90); await shot(); }
for (let i = 0; i < 3; i++) { await shot(); await sleep(120); }
await scrollTo(0); await sleep(200);
for (let i = 0; i < 3; i++) { await shot(); await sleep(120); }

ws.close(); bye();

const media = path.join(REPO, 'docs', 'media');
const gif = path.join(media, 'kanban.gif');
const vf = `fps=5,scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
if (WANT_GIF) {
  fs.mkdirSync(media, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-framerate', '5', '-i', path.join(FRAMES, 'f%03d.png'), '-vf', vf, gif], { stdio: 'ignore' });
  fs.copyFileSync(path.join(FRAMES, 'f012.png'), path.join(media, 'kanban.png'));   // the still fallback
  console.log(`${n} frames -> ${gif} (${Math.round(fs.statSync(gif).size / 1024)}KB) + kanban.png`);
} else {
  console.log(`${n} frames in ${FRAMES}\nassemble with:\n  ffmpeg -y -framerate 5 -i ${path.join(FRAMES, 'f%03d.png')} -vf "${vf}" ${gif}`);
}
