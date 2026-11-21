// examples.mjs — the team examples in examples/team, run as a reader runs them: one command, each on
// a fresh `hub demo` of its own. An engine change that breaks one of the recipes fails here, not in
// the hands of a team that copied it. Each example also has to say which rule it shows and which
// scar the rule came from, in its header: an example without them is a script, not a recipe.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ok, mktmp, REPO, done } from './_h.mjs';

const DIR = path.join(REPO, 'examples/team');
const files = fs.readdirSync(DIR).filter(f => /^\d\d-.*\.sh$/.test(f)).sort();
ok(files.length >= 9, `examples/team holds the nine examples (${files.length})`);
for (const f of files) {
  const head = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').slice(0, 15).join('\n');
  ok(/^# Rule: /m.test(head) && /^# Scar: /m.test(head), `${f}: its header names the rule and the scar`);
}

const tmp = mktmp();
const r = spawnSync('sh', [path.join(DIR, 'run.sh')], {
  encoding: 'utf8',
  env: { ...process.env, HUB: `${process.execPath} ${path.join(REPO, 'hub/hub.mjs')}`, HUBD: `${process.execPath} ${path.join(REPO, 'hub/index.mjs')}`, TMPDIR: tmp, HUBD_AGENT: '' },
  timeout: 300000,
});
const out = (r.stdout || '') + (r.stderr || '');
for (const f of files) {
  const name = f.replace(/\.sh$/, '');
  const line = out.split('\n').find(l => l.endsWith(' ' + name) || l.includes(' ' + name + ':')) || `(no line for ${name})`;
  ok(line.startsWith('PASS '), `run.sh: ${line}`);
}
ok(r.status === 0, `run.sh exits 0 (${r.status})`);
done();
