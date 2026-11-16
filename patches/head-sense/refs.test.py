"""refs.test.py - acceptance test for head_sense.py patch.

Copies the live baseline, runs git apply --check on the new patch, then exercises
three scenarios via the module's Python API (importlib on the patched copy).
"""
import os, sys, tempfile, shutil, subprocess, importlib.util

LIVE = "/home/agent/fleet-tools/head_sense.py"
PATCH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "head_sense.py.patch")
BASELINE_SHA = "e7d1263e7beb60620294296d47b707eecbb2b4182e1ff508e17b2c9eb8a4744e"

def sh(args, cwd=None, timeout=120):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)

# 1. copy live file to /tmp
tmp = tempfile.mkdtemp(prefix="hs-test-")
live_copy = os.path.join(tmp, "head_sense.py")
shutil.copy(LIVE, live_copy)

# 2. git apply --check
repo = os.path.join(tmp, "repo")
os.makedirs(repo)
shutil.copy(live_copy, os.path.join(repo, "head_sense.py"))
sh(["git", "init", "-q"], cwd=repo)
sh(["git", "add", "head_sense.py"], cwd=repo)
sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], cwd=repo)
r = sh(["git", "apply", "--check", PATCH], cwd=repo)
assert r.returncode == 0, f"git apply --check failed: {r.stderr}"
print("PASS: git apply --check rc=0")

# apply patch to get patched module
sh(["git", "apply", PATCH], cwd=repo)
patched_path = os.path.join(repo, "head_sense.py")

# 3. load module
spec = importlib.util.spec_from_file_location("hs", patched_path)
hs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hs)

def make_repo(path):
    os.makedirs(path, exist_ok=True)
    sh(["git", "init", "-q", "-b", "main"], cwd=path)
    open(os.path.join(path, "README"), "w").write("x")
    sh(["git", "add", "."], cwd=path)
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], cwd=path)

def add_branch(repo, branch, content="y"):
    sh(["git", "checkout", "-q", "-b", branch], cwd=repo)
    open(os.path.join(repo, "f"), "w").write(content)
    sh(["git", "add", "."], cwd=repo)
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", branch], cwd=repo)
    sh(["git", "checkout", "-q", "main"], cwd=repo)

# Scenario A: live branch exists in worker repo B -> judged by fresh tip
work = os.path.join(tmp, "scnA")
review = os.path.join(work, "review")
repoA = os.path.join(work, "repoA")
repoB = os.path.join(work, "repoB")
os.makedirs(work)
for r in [review, repoA, repoB]:
    make_repo(r)
add_branch(repoB, "task/x")
conf = {"review": review, "base": "main", "repo": "origin", "repos": [repoA, repoB]}
# ensure review has main (already). check should find task/x in repoB
ok, txt = hs.check(conf, "task/x")
assert ok is not None, f"scenario A: expected judgement, got merged-already ({txt})"
assert "\u0443\u0434\u0430\u043b\u0435\u043d\u0430" not in txt and "deleted" not in txt, f"scenario A: wrongly deleted: {txt}"
print("PASS scenario A: live branch judged by fresh tip ->", txt[:60])

# Scenario B: deleted branch with stale refs/wrk -> "deleted" message
work2 = os.path.join(tmp, "scnB")
review2 = os.path.join(work2, "review")
repoC = os.path.join(work2, "repoC")
os.makedirs(work2)
make_repo(review2)
make_repo(repoC)
# create stale refs/wrk/task/x in review2 (a commit not in any repo)
sh(["git", "checkout", "-q", "-b", "stale"], cwd=review2)
open(os.path.join(review2, "stale"), "w").write("z")
sh(["git", "add", "."], cwd=review2)
sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "stale"], cwd=review2)
stale = sh(["git", "rev-parse", "HEAD"], cwd=review2).stdout.strip()
sh(["git", "checkout", "-q", "main"], cwd=review2)
sh(["git", "update-ref", "refs/wrk/task/x", stale], cwd=review2)
conf2 = {"review": review2, "base": "main", "repo": "origin", "repos": [repoC]}
ok2, txt2 = hs.check(conf2, "task/x")
assert ok2 is False, f"scenario B: expected False (deleted), got {ok2}"
assert "deleted" in txt2 or "\u0443\u0434\u0430\u043b\u0435\u043d\u0430" in txt2, f"scenario B: no deleted msg: {txt2}"
print("PASS scenario B: deleted branch ->", txt2)

# Scenario C: branch only in second repo (first repo empty) -> resolves
work3 = os.path.join(tmp, "scnC")
review3 = os.path.join(work3, "review")
repoD = os.path.join(work3, "repoD")
repoE = os.path.join(work3, "repoE")
os.makedirs(work3)
for r in [review3, repoD, repoE]:
    make_repo(r)
add_branch(repoE, "task/x")  # only in second repo
conf3 = {"review": review3, "base": "main", "repo": "origin", "repos": [repoD, repoE]}
ok3, txt3 = hs.check(conf3, "task/x")
assert ok3 is not None, f"scenario C: expected judgement, got merged-already ({txt3})"
assert "\u0443\u0434\u0430\u043b\u0435\u043d\u0430" not in txt3 and "deleted" not in txt3, f"scenario C: wrongly deleted: {txt3}"
print("PASS scenario C: branch in second repo resolves ->", txt3[:60])

print("\nALL 3 SCENARIOS PASSED")
sys.exit(0)
