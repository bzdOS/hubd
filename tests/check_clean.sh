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

# Cyrillic (U+0400-04FF) or CJK (U+4E00-9FFF): no Russian/Chinese in a public repo.
nonlatin_re = re.compile("[%s-%s%s-%s]" % (chr(0x0400), chr(0x04FF), chr(0x4E00), chr(0x9FFF)))

# Private terms, and the machine, role and path names of the fleet this is developed on. Kept as
# hashes: a list of the words would publish exactly what it is here to keep out. A word is found
# inside any run of letters and digits (a handle, an e-mail, a longer name); a hyphenated name, a
# path or a file name is matched whole. To add one, print its hash:
#   python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].lower().encode()).hexdigest()[:16])" WORD
# and put it under its length in DENY_IN_WORDS, or in DENY_WHOLE.
import hashlib
from functools import lru_cache
DENY_IN_WORDS = {
    4: {'a969e98b3fb984d2', 'c3ea52707db9769e'},
    5: {'ab99a5eb2155faf5'},
    6: {'0c5eea7641f12bc4', '27b2bfe93c31bec0', '3196a7e487413f1f', '44f86611d4de6daf', '750bd39768d2b52a', 'fe67265f89d5214c'},
    7: {'26b47209413e5776'},
    8: {'e629845ad96eb5f1'},
    9: {'fa3c5bcb2ee5eddb'},
}
DENY_WHOLE = {'06db35b7b9a30cd8', '5123c3006870ef8b', 'ae6c479d631d685b', 'b2d26135dccb88d1', 'd2c8e5f2a132ce0d', 'b872f890b2579d17', 'f7e060a45439112d'}
word_re = re.compile(r"[a-z0-9]+")
whole_res = [re.compile(r"[a-z0-9-]+"), re.compile(r"[a-z0-9./_-]+")]

def sha(t):
    return hashlib.sha256(t.encode()).hexdigest()[:16]

@lru_cache(maxsize=None)
def bad_word(w):
    return any(sha(w[i:i + n]) in hs for n, hs in DENY_IN_WORDS.items() for i in range(len(w) - n + 1))

@lru_cache(maxsize=None)
def bad_whole(t):
    return sha(t.rstrip(".")) in DENY_WHOLE

def deny_hit(line):
    low = line.lower()
    return any(bad_word(w) for w in word_re.findall(low)) or any(bad_whole(t) for rx in whole_res for t in rx.findall(low))

def hits(line):
    return deny_hit(line) or nonlatin_re.search(line)

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
        print("  the public repo is English-only and names no fleet machine, role or path;")
        print("  the git log is as public as the files")
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
    if f == "glama.json":
        continue  # the Glama claim names the maintainer's GitHub handle, which is the point of it
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

# 4) docs/reference/ is generated from the code; a page behind it documents
#    the release before this one. It runs the CLI and the server, so the
#    commit-msg hook (--msg) leaves it to the full gate and the tests.
[ -n "$MSG_FILE" ] || node scripts/gen-reference.mjs --check || exit 1
