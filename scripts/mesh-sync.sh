#!/bin/sh
# mesh-sync.sh — sync one node's hub folder into a git mesh of peers. No GitHub needed:
# the "server" is any machine you can ssh into.
#
#   sh mesh-sync.sh                 # uses $HUBD_DIR, else ~/.hubd
#   HUBD_DIR=/srv/hub sh mesh-sync.sh
#
# Commits this node's writes, then — only if a remote named 'origin' exists — fetches, merges
# and pushes. Runs unattended (cron / launchd / systemd timer): non-interactive ssh, no
# prompts, distinct exit codes, and it never leaves the hub in a half-merged state.
#
# Every safety property below is a scar. Read them before "simplifying" this file:
#
#   * APPEND-ONLY GUARD (exit 4). Task event logs are the truth and only ever grow. If a
#     line was removed or changed, some migration rewrote history instead of appending to
#     it — syncing that would propagate the damage to every peer. Refuse, and say how to
#     restore. (A migration adds set/backfill events. Data is richer than the schema by
#     design; an unrecognized field is meaning, not cruft.)
#   * IDENTITY ON BOTH COMMIT AND MERGE. A merge commit needs a committer, and a fresh node
#     often has no global git user. Without this, the merge fails and reports a MERGE
#     CONFLICT that does not exist — a content clash that is really a missing name.
#   * ABORT, NEVER HALF-MERGE (exit 2). Conflict markers inside journal or task files are
#     corrupt hub data, not a thing to resolve later. Abort and leave it to a human.
#   * NO MERGE STANDS OPEN IN THE HUB (exit 2). Readers poll the hub while this runs. A merge
#     that stopped on a conflict used to stand in the hub dir until the abort, every file it
#     touched holding the other side's version meanwhile. A queue reader took a block from
#     one; the abort rolled the file back, shorter, its cursor fell to 0, and the worker got
#     its whole queue again, on every failed run for over an hour. So the merge is tried
#     first outside the tree (git merge-tree, git 2.38+), and only a clean one is made here.
#   * NAME THE RIGHT FAILURE (exit 5 vs 2). A merge git REFUSES before merging is not a
#     conflict, and telling a human to "resolve it by hand" sends them to fix nothing. Exit
#     5 is that case — local changes, or two paths differing only by case, which no
#     case-insensitive filesystem can hold. Exit 2 stays for a genuine content clash.
#   * GIT SPEAKS ENGLISH HERE (LC_ALL=C). The failure is told apart by git's own words, and git
#     translates them. On a node with a Russian locale a card conflict was reported as a failed
#     pull, not as a conflict, and that node's mesh stood for 2.5 and 4.5 hours.
#   * A DELETED LOG IS ALSO NOT APPEND-ONLY (exit 4). The guard above reads diffs, and a file
#     that is gone has no diff to read. Removing journal.<node>.jsonl or a queue file deletes
#     history for every peer on the next push, which is the same damage by a different route.
#     The one exception is a MOVE into an archive with the bytes intact (hub gc): same history,
#     another name. It is checked by content, so an rm or an edited copy is still refused.
#   * KEEP A SHARED HUB WRITABLE (after merge). On a fleet node the hub is one directory used by
#     several users — roles under one account, this script under root. Whatever a merge creates
#     belongs to the user running the merge, so a root-run sync silently locks the roles out of
#     new directories and out of .git. The symptom is not an error: a role reads everything,
#     writes nothing, and its queue answers "nothing new" forever (task maple-98). So when
#     the hub dir is itself group-writable — the mark of a shared hub — group write is restored
#     over the tree after any merge that changed something, and after every failed fetch or
#     merge: a fetch writes into .git, and an in-place merge writes the tree before it aborts.
#     A private hub is left untouched.
#   * A NODE THAT DIED MID-COMMIT IS REPAIRED HERE (exit 6 when it cannot be). One node's kernel
#     panicked inside a commit: empty object files, a branch naming an empty object, and every run
#     after it failed on "bad object" for two hours. Repaired by hand, the second half showed: the
#     tree was still the one from before the panic, and this script committed it over the fresh
#     branch, +306/-612 lines of the other nodes' queues, journals and task logs rolled back. Only
#     a conflict kept that from the push. So the broken objects and refs move to a quarantine in
#     .git, the branch goes to origin's, every file not this node's takes origin's version, and
#     this node's own files stay. Without an origin there is nothing to repair from: exit 6.
#   * ANOTHER NODE'S LINES ARE NOT REMOVED HERE (exit 4). journal.<node>.jsonl, a queue shard and
#     its acks grow and are written by their node; a line gone from one of another node's is a
#     tree older than HEAD, whatever the cause. A line found in an archive of the same file is
#     moved, not lost. HUBD_SYNC_OWN names the other node names a hub is written under.
#   * PUSH FAILURE IS NOT DATA LOSS (exit 3). The commit is already local; the next run
#     retries. A busy or briefly unreachable peer must not turn into an error you learn
#     about by losing work.
#   * A LOST PUSH RACE IS FETCHED AGAIN, IN THE SAME RUN. Every node pushes to one mirror about
#     once a minute, and a push that lands between this node's fetch and its push wins: git
#     refuses ours ("fetch first"), or the mirror cannot lock the branch it is moving. One node
#     lost one run in six that way, about 90 a day, each a minute of delay and a failed unit in
#     systemd's log. So that failure, and only that one, goes back to the fetch, up to
#     HUBD_SYNC_PUSH_TRIES times in all (default 3). Any other push failure is not retried: an
#     unreachable peer would only be waited on again.
#   * BOUND THE NETWORK STEPS. Unattended on a timer, a git that blocks forever leaves a
#     process nothing will clean up and no line in the log to say so. BatchMode and
#     ConnectTimeout cover ssh, not git. HUBD_SYNC_TIMEOUT (default 300s) caps fetch and
#     push; hitting the cap is a failed run that the next one retries.
#   * PACK IN THE FOREGROUND, ONCE A RUN. git packs its objects by itself after a commit, a
#     fetch or a merge, in a process it forks into the background. On macOS that process
#     crashed after the fork and left .git/gc.log.lock behind, and every background gc after
#     it stopped on that lock without a word. One hub went seven weeks unpacked, 86000 loose
#     objects and 3.75 GiB, and every run of this script redid the part of gc that comes
#     before the fork, once for each command that started one. So git's own gc is off for the
#     commands here, and one `gc --auto` runs after the push, in the foreground, with its
#     errors in this script's log. It returns at once when there is nothing to pack.
#
# Per-host files are what make this work at all: journal.<node>.jsonl,
# tasks.<node>.events.jsonl and queues/<role>.<node>.queue.md have exactly one writer
# each, so two nodes editing "the queue" never touch the same file.
#
# Schedule it however your OS prefers — every minute is fine, it exits in milliseconds
# when there is nothing to do:
#   cron:    * * * * * /bin/sh /path/to/mesh-sync.sh >/dev/null 2>&1
#   launchd: ProgramArguments [/bin/sh, /path/to/mesh-sync.sh], StartInterval 60
# Note for cron specifically: an ssh key with a passphrase will not work unattended
# there (no agent). launchd/systemd user services inherit one; cron does not.
set -u
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
export LC_ALL=C   # the case below reads git's messages; a translated one fell through to "merge failed"
# No gc inside the commit, fetch and merge (git 2.31+ reads this); step 3 packs, once.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false

