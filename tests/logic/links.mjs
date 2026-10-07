// links.mjs — every relative link in the repository's markdown leads somewhere on GitHub: to a file
// git tracks (one that exists only in a working copy is a 404 there), and to a heading that is on
// that page, by GitHub's rule for anchors.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, ok, done } from './_h.mjs';

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
const files = new Set(tracked);
const dirs = new Set(tracked.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
const pages = tracked.filter((f) => f.endsWith('.md'));
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const unfenced = (text) => text.replace(/^```[\s\S]*?^```[ \t]*$/gm, '');

// GitHub's anchor for a heading: lower case, markup and punctuation dropped, spaces to dashes; the
// second heading of the same name gets -1, the third -2.
function slug(h) {
  return h.trim().toLowerCase().replace(/[`*]/g, '').replace(/(?<!\w)_|_(?!\w)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}
const anchorCache = new Map();
function anchors(f) {
  if (!anchorCache.has(f)) {
    const seen = new Map(), out = new Set();
    for (const m of unfenced(read(f)).matchAll(/^#{1,6}\s+(.*)$/gm)) {
      const s = slug(m[1]), n = seen.get(s) || 0;
      seen.set(s, n + 1);
      out.add(n ? `${s}-${n}` : s);
    }
    anchorCache.set(f, out);
  }
  return anchorCache.get(f);
}

const missing = [], noAnchor = [];
let links = 0;
for (const f of pages) {
  for (const m of unfenced(read(f)).matchAll(/\]\(([^)\s]+)\)/g)) {
    const url = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;   // https:, mailto:
    links++;
    const [p, frag] = url.split('#');
    const target = p ? path.posix.normalize(path.posix.join(path.posix.dirname(f), decodeURIComponent(p))).replace(/\/$/, '') : f;
    if (!files.has(target) && !dirs.has(target)) { missing.push(`${f}: ${url}`); continue; }
    if (frag && target.endsWith('.md') && !anchors(target).has(frag)) noAnchor.push(`${f}: ${url}`);
  }
}

ok(pages.length > 50 && links > 100, `links: ${links} relative links in ${pages.length} tracked pages`);
ok(!missing.length, 'links: every relative link leads to a file or folder git tracks' + missing.map((l) => '\n  ' + l).join(''));
ok(!noAnchor.length, 'links: every #anchor names a heading on its page' + noAnchor.map((l) => '\n  ' + l).join(''));

// the rule above, held to GitHub's own anchors for headings these pages have
ok(slug('Escalations and the owner\'s decisions') === 'escalations-and-the-owners-decisions' && slug('`hub_context` — where am I?') === 'hub_context--where-am-i'
  && slug('1. Three clients, one project') === '1-three-clients-one-project' && slug('HUBD_DIR and HUBD_TEAM_DIR') === 'hubd_dir-and-hubd_team_dir',
  'links: headings become anchors as GitHub makes them');

done();
