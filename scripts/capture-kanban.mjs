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
import crypto from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'hub', 'cli.mjs');
const WORK = process.env.CAPTURE_DIR || path.join(os.tmpdir(), 'hubd-kanban-capture');
const HUB = path.join(WORK, 'demo-hub');
const FRAMES = path.join(WORK, 'frames');
const PORT = Number(process.env.BOARD_PORT || 7788);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const W = Number(process.env.WIDTH || 1280), H = Number(process.env.HEIGHT || 720);
const WANT_GIF = process.argv.includes('--gif');
const FPS = Number(process.env.FPS || 10);

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
// of scripting. Timestamps are minutes BEFORE NOW, not clock times on a date: filmed in the
// morning, a hard-coded "20:15" is in the future, sorts above the live edits, and hides the very
// thing the recording is about (it did exactly that once).
const MIN = 60 * 1000;
const stamp = (agoMin) => new Date(Date.now() - agoMin * MIN).toISOString().slice(0, 16).replace('T', ' ');
const JOURNAL = [
  [660, 'atlas', 'dev-atlas', 'sync', 'synced with digest (3 new commits, +412/-96)'],
  [630, 'relay', 'dev-relay', 'sync', 'synced with digest (1 new commit, +58/-12)'],
  [585, 'atlas', 'product-atlas', 'task', '+ task #demo-1: Rewrite the onboarding funnel copy'],
  [540, 'relay', 'dev-relay', 'note', 'ingest backpressure holds at 12k msg/s, testing 20k next'],
  [498, 'atlas', 'dev-atlas', 'fact', 'search p95 dropped from 840ms to 210ms after the index rewrite'],
  [455, 'pinboard', 'dev-pinboard', 'blocked', 'export endpoint still has one internal caller - waiting on a reply'],
  [410, 'relay', 'sre-relay', 'claim', 'locked relay/ci for 240m'],
  [366, 'atlas', 'dev-atlas', 'decision', 'ranking v2 ships behind a flag - two weeks of data beats one argument'],
  [320, 'pinboard', 'dev-pinboard', 'task', '+ task #demo-3: Drop the legacy export endpoint'],
  [276, 'atlas', 'qa-atlas', 'fact', 'the login test was racing the session cookie, not the server'],
  [272, 'atlas', 'qa-atlas', 'task', '~ task #demo-8 -> done'],
  [228, 'relay', 'sre-relay', 'done', 'release 2.4.1 cut and verified on all three nodes'],
  [184, 'atlas', 'product-atlas', 'comm', 'onboarding rewrite brief sent to the copy queue'],
  [140, 'relay', 'dev-relay', 'fact', 'new runner image cuts CI wall-clock from 9m to 4m'],
  [96, 'atlas', 'dev-atlas', 'note', 'ranking flag wired, waiting on the 10% rollout decision'],
  [64, 'atlas', 'product-atlas', 'task', '+ task #demo-4: Audit third-party scripts on the landing page'],
  [42, 'relay', 'sre-relay', 'note', 'three nodes green, queue depth flat overnight'],
  [22, 'atlas', 'dev-atlas', 'next', 'turn the ranking flag on for 10% of traffic'],
];
fs.writeFileSync(path.join(HUB, 'journal.demo.jsonl'),
  JOURNAL.map(([ago, project, agent, kind, text]) => JSON.stringify({ ts: stamp(ago), project, agent, kind, text })).join('\n') + '\n');

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
// deviceScaleFactor 2 and downscale later: GIF text is the whole content here, and 1x capture
// scaled to the same width comes out mushy.
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await cdp('Page.navigate', { url: `http://localhost:${PORT}` });
await sleep(2500);

/* A STORYBOARD, not a timer.
 *
 * The first version shot on a fixed cadence while waiting for the board's 3s poll, and 26 of its
 * 37 frames came out byte-identical to the frame before: seven of eight seconds were a frozen
 * picture with two teleports in the middle. So capture is now driven by what is on screen —
 * frames are only taken during a deliberate hold or a scroll, waiting happens with the shutter
 * closed, and an identical frame is never written twice unless a hold asks for it.
 */