# Bound the network steps. This runs unattended on a timer, and a git that blocks forever -- a
# wedged fetch, an unresponsive peer, a filesystem that stops answering -- leaves a process nothing
# will ever clean up and no line in the log to say so. BatchMode and ConnectTimeout above cover
# ssh; they do not cover git itself. A run that hits the cap exits non-zero and the next one
# retries, which is the same contract as a failed push.
#
# `timeout` is in FreeBSD base and GNU coreutils, but not everywhere: without it, no wrapper. That
# is the old behaviour, so a host that lacks it is no worse off than before.
if command -v timeout >/dev/null 2>&1; then
  GIT_MAX="${HUBD_SYNC_TIMEOUT:-300}"
  g() { timeout "$GIT_MAX" git "$@"; }
else
  g() { git "$@"; }
fi

DIR="${HUBD_DIR:-$HOME/.hubd}"
cd "$DIR" 2>/dev/null || { echo "mesh-sync: missing $DIR" >&2; exit 1; }
# FROZEN before anything else, including the repo check: a freeze means "do nothing to this
# directory", and that answer does not depend on how the directory is configured.
if [ -f "$DIR/.mesh-freeze" ]; then
  echo "mesh-sync: FROZEN — skipping ($DIR/.mesh-freeze). Run: hub unfreeze"
  exit 0
