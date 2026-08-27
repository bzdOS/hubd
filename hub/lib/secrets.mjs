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
import { execFileSync } from 'child_process';
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

// Buffers throughout, never a utf8 string. A keystore read as utf8 grows from
// 4396 bytes to 7729 -- every byte that is not valid UTF-8 becomes U+FFFD, and
// the damage is irreversible. Worse, a verify that reads both sides the same way
// reports "matches" about two equally corrupted copies, which is how a backup
// convinces you it is good. Measured on this project's own release keystore.
export function setSecret(name, value, { teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const f = fileFor(name);
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  fs.writeFileSync(f, buf, { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return { file: f, bytes: buf.length };
}

/** Raw bytes. Decode at the call site if the value is known to be text. */
export function getSecret(name, { teamRoot } = {}) {
  assertNotReplicated(teamRoot);
  const f = fileFor(name);
  if (!fs.existsSync(f)) throw new Error(`no secret named ${name}`);
  return fs.readFileSync(f);
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


/* ── Encrypted backup inside the hub ──────────────────────────────────────────
 *
 * The plaintext store deliberately sits outside the replicated hub. That keeps
 * the secret off every peer and out of room history, and it also means the hub's
 * replication — the one thing here that survives losing this machine — does not
 * back it up.
 *
 * So an ENCRYPTED copy goes into the hub, and rides replication like everything
 * else. What makes that safe is where the passphrase is not: it lives in the
 * plaintext store, outside. A hub carrying both the ciphertext and the key to it
 * would be an elaborate way of storing plaintext.
 *
 * Which leads to the one thing an operator has to understand, so it is said in
 * the output and not only here: this protects against losing the DISK, not
 * against losing the MACHINE. Both the ciphertext (via a peer) and the passphrase
 * (only here) are needed, so the passphrase must also be kept somewhere else --
 * on paper, in a password manager, anywhere that is not this host. A backup whose
 * key exists in exactly one place is a backup of nothing.
 *
 * gpg symmetric with AES-256, not `openssl enc`: openssl's enc has no
 * authentication, so a truncated or altered blob decrypts to silent garbage, and
 * a backup that cannot tell you it is damaged is worse than none.
 */
const BACKUP_DIRNAME = 'secrets.backup';
const PASSPHRASE_NAME = 'backup-passphrase';

export function backupDir(teamRoot) {
  return path.join(teamRoot, BACKUP_DIRNAME);
}

function passphraseFile({ teamRoot }) {
  try {
    return secretPath(PASSPHRASE_NAME, { teamRoot });
  } catch {
    throw new Error(
      `no ${PASSPHRASE_NAME} in the secret store. Create one first and keep a ` +
      `copy OFF this machine:\n` +
      `  openssl rand -base64 39 | tr -d '\\n' | hub secret set ${PASSPHRASE_NAME}\n` +
      `Without a copy elsewhere the encrypted backup is unreadable the moment ` +
      `this host is gone, which is the case it exists for.`);
  }
}

function gpg(args, input, passFile) {
  // --passphrase-file pointed at the stored secret itself: no temp file to leak
  // and no --passphrase on argv, which `ps` would show to every user here. The
  // first attempt at this passed the value on fd 3 via Node's stdio option --
  // which does not accept a Buffer as a descriptor, so it would have failed at
  // the first call rather than done anything unsafe, but it was wrong.
  return execFileSync('gpg', [
    '--batch', '--yes', '--quiet', '--pinentry-mode', 'loopback',
    '--passphrase-file', passFile, ...args,
  ], { input, maxBuffer: 64 * 1024 * 1024 });
}

export function backupSecret(name, { teamRoot }) {
  assertNotReplicated(teamRoot);
  if (!teamRoot) throw new Error('no team root: nowhere to put an encrypted backup');
  if (name === PASSPHRASE_NAME) {
    throw new Error(
      `refusing to back up ${PASSPHRASE_NAME} into the hub: it is the key to ` +
      `everything else there, and storing it beside the ciphertext would make ` +
      `the encryption decorative.`);
  }
  const value = getSecret(name, { teamRoot });
  const out = gpg(['--symmetric', '--cipher-algo', 'AES256'], value, passphraseFile({ teamRoot }));
  const dir = backupDir(teamRoot);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.gpg`);
  fs.writeFileSync(f, out, { mode: 0o600 });
  return { file: f, bytes: out.length };
}

export function restoreSecret(name, { teamRoot }) {
  assertNotReplicated(teamRoot);
  const f = path.join(backupDir(teamRoot), `${name}.gpg`);
  if (!fs.existsSync(f)) throw new Error(`no encrypted backup for ${name} at ${f}`);
  const plain = gpg(['--decrypt'], fs.readFileSync(f), passphraseFile({ teamRoot }));
  return setSecret(name, plain, { teamRoot });
}

/** Decrypt every backup and compare with the live value, without printing either. */
export function verifyBackups({ teamRoot }) {
  assertNotReplicated(teamRoot);
  const dir = backupDir(teamRoot);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.gpg')); } catch { return []; }
  const pass = passphraseFile({ teamRoot });
  return files.sort().map(f => {
    const name = f.slice(0, -4);
    let status;
    try {
      const plain = gpg(['--decrypt'], fs.readFileSync(path.join(dir, f)), pass);
      let live = null;
      try { live = getSecret(name, { teamRoot }); } catch { /* absent locally */ }
      status = live === null ? 'decrypts, no local copy to compare'
             : live.equals(plain) ? 'decrypts and matches the local value byte for byte'
             : 'DECRYPTS BUT DIFFERS from the local value';
    } catch (e) {
      status = `FAILS TO DECRYPT: ${String(e.message).split('\n')[0]}`;
    }
    return { name, status };
  });
}
