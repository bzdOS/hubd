/**
 * session.mjs — identify the current SUBSCRIBER without asking the model.
 *
 * A queue cursor (and a whatsnew checkpoint) belongs to a reader, not to a machine.
 * The offset used to live at .qstate/<file>.offset — one per queue file, shared by
 * everyone on the node — so when several sessions on one machine subscribed to the
 * same role, whichever polled first advanced the cursor for all of them and the
 * others never saw the message. That is correct for competing workers and wrong for
 * subscribers, and hubd had no way to express the difference.
 *
 * The identity has to be:
 *   - unique per concurrent session, or they steal from each other again;
 *   - stable across an MCP server respawn — the client restarts the server while the
 *     same session continues, and a cursor lost there means silently skipping the
 *     messages that arrived in the gap;
 *   - derivable WITHOUT the model's cooperation. A model-supplied name drifts: in
 *     this hub's journal the optional `agent` field holds 44 distinct values across
 *     1193 entries, 19% of them placeholders like "unknown".
 *
 * Resolution order, deliberately vendor-neutral — no client-specific variable names,
 * because hubd serves Claude Code, opencode, cursor and anything else equally:
 *
 *   1. HUBD_SESSION — explicit, for any client or wrapper that knows better than we
 *      can guess. Also the escape hatch for a client that wants its own id (a
 *      transcript id, say) so an eval satellite can join on it later.
 *   2. the parent process id, PLUS that parent's start time — for a stdio MCP server
 *      the parent IS the client process, so this is stable for as long as that client
 *      lives and survives the server being respawned under it. The start time is what
 *      makes it safe: pids are recycled, and a new client landing on a dead session's
 *      pid would otherwise inherit its cursor and silently resume at its offset,
 *      skipping every message in between — the exact failure this file exists to fix.
 *      A changed start time means a different process, so it gets a fresh cursor and
 *      re-reads rather than skips. If the start time cannot be read (unknown platform)
 *      the bare pid is used, which is no worse than not having this at all.
 *   3. null — no identity. The caller then keeps using the shared per-node cursor,
 *      i.e. exactly today's behaviour. Nothing regresses.
 *
 * NOT split per coexisting server under one client: a resumed client was observed
 * holding two live hubd servers at once, and those two are still one session, so
 * sharing a cursor between them is right. Splitting them would need a liveness dance
 * that buys nothing here.
 *
 * Only a long-lived server may claim a ppid-derived identity. A CLI invocation's
 * parent is whatever shell ran it — a fresh process per call — so a ppid cursor
 * would never advance. cli.mjs therefore passes no subscriber at all.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * A token that changes when the process at `pid` is a DIFFERENT process than before,
 * even if the pid is the same. Linux: field 22 of /proc/<pid>/stat, the start time in
 * clock ticks (read directly — no subprocess). Elsewhere: `ps -o lstart=`, spawned at
 * most once per process because sessionId() memoises. Empty string when unavailable.
 */
function startToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm is parenthesised and may itself contain spaces — split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return clean(rest[19] || '');            // field 22 overall = index 19 after pid, comm, state
  } catch { /* not Linux, or no procfs */ }
  try {
    return clean(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim());
  } catch { return ''; }
}

let cached;

/** Subscriber id for this process, or null to use the shared per-node cursor. */
export function sessionId() {
  if (cached !== undefined) return cached;
  const explicit = clean(process.env.HUBD_SESSION || '');
  if (explicit) return (cached = 's-' + explicit);
  const pp = process.ppid;
  if (!Number.isInteger(pp) || pp <= 1) return (cached = null);
  const tok = startToken(pp);
  cached = tok ? `p-${pp}-${tok}` : `p-${pp}`;
  return cached;
}

/** Test seam: forget the memoised value so a test can vary the environment. */
export function resetSessionId() { cached = undefined; }