fi
[ -d .git ] || { echo "mesh-sync: $DIR is not a git repo" >&2; exit 1; }

# The name this node's commits carry: HUBD_NODE when set, else the hostname, normalised exactly as
# hubd normalises it for journal.<node>.jsonl, so a peer reading the history and one reading the
# file names mean the same node. A raw hostname ("Pine") and a HUBD_NODE that differs from it both
# used to put one node under two names.
NODE="$(printf '%s' "${HUBD_NODE:-$(hostname 2>/dev/null)}" | cut -d. -f1 | tr '[:upper:]' '[:lower:]' \
  | sed -e 's/[^a-z0-9_-][^a-z0-9_-]*/-/g' -e 's/^-*//' -e 's/-*$//' | cut -c1-40)"; [ -n "$NODE" ] || NODE=node
# The branch is read from .git/HEAD itself: git cannot name it once the ref it points to is broken.
BR="$(sed -n 's#^ref: refs/heads/##p' .git/HEAD 2>/dev/null)"
[ -n "$BR" ] || BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"; [ -n "$BR" ] || BR=main
STAMP="$(date -u '+%Y-%m-%d %H:%M')"

# The node a per-node file belongs to: the second part of its name, in lower case as NODE is.
# journal.<node>.jsonl and its month archives journal.<node>-<YYYY-MM>[.<n>].jsonl,
# tasks.<node>.events.jsonl, queues/<role>.<node>.queue.md and .acks, presence.<node>.json.
node_of() {
  printf '%s\n' "${1##*/}" | sed -n 's/^[^.]*\.\([^.]*\)\..*/\1/p' | sed -e 's/-[0-9]\{4\}-[0-9]\{2\}$//' -e '/^queue$/d' -e '/^events$/d' |
    tr '[:upper:]' '[:lower:]'
}
# This node's own names: NODE, and those in HUBD_SYNC_OWN, for a hub several HUBD_NODE names write into.
OWN=" $NODE $(printf '%s' "${HUBD_SYNC_OWN:-}" | tr ',' ' ' | tr '[:upper:]' '[:lower:]') "
mine() { n="$(node_of "$1")"; [ -n "$n" ] && case "$OWN" in *" $n "*) return 0 ;; esac; return 1; }
# Another node's file: one with a node in its name that is not one of ours.
theirs() { n="$(node_of "$1")"; [ -n "$n" ] && ! mine "$1"; }

# Restore group write over a SHARED hub after a merge created files as this user. Only when the
# hub dir carries the group-write bit itself; a private hub keeps its own modes. Both chmods are
# idempotent, so a run that changed nothing costs one find.
share_perms() {
  [ -n "$(find . -maxdepth 0 -perm -g+w 2>/dev/null)" ] || return 0
  chmod -R g+rwX . 2>/dev/null || true
  find . -type d ! -perm -g+s -exec chmod g+s {} + 2>/dev/null || true
}

