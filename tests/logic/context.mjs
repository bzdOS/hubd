// context.mjs — what a session reads first: the protocol, context and whereami, claims, search, recall, whatsnew, usage, scope
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, ok, mktmp, cli, core, usageLib, recallLib, done } from './_h.mjs';

// ── protocol: ensureProtocol materialises HUBD.md (versioned, gitignored, per-node) ──
const TP = mktmp();
core.setHubBase(TP); core.ensureHubDirs();
const e1 = core.ensureProtocol();
ok(e1.wrote === true && e1.version === core.VERSION, 'ensureProtocol: writes HUBD.md stamped with the installed version');
const hubmd = fs.readFileSync(path.join(TP, 'HUBD.md'), 'utf8');
ok(new RegExp('hubd-protocol v' + core.VERSION.replace(/\./g, '\\.')).test(hubmd), 'protocol: HUBD.md carries the version stamp');
ok(/hub claim/.test(hubmd) && /hub report/.test(hubmd) && /play-by-play/.test(hubmd), 'protocol: HUBD.md teaches claim-vs-report');
ok(core.ensureProtocol().wrote === false, 'ensureProtocol: idempotent when current (no rewrite)');
ok(core.ensureProtocol(true).wrote === true, 'ensureProtocol: force rewrites');
ok(core.HUB_GITIGNORE.includes('HUBD.md'), 'protocol: HUBD.md is a node-local line (ignored per node, not mesh-synced)');
fs.rmSync(TP, { recursive: true, force: true });

