#!/bin/sh
# run.sh — every example on a fresh `hub demo` of its own, one PASS/FAIL line each.
#
#   sh examples/team/run.sh            # all of them
#   sh examples/team/run.sh 03 08      # only these
#   sh examples/team/run.sh -v 04      # and show what each one printed
#
# HUB is the command that runs hub (default: hub). Nothing outside a temporary folder is read or
# written: each example gets its own demo hub and its own git repos, removed when it passes.
# Exit 1 if any example failed; its folder is kept and named.
cd "$(dirname "$0")" || exit 2
HUB=${HUB:-hub}
VERBOSE=0
[ "$1" = "-v" ] && { VERBOSE=1; shift; }
pass=0 failed=0
for f in [0-9][0-9]-*.sh; do
  if [ $# -gt 0 ]; then
    hit=0; for w in "$@"; do case "$f" in "$w"*) hit=1;; esac; done
    [ $hit = 1 ] || continue
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/hubd-example.XXXXXX") || exit 2
  # hub demo refuses to write into the hub it runs against, so it runs against none
  if ! HUBD_DIR="$tmp/none" HUBD_TEAM_DIR="$tmp/none" $HUB demo "$tmp/hub" >"$tmp/demo.log" 2>&1; then
    echo "FAIL ${f%.sh}: hub demo did not build (see $tmp/demo.log)"; failed=$((failed + 1)); continue
  fi
  if env HUB="$HUB" HUBD_DIR="$tmp/hub" HUBD_TEAM_DIR="$tmp/hub" HUBD_NODE=elm HUBD_AGENT= \
       HUBD_SENSE_DIR="$tmp/sense" HUBD_SENSE_ESCALATIONS="$tmp/escalations.log" WORK="$tmp" \
       sh "./$f" >"$tmp/out.log" 2>&1; then
    echo "PASS ${f%.sh}"; pass=$((pass + 1))
    [ $VERBOSE = 1 ] && sed 's/^/     /' "$tmp/out.log"
    rm -rf "$tmp"
  else
    echo "FAIL ${f%.sh}: $(grep '^FAIL' "$tmp/out.log" | tail -1) (output: $tmp/out.log)"
    [ $VERBOSE = 1 ] && sed 's/^/     /' "$tmp/out.log"
    failed=$((failed + 1))
  fi
done
echo "$pass pass, $failed fail"
[ $failed = 0 ]