# 0. A NODE THAT DIED MID-COMMIT. Empty object files, a branch naming no readable commit, an index
#    git cannot read: each is a git killed between writing and syncing a file. Nothing here is
#    deleted: what is broken moves to .git/hubd-quarantine/<time>/. The branch then goes to
#    origin's, and only this node's files are kept from the tree (see realign). A repair stopped
#    halfway, by a failed fetch say, is marked, so the next run finishes it instead of committing
#    the old tree onto no branch at all.
has_branch() { [ -e ".git/refs/heads/$BR" ] || grep -q " refs/heads/$BR\$" .git/packed-refs 2>/dev/null; }
head_whole() {   # head_whole [<base>] -> HEAD is a commit, and every object of it past <base> is there
  git rev-parse -q --verify 'HEAD^{commit}' >/dev/null 2>&1 &&
    git rev-list --objects HEAD ${1:+--not "$1"} >/dev/null 2>&1
}
empty_objects() { find .git/objects -type f -empty ! -path '.git/objects/info/*' 2>/dev/null; }
PENDING=.git/hubd-repair-pending
DAMAGE=""
[ ! -f "$PENDING" ] || DAMAGE="a repair not finished"
[ -z "$(empty_objects | head -n 1)" ] || DAMAGE="${DAMAGE:+$DAMAGE, }empty object files"
if has_branch && ! git rev-parse -q --verify 'HEAD^{commit}' >/dev/null 2>&1; then
  DAMAGE="${DAMAGE:+$DAMAGE, }$BR names no readable commit"
fi
git ls-files >/dev/null 2>&1 || DAMAGE="${DAMAGE:+$DAMAGE, }an index git cannot read"

# The tree after a crash is the tree from before it: syncing it over a fresh branch rolls back every
# line the other nodes wrote meanwhile. So each file of another node, and each file of no node,
# takes origin's version; this node's own files stay as the tree has them. The tree's copy of a
# file that changes goes to $Q/tree/ first.
realign() {
  { git -c core.quotePath=false diff --name-only; git -c core.quotePath=false ls-files --others --exclude-standard; } |
  while IFS= read -r p; do
    mine "$p" && continue
    mkdir -p "$Q/tree/$(dirname "$p")"
    if git ls-files --error-unmatch -- ":(literal)$p" >/dev/null 2>&1; then
      [ ! -e "$p" ] || cp -p "$p" "$Q/tree/$p"
      git checkout -q -- ":(literal)$p"
    else
      mv "$p" "$Q/tree/$p"
    fi
    printf '%s\n' "$p" >> "$Q/from-origin.txt"
  done
}

if [ -n "$DAMAGE" ]; then
  Q="$(cat "$PENDING" 2>/dev/null)"
  [ -n "$Q" ] && [ -d "$Q" ] || Q=".git/hubd-quarantine/$(date -u +%Y%m%d-%H%M%S)"
  mkdir -p "$Q" && printf '%s\n' "$Q" > "$PENDING"
  echo "mesh-sync: the hub's git is damaged ($DAMAGE): repairing, nothing deleted, see $DIR/$Q" >&2
  empty_objects | while IFS= read -r f; do mkdir -p "$Q/${f%/*}" && mv "$f" "$Q/$f"; done
  for f in .git/objects/pack/tmp_*; do [ -e "$f" ] && mkdir -p "$Q/.git/objects/pack" && mv "$f" "$Q/$f"; done
  # A broken ref stops a fetch from agreeing with the peer: its name and value are kept, the ref goes.
  for r in $({ find .git/refs -type f | sed 's#^\.git/##'; git for-each-ref --format='%(refname)' 2>/dev/null; } | sort -u); do
    git rev-parse -q --verify "$r^{commit}" >/dev/null 2>&1 && continue
    echo "$r $(cat ".git/$r" 2>/dev/null || git rev-parse -q "$r" 2>/dev/null)" >> "$Q/bad-refs.txt"
    git update-ref --no-deref -d "$r" 2>/dev/null || { mkdir -p "$Q/.git/${r%/*}"; mv ".git/$r" "$Q/.git/$r"; }
  done
  # Reflogs name the lost commits too, and git gc stops on them.
  [ ! -d .git/logs ] || mv .git/logs "$Q/logs"
  git ls-files >/dev/null 2>&1 || mv .git/index "$Q/index-unreadable"
  if git remote | grep -qx origin; then
    if ! FETCH_OUT="$(g fetch -q origin "$BR" 2>&1)"; then
      [ -n "$FETCH_OUT" ] && printf '%s\n' "$FETCH_OUT" >&2
      echo "mesh-sync: fetch failed on $BR (output above), so the repair stops halfway; the next run goes on" >&2
      share_perms; exit 2
    fi
    if head_whole FETCH_HEAD; then
      [ -e .git/index ] || git reset -q
      echo "mesh-sync: repaired: $BR was whole, and stays" >&2
    else
      git update-ref "refs/heads/$BR" FETCH_HEAD
      [ ! -e .git/index ] || mv .git/index "$Q/index"
      git reset -q
      realign
      echo "mesh-sync: repaired: $BR set to origin's $(git rev-parse --short HEAD);" \
        "$(cat "$Q/from-origin.txt" 2>/dev/null | wc -l | tr -d ' ') file(s) not this node's taken from origin, the tree's copies in $DIR/$Q/tree; this node's files kept" >&2
    fi
  elif head_whole; then
    [ -e .git/index ] || git reset -q
    echo "mesh-sync: repaired: $BR was whole, and stays" >&2
  else
    echo "mesh-sync: $BR is damaged and there is no origin to repair it from. What was broken is in $DIR/$Q" >&2
    share_perms; exit 6
  fi
  mv "$PENDING" "$Q/repair-done"
  share_perms