// ── harvest: package-shipped prompt via core + MCP (not fetched from the repo) ──
const hp = core.harvestPrompt();
ok(hp && /Harvest this dialog/.test(hp), 'harvestPrompt: returns the paste-able Harvest Protocol prompt');
ok(/DECIDE:/.test(hp) && !/hub report "<decisions/.test(hp), 'harvestPrompt: OUTPUT uses the structured report, not the old prose blob');
const idxReqs = [
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
  JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'harvest' } }),
].join('\n') + '\n';
let mcpOut = '';
try { mcpOut = execSync(`node ${REPO}/hub/index.mjs`, { input: idxReqs, encoding: 'utf8', env: { ...process.env, HUBD_DIR: mktmp() }, timeout: 15000 }); }
catch (e) { mcpOut = (e.stdout || ''); }
ok(/"prompts"\s*:\s*\{/.test(mcpOut), 'MCP: initialize advertises the prompts capability');
ok(/"name"\s*:\s*"harvest"/.test(mcpOut), 'MCP: prompts/list advertises harvest');
ok(/Harvest this dialog/.test(mcpOut), 'MCP: prompts/get returns the harvest prompt text');

// ── resolveContext/runContext: cwd → project bootstrap ──
// marker file wins; then a card's recorded sync path; then a folder-name guess
// ONLY if that exact card already exists; else null with a hint. Never crosses
// above the nearest .git root while looking for a marker.
const ctxRoot1 = mktmp();
core.setHubBase(ctxRoot1); core.ensureHubDirs();
const ctxOuterDir = path.join(ctxRoot1, 'outer');
const ctxRepoDir = path.join(ctxOuterDir, 'repo');
const ctxNestedDir = path.join(ctxRepoDir, 'src', 'deep');
fs.mkdirSync(ctxNestedDir, { recursive: true });
fs.mkdirSync(path.join(ctxRepoDir, '.git'));
fs.writeFileSync(path.join(ctxOuterDir, '.hubd'), 'wrong-project\n');   // above the .git root — must be ignored
fs.writeFileSync(path.join(ctxRepoDir, '.hubd'), 'Right Project\n');    // at the repo root — must win
const ctxA = core.resolveContext(ctxNestedDir);
ok(ctxA.project === 'right-project', `context marker: slugified, found by walking up from a nested dir (got ${ctxA.project})`);
ok(ctxA.via === 'marker' && ctxA.guessed === false && ctxA.root === ctxRepoDir, 'context marker: via=marker, root=repo, not guessed');
fs.rmSync(ctxRoot1, { recursive: true, force: true });

const ctxRoot1b = mktmp();
core.setHubBase(ctxRoot1b); core.ensureHubDirs();
const ctxOuterDir2 = path.join(ctxRoot1b, 'outer2');
const ctxRepoDirB = path.join(ctxOuterDir2, 'repoB');
fs.mkdirSync(ctxRepoDirB, { recursive: true });
fs.mkdirSync(path.join(ctxRepoDirB, '.git'));
fs.writeFileSync(path.join(ctxOuterDir2, '.hubd'), 'should-not-be-used\n');   // above the repo root
const ctxB = core.resolveContext(ctxRepoDirB);
ok(ctxB.project === null && ctxB.via === 'none', `context marker: never searches above the .git root (got project=${ctxB.project}, via=${ctxB.via})`);
fs.rmSync(ctxRoot1b, { recursive: true, force: true });

const ctxRoot2 = mktmp();
core.setHubBase(ctxRoot2); core.ensureHubDirs();
const ctxSyncedDir = path.join(ctxRoot2, 'somefolder');
fs.mkdirSync(ctxSyncedDir, { recursive: true });
core.runSync({ path: ctxSyncedDir, name: 'Custom Name', digest: 'd1', agent: 'test' });   // slug custom-name != folder name
const ctxC = core.resolveContext(ctxSyncedDir);
ok(ctxC.project === 'custom-name', `context path-match: resolves via the card's recorded sync path (got ${ctxC.project})`);
ok(ctxC.via === 'path' && ctxC.guessed === false, 'context path-match: via=path, not guessed');
const ctxSyncedSub = path.join(ctxSyncedDir, 'sub');
fs.mkdirSync(ctxSyncedSub, { recursive: true });
const ctxD = core.resolveContext(ctxSyncedSub);
ok(ctxD.project === 'custom-name', `context path-match: also resolves from a subdirectory of the synced path (got ${JSON.stringify(ctxD)})`);
fs.rmSync(ctxRoot2, { recursive: true, force: true });

const ctxRoot3 = mktmp();
core.setHubBase(ctxRoot3); core.ensureHubDirs();
core.runCardSet({ project: 'myapp', digest: 'kickoff', by: 'test' });   // harvested card, no recorded path
const ctxGuessDir = path.join(ctxRoot3, 'work', 'myapp');
fs.mkdirSync(ctxGuessDir, { recursive: true });
const ctxE = core.resolveContext(ctxGuessDir);
ok(ctxE.project === 'myapp' && ctxE.via === 'guess' && ctxE.guessed === true, `context basename-guess: matches an existing card by folder name, flagged guessed (got ${JSON.stringify(ctxE)})`);
fs.rmSync(ctxRoot3, { recursive: true, force: true });

const ctxRoot4 = mktmp();
core.setHubBase(ctxRoot4); core.ensureHubDirs();
const ctxUnknownDir = path.join(ctxRoot4, 'totally-unknown-folder-xyz');
fs.mkdirSync(ctxUnknownDir, { recursive: true });
const ctxF = core.resolveContext(ctxUnknownDir);
ok(ctxF.project === null && ctxF.via === 'none', `context no-match: project null, via=none (got ${JSON.stringify(ctxF)})`);
ok(typeof ctxF.hint === 'string' && ctxF.hint.length > 0, 'context no-match: hint present to guide the caller');
fs.rmSync(ctxRoot4, { recursive: true, force: true });

const ctxRoot5 = mktmp();
core.setHubBase(ctxRoot5); core.ensureHubDirs();
const ctxFullDir = path.join(ctxRoot5, 'proj5');
fs.mkdirSync(ctxFullDir, { recursive: true });
fs.writeFileSync(path.join(ctxFullDir, '.hubd'), 'proj5\n');
core.runCardSet({ project: 'proj5', digest: 'the digest text', by: 'test' });
core.runTaskAdd({ project: 'proj5', text: 'do the thing', by: 'test' });
core.runClaim({ project: 'proj5', area: 'app', agent: 'tester' });
const ctxFull = core.runContext({ cwd: ctxFullDir });
ok(ctxFull.project === 'proj5' && ctxFull.via === 'marker', 'runContext: resolves project via marker');
ok(/the digest text/.test(ctxFull.digest || ''), `runContext: digest extracted from the card (got ${ctxFull.digest})`);
ok(Array.isArray(ctxFull.openTasks) && ctxFull.openTasks.some(t => /do the thing/.test(t.text)), 'runContext: openTasks includes the seeded task');
ok(Array.isArray(ctxFull.activeClaims) && ctxFull.activeClaims.some(c => c.area === 'app'), 'runContext: activeClaims includes the seeded claim');
let ctxThrew = false;
try { core.runContext({}); } catch { ctxThrew = true; }
ok(ctxThrew, "runContext: throws without cwd (never silently falls back to the server's own cwd)");

// ── runContext as "where am I": digest age + stale, who is here, journal tail ──
ok(/^\d{4}-\d{2}-\d{2}/.test(ctxFull.digestSetAt || '') && ctxFull.digestSetBy === 'test' && ctxFull.digestAgeDays === 0,
  `runContext: digest carries when and by whom it was set (${ctxFull.digestSetAt} by ${ctxFull.digestSetBy}, age ${ctxFull.digestAgeDays})`);
ok(ctxFull.digestStale === undefined, 'runContext: a digest written today is not stale');
ok(Array.isArray(ctxFull.journalTail) && ctxFull.journalTail.length >= 1 && ctxFull.journalTail.every(e => e.project === 'proj5'),
  `runContext: journalTail holds the project's own recent entries (${ctxFull.journalTail.length})`);
{
  // Age the card's set-stamp 40 days back while the journal keeps writing → the same verdict hub_status gives.
  const cp = path.join(ctxRoot5, 'projects', 'proj5.md');
  const oldTs = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 16).replace('T', ' ');
  fs.writeFileSync(cp, fs.readFileSync(cp, 'utf8').replace(/- set: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, `- set: ${oldTs}`));
  core.runReport({ project: 'proj5', by: 'test', text: 'NOTE: work moved on' });
  const aged = core.runContext({ cwd: ctxFullDir });
  ok(aged.digestAgeDays >= 39 && aged.digestStale && aged.digestStale.daysBehind >= 39,
    `runContext: a digest 40 days behind its journal is flagged digestStale (age ${aged.digestAgeDays}, behind ${aged.digestStale && aged.digestStale.daysBehind})`);
  ok(core.runContext({ cwd: ctxFullDir, staleDays: 60 }).digestStale === undefined, 'runContext: staleDays raises the bar the same way hub_status does');
}
{
  // Two sessions heartbeat under the same root; a third works elsewhere.
  const other = path.join(ctxRoot5, 'elsewhere'); fs.mkdirSync(other, { recursive: true });
  core.runHeartbeat({ agent: 'here-a@s1', role: 'editor', cwd: ctxFullDir, status: 'editing §01' });
  core.runHeartbeat({ agent: 'here-b@s2', role: 'auditor', cwd: path.join(ctxFullDir, 'docs'), status: 'reading' });
  core.runHeartbeat({ agent: 'away-c', role: 'editor', cwd: other });
  const ph = core.runContext({ cwd: ctxFullDir }).presenceHere;
  const names = ph.map(p => p.agent).sort();
  ok(names.join(',') === 'here-a@s1,here-b@s2' && ph.every(p => p.cwd && p.last_seen && p.status !== undefined),
    `runContext: presenceHere lists the live sessions under this root and nobody else (got ${names.join(',')})`);
  const byCwd = core.runPresence({ cwd: ctxFullDir }).agents.map(p => p.agent).sort();
  const byProj = core.runPresence({ project: 'proj5' }).agents.map(p => p.agent).sort();
  ok(byCwd.join(',') === 'here-a@s1,here-b@s2' && byProj.join(',') === 'here-a@s1,here-b@s2',
    `runPresence: cwd and project filters name the same two sessions (${byCwd.join(',')} / ${byProj.join(',')})`);
  ok(!core.runPresence({ cwd: path.join(ctxFullDir, 'doc') }).agents.some(p => p.agent === 'here-b@s2'), 'runPresence: "doc" does not claim an agent sitting in "docs" (segment boundary)');
}

