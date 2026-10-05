// _h.mjs — what every file in tests/logic shares: the engine loaded against a throwaway hub,
// the CLI runner, ok(), and temp dirs and background processes, gone when the file exits, pass or fail.
// A file runs alone (node tests/logic/queue.mjs) or with the rest (node tests/run.mjs).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = `node ${REPO}/hub/cli.mjs`;

let pass = 0, fail = 0;
export const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

const temps = [];
export const mktmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hubd-t-')); temps.push(d); return d; };
// A process a file starts in the background (a server, a follower) is ended when the file exits,
// pass or fail, before its temp dirs go: one that outlived a failed run kept polling a hub that
// was gone, for hours.
const kids = [];
export const reap = (child) => { kids.push(child); return child; };
process.on('exit', () => {
  for (const c of kids) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

// run the CLI, never throw — capture non-zero exits (doctor exits 1 on warnings)
export function run(args, env) {
  try { return { code: 0, out: execSync(`${CLI} ${args}`, { env: { ...process.env, ...env }, encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

// the CLI with an argument list and no shell in between, so a body with quotes, dollars or a
// line break reaches it as the caller's argv holds it; an env value of undefined unsets it
export function cli(argv, { env = {}, cwd, input } = {}) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [path.join(REPO, 'hub/cli.mjs'), ...argv], { env: e, cwd, input, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}

// a port nobody holds right now: the files run side by side, so a fixed number can be taken
export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// The engine reads HUBD_DIR and HUBD_NODE once, at import: both are set before it loads.
// Every file writes as node 'cedar'.
export const T0 = mktmp();
process.env.HUBD_DIR = T0;
process.env.HUBD_NODE = 'cedar';
const lib = (f) => import(path.join(REPO, 'hub/lib', f));
export const core = await lib('core.mjs');
core.ensureHubDirs();   // pointing at a base creates nothing; a test hub starts with its folders, as a written one has
export const doc = await lib('doctor.mjs');
export const queueLib = await lib('queue.mjs');
export const conflictsLib = await lib('conflicts.mjs');
export const usageLib = await lib('usage.mjs');
export const cardsLib = await lib('cards.mjs');
export const recallLib = await lib('recall.mjs');
export const absorbLib = await lib('absorb.mjs');

export function done() {
  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
}
