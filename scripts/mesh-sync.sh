#!/bin/sh
# mesh-sync.sh — sync one node's hub folder into a git mesh of peers. No GitHub needed:
# the "server" is any machine you can ssh into.
#
#   sh mesh-sync.sh                 # uses $HUBD_DIR, else ~/.hubd
#   HUBD_DIR=/srv/hub sh mesh-sync.sh
#
# Commits this node's writes, then — only if a remote named 'origin' exists — pulls and
# pushes. Runs unattended (cron / launchd / systemd timer): non-interactive ssh, no
# prompts, distinct exit codes, and it never leaves the hub in a half-merged state.
#
# Every safety property below is a scar. Read them before "simplifying" this file:
#
#   * APPEND-ONLY GUARD (exit 4). Task event logs are the truth and only ever grow. If a
#     line was removed or changed, some migration rewrote history instead of appending to
#     it — syncing that would propagate the damage to every peer. Refuse, and say how to
#     restore. (A migration adds set/backfill events. Data is richer than the schema by
#     design; an unrecognized field is meaning, not cruft.)
#   * IDENTITY ON BOTH COMMIT AND PULL. A merge commit needs a committer, and a fresh node
#     often has no global git user. Without this, the pull fails and reports a MERGE
#     CONFLICT that does not exist — a content clash that is really a missing name.
#   * ABORT, NEVER HALF-MERGE (exit 2). Conflict markers inside journal or task files are
#     corrupt hub data, not a thing to resolve later. Abort and leave it to a human.
#   * NAME THE RIGHT FAILURE (exit 5 vs 2). A pull git REFUSES before merging is not a
#     conflict, and telling a human to "resolve it by hand" sends them to fix nothing. Exit
#     5 is that case — local changes, or two paths differing only by case, which no
#     case-insensitive filesystem can hold. Exit 2 stays for a genuine content clash.
#   * PUSH FAILURE IS NOT DATA LOSS (exit 3). The commit is already local; the next run
#     retries. A busy or briefly unreachable peer must not turn into an error you learn
#     about by losing work.
#   * BOUND THE NETWORK STEPS. Unattended on a timer, a git that blocks forever leaves a
#     process nothing will clean up and no line in the log to say so. BatchMode and
#     ConnectTimeout cover ssh, not git. HUBD_SYNC_TIMEOUT (default 300s) caps pull and
#     push; hitting the cap is a failed run that the next one retries.
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

# Bound the network steps. This runs unattended on a timer, and a git that blocks forever -- a
# wedged pull, an unresponsive peer, a filesystem that stops answering -- leaves a process nothing
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
[ -d .git ] || { echo "mesh-sync: $DIR is not a git repo" >&2; exit 1; }

NODE="$(hostname 2>/dev/null | cut -d. -f1)"; [ -n "$NODE" ] || NODE=node
BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"; [ -n "$BR" ] || BR=main
STAMP="$(date -u '+%Y-%m-%d %H:%M')"

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

# 1. commit local hub writes, if any
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git -c user.name="$NODE" -c user.email="hubd-mesh@$NODE" commit -q -m "mesh-sync: $NODE $STAMP" || true
fi

# 2. exchange with upstream, if one is configured (the always-on hub has none)
if git remote | grep -qx origin; then
  # identity injected on the pull too: the merge commit needs a committer, and a
  # node may have no global git user set (fedora hit exactly this — reported as a
  # bogus "MERGE CONFLICT" when it was really an identity failure, not a content clash).
  if ! PULL_OUT="$(g -c user.name="$NODE" -c user.email="hubd-mesh@$NODE" pull --no-rebase --no-edit -q origin "$BR" 2>&1)"; then
    git merge --abort 2>/dev/null
    [ -n "$PULL_OUT" ] && printf '%s\n' "$PULL_OUT" >&2
    # SAY WHAT ACTUALLY HAPPENED. This message used to read "(real content conflict)"
    # unconditionally, and it was wrong twice. Once for a missing git identity — the scar the
    # comment above describes, where the fix went into the code and the message was left saying
    # the same wrong thing. And once for two tracked paths differing only by case, where git
    # refuses BEFORE merging anything, so there is no conflict to resolve and no amount of
    # resolving by hand will help. One node retried that failure every 60 seconds for 228
    # commits of everyone else's history, and the log said "resolve by hand" each time.
    case "$PULL_OUT" in
      *"would be overwritten by merge"*)
        echo "mesh-sync: pull REFUSED on $BR before merging — nothing conflicted." >&2
        echo "  Cause is local changes to a tracked file, or two paths differing only by case" >&2
        echo "  (which a case-insensitive filesystem cannot both check out). Run: hub doctor" >&2
        exit 5 ;;
      *CONFLICT*)
        echo "mesh-sync: real content conflict on $BR — aborted; resolve by hand in $DIR" >&2
        exit 2 ;;
      *)
        echo "mesh-sync: pull failed on $BR (output above) — aborted; nothing was merged." >&2
        exit 2 ;;
    esac
  fi
  g push -q origin "$BR" || { echo "mesh-sync: push failed (remote busy/dirty?) — retry next run" >&2; exit 3; }
fi
echo "mesh-sync: ok ($NODE $STAMP, $BR)"
