/* cardmerge.mjs — the git merge driver for project cards, and its install on one node.
 *
 * A card is the one shared file that several nodes rewrite. Roles on two nodes report into the same
 * card within the same minute, and git sees a fact appended on one side and the next step replaced
 * on the other as one more conflict. Measured on a mesh: 72 merges in nine days found a card changed
 * on both sides, 42 of them would have stopped the sync, and one node's mesh stood for 2.5 and 4.5
 * hours on a card. The hub had answered with `projects/*.md merge=union` in its .gitattributes: a
 * doubled line is better than a stopped mesh. Union over the whole file also interleaves two
 * rewrites of a digest without a word, and nobody learns that a card now holds two versions.
 *
 * So a card merges by section. A section is a `## ` heading and everything to the next one; the text
 * above the first heading is a section too. A section changed on one side takes that side; changed
 * on both, it gets a line merge of its own, and when that clashes, both versions are kept, ours
 * first, a line theirs repeats dropped, and MERGED_MARK goes under the heading. The merge never
 * stops and never guesses which version replaces the other; the mark says a person should look.
 * Of the 42 measured conflicts, 4 merge clean this way and 38 are one section changed on both
 * sides, kept and marked; no line of either side is lost in any of them.
 *
 * The one rewrite that is not content is the write stamp (`- set: <ts> by <who>`). Both sides of
 * two card writes change it, and the later stamp is simply the card's last touch, so it is taken.
 *
 * The driver is installed per node (.git/config and .git/info/attributes, neither of which travels).
 * A shared .gitattributes naming it would leave a node without the driver on git's plain text merge,
 * which is worse than the union it has now; node-local attributes take precedence over the shared
 * file, so a node that has the driver uses it and one that has not keeps whatever the hub says. The
 * driver command ends in `|| git merge-file --union`: if node or hubd moves and the path goes stale,
 * the merge falls back to the union it replaced, and the mesh does not stop over a missing file.
 *
 * Nothing here imports the hub: git runs the driver in the middle of a merge, maybe as another user,
 * and it must read three files and write one, and touch nothing else. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CARD_DRIVER = 'hubd-card';
export const CARD_ATTR = `projects/*.md merge=${CARD_DRIVER}`;
export const MERGED_MARK = '<!-- hubd: two nodes changed this section at once; both versions are kept. Review, then delete this line. -->';

const STAMP_RE = /^- (?:set|synced): (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?).*$/m;
const SIZE = 40;                                       // conflict markers no card line can look like
const OPEN = '<'.repeat(SIZE), MID = '='.repeat(SIZE), CLOSE = '>'.repeat(SIZE);

/* [{key, text}], the text above the first heading first (key ''), then one entry per section. The
 * pieces concatenate back to the input byte for byte. A heading that repeats gets its count in the
 * key, so the second `## Facts` is matched to the second one on the other side. */
