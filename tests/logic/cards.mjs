// cards.mjs — cards: what a write keeps, the template, report routing, sync metrics, a conflicted card, merge
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ok, mktmp, run, cli, T0, core, doc, conflictsLib, cardsLib, done } from './_h.mjs';

// ── core: card-set / sync must preserve ALL owner sections, not just "## Facts" ──
// regression: the writer used to keep only "## Facts" and silently drop any other
// hand section (roadmap/gates/decisions) — card data loss on every rewrite.
const TC = mktmp();
core.setHubBase(TC);            // creates projects/ + projects/history/
fs.writeFileSync(path.join(TC, 'projects', 'demo.md'),
  '---\nslug: demo\nowner_kind: mixed\n---\n# demo\n\n- slug: demo\n\n' +
  '## Digest\n\nold digest\n\n' +
  '## Facts\n\n- hand fact\n\n' +
  '## Roadmap\n\n- ship it\n\n' +
  '## Decisions\n\n- chose files-first\n');
core.runCardSet({ project: 'demo', digest: 'fresh digest v6', by: 'test' });
const cs = core.readCard('demo');
ok(/fresh digest v6/.test(cs), 'card-set: digest updated');
ok(/## Facts[\s\S]*hand fact/.test(cs), 'card-set: hand "## Facts" preserved');
ok(/## Roadmap[\s\S]*ship it/.test(cs), 'card-set: custom "## Roadmap" preserved (no data loss)');
ok(/## Decisions[\s\S]*files-first/.test(cs), 'card-set: custom "## Decisions" preserved');
ok(/owner_kind: mixed/.test(cs), 'card-set: frontmatter preserved');
ok(!/## Next step/.test(cs), 'card-set: existing card NOT re-scaffolded with the template');
ok(fs.existsSync(path.join(TC, 'projects', 'history', 'demo.md')), 'card-set: old digest archived to history');

// ── card-set patch mode: fix one line, leave the owner's framing byte-for-byte ──
core.runCardSet({ project: 'demo', by: 'test', digest: 'OWNER FRAME — lane A, gate #87 first\nstatus: article v17, 156-item instrument\nwave-2 deploy pending' });
const pr = core.runCardSet({ project: 'demo', by: 'test', replace: [{ from: 'v17, 156-item', to: 'v19 (unpublished), 183-item' }], appendLine: 'wave-2 in production since 10.08' });
ok(pr.patched && pr.patched.length === 2 && pr.digest === 'OWNER FRAME — lane A, gate #87 first\nstatus: article v19 (unpublished), 183-item instrument\nwave-2 deploy pending\nwave-2 in production since 10.08',
  `card-set patch: one substring swapped, one line appended, everything else intact (got ${JSON.stringify(pr.digest)})`);
ok(core.digestOf(core.readCard('demo')) === pr.digest && /- set: \d{4}-\d{2}-\d{2} \d{2}:\d{2} by test/.test(core.readCard('demo')), 'card-set patch: the card holds the patched digest and a fresh set-stamp');
let perr = ''; try { core.runCardSet({ project: 'demo', by: 'test', replace: [{ from: 'not in there', to: 'x' }] }); } catch (e) { perr = e.message; }
ok(/not in the digest/.test(perr) && /nothing changed/.test(perr) && core.digestOf(core.readCard('demo')) === pr.digest, 'card-set patch: a from that is absent is an error and the digest is untouched');
perr = ''; try { core.runCardSet({ project: 'demo', by: 'test', replace: [{ from: 'wave-2', to: 'x' }] }); } catch (e) { perr = e.message; }
ok(/more than once/.test(perr), 'card-set patch: an ambiguous from (two occurrences) is refused rather than guessed');
perr = ''; try { core.runCardSet({ project: 'demo', by: 'test', digest: 'whole', replace: [{ from: 'a', to: 'b' }] }); } catch (e) { perr = e.message; }
ok(/not both/.test(perr), 'card-set patch: digest and replace together are refused');
perr = ''; try { core.runCardSet({ project: 'demo', by: 'test' }); } catch (e) { perr = e.message; }
ok(/digest required/.test(perr) && /replace/.test(perr), 'card-set: no digest and no patch → the error names both ways in');
{
  // hub_report says how old the digest is, and nudges once it trails the journal it just moved.
  const r0 = core.runReport({ project: 'demo', by: 'test', text: 'NOTE: same-day report' });
  ok(r0.digestAgeDays === 0 && r0.digestStale === undefined && r0.hint === undefined, 'report: a same-day digest gets its age and no nudge');
  const cp = path.join(TC, 'projects', 'demo.md');
  const oldTs = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 16).replace('T', ' ');
  fs.writeFileSync(cp, fs.readFileSync(cp, 'utf8').replace(/- set: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, `- set: ${oldTs}`));
  const r1 = core.runReport({ project: 'demo', by: 'test', text: 'FACT: wave-2 held for a week without incident' });
  ok(r1.digestAgeDays >= 19 && r1.digestStale && r1.digestStale.daysBehind >= 19 && /replace/.test(r1.hint || '') && /20\d\d-/.test(r1.hint || ''),
    `report: a digest 20 days behind the journal it just moved gets a nudge naming the last set date and the patch route (${(r1.hint || '').slice(0, 80)})`);
  ok(core.runReport({ project: 'demo', by: 'test', text: 'NOTE: lenient', staleDays: 60 }).hint === undefined, 'report: staleDays raises the bar');
}
core.runSync({ path: TC, name: 'demo', digest: 'synced digest', agent: 'test' });
const sy = core.readCard('demo');
ok(/## Roadmap[\s\S]*ship it/.test(sy), 'sync: custom "## Roadmap" preserved');
ok(/## Decisions[\s\S]*files-first/.test(sy), 'sync: custom "## Decisions" preserved');
ok(/## Facts \(auto\)/.test(sy), 'sync: regenerates its own "## Facts (auto)"');
fs.rmSync(TC, { recursive: true, force: true });

// ── core: a NEW card is scaffolded from the card template; HUB/card-template.md overrides ──
const TN = mktmp();
core.setHubBase(TN);
core.runCardSet({ project: 'fresh', digest: 'kickoff', by: 'test' });
const nc = core.readCard('fresh');
ok(/kickoff/.test(nc), 'new card: digest set');
ok(/## Next step/.test(nc), 'new card: scaffolds "## Next step"');
ok(/## Gates/.test(nc), 'new card: scaffolds "## Gates"');
ok(/## Decisions/.test(nc), 'new card: scaffolds "## Decisions"');
ok(/## Communication/.test(nc), 'new card: scaffolds "## Communication"');
fs.writeFileSync(path.join(TN, 'card-template.md'), '## Custom Section\n\noverride body\n');
core.runCardSet({ project: 'fresh2', digest: 'd2', by: 'test' });
const oc = core.readCard('fresh2');
ok(/## Custom Section[\s\S]*override body/.test(oc), 'new card: HUB/card-template.md override is used');
ok(!/## Gates/.test(oc), 'new card: override replaces the built-in template');
fs.rmSync(TN, { recursive: true, force: true });

// ── core: sync of a NEW project scaffolds the template + auto "open tasks" in Facts (auto) ──
const TG = mktmp();
core.setHubBase(TG);
const proj = path.join(TG, 'proj');
fs.mkdirSync(proj, { recursive: true });
core.runSync({ path: proj, name: 'proj', digest: 'first', agent: 'test' });
const gc = core.readCard('proj');
ok(/## Next step/.test(gc) && /## Communication/.test(gc), 'sync new card: template scaffolded');
ok(/## Facts \(auto\)[\s\S]*open tasks: 0/.test(gc), 'sync: Facts (auto) carries the auto open-tasks count');
fs.rmSync(TG, { recursive: true, force: true });

// ── resources: card with structured attrs + typed edges, the graph, and task↔resource ──
const TR = mktmp();
core.setHubBase(TR);
core.runResourceSet({ slug: 'vm1', type: 'host', address: '10.0.0.1', status: 'live', by: 'test' });
core.runResourceSet({ slug: 'vm1', edges: { runs_on: ['hubd'] }, by: 'test' });   // 2nd set: add edge, keep attrs
const rcard = core.readResource('vm1');
ok(/kind: resource/.test(rcard), 'resource: kind in frontmatter');
ok(/type: host/.test(rcard) && /address: 10\.0\.0\.1/.test(rcard), 'resource: structured attrs in frontmatter');
ok(/status: live/.test(rcard), 'resource: attrs survive a 2nd set (merge, no clobber)');
ok(/runs_on: \[\[hubd\]\]/.test(rcard), 'resource: typed edge written to frontmatter');
ok(core.runResourceList().count === 1, 'resource list: counts the card');
const g = core.runGraph();
ok(g.edges.some(e => e.from === 'vm1' && e.rel === 'runs_on' && e.to === 'hubd'), 'graph: vm1 —runs_on→ hubd');
ok(g.dangling.some(d => d.to === 'hubd'), 'graph: dangling [[hubd]] flagged (no card yet)');
fs.writeFileSync(path.join(TR, 'projects', 'hubd.md'), '---\nslug: hubd\nruns_on: [[vm1]]\n---\n# hubd\n\n## Digest\n\nx\n');
const g2 = core.runGraph();
ok(!g2.dangling.some(d => d.to === 'hubd'), 'graph: link resolves once the card exists');
ok(g2.edges.some(e => e.from === 'hubd' && e.rel === 'runs_on' && e.to === 'vm1'), 'graph: project→resource edge read from project frontmatter');
const tk = core.runTaskAdd({ project: 'hubd', text: 'patch the box', resources: ['vm1'], by: 'test' });
ok(Array.isArray(tk.task.resources) && tk.task.resources[0] === 'vm1', 'task: resources field stored on add');
ok(core.runTaskList({ project: 'hubd' }).tasks[0].resources[0] === 'vm1', 'task list: resources survive the event fold');
fs.rmSync(TR, { recursive: true, force: true });

// ── structured report: prefix batch → card sections + task events + note ──
const TRP = mktmp();
core.setHubBase(TRP);
const seed = core.runTaskAdd({ project: 'proj', text: 'old task', by: 'test' }).task.id;
const batch = [
  'DECIDE: ship docs in release | npm README drifted',
  'DECISION: register 0.1.8 | mcpservers approved',   // synonym → decide
  'FACT: registry JWT expires in minutes',
  'GOTCHA: pkg ABI is FreeBSD-15-aarch64',            // synonym → fact
  'HYPO: acme in fundraising',
  'COMM: 0.1.8 live on mcpservers',
  'NEXT: redeploy vm1',
  'DONE: ' + seed,
  'TASK: write the changelog',
  'NOTE: distribution session',
  'an unprefixed trailing thought',                   // → note
].join('\n');
const rep = core.runReport({ project: 'proj', by: 'test', text: batch });
const rc = core.readCard('proj');
ok(rep.decisions === 2, `report: 2 decisions incl. DECISION synonym (got ${rep.decisions})`);
ok(/## Decisions[\s\S]*ship docs in release — npm README drifted/.test(rc), 'report: decision+why → ## Decisions');
ok(/## Decisions[\s\S]*register 0\.1\.8 — mcpservers approved/.test(rc), 'report: 2nd decision present (multiplicity)');
ok(/## Facts & hypotheses[\s\S]*fact: registry JWT expires/.test(rc), 'report: FACT → Facts & hypotheses');
ok(/## Facts & hypotheses[\s\S]*fact: pkg ABI is FreeBSD-15-aarch64/.test(rc), 'report: GOTCHA synonym → fact');
ok(/## Facts & hypotheses[\s\S]*hypothesis: acme in fundraising/.test(rc), 'report: HYPO → hypothesis');
ok(/## Communication[\s\S]*0\.1\.8 live on mcpservers/.test(rc), 'report: COMM → ## Communication');
const nextBody = rc.split('## Next step')[1].split(/\n## /)[0];
ok(/redeploy vm1/.test(nextBody) && !/<the one next action/.test(nextBody), 'report: NEXT set ## Next step (replaced placeholder)');
ok(core.runTaskList({ project: 'proj', status: 'done' }).tasks.some(t => t.id === seed), 'report: DONE closed the seeded task');
ok(core.runTaskList({ project: 'proj', status: 'open' }).tasks.some(t => /changelog/.test(t.text)), 'report: TASK opened a new task');
const jp = core.journalTail('proj', 50);
ok(jp.filter(e => e.kind === 'decision').length === 2, 'report: decisions emit kind:decision journal events');
ok(jp.some(e => e.kind === 'note' && /distribution session/.test(e.text) && /unprefixed trailing/.test(e.text)), 'report: NOTE + unprefixed → one note entry');
ok(/- redeploy vm1 — set \d{4}-\d{2}-\d{2} \d{2}:\d{2} by test/.test(nextBody), 'report: NEXT carries who set it and when');
ok(rep.nextReplaced === undefined, 'report: replacing a placeholder reports nothing replaced');

// ── NEXT: never silent, and an owner's step is not overwritten by a non-owner ──
const r2 = core.runReport({ project: 'proj', by: 'test', text: 'NEXT: second step' });
ok(r2.nextReplaced && r2.nextReplaced.text === 'redeploy vm1' && r2.nextReplaced.by === 'test' && /^\d{4}-/.test(r2.nextReplaced.at || ''),
  `report: NEXT replacing a step returns nextReplaced {text, by, at} (got ${JSON.stringify(r2.nextReplaced)})`);
let nb = core.sectionBody(core.readCard('proj'), 'Next step');
ok(/^- second step — set .* by test$/m.test(nb) && /^- prev \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}, by test\): redeploy vm1$/m.test(nb),
  'report: the card keeps the new step plus ONE dated prev line');
core.runReport({ project: 'proj', by: 'test', text: 'NEXT: third step' });
nb = core.sectionBody(core.readCard('proj'), 'Next step');
ok((nb.match(/^- prev \(/gm) || []).length === 1 && /prev \(.*\): second step$/m.test(nb) && !/redeploy vm1/.test(nb),
  'report: a second replacement keeps exactly one prev line (the latest), not a history');
fs.writeFileSync(path.join(TRP, 'owner-roles.json'), JSON.stringify(['owner-t']));
core.runReport({ project: 'proj', by: 'owner-t', text: 'NEXT: test the live build by hand first' });
let refused = null;
try { core.runReport({ project: 'proj', by: 'test', text: 'NEXT: publish v19' }); } catch (e) { refused = e.message; }
ok(refused && /owner role "owner-t"/.test(refused) && /test the live build by hand first/.test(refused),
  `report: non-owner NEXT over an owner step is refused and the error quotes the step (got ${refused})`);
nb = core.sectionBody(core.readCard('proj'), 'Next step');
ok(/^- test the live build by hand first — set .* by owner-t$/m.test(nb) && !/publish v19/.test(nb), 'report: refused NEXT left the card untouched');
const r3 = core.runReport({ project: 'proj', by: 'test', text: 'DECIDE: publish now | owner agreed in chat\nNEXT: publish v19', force: true });
nb = core.sectionBody(core.readCard('proj'), 'Next step');
ok(r3.next && r3.nextReplaced && r3.nextReplaced.by === 'owner-t' && /^- publish v19 — set .* by test$/m.test(nb) && /prev \(.*, by owner-t\): test the live build by hand first$/m.test(nb),
  'report: force replaces the owner step, keeps it as prev, and reports it');
const r4 = core.runReport({ project: 'proj', by: 'owner-t', text: 'NEXT: owner changes own mind' });
ok(r4.next && r4.nextReplaced && r4.nextReplaced.text === 'publish v19', 'report: an owner replaces any step without force');
fs.rmSync(TRP, { recursive: true, force: true });

// ── sections.json: ONE i18n source drives BOTH the scaffold AND report routing (0.2.0) ──
const TRO = mktmp();
core.setHubBase(TRO);
fs.writeFileSync(path.join(TRO, 'sections.json'), JSON.stringify({ decisions: 'Verdicts', next: { heading: 'Up next', hint: 'do this' } }));
core.runCardSet({ project: 'p2', digest: 'kick', by: 'test' });            // new card → scaffolded from sections.json
const p2 = core.readCard('p2');
ok(/## Verdicts/.test(p2) && !/## Decisions/.test(p2), 'sections.json: scaffold uses the overridden heading');
ok(/## Up next[\s\S]*do this/.test(p2), 'sections.json: {heading,hint} override applies to the scaffold');
core.runReport({ project: 'p2', by: 'test', text: 'DECIDE: do X | because Y' });
ok(/## Verdicts[\s\S]*do X — because Y/.test(core.readCard('p2')), 'sections.json: report routes into the SAME heading as scaffold (no drift)');
ok(core.sectionsConfig().find(s => s.key === 'decisions').heading === 'Verdicts', 'sectionsConfig: merge-by-key override');
fs.rmSync(TRO, { recursive: true, force: true });

// ── report-sections.json still honoured as a deprecated alias ──
const TRA = mktmp();
core.setHubBase(TRA);
fs.writeFileSync(path.join(TRA, 'report-sections.json'), JSON.stringify({ communication: 'Outbound' }));
core.runReport({ project: 'p3', by: 'test', text: 'COMM: shipped X' });
ok(/## Outbound[\s\S]*shipped X/.test(core.readCard('p3')), 'report-sections.json: deprecated alias still routes');
fs.rmSync(TRA, { recursive: true, force: true });

// ── git diff metrics: "nothing new" must not be reported as movement ──────────
// Bug: an empty `hashAt..HEAD` range fell into the same fallback as "no prior
// sync", which substituted the last 10 commits — so a sync with zero new commits
// reported "since last sync: 10 commit(s)". sinceLastSync now separates
// "answered, and the answer is 0" from "no baseline to answer against".
const GD = mktmp();
core.setHubBase(mktmp());   // runSync below writes a card; give it a live hub base
// Commit dates are pinned and a minute apart: the baseline is a 1-second-resolution
// timestamp, so same-second commits would be indistinguishable from the baseline.
const gitc = (args, date) => execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`,
  { cwd: GD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
gitc('init -q');
fs.writeFileSync(path.join(GD, 'a.txt'), 'one\n');
gitc('add -A'); gitc('commit -qm first', '2026-01-01T10:00:00+0000');
const firstTs = gitc('log -1 --format=%ci').trim();
fs.writeFileSync(path.join(GD, 'a.txt'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(GD, 'b.txt'), 'new file\n');
gitc('add -A'); gitc('commit -qm second', '2026-01-01T10:01:00+0000');
const headTs = gitc('log -1 --format=%ci').trim();

const dNone = core.gitDiffSummary(GD, headTs);
ok(dNone.sinceLastSync === true, 'gitDiffSummary: HEAD as baseline is a real baseline');
ok(dNone.newCommits === 0, `gitDiffSummary: nothing new → 0 commits, not the last-10 fallback (got ${dNone.newCommits})`);
ok(dNone.commitLog.length === 0, `gitDiffSummary: nothing new → empty commitLog (got ${dNone.commitLog.length})`);

const dSome = core.gitDiffSummary(GD, firstTs);
ok(dSome.sinceLastSync === true && dSome.newCommits === 1, `gitDiffSummary: one commit since baseline (got ${dSome.newCommits})`);
ok(dSome.insertions === 3 && dSome.deletions === 0 && dSome.filesChanged === 2,
  `gitDiffSummary: shortstat parsed (+${dSome.insertions}/-${dSome.deletions}, ${dSome.filesChanged} files)`);

const dNoBase = core.gitDiffSummary(GD, null);
ok(dNoBase.sinceLastSync === false && dNoBase.newCommits === 0,
  'gitDiffSummary: no baseline → sinceLastSync false and 0 new commits');
ok(dNoBase.commitLog.length === 2, `gitDiffSummary: no baseline → recent commits as context (got ${dNoBase.commitLog.length})`);

// The baseline comes out of a user-editable card and is interpolated into a
// shell command: anything not shaped like git's %ci is refused, not run.
const pwned = path.join(GD, 'PWNED');
const dEvil = core.gitDiffSummary(GD, `x"; touch ${pwned}; #`);
ok(dEvil.sinceLastSync === false, 'gitDiffSummary: malformed baseline is refused, not trusted');
ok(!fs.existsSync(pwned), 'gitDiffSummary: malformed baseline does not reach the shell');
ok(core.gitDiffSummary(mktmp(), null) === null, 'gitDiffSummary: non-git dir → null');

// runSync must not claim movement on a re-sync with no new commits.
const syncCard = core.runSync({ path: GD, name: 'difftest', agent: 't', digest: 'first pass' });
ok(syncCard.newCommits === 0, 'runSync: first sync of an unseen project claims no new commits');
const resync = core.runSync({ path: GD, name: 'difftest', agent: 't', digest: 'second pass' });
ok(resync.newCommits === 0, `runSync: re-sync with no new commits reports 0 (got ${resync.newCommits})`);
ok(!/- since last sync:/.test(fs.readFileSync(syncCard.card, 'utf8')),
  'runSync: card omits the "since last sync" line when nothing moved');

// Bug: runSync read the baseline back with /- last commit: /, but it writes that
// value as "· last commit: " on the branch line — so the baseline never parsed and
// the diff was always the no-baseline fallback. Real movement must be detected.
fs.writeFileSync(path.join(GD, 'a.txt'), 'one\ntwo\nthree\nfour\n');
gitc('add -A'); gitc('commit -qm third', '2026-01-01T10:05:00+0000');
const moved = core.runSync({ path: GD, name: 'difftest', agent: 't', digest: 'third pass' });
ok(moved.newCommits === 1, `runSync: detects the commit made since the previous sync (got ${moved.newCommits})`);
const movedCard = fs.readFileSync(moved.card, 'utf8');
ok(/- since last sync: 1 commit\(s\), 1 file\(s\), \+1\/-0 lines/.test(movedCard),
  'runSync: card reports the real diff since last sync');

// projectMetrics reads the version out of package.json.
fs.writeFileSync(path.join(GD, 'package.json'), JSON.stringify({ name: 'difftest', version: '9.9.9' }));
const pm = core.projectMetrics(GD);
ok(pm && pm.version === '9.9.9', `projectMetrics: version from package.json (got ${pm && pm.version})`);
ok(core.projectMetrics(mktmp()) === null, 'projectMetrics: nothing detectable → null');
fs.rmSync(GD, { recursive: true, force: true });

// ── the digest ends at the next heading, not at a literal "## Facts" ──
// A localised hub (sections.json) or any card whose next section simply is not "Facts"
// used to report its whole body as the digest — in hub_status, in hub_context, and as the
// baseline runSync compares against (so every sync "changed" the digest and archived the
// entire card into history).
const DG = mktmp();
core.setHubBase(DG);
fs.writeFileSync(path.join(DG, 'projects', 'loc.md'),
  '# loc\n\n- slug: loc\n- set: 2026-07-01 10:00 by dev-t\n\n## Digest\n\nthe one-line digest\n\n## Next step\n\n- do the thing\n\n## Gates\n\n- kill if X\n');
ok(core.digestOf(fs.readFileSync(path.join(DG, 'projects', 'loc.md'), 'utf8')) === 'the one-line digest',
  'digest: cut at the next ## heading, not at the word Facts');
const dgStatus = core.runStatus().projects.find(p => p.project === 'loc');
ok(dgStatus && dgStatus.digest === 'the one-line digest',
  `status: reports the digest, not the whole card (got ${JSON.stringify((dgStatus || {}).digest || '').slice(0, 60)})`);
ok(core.digestOf('# x\n\nno digest section here\n') === null, 'digest: a card without ## Digest yields null');

// ── a card that trails its own journal is flagged, a quiet project is not ──
const ymd = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 16).replace('T', ' ');
fs.writeFileSync(path.join(DG, 'projects', 'busy.md'), `# busy\n\n- slug: busy\n- set: ${ymd(40)} by dev-t\n\n## Digest\n\nold news\n`);
fs.writeFileSync(path.join(DG, 'projects', 'quiet.md'), `# quiet\n\n- slug: quiet\n- set: ${ymd(40)} by dev-t\n\n## Digest\n\nstill true\n`);
fs.writeFileSync(path.join(DG, 'journal.t.jsonl'),
  JSON.stringify({ ts: ymd(1), project: 'busy', agent: 'dev-t', kind: 'note', text: 'work kept happening' }) + '\n' +
  JSON.stringify({ ts: ymd(41), project: 'quiet', agent: 'dev-t', kind: 'note', text: 'last thing that ever happened' }) + '\n');
const lagged = core.runStatus().projects.find(p => p.project === 'busy');
const calm = core.runStatus().projects.find(p => p.project === 'quiet');
ok(lagged && lagged.digestStale && lagged.digestStale.daysBehind >= 38,
  `staleness: a card 39d behind its own journal is flagged (got ${JSON.stringify((lagged || {}).digestStale)})`);
ok(calm && !calm.digestStale, 'staleness: a dormant project whose journal stopped first is NOT flagged');
ok(core.runBrief().staleDigests.some(s => s.project === 'busy'), 'staleness: brief lists it under staleDigests');

// ── writing one section of a card, without touching the rest ──
const SEC = mktmp();
core.setHubBase(SEC);
core.runCardSet({ project: 'demo', digest: 'the digest', by: 'dev-t' });
const secGates = core.runSectionAdd({ project: 'demo', section: 'gates', text: 'kill if no paying user by 2026-09-01', provenance: 'owner call', by: 'dev-t' });
core.runSectionAdd({ project: 'demo', section: 'metrics', text: '42 signups', by: 'dev-t' });
core.runSectionAdd({ project: 'demo', section: 'metrics', text: '58 signups', by: 'dev-t' });
const secCard = fs.readFileSync(path.join(SEC, 'projects', 'demo.md'), 'utf8');
ok(secGates.created === false, 'section add: a scaffolded section is written, not created anew');
ok(/## Gates\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}: kill if no paying user by 2026-09-01 · src: owner call/.test(secCard),
  'section add: the line is dated and carries its provenance');
ok((secCard.match(/signups/g) || []).length === 2, 'section add: append accumulates instead of replacing');
ok(/## Digest\n\nthe digest/.test(secCard) && /## Market/.test(secCard),
  'section add: the digest and every other section survive verbatim');
const secHand = core.runSectionAdd({ project: 'demo', section: 'Runbook', text: 'restart with make deploy', by: 'dev-t' });
ok(secHand.created === true && /## Runbook\n\n- /.test(fs.readFileSync(path.join(SEC, 'projects', 'demo.md'), 'utf8')),
  'section add: an unknown heading is created and REPORTED as created (a typo must not pass silently)');
core.runSectionAdd({ project: 'demo', section: 'next', text: 'ship 0.7', mode: 'set', by: 'dev-t' });
core.runSectionAdd({ project: 'demo', section: 'next', text: 'ship 0.7.1', mode: 'set', by: 'dev-t' });
const secNext = fs.readFileSync(path.join(SEC, 'projects', 'demo.md'), 'utf8');
ok((secNext.match(/ship 0\.7/g) || []).length === 1 && /ship 0\.7\.1/.test(secNext),
  'section add: mode=set replaces the section body (right for "the one next action")');
let secErr = ''; try { core.runSectionAdd({ project: 'demo', text: 'x', by: 'dev-t' }); } catch (e) { secErr = e.message; }
ok(/section required/.test(secErr) && /gates/.test(secErr), 'section add: a missing section names the vocabulary');

// ── a card is the one shared file that CAN conflict ──────────────────────────
/* Every other shared file in a hub is per-node and append-only. A project card is one mutable file
 * any node rewrites, so two nodes appending to the same section is a same-hunk change — three
 * conflicts in one hour on one card. And markers left in a card are not a broken file to a reader:
 * readCard returns them, hub_context hands them to an agent, and the agent reads two contradictory
 * versions of the project as though both were true. */
const CC = mktmp();
core.setHubBase(CC);
const ccCard = path.join(CC, 'projects', 'demo.md');
fs.mkdirSync(path.dirname(ccCard), { recursive: true });
const ccText = ['# demo', '', '## Digest', '<<<<<<< HEAD', 'our digest', '=======', 'their digest',
  '>>>>>>> abc', '', '## Facts', '- fact: already here', '<<<<<<< HEAD', '- fact: ours',
  '- fact: both wrote this', '=======', '- fact: both wrote this', '- fact: theirs', '>>>>>>> abc', ''].join('\n');
fs.writeFileSync(ccCard, ccText);
ok(conflictsLib.conflictedFiles().length === 1 && conflictsLib.conflictedFiles()[0].file === ccCard && conflictsLib.conflictedFiles()[0].kind === 'card',
  'conflictedFiles: a card holding markers is found, and named as a card');
/* Queues were missing from this for three releases, and they are the worse case: a card is READ,
 * a queue is DELIVERED. 83 marker lines were found committed across eight queue files on one
 * mesh, 57 in a single file, every one handed to a worker as the text of a message. */
fs.mkdirSync(path.join(CC, 'queues'), { recursive: true });
fs.writeFileSync(path.join(CC, 'queues', 'queueLib.n1.queue.md'),
  '\n## 2026-09-01 10:00 · from alice\nx\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> abc\n');
const ccAll = conflictsLib.conflictedFiles({ queueRoot: CC });
ok(ccAll.length === 2 && ccAll.some(c => c.kind === 'queue'),
  `conflictedFiles: a queue holding markers is found too (got ${JSON.stringify(ccAll.map(c => c.kind))})`);
ok(conflictsLib.conflictedFiles().filter(c => c.kind === 'queue').length === 0,
  'conflictedFiles: and queues are only scanned when a queue root is given — the team root can differ from the hub base');
const ccRes = conflictsLib.resolveCardConflicts(ccText);
ok(ccRes.resolved === 1 && ccRes.unresolved.length === 1 && ccRes.unresolved[0].section === 'Digest',
  `resolveCardConflicts: unions the list hunk, refuses the prose one (got ${ccRes.resolved}/${JSON.stringify(ccRes.unresolved)})`);
const ccLines = ccRes.text.split('\n');
ok(ccLines.filter(l => l === '- fact: both wrote this').length === 1,
  'resolveCardConflicts: a bullet both sides wrote appears once');
ok(ccLines.includes('- fact: ours') && ccLines.includes('- fact: theirs'),
  'resolveCardConflicts: and neither side loses its own bullet');
ok(ccRes.text.includes('<<<<<<< HEAD') && ccRes.text.includes('our digest') && ccRes.text.includes('their digest'),
  'resolveCardConflicts: the prose hunk is left byte-for-byte, both sides intact');
/* A half-written hunk is left alone: guessing at the shape of one is how a resolver corrupts a
 * file that a human could still have read. */
const ccTorn = conflictsLib.resolveCardConflicts('## Facts\n<<<<<<< HEAD\n- fact: a\n');
ok(ccTorn.resolved === 0 && ccTorn.text === '## Facts\n<<<<<<< HEAD\n- fact: a\n',
  'resolveCardConflicts: a hunk with no separator or terminator is not touched');
const ccDoc = run('doctor', { HUBD_DIR: CC, HUBD_TEAM_DIR: CC });
ok(/markers: +\d+ file\(s\) still hold git conflict markers/.test(ccDoc.out) && /card\(s\) - fix with: hub card resolve/.test(ccDoc.out),
  'doctor: names files that still hold markers, and the command that fixes each KIND');
ok(/queue\(s\) - fix with: hub queue resolve/.test(ccDoc.out),
  'doctor: a conflicted queue is sent to the queue resolver, not the card one');
ok(/a queue DELIVERS them/.test(ccDoc.out),
  'doctor: and says why a queue is the worse case of the two');
const ccCli = run('card resolve', { HUBD_DIR: CC, HUBD_TEAM_DIR: CC });
ok(ccCli.code === 1 && /1 list hunk\(s\) unioned, 1 left for you/.test(ccCli.out),
  `card resolve: exits non-zero while anything is left, so a script cannot mistake it for done (code ${ccCli.code})`);
ok(/still conflicted in "Digest"/.test(ccCli.out),
  'card resolve: and says which section a human still has to read');

// ── one card, two sections that mean the same thing ──
const MS2 = mktmp();
core.setHubBase(MS2);
{
  // A hub localised AFTER its cards were written: "Up next" / "Known things" configured, while the
  // card still carries the English defaults. The writers used to start a second section beside them.
  fs.writeFileSync(path.join(MS2, 'sections.json'), JSON.stringify({ next: 'Up next', facts: 'Known things' }));
  fs.writeFileSync(path.join(MS2, 'projects', 'loc.md'),
    '# loc\n\n- slug: loc\n- set: 2026-09-01 10:00 by dev-t\n\n## Digest\n\nd\n\n## Facts & hypotheses\n\n- fact: old one\n\n## decisions\n\n- 2026-09-01 10:00: lower-case heading\n');
  core.runReport({ project: 'loc', by: 'dev-t', text: 'FACT: new one\nDECIDE: goes to the lower-case section' });
  let card = core.readCard('loc');
  ok(!/## Known things/.test(card) && /- fact: old one\n- fact: new one/.test(card),
    'sections: a FACT lands in the English section the card already has, not in a new localised one');
  ok((card.match(/^## decisions$/gim) || []).length === 1 && /goes to the lower-case section/.test(core.sectionBody(card, 'decisions')),
    'sections: heading match is case-insensitive — no second "Decisions" beside "decisions"');
  const sa = core.runSectionAdd({ project: 'loc', section: 'Known things', text: 'via the configured name', by: 'dev-t' });
  ok(sa.section === 'Facts & hypotheses' && sa.created === false, `section add: a configured heading resolves to the section the card has (got ${sa.section})`);

  // Detection and merge.
  fs.writeFileSync(path.join(MS2, 'projects', 'dup.md'),
    '# dup\n\n- slug: dup\n\n## Digest\n\nd\n\n## Up next\n\n- live step — set 2026-09-20 10:00 by dev-t\n\n## Handoff linux\n\n- first\n\n' +
    '## Next step\n\n- stale english step\n\n## Handoff linux\n\n- second\n\n## Handoff linux\n\n- third\n');
  const iss = cardsLib.cardSectionIssues(core.readCard('dup'));
  ok(iss.some(i => i.key === 'next' && i.kind === 'locales') && iss.some(i => i.heading === 'Handoff linux' && i.count === 3),
    `sections: detection names one key under two headings and a heading repeated three times (${JSON.stringify(iss)})`);
  const dry = cardsLib.runCardsMergeSections({});
  ok(dry.apply === false && dry.cards.some(c => c.slug === 'dup') && !dry.cards.some(c => c.merged) && /stale english step/.test(core.readCard('dup')),
    'merge: dry run lists and writes nothing');
  let thrown = null; try { cardsLib.runCardsMergeSections({ apply: true }); } catch (e) { thrown = e.message; }
  ok(/by required/.test(thrown || ''), 'merge: --apply needs an author');
  cardsLib.runCardsMergeSections({ apply: true, by: 'dev-t' });
  card = core.readCard('dup');
  ok((card.match(/^## Handoff linux$/gm) || []).length === 1 && /- first\n- second\n- third/.test(card),
    'merge: a repeated heading is folded into the first, entries in file order');
  ok((card.match(/^## (Up next|Next step)$/gm) || []).length === 1 && /live step/.test(card) && !/stale english step/.test(card),
    'merge: two next-step sections leave the LIVE one, not two current steps');
  ok(/stale english step/.test(fs.readFileSync(path.join(MS2, 'projects', 'history', 'dup.md'), 'utf8')), 'merge: the superseded step is in history, not dropped');
  ok(cardsLib.cardSectionIssues(card).length === 0, 'merge: nothing doubled is left');
  // Declared aliases are the only way a look-alike heading joins a key.
  fs.writeFileSync(path.join(MS2, 'projects', 'hand.md'), '# hand\n\n## Digest\n\nd\n\n## Facts\n\n- curated\n\n## Known things\n\n- fact: x\n');
  ok(cardsLib.cardSectionIssues(core.readCard('hand')).length === 0, 'sections: an undeclared look-alike ("Facts") is a separate hand section');
  fs.writeFileSync(path.join(MS2, 'sections.json'), JSON.stringify({ next: 'Up next', facts: { heading: 'Known things', aliases: ['Facts'] } }));
  ok(cardsLib.cardSectionIssues(core.readCard('hand')).some(i => i.key === 'facts'), 'sections: once declared as an alias it is reported as the same section');
  const doc = run('doctor', { HUBD_DIR: MS2, HUBD_TEAM_DIR: MS2 });
  ok(/card\(s\) hold a section twice/.test(doc.out) && /hand: ## Facts \+ ## Known things/.test(doc.out), 'doctor: names the cards that hold a section twice');
  const cliM = run('cards merge-sections', { HUBD_DIR: MS2, HUBD_TEAM_DIR: MS2 });
  ok(cliM.code === 0 && /hand: facts: ## Facts \+ ## Known things/.test(cliM.out) && /dry run/.test(cliM.out), 'merge CLI: dry run prints the plan');
}
core.setHubBase(T0);

// ── cards merge: the dry run says whether the alias exists, not always yes ──
const MG = mktmp();
core.setHubBase(MG);
{
  core.runCardSet({ project: 'mg-a', digest: 'dup', by: 'dev-t' });
  core.runCardSet({ project: 'mg-b', digest: 'canon', by: 'dev-t' });
  ok(cardsLib.runCardsMerge({ from: 'mg-a', into: 'mg-b' }).aliasExisted === false, 'cards merge: a dry run without an alias says so');
  fs.writeFileSync(path.join(MG, 'project-aliases.json'), JSON.stringify({ 'mg-a': 'mg-b' }));
  ok(cardsLib.runCardsMerge({ from: 'mg-a', into: 'mg-b' }).aliasExisted === true, 'cards merge: and with one, says that');
}
core.setHubBase(T0);

// ── the card cap from the CLI: the flags reach the refusals the engine tests above hold ──
{
  const CP = mktmp(), env = { HUBD_DIR: CP, HUBD_TEAM_DIR: CP };
  cli(['card', 'capproj', '-m', 'a real snapshot', '--by', 'smoke'], { env });
  const al = cli(['card', 'capproj', '--append-line', '- 2026-09-23: shipped it', '--by', 'smoke'], { env });
  ok(al.code !== 0 && /hub_report/.test(al.out), 'card: --append-line with a dated line is refused and names hub_report');
  const cc = cli(['cards', 'compact'], { env, cwd: CP });
  ok(cc.code === 0 && /Would compact|already inside the limit/.test(cc.out), 'cards compact: a dry run reports without writing');
}

done();
