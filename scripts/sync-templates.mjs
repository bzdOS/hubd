#!/usr/bin/env node
// sync-templates.mjs — one-way sync of shared prompt files into hubd-company/.
//
// The company template ships SNAPSHOTS of files whose source of truth is the
// repo root. Editing the copy is the drift this script exists to kill: the
// copies once sat untouched through a whole protocol rewrite and kept teaching
// agents the old mechanics. Edit the root file, run this, commit both.
//
//   node scripts/sync-templates.mjs          # rewrite stale snapshots
//   node scripts/sync-templates.mjs --check  # exit 1 if any snapshot is stale (gate)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!-- snapshot synced from the hubd repo root; edit the root copy, then run: node scripts/sync-templates.mjs -->';
const PAIRS = [
  ['prompts/claude-code.md', 'hubd-company/prompts/claude-code.md'],
  ['prompts/cursor.md', 'hubd-company/prompts/cursor.md'],
  ['prompts/agents-md.md', 'hubd-company/prompts/agents-md.md'],
  ['prompts/mcp-chat.md', 'hubd-company/prompts/mcp-chat.md'],
  ['prompts/inventory.md', 'hubd-company/recipes/inventory.md'],
  ['HARVEST.md', 'hubd-company/HARVEST.md'],
];

const check = process.argv.includes('--check');
let stale = 0;
for (const [src, dst] of PAIRS) {
  const want = MARKER + '\n' + fs.readFileSync(path.join(ROOT, src), 'utf8');
  let have = null;
  try { have = fs.readFileSync(path.join(ROOT, dst), 'utf8'); } catch {}
  if (have === want) continue;
  stale++;
  if (check) { console.error(`stale snapshot: ${dst} (source: ${src})`); continue; }
  fs.writeFileSync(path.join(ROOT, dst), want, 'utf8');
  console.log(`synced ${src} -> ${dst}`);
}
if (check && stale) { console.error(`${stale} stale snapshot(s) - run: node scripts/sync-templates.mjs`); process.exit(1); }
console.log(check ? 'snapshots current' : (stale ? `${stale} file(s) written` : 'nothing to do - all snapshots current'));