fi

# 0. APPEND-ONLY GUARD: task event logs are the truth and only grow. Refuse to sync
#    if any existing line was removed/changed — that means a destructive "migration"
#    stripped fields. Migrations must APPEND set/backfill events, never rewrite. Data is
#    richer than the code schema by design. (Journals rotate, so they are not checked.)
if git diff HEAD -- '*.events.jsonl' 2>/dev/null | grep -E '^-[^-]' | grep -q .; then
  echo "mesh-sync: REFUSED — a task event log lost/changed lines (not append-only)." >&2
  echo "  Event logs only grow; migrations add events, never strip fields. Restore, then re-sync:" >&2
  echo "    git -C \"$DIR\" checkout -- '*.events.jsonl'" >&2
  git diff --stat HEAD -- '*.events.jsonl' >&2
  exit 4
fi

# A deleted log is accepted in exactly one case: the same bytes sit in an archive in the working
# tree — queues/archive/ (where hub gc and hub queue gc move a queue) or _archive/<same path>.
# That is a move, not a deletion: the history still travels to every peer, under another name.
# Anything else — an rm, a move with changed content — is still refused. Without this, the
# archive commands this message recommends were refused by this very check.
archived() {
  want="$(git rev-parse -q --verify "HEAD:$1" 2>/dev/null)" || return 1
  b="$(basename "$1")"
  for a in "_archive/$1" queues/archive/"${b%.queue.md}".*queue.md queues/archive/"$b"; do
    [ -f "$a" ] && [ "$(git hash-object "$a" 2>/dev/null)" = "$want" ] && return 0
  done
  return 1
}
DELETED_LOGS=""
for f in $(git diff --name-only --diff-filter=D HEAD -- '*.jsonl' '*.queue.md' 2>/dev/null); do
  archived "$f" || DELETED_LOGS="$DELETED_LOGS $f"
done
if [ -n "$DELETED_LOGS" ]; then
  echo "mesh-sync: REFUSED — an append-only log file was DELETED, not appended to:" >&2
  printf '    %s\n' $DELETED_LOGS >&2
  echo "  Committing this would remove that history from every peer on the next push." >&2
  echo "  Restore it, then re-sync:" >&2
  echo "    git -C \"$DIR\" checkout -- $(printf '%s ' $DELETED_LOGS)" >&2
  echo "  (Retiring a queue on purpose? hub gc --apply --by <you> MOVES it to queues/archive/ instead.)" >&2
  exit 4
fi

