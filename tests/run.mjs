// run.mjs — every suite, side by side: the files in tests/logic and the shell suites.
//   node tests/run.mjs              # all of them (npm test)
//   node tests/run.mjs queue cards  # only the suites whose name contains one of these
// One line per suite; a failing suite prints its FAIL lines and the tail of its output.
// Exit 1 if any suite failed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const shell = (f) => (/bash/.test(fs.readFileSync(path.join(TESTS, f), 'utf8').split('\n')[0]) ? 'bash' : 'sh');
// the longest first: the wall time is the slowest suite, as long as it starts at once
const suites = [
  ...['test_mesh_sync.sh', 'smoke_mcp.sh', 'test_sync_preserve.sh', 'check_clean.sh']
    .map(f => ({ name: f.replace(/\.sh$/, ''), cmd: shell(f), args: [path.join(TESTS, f)] })),
  ...fs.readdirSync(path.join(TESTS, 'logic')).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()
    .map(f => ({ name: 'logic/' + f.replace(/\.mjs$/, ''), cmd: process.execPath, args: [path.join(TESTS, 'logic', f)] })),
];
const want = process.argv.slice(2);
const todo = want.length ? suites.filter(s => want.some(w => s.name.includes(w))) : suites;
if (!todo.length) { console.error(`no suite matches ${want.join(' ')}; suites: ${suites.map(s => s.name).join(' ')}`); process.exit(2); }

const width = Math.max(...todo.map(s => s.name.length));
const jobs = Math.max(2, (os.availableParallelism ? os.availableParallelism() : os.cpus().length));
const t0 = Date.now();
let failed = 0, passTotal = 0;

function runOne(s) {
  return new Promise((resolve) => {
    const start = Date.now();
    const p = spawn(s.cmd, s.args, { cwd: path.dirname(TESTS), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      // a suite can print several "N pass, M fail" lines, one per part
      const parts = [...out.matchAll(/^(\d+) pass, (\d+) fail/gm)];
      const p = parts.reduce((n, m) => n + Number(m[1]), 0), f = parts.reduce((n, m) => n + Number(m[2]), 0);
      const secs = ((Date.now() - start) / 1000).toFixed(1).padStart(5);
      const summary = parts.length ? `${p} pass, ${f} fail` : '';
      passTotal += p;
      console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${s.name.padEnd(width)} ${secs}s  ${summary}`);
      if (code !== 0) {
        failed++;
        const lines = out.trimEnd().split('\n');
        const fails = lines.filter(l => l.startsWith('FAIL '));
        for (const l of fails) console.log('       ' + l);
        for (const l of lines.slice(-15)) if (!fails.includes(l)) console.log('     | ' + l);
      }
      resolve();
    });
  });
}

const queue = [...todo];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) await runOne(queue.shift());
}));
console.log(`\n${todo.length - failed}/${todo.length} suites passed, ${passTotal} checks, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