let n = 0;
let lastHash = null;
const write = (buf) => fs.writeFileSync(path.join(FRAMES, `f${String(n++).padStart(3, '0')}.png`), buf);
const grab = async () => Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64');
const hash = (b) => crypto.createHash('sha1').update(b).digest('hex');
const shotUnique = async () => {                    // for motion: skip a frame that did not change
  const b = await grab(); const h = hash(b);
  if (h === lastHash) return false;
  lastHash = h; write(b); return true;
};
const hold = async (ms) => {                        // for beats: same image, held on purpose
  const b = await grab(); lastHash = hash(b);
  for (let i = 0; i < Math.max(1, Math.round(ms / (1000 / FPS))); i++) write(b);
};
const scrollTo = (y) => cdp('Runtime.evaluate', { expression: `window.scrollTo(0,${y})` });
const edit = (call) => execFileSync(process.execPath, ['-e',
  `import(${JSON.stringify(path.join(REPO, 'hub/lib/core.mjs'))}).then(m=>m.${call})`], { env: ENV, stdio: 'ignore' });
// One board update = one edit + the poll that notices it. Wait with the shutter CLOSED, then
// capture the new state; a cut is what the product actually does, and holding either side of it
// gives the eye time to see WHICH card moved.
const step = async (call) => { edit(call); await sleep(3400); await hold(560); };

await hold(700);                                                  // the board, before anything
await step(`runTaskUpdate({id:'demo-1',assignee:'dev-atlas',by:'product-atlas'})`);   // QUEUED -> IN PROGRESS
await step(`runTaskUpdate({id:'demo-6',status:'done',by:'dev-relay'})`);              // IN PROGRESS -> DONE
await step(`runTaskUpdate({id:'demo-2',assignee:'sre-relay',by:'dev-relay'})`);       // another one picked up
await step(`runTaskUpdate({id:'demo-5',status:'done',by:'dev-atlas'})`);              // and another finished
await hold(320);
const stillFrame = n - 1;   // the board with every move landed — the one frame worth publishing alone

// Smooth scroll: many small steps, so the timeline glides instead of jumping in fourteen lurches.
const maxY = (await cdp('Runtime.evaluate', {
  expression: 'document.documentElement.scrollHeight - window.innerHeight', returnByValue: true })).result.value || 600;
// Two thirds of the way down is enough to read "this is a day's log"; the rest is more of the
// same, and every scrolled row is a full-frame change a GIF pays for in bytes.
const stopY = Math.round(maxY * 0.66);
for (let y = 0; y <= stopY; y += Math.max(8, Math.round(stopY / 30))) { await scrollTo(y); await sleep(30); await shotUnique(); }
await hold(700);

ws.close(); bye();

const media = path.join(REPO, 'docs', 'media');
const gif = path.join(media, 'kanban.gif');
const vf = `fps=${FPS},scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
if (WANT_GIF) {
  fs.mkdirSync(media, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%03d.png'), '-vf', vf, gif], { stdio: 'ignore' });
  // The still fallback is the frame captured after the LAST move landed (index recorded during the
  // storyboard, not guessed): three full columns plus the live activity lines, never mid-transition.
  fs.copyFileSync(path.join(FRAMES, `f${String(stillFrame).padStart(3, '0')}.png`), path.join(media, 'kanban.png'));
  console.log(`${n} frames -> ${gif} (${Math.round(fs.statSync(gif).size / 1024)}KB) + kanban.png`);
} else {
  console.log(`${n} frames in ${FRAMES}\nassemble with:\n  ffmpeg -y -framerate ${FPS} -i ${path.join(FRAMES, 'f%03d.png')} -vf "${vf}" ${gif}`);
}