function split(text) {
  const parts = String(text ?? '').split(/(?=^## )/m);
  const out = [{ key: '', text: /^## /.test(parts[0]) ? '' : parts.shift() }];
  const seen = new Map();
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const h = (nl === -1 ? p : p.slice(0, nl)).trim();
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    out.push({ key: n > 1 ? h + '\n' + n : h, text: p });
  }
  return out;
}

/* A line merge of one section, by git itself. Clean: its result. Clashing: each clash becomes ours
 * then theirs, without a non-blank line theirs repeats from ours. */
function lineMerge(o, a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubd-card-'));
  try {
    const f = (n, t) => { const p = path.join(dir, n); fs.writeFileSync(p, t); return p; };
    const args = ['-c', 'merge.conflictStyle=merge', 'merge-file', '-p', '--marker-size=' + SIZE,
      f('ours', a), f('base', o), f('theirs', b)];
    let out, clashes = 0;
    try { out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) {
      if (!(e.status > 0 && e.status < 128) || typeof e.stdout !== 'string') throw e;
      out = e.stdout; clashes = e.status;
    }
    if (!clashes) return { text: out, both: false };
    const lines = out.split('\n'), res = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith(OPEN)) { res.push(lines[i]); continue; }
      const mid = lines.indexOf(MID, i + 1), end = lines.findIndex((l, j) => j > mid && l.startsWith(CLOSE));
      if (mid === -1 || end === -1) throw new Error('unreadable merge-file output');
      const ours = lines.slice(i + 1, mid);
      const have = new Set(ours.map(l => l.trim()).filter(Boolean));
      res.push(...ours, ...lines.slice(mid + 1, end).filter(l => !l.trim() || !have.has(l.trim())));
      i = end;
    }
    return { text: res.join('\n'), both: true };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function marked(key, text) {
  if (text.includes(MERGED_MARK)) return text;
  if (!key) {                                          // above the first heading: after its last line,
    const body = text.replace(/\s+$/, '');             // so a frontmatter block stays first
    return body + '\n' + MERGED_MARK + (text.slice(body.length) || '\n');
  }
  const nl = text.indexOf('\n');
  return nl === -1 ? text + '\n' + MERGED_MARK + '\n' : text.slice(0, nl + 1) + MERGED_MARK + '\n' + text.slice(nl + 1);
}

/* One piece, three ways. undefined is a piece that side does not have. */
function mergePiece(key, o, a, b) {
  if (!key && a != null && b != null) {                // the write stamp: the later one
    const sa = STAMP_RE.exec(a), sb = STAMP_RE.exec(b);
    if (sa && sb && sa[0] !== sb[0]) {
      const newer = sb[1] > sa[1] ? sb[0] : sa[0];
      a = a.replace(sa[0], () => newer); b = b.replace(sb[0], () => newer);
    }
  }
  if (a === b) return { text: a, both: false };
  if (a === o) return { text: b, both: false };
  if (b === o) return { text: a, both: false };
  if (a == null) return { text: b, both: true };       // removed here, changed there: the change stays
  if (b == null) return { text: a, both: true };
  /* The blank lines that end a section are the gap before the next heading, so a section added
   * after this one changes them too. They merge apart from the body, and the wider gap is kept. */
  const [ob, ot] = tail(o ?? ''), [ab, at] = tail(a), [bb, bt] = tail(b);
  const gap = at === bt || bt === ot ? at : at === ot ? bt : (at.length > bt.length ? at : bt);
  const r = ab === bb ? { text: ab, both: false } : ab === ob ? { text: bb, both: false }
    : bb === ob ? { text: ab, both: false } : lineMerge(ob, ab, bb);
  return { text: r.text + gap, both: r.both };
}

/* [body, gap]: the gap is the blank lines after the body's last line break. */
const tail = (t) => { const m = /\n(\n*)$/.exec(t); return m ? [t.slice(0, t.length - m[1].length), m[1]] : [t, '']; };

/** Merge three versions of a card. Returns the text and the sections that kept both versions. */
export function mergeCard(base, ours, theirs) {
  const O = new Map(split(base).map(p => [p.key, p.text]));
  const A = split(ours), B = split(theirs);
  const Am = new Map(A.map(p => [p.key, p.text])), Bm = new Map(B.map(p => [p.key, p.text]));
  // Ours in its order; a section only theirs has goes after the one before it in theirs.
  const order = A.map(p => p.key);
  B.forEach((p, i) => {
    if (Am.has(p.key)) return;
    let at = 1;
    for (let j = i - 1; j >= 0; j--) { const k = order.indexOf(B[j].key); if (k !== -1) { at = k + 1; break; } }
    order.splice(at, 0, p.key);
  });
  const pieces = [], both = [];
  for (const key of order) {
    const r = mergePiece(key, O.get(key), Am.get(key), Bm.get(key));
    if (r.text == null) continue;
    if (r.both) both.push(key ? key.split('\n')[0] : '(top of card)');
    pieces.push(r.both && r.text.trim() ? marked(key, r.text) : r.text);
  }
  const text = pieces.map((t, i) => (i < pieces.length - 1 && t && !t.endsWith('\n') ? t + '\n' : t)).join('');
  return { text, both };
}

/** The driver itself: git hands it %O %A %B and reads the result back from %A. */
export function runDriver([base, ours, theirs]) {
  const read = (f) => fs.readFileSync(f, 'utf8');
  const r = mergeCard(read(base), read(ours), read(theirs));
  fs.writeFileSync(ours, r.text);
}

export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const attrFile = (hub) => path.join(hub, '.git', 'info', 'attributes');
const ownRepo = (hub) => { try { return fs.statSync(path.join(hub, '.git')).isDirectory(); } catch { return false; } };

/** Install (or refresh) merge driver `name` in the hub's own repository: its command in .git/config,
 *  its `attrs` lines in .git/info/attributes. Returns what was there before and the lines added. */
export function installDriver(hub, { name, label, command, attrs }) {
  if (!ownRepo(hub)) throw new Error(`${hub} is not a git repository of its own: nothing merges here`);
  let was = '';
  try { was = git(hub, 'config', '--get', `merge.${name}.driver`).trim(); } catch {}
  git(hub, 'config', `merge.${name}.name`, label);
  git(hub, 'config', `merge.${name}.driver`, command);
  const af = attrFile(hub);
  let cur = '';
  try { cur = fs.readFileSync(af, 'utf8'); } catch {}
  const have = new Set(cur.split('\n').map(l => l.trim()));
  const added = attrs.filter(a => !have.has(a));
  if (added.length) {
    fs.mkdirSync(path.dirname(af), { recursive: true });
    fs.appendFileSync(af, (cur && !cur.endsWith('\n') ? '\n' : '') + added.map(a => a + '\n').join(''));
  }
  return { driver: command, was: was || null, added, attrFile: af };
}

/** Take driver `name` and its `attrs` lines out again. */
export function removeDriver(hub, { name, attrs }) {
  if (!ownRepo(hub)) throw new Error(`${hub} is not a git repository of its own`);
  let had = false;
  try { git(hub, 'config', '--remove-section', `merge.${name}`); had = true; } catch {}
  const af = attrFile(hub);
  let cur = '';
  try { cur = fs.readFileSync(af, 'utf8'); } catch {}
  const kept = cur.split('\n').filter(l => !attrs.includes(l.trim()));
  if (kept.length !== cur.split('\n').length) { fs.writeFileSync(af, kept.join('\n')); had = true; }
  return { had, attrFile: af };
}

/** Install (or refresh) the card driver. `script` is scripts/card-merge.mjs. */
export function installCardDriver(hub, { node = process.execPath, script }) {
  const r = installDriver(hub, { name: CARD_DRIVER, label: 'hubd: project cards, merged by ## section',
    command: `${shq(node)} ${shq(script)} %O %A %B || git merge-file --union %A %O %B`, attrs: [CARD_ATTR] });
  return { ...r, attrAdded: r.added.length > 0 };
}

/** Take it out again: the hub's own .gitattributes decides how cards merge on this node. */
export function removeCardDriver(hub) { return removeDriver(hub, { name: CARD_DRIVER, attrs: [CARD_ATTR] }); }