// ── claims as globs + hub claim check ──
{
  const P = (area, p) => (core.areaPatterns(area) || []).some(re => re.test(p));
  ok(P('src/**/*.ts', 'src/x/y.ts') && P('src/**/*.ts', 'src/a.ts') && !P('src/**/*.ts', 'lib/a.ts') && !P('src/**/*.ts', 'src/a.tsx'), 'claim glob: ** spans directories, * stays in a segment');
  ok(P('docs/{a,b}.md', 'docs/b.md') && !P('docs/{a,b}.md', 'docs/c.md'), 'claim glob: brace expansion');
  ok(P('app', 'app') && P('app', 'app/deep/file.js') && !P('app', 'application.js'), 'claim glob: a bare name covers itself and everything under it, not a prefix of another name');
  ok(P('sections/{03,04}.tex + LINEAGE.md', 'LINEAGE.md') && P('sections/{03,04}.tex + LINEAGE.md', 'sections/04.tex'), 'claim glob: several patterns joined with " + "');
  ok(core.areaPatterns('the whole article and its figures') === null, 'claim glob: prose is not matchable');
  const cA = core.runClaim({ project: 'proj5', area: 'src/**/*.ts', agent: 'agent-a' });
  ok(cA.matchable === true && cA.hint === undefined, 'claim: a glob area reports matchable');
  const cP = core.runClaim({ project: 'proj5', area: 'everything about deic', agent: 'agent-p' });
  ok(cP.matchable === false && /glob/.test(cP.hint), 'claim: a prose area reports matchable:false with a hint');
  const byB = core.runClaimCheck({ path: path.join(ctxFullDir, 'src', 'x', 'y.ts'), agent: 'agent-b' });
  ok(byB.project === 'proj5' && byB.free === false && byB.holders.length === 1 && byB.holders[0].agent === 'agent-a' && byB.holders[0].area === 'src/**/*.ts' && byB.rel === 'src/x/y.ts',
    `claim check: B asking about a file in A's zone gets A (${JSON.stringify(byB.holders)})`);
  ok(byB.unmatchable.length === 1 && byB.unmatchable[0].agent === 'agent-p', 'claim check: the prose claim is listed as unmatchable, not silently ignored');
  const byA = core.runClaimCheck({ path: path.join(ctxFullDir, 'src', 'x', 'y.ts'), agent: 'agent-a' });
  ok(byA.free === true && byA.mine.length === 1, 'claim check: the holder asking about its own zone is free, with the claim under mine');
  ok(core.runClaimCheck({ path: 'src/x/y.ts', project: 'proj5', root: ctxFullDir, agent: 'agent-b' }).free === false, 'claim check: a relative path with an explicit project works too');
  ok(core.runClaimCheck({ path: path.join(ctxFullDir, 'docs', 'readme.md'), agent: 'agent-b' }).free === true, 'claim check: a file outside every glob is free');
  core.runRelease({ id: cA.claim.id });
  ok(core.runClaimCheck({ path: path.join(ctxFullDir, 'src', 'x', 'y.ts'), agent: 'agent-b' }).free === true, 'claim check: after release the file is free');
  // "you are already editing someone's zone": a recently modified file under a live glob shows in hub_context
  core.runClaim({ project: 'proj5', area: 'docs/**', agent: 'agent-d' });
  fs.mkdirSync(path.join(ctxFullDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctxFullDir, 'docs', 'fresh.md'), 'x');
  const ct = core.runContext({ cwd: ctxFullDir, agent: 'agent-e' }).claimsTouched;
  ok(ct.touched.length === 1 && ct.touched[0].agent === 'agent-d' && ct.touched[0].files.includes('docs/fresh.md'),
    `runContext: a fresh file under another agent's glob is reported as claimsTouched (${JSON.stringify(ct.touched)})`);
  ok(core.runContext({ cwd: ctxFullDir, agent: 'agent-d' }).claimsTouched.touched.length === 0, 'runContext: the holder editing its own zone is not warned about itself');
}

