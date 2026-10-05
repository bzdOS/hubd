// cardmerge.mjs — a card merged by ## section: the merge driver, and its install on one node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ok, mktmp, run, REPO, core, done } from './_h.mjs';

const { mergeCard, MERGED_MARK, CARD_ATTR } = await import(path.join(REPO, 'hub/lib/cardmerge.mjs'));

const card = (stamp, sections) => `---\nslug: p\n---\n# p\n\n- slug: p\n- set: ${stamp} by t\n\n` +
  Object.entries(sections).map(([h, body]) => `## ${h}\n\n${body}\n`).join('\n');
const BASE = card('2026-09-01 10:00', { Digest: 'what p is', Facts: '- one\n- two\n- three', 'Next step': '- ship it' });
// What git's own text merge makes of the whole file: the number of clashes, 0 when clean.
const gitClashes = (o, a, b) => {
  const d = mktmp();
  for (const [n, t] of [['o', o], ['a', a], ['b', b]]) fs.writeFileSync(path.join(d, n), t);
  return spawnSync('git', ['merge-file', '-p', path.join(d, 'a'), path.join(d, 'o'), path.join(d, 'b')]).status;
};

// ── different sections: each side's change, nothing marked ──
{
  const a = BASE.replace('- three', '- three\n- four from a');
  const b = BASE.replace('- ship it', '- ship it on friday');
  const r = mergeCard(BASE, a, b);
  ok(r.text.includes('- four from a') && r.text.includes('- ship it on friday') && !r.text.includes('- ship it\n'),
    'sections: a fact added on one side and the next step replaced on the other both arrive');
  ok(!r.both.length && !r.text.includes(MERGED_MARK), 'sections: nothing is marked when no section changed on both sides');
}
/* Two sections that git's text merge cannot tell apart: both sides write at the end of the card,
 * one into its last section, the other a new section after it. One clash for git; for the card,
 * two different sections. */
{
  const a = BASE + '- later from a\n';
  const b = BASE + '\n## Notes\n\n- from b\n';
  ok(gitClashes(BASE, a, b) > 0, 'sections: (git\'s text merge does clash on this pair)');
  const r = mergeCard(BASE, a, b);
  ok(!r.both.length && /- ship it\n- later from a\n\n## Notes\n\n- from b\n$/.test(r.text),
    'sections: an append to the last section and a new section after it merge cleanly, in order');
}

// ── one section, changed on both sides ──
{
  const a = BASE.replace('- one', '- one, corrected');
  const b = BASE.replace('- three', '- three\n- four');
  const r = mergeCard(BASE, a, b);
  ok(!r.both.length && r.text.includes('- one, corrected\n- two\n- three\n- four\n'),
    'one section: edits that do not touch the same lines merge line by line, unmarked');
}
{
  const a = BASE.replace('- ship it', '- ship it today\n- tell the owner');
  const b = BASE.replace('- ship it', '- wait for review\n- tell the owner');
  ok(gitClashes(BASE, a, b) > 0, 'one section: (a real clash for git)');
  const r = mergeCard(BASE, a, b);
  ok(r.both.length === 1 && r.both[0] === '## Next step', `one section: the clash is reported by its heading (got ${JSON.stringify(r.both)})`);
  ok(/## Next step\n<!-- hubd: [^\n]* -->\n\n- ship it today\n- wait for review\n- tell the owner\n$/.test(r.text),
    'one section: both versions are kept, ours first, the marker right under the heading');
  ok(r.text.split('- tell the owner').length === 2, 'one section: a line both sides wrote is kept once');
  ok(!core.CONFLICT_RE.test(r.text), 'one section: no conflict markers — the card stays writable');
  ok(r.text.startsWith(BASE.slice(0, BASE.indexOf('## Next step'))), 'one section: every other section is byte for byte as it was');
  // merged again later, with the marker on both sides: still one marker
  const a2 = r.text.replace('- ship it today', '- ship it today, done'), b2 = r.text.replace('- ship it today', '- ship it today, not yet');
  const r2 = mergeCard(r.text, a2, b2);
  ok(r2.text.split(MERGED_MARK).length === 2, 'one section: a section already marked is not marked twice');
}

// ── the write stamp, sections added and removed ──
{
  const a = card('2026-09-02 09:00', { Digest: 'p, as a wrote it', Facts: '- one\n- two\n- three', 'Next step': '- ship it' });
  const b = card('2026-09-02 11:30', { Digest: 'what p is', Facts: '- one\n- two\n- three', 'Next step': '- ship it now' });
  const r = mergeCard(BASE, a, b);
  ok(r.text.includes('- set: 2026-09-02 11:30 by t') && !r.text.includes('2026-09-02 09:00') && !r.both.length,
    'stamp: two card writes keep the later stamp, and the top of the card is not marked for it');
  ok(r.text.includes('p, as a wrote it') && r.text.includes('- ship it now'), 'stamp: and each side\'s section arrives');
}
{
  const a = BASE + '\n## From a\n\n- x\n';
  const b = BASE.replace('## Next step', '## From b\n\n- y\n\n## Next step');
  const r = mergeCard(BASE, a, b);
  ok(/## Facts[\s\S]*## From b[\s\S]*## Next step[\s\S]*## From a/.test(r.text) && !r.both.length,
    'added: a section new on each side is kept, theirs after the section it follows there');
}
{
  const drop = (t) => t.replace(/## Facts\n[\s\S]*?(?=## Next step)/, '');
  ok(!mergeCard(BASE, drop(BASE), BASE.replace('- ship it', '- ship it now')).text.includes('## Facts'),
    'removed: a section removed on one side and untouched on the other is gone');
  const r = mergeCard(BASE, drop(BASE), BASE.replace('- two', '- two, still true'));
  ok(r.text.includes('- two, still true') && r.both[0] === '## Facts', 'removed: removed on one side and changed on the other, the change stays, marked');
}
ok(mergeCard(BASE, BASE, BASE).text === BASE, 'unchanged: three equal cards merge to the same bytes');

// ── the install, on one node ──
const H = mktmp();
execFileSync('git', ['init', '-q', '-b', 'main', H]);
const env = { HUBD_DIR: H, HUBD_TEAM_DIR: H };
let r = run('card merge-driver', env);
const attrs = () => fs.readFileSync(path.join(H, '.git', 'info', 'attributes'), 'utf8');
const drv = () => { try { return execFileSync('git', ['-C', H, 'config', '--get', 'merge.hubd-card.driver'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
ok(r.code === 0 && attrs().includes(CARD_ATTR), `install: the attribute goes to .git/info/attributes, which never travels (code ${r.code})`);
ok(drv().includes('scripts/card-merge.mjs') && /\|\| git merge-file --union %A %O %B$/.test(drv()),
  'install: the driver names this hubd\'s script and falls back to a union merge when it cannot run');
ok(!fs.existsSync(path.join(H, '.gitattributes')), 'install: the shared .gitattributes is not touched');
r = run('card merge-driver', env);
ok(r.code === 0 && /already installed/.test(r.out) && attrs().split(CARD_ATTR).length === 2, 'install: a second run changes nothing');
r = run('card merge-driver --remove', env);
ok(r.code === 0 && !drv() && !attrs().includes(CARD_ATTR), 'install: --remove takes both out');
const NOGIT = mktmp();
r = run('card merge-driver', { HUBD_DIR: NOGIT, HUBD_TEAM_DIR: NOGIT });
ok(r.code !== 0 && /not a git repository/.test(r.out), 'install: a hub that is not its own git repository is refused');

done();
