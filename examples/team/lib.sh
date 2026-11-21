# lib.sh — what every example sources. Not run on its own.
#
# HUB is the command that runs hub: `hub` by default, or e.g. HUB="node /path/to/hub/hub.mjs".
# run.sh sets HUBD_DIR and HUBD_TEAM_DIR to a fresh `hub demo` before each example.
HUB=${HUB:-hub}
# HUBD is the command that runs the MCP server: `hubd` by default.
HUBD=${HUBD:-hubd}
OUT=''
RC=0

# run <hub args...>: run hub, show the command and its output, keep both in OUT and RC.
run() {
  printf '\n$ hub %s\n' "$*"
  OUT=$($HUB "$@" 2>&1)
  RC=$?
  printf '%s\n' "$OUT" | sed 's/^/  /'
}

# sh_run <shell command>: the same for a command that is not hub (git, a handler script).
sh_run() {
  printf '\n$ %s\n' "$1"
  OUT=$(sh -c "$1" 2>&1)
  RC=$?
  printf '%s\n' "$OUT" | sed 's/^/  /'
}

fail() { printf 'FAIL: %s\n' "$*"; exit 1; }
expect() { printf '%s\n' "$OUT" | grep -qF -- "$1" || fail "expected in the output: $1"; }
expect_not() { if printf '%s\n' "$OUT" | grep -qF -- "$1"; then fail "not expected in the output: $1"; fi; }
expect_rc() { [ "$RC" = "$1" ] || fail "expected exit $1, got $RC"; }
say() { printf '\n# %s\n' "$*"; }

# make_repo <dir>: a bare origin with one commit on main, a worker's clone (work) and the head's
# review clone (review), all under <dir>. No network.
GIT="git -c user.name=dev -c user.email=dev@example.com -c init.defaultBranch=main -c advice.detachedHead=false"
make_repo() {
  mkdir -p "$1" && (
    cd "$1" &&
    $GIT init -q --bare origin.git &&
    $GIT clone -q origin.git work 2>/dev/null &&
    cd work && $GIT commit -q --allow-empty -m init && $GIT push -q origin main &&
    cd .. && $GIT clone -q origin.git review 2>/dev/null
  ) || fail "could not build a git repo in $1"
}

# push_branch <dir> <branch> <file> <line> <message>: a worker's commit on a task branch, pushed.
push_branch() {
  ( cd "$1/work" && $GIT checkout -q main && $GIT checkout -q -b "$2" &&
    printf '%s\n' "$4" > "$3" && $GIT add "$3" && $GIT commit -q -m "$5" &&
    $GIT push -q origin "$2" ) || fail "could not push $2"
}

# wait_for <seconds> <shell test>: poll until the test holds; exit 1 if it never does.
wait_for() {
  n=$(($1 * 5))
  while [ $n -gt 0 ]; do sh -c "$2" && return 0; sleep 0.2; n=$((n - 1)); done
  return 1
}
