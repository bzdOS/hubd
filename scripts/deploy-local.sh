#!/usr/bin/env bash
# deploy-local.sh — install this working tree into the prefix the RUNNING hubd
# actually uses, then prove it took effect.
#
# The trap this exists for
# ------------------------
# On 2026-08-27 `npm i -g .` reported "changed 1 package" and changed nothing
# that matters. There are two global trees on this host:
#
#   /root/.nvm/versions/node/<ver>/lib/node_modules/@bzdos/hubd   <- npm's default
#   /usr/local/lib/node_modules/@bzdos/hubd                       <- what runs
#
# The MCP server is launched by ABSOLUTE PATH from the second one (see the
# `hubd` entry in ~/.claude.json), while `npm root -g` points at the first. So
# the default deploy command silently updates a tree nobody executes, and the
# operator walks away believing the fix is live. Verified the hard way: the
# install succeeded, the version stayed 0.5.0, and the new function was absent.
#
# The bin symlinks (`hub`, `hubd`) are a third path again — they resolve to
# /root/hubd directly, so the CLI is always current while the MCP server is
# whatever was last deployed. Two code paths for one product, neither declared.
#
# Why not just point the MCP config at the source tree and drop deploying?
# Because for live coordination infrastructure the checkpoint is a feature: an
# unfinished edit in the working tree would otherwise become the server's code
# on its next spawn. Keeping the copy means a deploy is deliberate. What had to
# go was the AMBIGUITY about where it lands, not the step itself.
#
# So this script derives the target from the running configuration rather than
# from npm's defaults, and refuses to report success it has not observed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${HUBD_MCP_CONFIG:-$HOME/.claude.json}"

# --- 1. Find where the running server is launched from -----------------------
TARGET_ENTRY=""
if [ -f "$CONFIG" ]; then
  TARGET_ENTRY="$(python3 - "$CONFIG" <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == 'mcpServers' and isinstance(v, dict):
                for cfg in v.values():
                    for a in (cfg.get('args') or []):
                        if 'hubd' in a and a.endswith('.mjs'):
                            print(a); return True
            elif walk(v): return True
    elif isinstance(o, list):
        for v in o:
            if walk(v): return True
    return False
walk(d)
PY
)"
fi

if [ -z "$TARGET_ENTRY" ]; then
  echo "deploy-local: could not find a hubd MCP entry in $CONFIG." >&2
  echo "  Point HUBD_MCP_CONFIG at the right file, or pass the prefix:" >&2
  echo "    npm i -g --prefix <prefix> $REPO" >&2
  echo "  Refusing to guess a prefix -- guessing is the bug this script exists for." >&2
  exit 2
fi

# .../lib/node_modules/@bzdos/hubd/hub/index.mjs  ->  prefix
PREFIX="${TARGET_ENTRY%/lib/node_modules/*}"
INSTALLED_DIR="${TARGET_ENTRY%/hub/*}"
if [ "$PREFIX" = "$TARGET_ENTRY" ]; then
  echo "deploy-local: the running server is launched from $TARGET_ENTRY," >&2
  echo "  which is not inside a node_modules prefix -- it looks like it already runs" >&2
  echo "  from a source tree. Nothing to deploy; edits there are live immediately." >&2
  exit 0
fi

echo "deploy-local: running server launches from"
echo "                $TARGET_ENTRY"
echo "              so the deploy prefix is"
echo "                $PREFIX"

# --- 2. A canary: something present in the repo that must appear installed ---
CANARY="$(git -C "$REPO" rev-parse --short HEAD)"
VER_REPO="$(node -p "require('$REPO/package.json').version")"
VER_BEFORE="$(node -p "require('$INSTALLED_DIR/package.json').version" 2>/dev/null || echo none)"
echo "              repo $VER_REPO ($CANARY), installed $VER_BEFORE"

# --- 3. Gate on the smoke suite. Live infrastructure. -----------------------
if [ -f "$REPO/tests/smoke_mcp.sh" ]; then
  echo "deploy-local: smoke suite first (this replaces code three agents rely on)"
  if ! bash "$REPO/tests/smoke_mcp.sh" >/tmp/hubd-deploy-smoke.log 2>&1; then
    echo "deploy-local: SMOKE FAILED -- not deploying. See /tmp/hubd-deploy-smoke.log" >&2
    tail -5 /tmp/hubd-deploy-smoke.log >&2
    exit 1
  fi
  echo "              $(grep -oE '[0-9]+ pass, [0-9]+ fail' /tmp/hubd-deploy-smoke.log | tail -1)"
fi

# --- 4. Install, explicitly, where the server actually looks -----------------
npm i -g --prefix "$PREFIX" "$REPO" >/tmp/hubd-deploy-npm.log 2>&1 || {
  echo "deploy-local: npm install failed. See /tmp/hubd-deploy-npm.log" >&2; exit 1; }

# --- 5. Verify. npm's own "changed 1 package" is not evidence ----------------
VER_AFTER="$(node -p "require('$INSTALLED_DIR/package.json').version" 2>/dev/null || echo none)"
if [ "$VER_AFTER" != "$VER_REPO" ]; then
  echo "deploy-local: FAILED -- installed version is $VER_AFTER, repo is $VER_REPO." >&2
  echo "  npm reported success and the tree the server runs did not change." >&2
  echo "  This is exactly the failure this script exists to catch." >&2
  exit 1
fi
if ! node -e "import('$INSTALLED_DIR/hub/index.mjs').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"; then
  echo "deploy-local: FAILED -- the installed entry point does not even import." >&2
  exit 1
fi

echo "deploy-local: OK -- $INSTALLED_DIR is now $VER_AFTER ($CANARY), and imports."
echo
echo "  NOTE: a running MCP server keeps the code it already loaded. This takes"
echo "  effect on its next spawn. Nothing here restarts it, deliberately: three"
echo "  agents coordinate through that process right now."
