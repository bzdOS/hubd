/* Secrets for a hub, kept OUTSIDE the hub.
 *
 * The hub folder is replicated. `scripts/mesh-sync.sh` does `git add -A` over the
 * whole thing, and mrgd's bridge carries `MATRIX_HS_HUBD_HUB_DIR` into Matrix
 * rooms. Both are the point of a hub and both are why a secret cannot live in
 * one: writing a signing key into the team root publishes it to every peer node
 * and into a room's history, where deleting the file afterwards removes nothing.
 *
 * So this store lives somewhere else by default, and REFUSES to operate if it
 * has been pointed inside the team root. That refusal is the actual feature.
 * Everything else here is a file with restrictive modes.
 *
 * What this is NOT: encryption at rest. A file mode is not a cipher, and calling
 * this an encrypted store would be the more dangerous lie -- an operator who
 * believes a value is encrypted treats a stolen disk differently than one who
 * knows it is a 0600 file. If encryption at rest is wanted, it belongs in the
 * filesystem or in a real keyring, and the honest thing here is to say so rather
 * than to imply it.
 *
 * Values are read from stdin, never from argv: a command line is visible in `ps`
 * to every user on the machine and lands in the shell history of the one who
 * typed it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function secretsRoot() {
  return process.env.HUBD_SECRETS_DIR || path.join(os.homedir(), '.hubd-secrets');
}

/** Throws if the store would sit inside the replicated team root. */
export function assertNotReplicated(teamRoot) {
  if (!teamRoot) return;
  const store = path.resolve(secretsRoot());
  const team = path.resolve(teamRoot);
  const inside = store === team || store.startsWith(team + path.sep);
  if (inside) {
    throw new Error(
      `refusing to use ${store} as the secret store: it is inside the team root ` +
      `${team}, which is replicated to every peer node and, when the Matrix ` +
      `bridge is on, into room history. Point HUBD_SECRETS_DIR somewhere outside ` +
      `it (default: ~/.hubd-secrets).`);
  }
}

function ensureRoot() {
  const r = secretsRoot();
  fs.mkdirSync(r, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(r, 0o700); } catch { /* best effort on odd filesystems */ }
  return r;
}

function fileFor(name) {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid secret name ${JSON.stringify(name)}: use letters, digits, dot, ` +
      `dash and underscore only. Rejected rather than sanitised, because a name ` +
      `with a path separator in it would write outside the store.`);
  }
  return path.join(ensureRoot(), name);
}

export function setSecret(name, value, { teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const f = fileFor(name);
  fs.writeFileSync(f, value, { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return { file: f, bytes: Buffer.byteLength(value) };
}

export function getSecret(name, { teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const f = fileFor(name);
  if (!fs.existsSync(f)) throw new Error(`no secret named ${name}`);
  return fs.readFileSync(f, 'utf8');
}

export function secretPath(name, { teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const f = fileFor(name);
  if (!fs.existsSync(f)) throw new Error(`no secret named ${name}`);
  return f;
}

/** Names and metadata only. A listing must never be a way to read a value. */
export function listSecrets({ teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const r = ensureRoot();
  let names = [];
  try { names = fs.readdirSync(r); } catch { return []; }
  return names.filter(n => NAME_RE.test(n)).sort().map(n => {
    const st = fs.statSync(path.join(r, n));
    return {
      name: n,
      bytes: st.size,
      modified: new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
      mode: '0' + (st.mode & 0o777).toString(8),
    };
  });
}

export function removeSecret(name, { teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const f = fileFor(name);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

/** Every mode that is not what it should be. Used by `hub doctor` and by set. */
export function auditModes({ teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const r = ensureRoot();
  const bad = [];
  let st;
  try { st = fs.statSync(r); } catch { return bad; }
  if ((st.mode & 0o777) !== 0o700) bad.push({ path: r, mode: '0' + (st.mode & 0o777).toString(8), want: '0700' });
  for (const n of (() => { try { return fs.readdirSync(r); } catch { return []; } })()) {
    const f = path.join(r, n);
    const s = fs.statSync(f);
    if ((s.mode & 0o777) !== 0o600) bad.push({ path: f, mode: '0' + (s.mode & 0o777).toString(8), want: '0600' });
  }
  return bad;
}
