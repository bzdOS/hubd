#!/usr/bin/env node
/* import-bank.mjs — seed a commons with the V3R1T4S target bank, as data.
 *
 *   node scripts/import-bank.mjs <targets.json> --commit <sha> --url <mcp url> --key <commons key> [--by <handle>] [--dry-run]
 *
 * Each target becomes one open problem: project = its category; its name, statement, success
 * criterion, partial wins, how to verify it, where its status comes from, pitfalls and angles in
 * the text; and a closing line naming the bank id and commit, under CC BY 4.0. A target tagged
 * commit-only in the bank (a live contest) keeps that tag, which makes the server take attempts on
 * it as a commitment only.
 *
 * It goes through the commons' own MCP endpoint, so the server checks every problem as it checks
 * any other write. Run again, it adds only the targets the commons does not hold yet (matched by
 * bank id); it never changes or closes one. The bank is github.com/elder-plinius/V3R1T4S. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const list = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const one = (s) => String(s ?? '').trim();
const ATTRIB = /V3R1T4S target bank, id ([a-z0-9][a-z0-9._-]*),/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The hub_task_add arguments for every target of a parsed bank file. */
export function bankTasks(bank, commit, by = 'commons-seed') {
  if (!bank || !Array.isArray(bank.targets)) throw new Error('not a V3R1T4S bank: no targets array');
  if (!/^v3r1t4s\.bank\//.test(String(bank.schema || ''))) throw new Error(`unknown bank schema "${bank.schema}"`);
  const sha = one(commit);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('--commit: the bank commit the file comes from, as hex');
  return bank.targets.map((t) => {
    const parts = [one(t.name), one(t.statement), 'Success: ' + one(t.success_criterion)];
    const wins = list(t.partial_wins).map(w => '- ' + (typeof w === 'string' ? w : one(w.statement)));
    if (wins.length) parts.push('Partial wins:\n' + wins.join('\n'));
    if (one(t.verification_method)) parts.push('How to verify: ' + one(t.verification_method));
    parts.push(`Status: open at ${one(t.status_source)}, as checked ${one(t.status_checked)}. Statuses go stale: check the source before you start, and again before you claim.`);
    const src = list(t.primary_sources).map(one).filter(Boolean);
    if (src.length) parts.push('Sources:\n' + src.map(s => '- ' + s).join('\n'));
    const pit = list(t.pitfalls).map(one).filter(Boolean);
    if (pit.length) parts.push('Pitfalls:\n' + pit.map(s => '- ' + s).join('\n'));
    const ang = list(t.angles).map(one).filter(Boolean);
    if (ang.length) parts.push('Angles:\n' + ang.map(s => '- ' + s).join('\n'));
    parts.push(`Kind: ${one(t.kind)}; tractability ${one(t.tractability)} of 5; compute: ${one(t.compute_profile)}.`);
    // A commons refuses a text with an e-mail address in it, the bank's contact for a third-party
    // site included: such an address is written out, and the credit line says so.
    let text = parts.join('\n\n');
    const written = text.replace(EMAIL, (m) => m.replace('@', ' (at) '));
    const changed = written !== text ? '; changed here: e-mail addresses written as name (at) domain' : '';
    text = written + '\n\n' + `From the V3R1T4S target bank, id ${one(t.id)}, commit ${sha.slice(0, 12)} (github.com/elder-plinius/V3R1T4S), CC BY 4.0${changed}.`;
    const tags = ['v3r1t4s', one(t.kind)].concat(t.disclosure === 'commit-only' ? ['commit-only'] : []).filter(Boolean);
    return { bankId: one(t.id), args: { project: one(t.category), text, tags, by } };
  });
}

/** The bank ids a commons already holds, from the attribution line of its problems. */
export function heldIds(tasks) {
  const out = new Set();
  for (const t of tasks) { const m = ATTRIB.exec(String(t.text || '')); if (m) out.add(m[1]); }
  return out;
}

async function main(argv) {
  const flag = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
  const VALUED = ['--commit', '--url', '--key', '--by'];
  const file = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
  const dry = argv.includes('--dry-run');
  const url = flag('--url'), key = flag('--key');
  if (!file || !flag('--commit') || (!dry && (!url || !key))) {
    console.error('Usage: node scripts/import-bank.mjs <targets.json> --commit <sha> --url <mcp url> --key <commons key> [--by <handle>] [--dry-run]');
    process.exit(2);
  }
  const all = bankTasks(JSON.parse(fs.readFileSync(file, 'utf8')), flag('--commit'), flag('--by') || 'commons-seed');
  if (dry) {
    const big = all.reduce((m, x) => Math.max(m, x.args.text.length), 0);
    console.log(`${all.length} targets; ${all.filter(x => x.args.tags.includes('commit-only')).length} commit-only; longest text ${big} characters`);
    console.log('\n' + all[0].args.text);
    return;
  }
  let seq = 0;
  const rpc = async (body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  };
  const call = (name, args) => ({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } });
  const held = [];
  for (let offset = 0; ; offset += 50) {
    const r = (await rpc(call('hub_task_list', { status: 'all', limit: 50, offset, full: true }))).result;
    if (r.isError) throw new Error(r.content[0].text);
    const page = JSON.parse(r.content[0].text);
    held.push(...page.tasks);
    if (offset + 50 >= page.total) break;
  }
  const have = heldIds(held);
  const todo = all.filter(x => !have.has(x.bankId));
  console.log(`${all.length} targets in the bank, ${have.size} already in the commons, ${todo.length} to add`);
  // A request carries at most 512 KB: batches are cut well under that.
  let added = 0, refused = 0;
  for (let i = 0; i < todo.length;) {
    const batch = [];
    let bytes = 0;
    while (i < todo.length && (!batch.length || bytes + todo[i].args.text.length < 300000)) { bytes += todo[i].args.text.length; batch.push(todo[i++]); }
    const res = await rpc(batch.map(x => call('hub_task_add', x.args)));
    const byId = new Map(res.map(r => [r.id, r]));
    for (const [k, x] of batch.entries()) {
      const r = byId.get(seq - batch.length + 1 + k);
      if (r && r.result && !r.result.isError) added++;
      else { refused++; console.log(`refused ${x.bankId}: ${r ? (r.result ? r.result.content[0].text : r.error.message) : 'no answer'}`); }
    }
  }
  console.log(`added ${added}, refused ${refused}`);
  if (refused) process.exit(1);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
