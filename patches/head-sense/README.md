# Patch: head_sense.py verdict fallback

Target: /home/agent/fleet-tools/head_sense.py (root-owned, not in this repo)
  baseline sha256: (see sha256sum on target)

Fix: cmd_verdict now falls back to refs/wrk/<branch> (fetching from worker repos,
as check() does since 25.10) instead of only origin/<branch>. Also, check() now
reports "branch deleted in worker repo" instead of judging a stale ref.

Verification: not run here (target is root-owned; head applies the patch).
Patch file: patches/head-sense/head_sense.py.patch
