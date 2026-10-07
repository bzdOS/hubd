// company.mjs — the hubd-company template run the way its README says: hub init keeps its files,
// scripts/team.mjs declares roles/team.json in the hub and renders each role's rules from prompts/meta,
// and `check` notices when an owner decision makes those rules stale. The template is not in the npm
// package, so nothing else would notice a change to the rule templates that breaks it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, ok, mktmp, cli, done } from './_h.mjs';

const CO = mktmp(), WORK = mktmp(), BIN = mktmp();
fs.cpSync(path.join(REPO, 'hubd-company'), CO, { recursive: true });
// team.mjs runs `hub` from PATH: here, this checkout's CLI
fs.writeFileSync(path.join(BIN, 'hub'), `#!/bin/sh\nexec "${process.execPath}" "${REPO}/hub/cli.mjs" "$@"\n`, { mode: 0o755 });
const env = { HUBD_DIR: CO, HUBD_TEAM_DIR: CO, HUBD_NODE: 'cedar', HUBD_AGENT: undefined, PATH: BIN + path.delimiter + process.env.PATH };
const hub = (argv, cwd) => cli(argv, { env, cwd });
const team = (...argv) => {
  const e = { ...process.env, ...env }; delete e.HUBD_AGENT;
  const r = spawnSync(process.execPath, [path.join(CO, 'scripts/team.mjs'), ...argv], { env: e, cwd: CO, encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
};
const teamFile = path.join(CO, 'roles/team.json');
const roles = Object.keys(JSON.parse(fs.readFileSync(teamFile, 'utf8')).roles);

// ── the template as shipped ──
{
  const zones = fs.readdirSync(path.join(CO, 'roles')).filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => f.replace(/\.md$/, ''));
  ok(roles.length > 0 && roles.every(r => zones.includes(r)) && zones.every(z => roles.includes(z)),
    `company: every role in team.json has its zone file in roles/, and every zone file a role (${roles.join(' ')})`);
  const agents = fs.readFileSync(path.join(CO, 'AGENTS.md'), 'utf8');
  ok(roles.every(r => agents.includes('| `' + r + '` |')), 'company: the org table in AGENTS.md lists every role of team.json');
  ok(!fs.existsSync(path.join(CO, 'projects')) || fs.readdirSync(path.join(CO, 'projects')).length === 0,
    'company: the template ships no sample card for the hub to read as a project');
  const init = hub(['init', CO]);
  ok(init.code === 0 && ['AGENTS.md', 'INBOX.md', 'queues/README.md', 'specs/SPEC_template.md'].every(f => init.out.includes('exists, kept ' + f)) && !/^ {2}created (?!\.gitignore)/m.test(init.out),
    'company: hub init keeps the template\'s AGENTS.md, INBOX.md, queues/README.md and spec template');
  const r = team('render');
  ok(r.code === 2 && /fill roles\/team\.json first: .*PRODUCT_SLUG.*OWNER_NAME/.test(r.out), 'company: team.mjs refuses an unfilled team.json and names the placeholders');
}

// ── filled in: declare, render, check ──
const REPO_DIR = path.join(WORK, 'shop');
fs.mkdirSync(REPO_DIR);
fs.writeFileSync(teamFile, fs.readFileSync(teamFile, 'utf8')
  .replaceAll('PRODUCT_SLUG', 'shop').replaceAll('OWNER_NAME', 'alice').replaceAll('/path/to/PRODUCT_REPO', REPO_DIR)
  .replaceAll('/path/to/this/company/folder', CO).replaceAll('CUSTOMER_DOMAIN', 'customer.example'));
{
  const r = team('declare', '--by', 'alice');
  ok(r.code === 2 && r.out.includes('hub sync .'), 'company: declare without the product card says how to make it (hub sync . in the repository)');
  ok(hub(['sync', '.', '-m', 'Web shop: catalogue, cart, checkout.', '--agent', 'alice'], REPO_DIR).code === 0, 'company: hub sync . in the product repository makes the card');
  ok(team('render').code === 2, 'company: render without a goal on the card is refused');
  hub(['section', 'add', 'shop', 'goal', 'Checkout that takes card payments without a support ticket', '--set', '--by', 'alice']);
}
{
  const r = team('declare', '--by', 'alice');
  ok(r.code === 0, `company: declare makes the cards (exit ${r.code})${r.code ? ' ' + r.out.slice(-200) : ''}`);
  const body = (n) => { try { return fs.readFileSync(path.join(CO, 'resources', n + '.md'), 'utf8'); } catch { return ''; } };
  ok(roles.every(n => /rank: (head|worker)/.test(body(n)) && /project: shop/.test(body(n)) && /head: \[\[(owner|product|cto)\]\]/.test(body(n))),
    'company: every role is a role card with its rank, the project and a link to its head');
  ok(/rank: fleet/.test(body('owner')) && /project: company/.test(body('owner')) && fs.existsSync(path.join(CO, 'projects/company.md')),
    'company: the owner desk is a fleet role on the company card');
  ok(JSON.parse(fs.readFileSync(path.join(CO, 'owner-roles.json'), 'utf8')).includes('alice'), 'company: the owner is in owner-roles.json');
}
{
  const r = team('render');
  const files = roles.map(n => path.join(CO, 'roles/rules', n + '.md'));
  ok(r.code === 0 && files.every(f => fs.existsSync(f)), `company: render writes roles/rules/<role>.md for all ${roles.length} roles`);
  const texts = files.map(f => fs.readFileSync(f, 'utf8'));
  ok(texts.every((t, i) => t.includes('`' + roles[i] + '`') && t.includes('without a support ticket') && !/\{\{/.test(t)),
    'company: each rules file names its role, carries the track goal and has no variable left');
  ok(/dispatch cycle/.test(fs.readFileSync(path.join(CO, 'roles/rules/cto.md'), 'utf8')) && !/dispatch cycle/.test(fs.readFileSync(path.join(CO, 'roles/rules/dev.md'), 'utf8')),
    'company: a head is rendered from the head template, a worker from the worker one');
  ok(team('check').code === 0, 'company: check passes right after a render');
  hub(['section', 'add', 'company', 'owner-decisions', 'Card payments through a hosted page only', '--by', 'alice']);
  const c = team('check');
  ok(c.code === 1 && /stale: .*cto/.test(c.out), 'company: an owner decision makes every rules file stale, and check exits 1');
  team('render');
  ok(team('check').code === 0 && fs.readFileSync(path.join(CO, 'roles/rules/dev.md'), 'utf8').includes('hosted page only'),
    'company: a render carries the decision into the rules');
}
{
  const l = hub(['lint']);
  ok(!/card-without-digest/.test(l.out), 'company: lint finds no card without a digest in a fresh company');
  const b = hub(['board']);
  ok(/── shop · head (cto, product|product, cto)/.test(b.out), 'company: the board shows the track with its two heads');
}

done();
