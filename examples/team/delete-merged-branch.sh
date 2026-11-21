#!/bin/sh
# delete-merged-branch.sh — a handler for `hub watch --as <name> --exec`.
# Reads one journal entry (JSON) on stdin. For "ACCEPT <sha> <branch> → <base>: ..." it deletes the
# branch from origin once <sha> is in <base>, and exits 0. Exit 1 while the merge has not happened,
# so the entry stays unmarked and the next pass tries again. Any other entry: exit 0, nothing done.
# REPO is a clone whose origin is the repo to clean.
entry=$(cat)
set -- $(printf '%s\n' "$entry" | sed -n 's/.*"text":"ACCEPT \([0-9a-f]\{40\}\) \([^ "]*\) → \([^ :"]*\):.*/\1 \2 \3/p')
[ $# -eq 3 ] || exit 0
sha=$1 branch=$2 base=$3
git -C "$REPO" fetch -q --prune origin || exit 1
git -C "$REPO" merge-base --is-ancestor "$sha" "origin/$base" || { echo "$branch: not in $base yet"; exit 1; }
git -C "$REPO" ls-remote --exit-code origin "refs/heads/$branch" >/dev/null || exit 0
git -C "$REPO" push -q origin --delete "$branch" && echo "deleted $branch (in $base at ${sha%"${sha#??????????}"})"
