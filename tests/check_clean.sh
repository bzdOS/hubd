#!/bin/sh
# check_clean.sh — pre-publish cleanliness gate.
# Fails (exit 1) if private or non-English leaks are found in tracked file
# contents OR in the git log. Must pass before any public push / npm publish.
#
#   sh tests/check_clean.sh              # the full gate
#   sh tests/check_clean.sh --msg FILE   # one commit message, before it exists
#
# The --msg mode exists because THE GATE CANNOT CATCH THE COMMIT THAT BREAKS IT.
# A message enters the git log only after the commit is made, so a run that passes
# is honest and the very next commit can still poison the log. Three commits did
# exactly that here, each ending with "Checked: check_clean PASS", each true, and
# together they blocked the next release until the messages were rewritten.
# Wire it once and the class is gone:
#
#   git config core.hooksPath .githooks
#
# This file is intentionally ASCII-only: Cyrillic/CJK personal terms are caught
# by the generic codepoint-range check below (built from hex via chr()), so no
# Cyrillic/CJK literal is ever written here.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

MSG_FILE=""
if [ "${1:-}" = "--msg" ]; then MSG_FILE="${2:?--msg needs a file}"; fi
export MSG_FILE

python3 - <<'PY' || exit 1
import subprocess, sys, re, os

# ASCII denylist (case-insensitive). Latin transliterations of private terms.
ASCII_DENY = [r"dayatlas", r"izmail", r"bazi", r"bodrov", r"nextop",
              r"schedule\.py", r"chapaevsk"]
deny_re = re.compile("|".join(ASCII_DENY), re.IGNORECASE)
# Cyrillic (U+0400-04FF) or CJK (U+4E00-9FFF): no Russian/Chinese in a public repo.
nonlatin_re = re.compile("[%s-%s%s-%s]" % (chr(0x0400), chr(0x04FF), chr(0x4E00), chr(0x9FFF)))

def hits(line):
    return deny_re.search(line) or nonlatin_re.search(line)

fails = []

# --msg: check one message and nothing else. Same denylist, applied before the commit exists
# rather than after, which is the only moment at which a bad message is still cheap to fix.
msg_file = os.environ.get("MSG_FILE") or ""
if msg_file:
    try:
        with open(msg_file, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh, 1):
                if line.startswith("#"):
                    continue          # git's own comment lines are stripped from the commit
                if hits(line):
                    fails.append("commit-msg:%d: %s" % (i, line.rstrip()[:100]))
    except OSError as e:
        fails.append("commit-msg: cannot read %s (%s)" % (msg_file, e))
    if fails:
        print("check_clean FAIL - %d leak(s) in the commit message:" % len(fails))
        for x in fails:
            print("  " + x)
        print("  the public repo is English-only; the git log is as public as the files")
        sys.exit(1)
    print("check_clean PASS - commit message is clean.")
    sys.exit(0)

# 1) tracked file contents
files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split("\n")
# Binary files are skipped: a byte in a GIF is not a word in a language, and decoding one as text
# lands random bytes inside the Cyrillic range — the gate reported ~200 "leaks" in docs/media/
# kanban.gif the moment it was committed.
# What this gate therefore CANNOT check is what an image SHOWS. That is handled upstream instead:
# scripts/capture-kanban.mjs films a synthetic hub in a temp dir, so no recording of real data
# exists to review. Any image added by hand needs a human to look at it.
BINARY_EXT = (".gif", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".pdf", ".woff", ".woff2", ".zip", ".gz")
for f in filter(None, files):
    if f in ("tests/check_clean.sh", "glama.json"):
        continue  # gate file + glama.json claim metadata legitimately name the maintainer handle
    if f.lower().endswith(BINARY_EXT):
        continue
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh, 1):
                if hits(line):
                    fails.append("%s:%d: %s" % (f, i, line.rstrip()[:100]))
    except (IsADirectoryError, FileNotFoundError):
        pass

# 2) git log (subjects + bodies)
log = subprocess.run(["git", "log", "--format=%H %s%n%b"], capture_output=True, text=True).stdout
for ln in log.split("\n"):
    if ln.strip() and hits(ln):
        fails.append("git-log: %s" % ln.strip()[:100])

if fails:
    print("check_clean FAIL - %d leak(s):" % len(fails))
    for x in fails[:60]:
        print("  " + x)
    sys.exit(1)
print("check_clean PASS - tracked files and git log are clean.")
PY

# 3) hubd-company ships snapshots of root prompt files; a stale copy teaches
#    agents an outdated protocol, which is worse than none.
node scripts/sync-templates.mjs --check || exit 1