# Another node's append-only file that lost lines here. Only that node writes it (and readers
# here append acks), so a line gone is a tree older than HEAD: committed, it would remove those
# lines from every peer. A line that sits in an archive of the same file is moved, not lost:
# hub queue dedupe folds copies into queues/archive/, a journal rotates into its month archive.
# Read from what the commit would hold, in a copy of the index: a path git cannot stage (two
# spellings of one file on a case-insensitive disk, exit 5 below) loses nothing.
lost_lines() {   # lost_lines <file> <archive...> -> lines <file> lost since HEAD that no archive holds
  f="$1"; shift
  { echo '#'; GIT_INDEX_FILE="$GI" git diff --cached -U0 HEAD -- "$f" | sed -n '/^@@/,$p' | sed -n 's/^-\(..*\)$/\1/p'; } |
    awk 'FNR == 1 { f++ } f == 1 { if (FNR > 1) lost[$0] = 1; next } { delete lost[$0] }
      END { n = 0; for (l in lost) n++; print n }' - "$@"
}
LOST=""; GI=""
CAND="$(git diff --name-only --diff-filter=M HEAD -- '*.jsonl' 'queues/*.queue.md' 'queues/*.acks' 2>/dev/null)"
if [ -n "$CAND" ] && GI="$(mktemp "${TMPDIR:-/tmp}/hubd-sync-index.XXXXXX")"; then
  cp .git/index "$GI" 2>/dev/null || GIT_INDEX_FILE="$GI" git read-tree HEAD
  GIT_INDEX_FILE="$GI" git add -A -- $CAND 2>/dev/null
  CAND="$(GIT_INDEX_FILE="$GI" git diff --cached --name-only --diff-filter=M HEAD -- $CAND 2>/dev/null)"
