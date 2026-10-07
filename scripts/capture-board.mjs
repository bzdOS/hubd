#!/usr/bin/env node
/**
 * Photograph the board's Summary and Tracks on the demo hub, for the README and the docs.
 *
 *   node scripts/capture-board.mjs             # docs/media/summary.png and docs/media/tracks.png
 *   node scripts/capture-board.mjs summary     # just the one
 *
 * The hub in the pictures is the one `hub demo` writes, made fresh by that very command, so a
 * reader who runs `hub demo` and `hub serve` sees the page the docs show, down to the ages ("38m
 * ago") the stamps are counted back to. Nothing is read from your hub: the published picture of a
 * real one would carry whatever is in it. The node is called oak, so no machine of yours is named.
 *
 * Zero dependencies, as capture-kanban.mjs: Chrome over the DevTools protocol, through Node's
 * global WebSocket.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'hub', 'cli.mjs');
const WORK = process.env.CAPTURE_DIR || path.join(os.tmpdir(), 'hubd-board-capture');
const HUB = path.join(WORK, 'demo-hub');
const PORT = Number(process.env.BOARD_PORT || 7792);
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const W = Number(process.env.WIDTH || 1200), MAX_H = Number(process.env.MAX_HEIGHT || 1500);
const VIEWS = process.argv.slice(2).length ? process.argv.slice(2) : ['summary', 'tracks'];
for (const v of VIEWS) if (!['summary', 'tracks', 'live', 'history'].includes(v)) { console.error(`no view ${v}: summary, tracks, live, history`); process.exit(1); }

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('no Chrome/Chromium found — set CHROME_PATH'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ENV = { ...process.env, HUBD_DIR: HUB, HUBD_TEAM_DIR: HUB, HUBD_NODE: 'oak' };

/* ── the demo, written by the command a reader runs ── */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
// run from a hub of nothing, so `hub demo` has no hub of its own to refuse to write into
const NONE = path.join(WORK, 'none');
execFileSync(process.execPath, [CLI, 'demo', HUB], { env: { ...ENV, HUBD_DIR: NONE, HUBD_TEAM_DIR: NONE }, cwd: WORK, stdio: 'ignore' });

/* ── serve it, drive Chrome, shoot ── */
const server = spawn(process.execPath, [CLI, 'serve', '-p', String(PORT)], { env: ENV, cwd: WORK, stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--window-size=${W},900`,
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
const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value;

await cdp('Page.enable');
// 2x: the pictures are text, and GitHub scales them down to its column; 1x comes out mushy
const metrics = (height) => cdp('Emulation.setDeviceMetricsOverride', { width: W, height, deviceScaleFactor: 2, mobile: false });
await metrics(900);
for (let i = 0; i < 40; i++) {   // the server may still be starting
  await cdp('Page.navigate', { url: `http://localhost:${PORT}` });
  await sleep(500);
  if (await evaluate(`typeof setMode === 'function' && !!document.getElementById('summary-view')`)) break;
}

const media = path.join(REPO, 'docs', 'media');
fs.mkdirSync(media, { recursive: true });
for (const view of VIEWS) {
  await metrics(900);
  await evaluate(`setMode(${JSON.stringify(view)}); window.scrollTo(0, 0)`);
  await sleep(1500);   // its fetch, and the render after it
  // the whole view, up to MAX_H: a picture taller than a screen is not read to the bottom anyway
  const height = Math.min(MAX_H, Math.max(600, await evaluate('document.documentElement.scrollHeight')));
  await metrics(height);
  await sleep(300);
  const png = Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  const out = path.join(media, view + '.png');
  fs.writeFileSync(out, png);
  console.log(`${path.relative(REPO, out)}  ${W}x${height} css px, ${Math.round(png.length / 1024)}KB`);
}
ws.close(); bye();
await sleep(500);   // Chrome lets go of its profile
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
