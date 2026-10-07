#!/usr/bin/env node
// team.mjs — the team in roles/team.json, made real in the hub.
//
//   node scripts/team.mjs declare --by <you>   # a role card per role, the owner's desk, the company card
//   node scripts/team.mjs render               # roles/rules/<role>.md from hubd's rule templates
//   node scripts/team.mjs check                # exit 1 when a rules file is stale or was edited by hand
//
// The hub is HUBD_DIR, else this folder. A role's rules carry its track's Goal and
// Facts & hypotheses (projects/<project>.md) and the Owner decisions of the company
// card (projects/<company>.md): render again after either changes, and `check` says
// when that is due. Needs the `hub` command (npm i -g @bzdos/hubd).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = resolve(process.env.HUBD_DIR || HERE);
const env = { ...process.env, HUBD_DIR: HUB };
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const die = (msg) => { console.error('team: ' + msg); process.exit(2); };

const TEAM_FILE = join(HERE, 'roles', 'team.json');
const RULES_DIR = join(HERE, 'roles', 'rules');
const COMPANY_DIGEST = 'The company itself: its roles, and what the owner decided for all of them.';

let raw = '';
try { raw = readFileSync(TEAM_FILE, 'utf8'); } catch { die('no roles/team.json next to this script'); }
const unfilled = [...new Set(raw.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\/path\/to\b/g) || [])];
if (unfilled.length) die(`fill roles/team.json first: ${unfilled.join(', ')}`);
let team;
try { team = JSON.parse(raw); } catch (e) { die(`roles/team.json is not JSON: ${e.message}`); }
const owner = team.owner || {};
const roles = Object.entries(team.roles || {});

// Runs `hub` against this hub; output passes through, a failure stops the script.
function hub(args, { quiet = false, okCodes = [0] } = {}) {
  const r = spawnSync('hub', args, { env, cwd: HERE, encoding: 'utf8' });
  if (r.error) die(r.error.code === 'ENOENT' ? 'no `hub` command: npm i -g @bzdos/hubd' : r.error.message);
  if (!quiet && r.stdout) process.stdout.write(r.stdout);
  if (!okCodes.includes(r.status)) { process.stderr.write(r.stderr || ''); die(`hub ${args[0]} ${args[1] || ''} exited ${r.status}`); }
  return r;
}

// One "## Heading" section of a card, by the engine's key; a hub that renames its
// headings (sections.json) is followed. Empty or a scaffold hint reads as null.
function section(slug, key) {
  const headings = { goal: 'Goal', facts: 'Facts & hypotheses', 'owner-decisions': 'Owner decisions' };
  try {
    const own = JSON.parse(readFileSync(join(HUB, 'sections.json'), 'utf8'))[key];
    if (own) headings[key] = typeof own === 'string' ? own : own.heading || headings[key];
  } catch {}
  let text = '';
  try { text = readFileSync(join(HUB, 'projects', slug + '.md'), 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === '## ' + headings[key]);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  const body = lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim();
  return !body || /^<[^>]*>$/.test(body) ? null : body;
}

function vars(role, r) {
  const goal = section(team.project, 'goal');
  if (!goal) die(`${team.project} has no goal yet: hub section add ${team.project} goal "<what the track is for>" --set --by <you>`);
  const v = {
    ...team.vars, ...(r.vars || {}), role, project: team.project, head: r.head,
    track_goal: goal,
    track_facts: section(team.project, 'facts') || '- none yet',
    owner_decisions: section(team.company, 'owner-decisions') || '- none yet',
  };
  if (Array.isArray(v.allowed_paths)) v.allowed_paths = v.allowed_paths.map((p) => '  - ' + p).join('\n');
  return v;
}

const template = (r) => (r.rank === 'head' ? 'head' : 'worker');
const rulesFile = (role) => `roles/rules/${role}.md`;   // relative to HERE, where hub runs

if (cmd === 'declare') {
  const by = opt('--by') || process.env.HUBD_AGENT;
  if (!by) die('declare --by <you>: every write in the hub names its author');
  if (!existsSync(join(HUB, 'projects', team.project + '.md')))
    die(`no card for ${team.project}: in the product's repository, hub sync . -m "<what it is, in a line>" --agent ${by}`);
  if (!existsSync(join(HUB, 'projects', team.company + '.md')))
    hub(['card', team.company, '-m', COMPANY_DIGEST, '--by', by]);
  hub(['resource', 'set', owner.role, '--type', 'role', '--attr', 'rank=fleet', '--attr', 'project=' + team.company,
    '-m', owner.digest, '--by', by]);
  for (const [role, r] of roles) {
    const attrs = Object.entries(r.attrs || {}).flatMap(([k, v]) => ['--attr', `${k}=${v}`]);
    hub(['resource', 'set', role, '--type', 'role', '--attr', 'rank=' + r.rank, '--attr', 'project=' + team.project,
      '--attr', 'head=', '--link', 'head:' + r.head, ...attrs, '-m', r.digest, '--by', by]);
  }
  const f = join(HUB, 'owner-roles.json');
  let have = [];
  try { have = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  const add = (owner.people || []).filter((p) => !have.includes(p));
  if (add.length) { writeFileSync(f, JSON.stringify([...have, ...add]) + '\n'); console.log('owner-roles.json: + ' + add.join(', ')); }
} else if (cmd === 'render') {
  mkdirSync(RULES_DIR, { recursive: true });
  for (const [role, r] of roles) {
    hub(['prompts', 'render', template(r), '--vars', JSON.stringify(vars(role, r)), '--out', rulesFile(role)]);
    console.log(`${rulesFile(role)}  (${template(r)})`);
  }
} else if (cmd === 'check') {
  const stale = [];
  for (const [role, r] of roles) {
    const res = hub(['prompts', 'render', template(r), '--vars', JSON.stringify(vars(role, r)), '--check', rulesFile(role)],
      { quiet: true, okCodes: [0, 1] });
    if (res.status === 1) { stale.push(role); process.stderr.write(res.stderr); }
  }
  if (stale.length) { console.error(`stale: ${stale.join(', ')} (node scripts/team.mjs render)`); process.exit(1); }
  console.log(`${roles.length} rules file(s) match the render`);
} else {
  die('declare --by <you> | render | check');
}
