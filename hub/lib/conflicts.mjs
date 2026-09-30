/* conflicts.mjs — the files a merge left holding git conflict markers, and their two resolvers.
 *
 * Cards and queues are the shared files that can conflict; everything else in a hub is per-node
 * and append-only. `hub doctor` lists them, `hub card resolve` and `hub queue resolve` repair them.
 * CONFLICT_RE itself stays in core, where the card writers refuse a half-merged card. */
import fs from 'node:fs';
import path from 'node:path';
import { PROJ, RESOURCES, CONFLICT_RE } from './core.mjs';

/* Files left holding git conflict markers.
 *
 * Every OTHER shared file in a hub is per-node and append-only, so it cannot conflict. Project
 * cards can: they are one mutable file that any node rewrites, and two nodes appending to the same
 * section is a same-hunk change. The mesh script aborts on conflict rather than leaving markers,
 * deliberately — but an abort is not the only way a merge ends, and a card that keeps its markers
 * is worse than one that fails to merge. `<<<<<<<` in a card is not a broken file to a reader: it
 * is CONTENT. readCard returns it, digestOf slices it, hub_context hands it to an agent, and the
 * agent reads two contradictory versions of the project's state as though both were true.
 *
 * QUEUES were missing from this check for three releases, and they are the worse case. A card is
 * only READ; a queue is DELIVERED. 83 marker lines turned out to be committed as content across
 * eight queue files on one mesh — 57 in a single file — and every one of them had been handed to
 * a worker as the text of a message. The markers got there the ordinary way: an earlier merge was
 * resolved by hand, incompletely, and committed, after which each new merge nested markers inside
 * the leftovers (`<<<<<<<` with no `=======`, two `=======` in a row).
 *
 * Reported with the kind, because the remedy differs: `hub card resolve` unions list hunks and
 * refuses prose, `hub queue resolve` unions blocks and appends. Telling a reader to run the wrong
 * one is the same class of mistake as the "upgrade that node" line 0.9.7 removed. */
/* queueRoot is passed in rather than resolved here: the team root can differ from the hub base
 * (HUBD_TEAM_DIR), and the resolver for it lives in queue.mjs, which imports this file. Taking it
 * as an argument keeps the dependency pointing one way. */
export function conflictedFiles({ queueRoot } = {}) {
  const out = [];
  const scan = (dir, kind, ext) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith(ext)); } catch { return; }
    for (const f of names) {
      try {
        if (CONFLICT_RE.test(fs.readFileSync(path.join(dir, f), 'utf8'))) out.push({ file: path.join(dir, f), kind });
      } catch {}
    }
  };
  scan(PROJ, 'card', '.md');
  scan(RESOURCES, 'resource', '.md');
  if (queueRoot) scan(path.join(queueRoot, 'queues'), 'queue', '.queue.md');
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/* Resolve a conflicted QUEUE file: ours, then whatever blocks only theirs has, appended at the end.
 *
 * Queue files are append-only by contract but have no union merge (only journal.*.jsonl and
 * tasks.*.events.jsonl do), so two sides that both appended are a real conflict. It happens: one
 * node came back after two days holding 49 local commits, with five queue files conflicted at
 * once, and every block on both sides was a message somebody really sent.
 *
 * Appending theirs at the END rather than merging by timestamp is the whole point, and it is a
 * better trade than the ts-ordered union this was first designed as. Cursors are byte offsets:
 * insert a block anywhere before a cursor and that cursor silently points at the wrong place, so
 * a ts-ordered merge has to recompute every cursor in the hub, including the ones on other nodes
 * that this node cannot see. Appending inserts nothing before anything, so every existing cursor
 * stays exactly as valid as it was. The cost is that the file is no longer in strict time order —
 * which costs nothing, because a reader walks forward from its cursor and every block carries its
 * own timestamp.
 *
 * Deduplicated on the whole block, not the header: the same minute and sender can carry two
 * different messages, and dropping one of those would be losing work to save a line. */
export function resolveQueueConflicts(text) {
  const lines = String(text).split('\n');
  const out = [];
  const theirs = [];
  let hunks = 0, malformed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^<<<<<<< /.test(lines[i])) { out.push(lines[i]); continue; }
    let mid = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (mid === -1 && lines[j] === '=======') mid = j;
      else if (/^>>>>>>> /.test(lines[j])) { end = j; break; }
    }
    if (mid === -1 || end === -1) { malformed++; out.push(lines[i]); continue; }
    out.push(...lines.slice(i + 1, mid));
    theirs.push(...lines.slice(mid + 1, end));
    hunks++;
    i = end;
  }
  if (!hunks) return { text: String(text), hunks: 0, carried: 0, malformed };
  const blocksOf = (arr) => {
    const src = arr.join('\n');
    const idx = [];
    const re = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · from /gm;
    for (let m; (m = re.exec(src));) idx.push(m.index);
    return idx.map((s, k) => src.slice(s, k + 1 < idx.length ? idx[k + 1] : src.length).replace(/\s+$/, ''));
  };
  const have = new Set(blocksOf(out));
  const carried = blocksOf(theirs).filter(b => b && !have.has(b));
  const body = out.join('\n').replace(/\s+$/, '');
  return {
    text: (carried.length ? body + '\n\n' + carried.join('\n\n') : body) + '\n',
    hunks, carried: carried.length, malformed,
  };
}

/* Resolve a conflicted card the way a human resolving one actually reasons.
 *
 * A card's accumulating sections are bullet lists — Facts, Next step, decisions — and two nodes
 * appending to one of them have not disagreed about anything. Both bullets are true; the conflict
 * is an artefact of them landing in the same hunk. Union is the correct resolution, and it is what
 * was done by hand three times in one hour before this existed.
 *
 * Prose is the opposite. A one-line digest, a heading, a paragraph: if both sides rewrote it, one
 * of them meant to replace the other, and picking for them would be inventing a decision nobody
 * made. Those hunks are left exactly as they are and named, so the file still fails the check and
 * a person still has to look.
 *
 * Identical bullets on both sides collapse to one. That is the only lossy step, and it is the same
 * reasoning as the log dedup: two byte-identical lines are indistinguishable to every reader. */
export function resolveCardConflicts(text) {
  const lines = String(text).split('\n');
  const out = [];
  let resolved = 0;
  const unresolved = [];
  const isBullet = (l) => /^\s*[-*+] \S/.test(l) || /^\s*$/.test(l);
  let heading = '(top of file)';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) heading = l.replace(/^##\s*/, '').trim();
    if (!/^<<<<<<< /.test(l)) { out.push(l); continue; }
    // Collect ours / theirs. A malformed hunk (no separator or no terminator) is left untouched:
    // guessing at the shape of a half-written conflict is how a resolver corrupts a file.
    let mid = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (mid === -1 && lines[j] === '=======') mid = j;
      else if (/^>>>>>>> /.test(lines[j])) { end = j; break; }
    }
    if (mid === -1 || end === -1) { out.push(l); continue; }
    const ours = lines.slice(i + 1, mid);
    const theirs = lines.slice(mid + 1, end);
    if (ours.every(isBullet) && theirs.every(isBullet) && (ours.some(x => x.trim()) || theirs.some(x => x.trim()))) {
      const seen = new Set(ours.map(x => x.trim()).filter(Boolean));
      out.push(...ours);
      for (const t of theirs) {
        const k = t.trim();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
      resolved++;
    } else {
      unresolved.push({ section: heading, ours: ours.length, theirs: theirs.length });
      out.push(...lines.slice(i, end + 1));
    }
    i = end;
  }
  return { text: out.join('\n'), resolved, unresolved };
}