fi
for f in $CAND; do
  case "$f" in
    queues/*/*|tasks.*.events.jsonl) continue ;;    # archives; task logs have the guard above
    queues/*) b="${f##*/}"; b="${b%.queue.md}"; arch="queues/archive/${b%.acks}." ;;
    */*) continue ;;
    *) b="${f%.jsonl}"; arch="${b%-[0-9][0-9][0-9][0-9]-[0-9][0-9]*}-" ;;
  esac
  theirs "$f" || continue
  set --; for a in "$arch"*; do [ -f "$a" ] && set -- "$@" "$a"; done
  n="$(lost_lines "$f" "$@")"
  [ "${n:-1}" = 0 ] || LOST="$LOST $f"
done
[ -z "$GI" ] || rm -f "$GI"
if [ -n "$LOST" ]; then
  echo "mesh-sync: REFUSED - another node's append-only file lost lines here:" >&2
  printf '    %s\n' $LOST >&2
  echo "  Only that node writes them, so this tree is older than HEAD there (a node back from a crash," >&2
  echo "  a copy put back by hand). Committing it would remove those lines from every peer." >&2
  echo "  Take HEAD's version back, then re-sync:" >&2
  echo "    git -C \"$DIR\" checkout -- $(printf '%s ' $LOST)" >&2
  echo "  (Several node names write into this hub? Name the others in HUBD_SYNC_OWN.)" >&2
  exit 4
fi

# 1. commit local hub writes, if any
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git -c user.name="$NODE" -c user.email="hubd-mesh@$NODE" commit -q -m "mesh-sync: $NODE $STAMP" || true
fi

# 2. exchange with upstream, if one is configured (the always-on hub has none)
if git remote | grep -qx origin; then
  TRIES="${HUBD_SYNC_PUSH_TRIES:-3}"; TRY=1
  while :; do
    HEAD_BEFORE="$(git rev-parse HEAD 2>/dev/null)"
    if ! FETCH_OUT="$(g fetch -q origin "$BR" 2>&1)"; then
      [ -n "$FETCH_OUT" ] && printf '%s\n' "$FETCH_OUT" >&2
      echo "mesh-sync: fetch failed on $BR (output above) — nothing was merged." >&2
      share_perms; exit 2
    fi
    # The trial merge, outside the working tree: exit 0 clean, 1 conflicted. Anything else is a git
    # without --write-tree (before 2.38), which merges in place below as it always did.
    MT_OUT="$(git merge-tree --write-tree --name-only HEAD FETCH_HEAD 2>&1)"; MT=$?
    if [ "$MT" -eq 1 ]; then
      printf '%s\n' "$MT_OUT" | sed 1d >&2   # line 1 is the tree; then the paths and git's messages
      echo "mesh-sync: real content conflict on $BR — nothing was merged, the hub was not touched; resolve by hand in $DIR" >&2
      share_perms; exit 2
    fi
    # identity injected on the merge too: the merge commit needs a committer, and a
    # node may have no global git user set (fir hit exactly this — reported as a
    # bogus "MERGE CONFLICT" when it was really an identity failure, not a content clash).
    # Not under the timeout: it is local, and a merge killed halfway is the half-merged hub.
    if ! MERGE_OUT="$(git -c user.name="$NODE" -c user.email="hubd-mesh@$NODE" merge --no-edit -q FETCH_HEAD 2>&1)"; then
      git merge --abort 2>/dev/null
      share_perms
      [ -n "$MERGE_OUT" ] && printf '%s\n' "$MERGE_OUT" >&2
      # SAY WHAT ACTUALLY HAPPENED. This message used to read "(real content conflict)"
      # unconditionally, and it was wrong twice. Once for a missing git identity — the scar the
      # comment above describes, where the fix went into the code and the message was left saying
      # the same wrong thing. And once for two tracked paths differing only by case, where git
      # refuses BEFORE merging anything, so there is no conflict to resolve and no amount of
      # resolving by hand will help. One node retried that failure every 60 seconds for 228
      # commits of everyone else's history, and the log said "resolve by hand" each time.
      case "$MERGE_OUT" in
        *"would be overwritten by merge"*)
          echo "mesh-sync: merge REFUSED on $BR before merging — nothing conflicted." >&2
          echo "  Cause is local changes to a tracked file, or two paths differing only by case" >&2
          echo "  (which a case-insensitive filesystem cannot both check out). Run: hub doctor" >&2
          exit 5 ;;
        *CONFLICT*)
          echo "mesh-sync: real content conflict on $BR — aborted; resolve by hand in $DIR" >&2
          exit 2 ;;
        *)
          echo "mesh-sync: merge failed on $BR (output above) — aborted; nothing was merged." >&2
          exit 2 ;;
      esac
    fi
    [ "$HEAD_BEFORE" = "$(git rev-parse HEAD 2>/dev/null)" ] || share_perms
    PUSH_OUT="$(g push -q origin "$BR" 2>&1)" && break
    # Another node's push landed after our fetch: fetch it and try again, a bounded number of times.
    case "$PUSH_OUT" in
      *"fetch first"*|*"non-fast-forward"*|*"cannot lock ref"*|*"failed to update ref"*)
        if [ "$TRY" -lt "$TRIES" ]; then
          TRY=$((TRY + 1))
          echo "mesh-sync: another node pushed first — fetching again (try $TRY of $TRIES)"
          continue
        fi ;;
    esac
    [ -n "$PUSH_OUT" ] && printf '%s\n' "$PUSH_OUT" >&2
    PUSH_FAILED=1; break
  done
fi

# 3. pack, after the push, so it never widens the gap between fetch and push. Also after a failed
#    push: a peer down for days must not leave this node unpacked for days. Not under the timeout:
#    a repack killed halfway has done its work for nothing, and the next run would start it again.
OBJ_BEFORE="$(git count-objects 2>/dev/null)"
nice git -c gc.autoDetach=false gc --auto --quiet ||
  echo "mesh-sync: git gc failed (output above); the sync itself is not affected" >&2
[ "$OBJ_BEFORE" = "$(git count-objects 2>/dev/null)" ] || share_perms

[ -z "${PUSH_FAILED:-}" ] || { echo "mesh-sync: push failed (remote busy/dirty?) — retry next run" >&2; exit 3; }
echo "mesh-sync: ok ($NODE $STAMP, $BR)"