// ── hub whereami: state, not narrative — context + git inventory + the project's own script ──
{
  const repo = path.join(ctxRoot5, 'wrepo'); fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  const g = (c) => execSync(`git ${c}`, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init -q');
  fs.writeFileSync(path.join(repo, '.hubd'), 'wproj\nscripts/inventory.sh\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'inventory.sh'), '#!/bin/sh\necho "registry: 3 claims withdrawn"\n'); fs.chmodSync(path.join(repo, 'scripts', 'inventory.sh'), 0o755);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one'); g('add .'); g('commit -q -m "empathy: a post-hoc split"');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two');                                   // modified, uncommitted
  fs.writeFileSync(path.join(repo, 'scripts', 'audit_items.py'), '"""Recount the 183 active items."""\nprint(1)\n');   // untracked
  core.runCardSet({ project: 'wproj', digest: 'w digest', by: 'test' });
  core.runReport({ project: 'wproj', by: 'test', text: 'DECIDE: keep IMM out | overlap explains it' });
  const w = core.runWhereAmI({ cwd: path.join(repo, 'scripts'), agent: 'me' });
  ok(w.project === 'wproj' && w.via === 'marker' && w.root === repo && w.inventory === 'scripts/inventory.sh', `whereami: resolves the marker and its second line (${w.project}, ${w.inventory})`);
  ok(w.git && w.git.commits.some(c => /empathy: a post-hoc split/.test(c)), 'whereami: commit subjects are there — the findings live in them');
  ok(w.git.dirtyFiles.some(f => /a\.txt/.test(f)) && /1 file changed/.test(w.git.dirty), `whereami: uncommitted changes with their stat (${w.git.dirty})`);
  ok(w.git.untracked.some(u => u.file === 'scripts/audit_items.py' && /Recount the 183/.test(u.firstLine)), `whereami: untracked files carry their first line (${JSON.stringify(w.git.untracked)})`);
  ok(w.git.recent.includes('a.txt') && w.git.recent.includes('scripts/audit_items.py'), 'whereami: files changed in the last 30 min are listed');
  ok(w.localInventory && /3 claims withdrawn/.test(w.localInventory.output) && !w.localInventory.missing, 'whereami: the project-local inventory script named in .hubd runs and its output is included');
  ok(w.journalTail.some(e => /keep IMM out/.test(e.text)) && w.digest === 'w digest', 'whereami: carries the hub side too (journal tail, digest)');
  fs.writeFileSync(path.join(repo, '.hubd'), 'wproj\nscripts/gone.sh\n');
  ok(core.runWhereAmI({ cwd: repo }).localInventory.missing === true, 'whereami: a named but missing inventory script is reported, not ignored');
  const plain = path.join(ctxRoot5, 'plain'); fs.mkdirSync(plain, { recursive: true });
  const wp = core.runWhereAmI({ cwd: plain });
  ok(wp.git === null && wp.localInventory === null, 'whereami: outside a git checkout the git block is null and nothing is run');
}
{
  const gdir = path.join(ctxRoot5, 'guessme'); fs.mkdirSync(gdir, { recursive: true });
  core.runCardSet({ project: 'guessme', digest: 'g', by: 'test' });
  const g = core.runContext({ cwd: gdir });
  ok(g.guessed === true && /\.hubd/.test(g.hint || '') && /"guessme"/.test(g.hint), `runContext: a guessed project comes with the one-line .hubd fix (${g.hint})`);
}
fs.rmSync(ctxRoot5, { recursive: true, force: true });

// ── hub_search: the engine returns every hit; only the server's plan trims, and it says so ──
{
  const TS = mktmp();
  core.setHubBase(TS); core.ensureHubDirs();
  const lines = Array.from({ length: 106 }, (_, i) => `- needle-82 line ${i}`).join('\n');
  fs.mkdirSync(path.join(TS, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(TS, 'projects', 'hay.md'), `# hay\n\n## Facts\n\n${lines}\n`);
  const s = core.runSearch({ query: 'needle-82' });
  ok(s.total === 106 && s.hits.length === 106, `search: engine returns all hits (hits ${s.hits.length}, total ${s.total})`);
  const c = core.capOutput(s, [['hits', 40]]);
  ok(c.hits.length === 40 && c.truncated && c.truncated.hits.shown === 40 && c.truncated.hits.hidden === 66 && /full:true/.test(c.hint),
    'search: the server plan trims to 40 and reports shown/hidden with the full:true hint');
  ok(core.capOutput(s, [['hits', 40]], { full: true }).hits.length === 106, 'search: full:true returns every hit');
  fs.rmSync(TS, { recursive: true, force: true });
}

// ── recall: ranked, and honest about age ──
const RC = mktmp();
core.setHubBase(RC); core.ensureHubDirs();
const old = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(RC, 'projects', 'p.md'),
  `# p\n\n- slug: p\n- set: ${old} by dev-t\n\n## Digest\n\nthe widget pipeline runs nightly\n\n## Decisions\n\n- ${old}: chose the widget queue over polling\n\n## Metrics\n\n- ${old}: widget throughput 40/s\n`);
fs.writeFileSync(path.join(RC, 'journal.t.jsonl'),
  JSON.stringify({ ts: core.now(), project: 'p', agent: 'dev-t', kind: 'note', text: 'touched the widget config today' }) + '\n');
const rcl = recallLib.runRecall({ query: 'widget queue', staleDays: 30 });
ok(rcl.hits.length >= 3 && rcl.hits.every(h => h.asOf !== null), 'recall: every hit carries the date it was true as of');
ok(/widget queue/i.test(rcl.hits[0].text),
  `recall: a hit matching BOTH terms outranks one matching a single term (top: ${rcl.hits[0].text.slice(0, 50)})`);
ok(rcl.hits.some(h => h.stale === true) && /verify/i.test(rcl.hint || ''),
  'recall: an old hit is flagged stale and the answer says to verify before acting');
ok(rcl.hits.some(h => h.stale === false), 'recall: a fresh hit is not flagged');
let rcErr = ''; try { recallLib.runRecall({ query: '  ' }); } catch (e) { rcErr = e.message; }
ok(/query required/.test(rcErr), 'recall: an empty query is refused, not answered with everything');

// ── recall: stop-words are not coverage, a substring is not a word, project narrows ──
fs.writeFileSync(path.join(RC, 'journal.t.jsonl'),
  JSON.stringify({ ts: core.now(), project: 'p', agent: 'dev-t', kind: 'note', text: 'touched the widget config today' }) + '\n' +
  JSON.stringify({ ts: core.now(), project: 'other', agent: 'dev-t', kind: 'note', text: 'committing the release; overlap is not a concern' }) + '\n' +
  JSON.stringify({ ts: core.now(), project: 'psy', agent: 'dev-t', kind: 'fact', text: 'IMM not established: attention overlap explains it' }) + '\n');
const rc77 = recallLib.runRecall({ query: 'IMM not established attention overlap' });
ok(rc77.dropped && rc77.dropped.includes('not') && !rc77.terms.includes('not'), `recall: "not" is dropped and reported (dropped=${JSON.stringify(rc77.dropped)})`);
ok(rc77.hits.length && /IMM not established/.test(rc77.hits[0].text), `recall: the line about the topic is the top hit (top: ${rc77.hits[0] && rc77.hits[0].text.slice(0, 40)})`);
ok(!rc77.hits.some(h => /committing the release/.test(h.text) && h.matched.includes('imm')), 'recall: "imm" does not match inside "committing"');
ok(rc77.hits.some(h => /committing the release/.test(h.text) && h.matched.length === 1 && h.matched[0] === 'overlap'),
  'recall: the other line matches on its real word only, ranked below full coverage');
ok(recallLib.runRecall({ query: 'immediately' }).total === 0 && recallLib.runRecall({ query: 'imm' }).hits.some(h => /IMM not/.test(h.text)), 'recall: prefix at a word start matches, infix never');
let rcStop = ''; try { recallLib.runRecall({ query: 'not the \u0438 \u043d\u0435' }); } catch (e) { rcStop = e.message; }
ok(/only stop-words/.test(rcStop) && /not, the/.test(rcStop), `recall: a stop-words-only query is refused and names them (${rcStop.slice(0, 60)})`);
const rcP = recallLib.runRecall({ query: 'overlap', project: 'psy' });
ok(rcP.total === 1 && rcP.hits[0].project === 'psy' && rcP.project[0] === 'psy', 'recall: project narrows to that project only');
ok(recallLib.runRecall({ query: 'overlap', project: 'psy,other' }).total === 2, 'recall: project accepts a comma-separated list');
{
  const wn = core.runWhatsNew({ agent: 'wn-77', hours: 48, project: 'psy' });
  ok(wn.entries.length === 1 && wn.entries[0].project === 'psy' && wn.project[0] === 'psy', `whatsnew: project narrows the delta (got ${wn.entries.length})`);
}

// ── whatsnew after a compaction: since:"session" returns the session's own writes; the default says why it is empty ──
{
  const first = core.runWhatsNew({ agent: 'wn-84', hours: 1 });          // session begins; checkpoint set
  ok(first.sinceMode === 'checkpoint' && first.firstCheckin === true, 'whatsnew: first call is a checkpoint call');
  core.runReport({ project: 'psy', by: 'wn-84', text: 'DECIDE: drop IMM as the central result | attention overlap explains it' });
  core.runWhatsNew({ agent: 'wn-84' });                                    // moves the checkpoint past the decision
  const dflt = core.runWhatsNew({ agent: 'wn-84' });                       // "after compaction": same key, fresh checkpoint
  ok(dflt.entries.length === 0 && /since:"session"/.test(dflt.hint || '') && /hub_context/.test(dflt.hint || ''),
    `whatsnew: a fresh checkpoint with an empty delta carries the compaction hint (${(dflt.hint || '').slice(0, 60)})`);
  const sess = core.runWhatsNew({ agent: 'wn-84', since: 'session' });
  ok(sess.sinceMode === 'session' && sess.entries.some(e => e.agent === 'wn-84' && /drop IMM/.test(e.text)) && sess.hint === undefined,
    `whatsnew: since:"session" returns the session's own decision (${sess.entries.length} entries since ${sess.since})`);
  const iso = core.runWhatsNew({ agent: 'wn-84', since: new Date(Date.now() - 3600000).toISOString() });
  ok(iso.sinceMode === 'time' && iso.entries.some(e => /drop IMM/.test(e.text)), 'whatsnew: an ISO since works as a plain window');
  let wErr = ''; try { core.runWhatsNew({ agent: 'wn-84', since: 'yesterday-ish' }); } catch (e) { wErr = e.message; }
  ok(/not "checkpoint", "session" or an ISO time/.test(wErr), 'whatsnew: a malformed since is refused, not silently treated as checkpoint');
}

// ── output hygiene: no-op resource set is not an event; repeats fold; onboarding has a short mode ──
{
  const r1 = core.runResourceSet({ slug: 'geo-proxy', type: 'endpoint', address: '127.0.0.1:10809', status: 'live', by: 'fo' });
  const r2 = core.runResourceSet({ slug: 'geo-proxy', type: 'endpoint', address: '127.0.0.1:10809', status: 'live', by: 'fo' });
  ok(r1.unchanged === undefined && r2.unchanged === true, 'resource set: a byte-identical second set reports unchanged');
  const rsLines = core.journalTail(null, 200).filter(e => e.kind === 'resource' && /geo-proxy/.test(e.text));
  ok(rsLines.length === 1, `resource set: the no-op set wrote no journal line (${rsLines.length} line(s))`);
  const stamp = (fs.readFileSync(path.join(RC, 'resources', 'geo-proxy.md'), 'utf8').match(/- set: ([^\n]+)/) || [])[1];
  const r3 = core.runResourceSet({ slug: 'geo-proxy', status: 'planned', by: 'fo' });
  ok(r3.unchanged === undefined && stamp && /status: planned/.test(fs.readFileSync(path.join(RC, 'resources', 'geo-proxy.md'), 'utf8')),
    'resource set: a real change is written and reported as a change');
  // fold identical entries — written minutes apart, because two byte-identical lines in one minute
  // never reach the reader at all (readLogEntries drops the copy); the real case was ten hours apart.
  const tsAgo = (min) => new Date(Date.now() - min * 60000).toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(path.join(RC, 'journal.t.jsonl'),
    JSON.stringify({ ts: tsAgo(30), project: 'fold', agent: 'fo', kind: 'resource', text: 'resource set: geo-proxy' }) + '\n' +
    JSON.stringify({ ts: tsAgo(10), project: 'fold', agent: 'fo', kind: 'resource', text: 'resource set: geo-proxy' }) + '\n' +
    JSON.stringify({ ts: tsAgo(5), project: 'fold', agent: 'fo', kind: 'note', text: 'a different line' }) + '\n');
  const wf = core.runWhatsNew({ agent: 'wn-83', hours: 1, project: 'fold' });
  const folded = wf.entries.filter(e => /resource set: geo-proxy/.test(e.text));
  ok(folded.length === 1 && folded[0].times === 2 && folded[0].firstTs === tsAgo(30) && folded[0].ts === tsAgo(10) && wf.entries.length === 2,
    `whatsnew: two identical entries fold into one with times:2 (${wf.entries.length} entries, times ${folded[0] && folded[0].times})`);
  ok(core.collapseRepeats([]).length === 0 && core.collapseRepeats([{ kind: 'note', text: 'x' }])[0].times === undefined, 'collapseRepeats: a single entry carries no times');
  // onboarding modes
  const ob = core.runOnboarding();
  const words = ob.protocol.split(/\s+/).filter(Boolean).length;
  ok(ob.mode === 'short' && words <= 600 && /\| you want to say \|/.test(ob.protocol) && /Say who you are/.test(ob.protocol) && /Session ritual/.test(ob.protocol),
    `onboarding: default is the short mode with the channel table, author rule and ritual (${words} words)`);
  ok(Array.isArray(ob.sections) && ob.sections.some(s => /Queues/.test(s)) && ob.protocol.includes('- ' + ob.sections[0]) && /mode:"full"/.test(ob.hint),
    'onboarding short: lists every section of the full manual and says how to get it');
  const full = core.runOnboarding({ mode: 'full' });
  ok(full.mode === 'full' && full.protocol.split(/\s+/).length > 3000 && /## Queues/.test(full.protocol), 'onboarding full: the whole manual');
  let obErr = ''; try { core.runOnboarding({ mode: 'medium' }); } catch (e) { obErr = e.message; }
  ok(/not "short" or "full"/.test(obErr), 'onboarding: an unknown mode is refused');
}

// ── usage: measured and supplied never mix ──
const US = mktmp();
core.setHubBase(US); core.ensureHubDirs();
let usErr = ''; try { usageLib.runUsageAdd({ agent: 'dev-t', project: 'p' }); } catch (e) { usErr = e.message; }
ok(/nothing to record/.test(usErr),
  'usage: an entry with no numbers is refused — an absent value must not become a recorded zero');
usageLib.runUsageAdd({ agent: 'dev-t', project: 'p', seconds: 900, tokensIn: 120000, tokensOut: 8000, costUsd: 1.85, model: 'm' });
usageLib.runUsageAdd({ agent: 'other-t', project: 'q', costUsd: 0.15 });
const usTask = core.runTaskAdd({ project: 'p', text: 'closed one', by: 'dev-t' }).task;
core.runTaskUpdate({ id: usTask.id, status: 'done', by: 'dev-t' });
const us = usageLib.runUsage({ days: 7 });
ok(us.supplied.calls === 2 && us.supplied.costUsd === 2 && us.supplied.tokensIn === 120000,
  `usage: supplied numbers aggregate (${JSON.stringify({ c: us.supplied.calls, $: us.supplied.costUsd })})`);
ok(us.supplied.byProject.p.seconds === 900 && us.supplied.byAgent['other-t'].costUsd === 0.15,
  'usage: split by project and by agent');
ok(us.measured.tasksClosed === 1 && /SUPPLIED/.test(us.note) && /MEASURED/.test(us.note),
  'usage: the measured half is the hub\'s own arithmetic, and the answer says which half is which');
ok(usageLib.runUsage({ days: 7, project: 'q' }).supplied.calls === 1, 'usage: filters by project');

// ── scope layers: the operator, the private braid, the rules ──
const SL = mktmp();
core.setHubBase(SL); core.ensureHubDirs();
const opMissing = core.runOperatorGet();
ok(opMissing.exists === false && /hub_card_set/.test(opMissing.hint) && /Boundaries/.test(opMissing.scaffold),
  'operator: absent card returns how to make one, not an error');
core.runCardSet({ project: 'operator', digest: 'the one human', by: 'dev-t' });
core.runSectionAdd({ project: 'operator', section: 'Boundaries', text: 'health is never collected', by: 'dev-t' });
core.runCardSet({ project: 'realproject', digest: 'a real one', by: 'dev-t' });
ok(core.runOperatorGet().exists === true, 'operator: reads back');
ok(!core.runStatus().projects.some(p => p.project === 'operator') &&
   core.runStatus().projects.some(p => p.project === 'realproject'),
  'operator: it is a card but NOT a project — it never appears in the project table');
ok(recallLib.runRecall({ query: 'health collected' }).hits.some(h => /never collected/.test(h.text)),
  'operator: recall reaches it on purpose — person-level facts are exactly what recall is for');

const priv = core.runReport({ project: 'personal', by: 'dev-t', text: 'energy was low', private: true });
ok(priv.private === true && fs.existsSync(path.join(SL, 'journal.life.jsonl')),
  'private: prose goes to the local-only life braid');
ok(!fs.readFileSync(path.join(SL, `journal.${core.JOURNAL_NODE}.jsonl`), 'utf8').includes('energy was low'),
  'private: and NOT into the mesh-synced journal');
ok(JSON.parse(fs.readFileSync(path.join(SL, 'journal.life.jsonl'), 'utf8').trim()).private === true,
  'private: the entry is stamped, so anything copying text can tell what it is holding');
ok(fs.readFileSync(path.join(SL, '.gitignore'), 'utf8').includes('journal.life.jsonl'),
  'private: the braid is gitignored — never mesh-synced');
let privErr = '';
try { core.runReport({ project: 'personal', by: 'dev-t', text: 'FACT: public thing', private: true }); } catch (e) { privErr = e.message; }
ok(/only prose lines can be private/.test(privErr),
  'private: mixing a structured prefix with private is refused instead of quietly publishing it');

fs.writeFileSync(path.join(SL, 'AGENTS.md'), '# rules\n\nThe first rule.\n');
ok(/The first rule/.test(core.runRules({}).text), 'rules: readable over the tool');
const amended = core.runRules({ append: 'gates need dates', by: 'cto-t' });
const rulesText = fs.readFileSync(path.join(SL, 'AGENTS.md'), 'utf8');
ok(/## Amendments/.test(rulesText) && /gates need dates/.test(rulesText) && /The first rule/.test(rulesText),
  'rules: an amendment is appended under one heading and the original text is untouched');
ok(/cto-t/.test(amended.appended) && /\d{4}-\d{2}-\d{2}/.test(amended.appended),
  'rules: the amendment is dated and attributed — an incident has to be able to quote it');
core.runRules({ append: 'and a second one', by: 'cto-t' });
ok((fs.readFileSync(path.join(SL, 'AGENTS.md'), 'utf8').match(/## Amendments/g) || []).length === 1,
  'rules: a second amendment joins the same heading instead of starting another');

// ── hub whereami from a shell: from the marker, as JSON, and outside any project ──
{
  const WD = mktmp(), W = path.join(WD, 'wrepo'); fs.mkdirSync(W); fs.writeFileSync(path.join(W, '.hubd'), 'wsmoke\n');
  execSync('git init -q && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m "first light"', { cwd: W, stdio: 'ignore' });
  const w = cli(['whereami'], { cwd: W, env: { HUBD_AGENT: 'smoke' } });
  ok(w.code === 0 && /^project: {2}wsmoke/m.test(w.out) && /first light/.test(w.out), 'whereami: the CLI names the project from the marker and lists the commit subjects');
  let wj = null; try { wj = JSON.parse(cli(['whereami', '--json'], { cwd: W }).stdout); } catch {}
  ok(wj && wj.project === 'wsmoke' && Array.isArray(wj.git && wj.git.commits), 'whereami --json: the same answer, machine-readable');
  const wn = cli(['whereami'], { cwd: WD });
  ok(wn.code === 0 && /project: {2}\(none\)/.test(wn.out), 'whereami: outside any project it still answers, with (none)');
}

done();
