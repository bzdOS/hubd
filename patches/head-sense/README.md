# Patch: head_sense.py stale-wrk guard + verdict state write

Target: /home/agent/fleet-tools/head_sense.py (root-owned, not in this repo)
  baseline sha256: e7d1263e7beb60620294296d47b707eecbb2b4182e1ff508e17b2c9eb8a4744e
  baseline bytes: 72728

Fix:
- check(): branch judged fresh only when this fetch brought it (fetch rc 0
  AND rev-parse refs/wrk ok). No early return inside the repos loop, so a
  branch living in a later repo still resolves. After the loop, a leftover
  stale refs/wrk (deleted branch) reports "deleted in worker repo" and the
  stale ref is removed; only a truly absent branch keeps the old message.
- cmd_verdict(): on unresolvable branch (print txt, return 1) now records
  st["verdicts"][branch] {v, error: txt[:200], ts} before returning.
- cmd_verdict() falls back through worker repos to refs/wrk/<branch>,
  matching check() (kept from prior version).

Verification (acceptance):
  python3 patches/head-sense/refs.test.py -> rc 0 (all 3 scenarios)

Repro for verdict state write (before -> after), cmd + rc:
  BEFORE(orig):    cmd=cmd_verdict(h, task/x, reject) rc=1 verdicts={}
  AFTER(patched):  cmd=cmd_verdict(h, task/x, reject) rc=1 verdicts={'task/x': {...}}

Apply: root/orchestrator only, not part of this delivery.
Patch file: patches/head-sense/head_sense.py.patch
