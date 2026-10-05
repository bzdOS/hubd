#!/usr/bin/env node
// The git merge driver for the files one node rewrites whole (snapshot, presence, sense, read
// marks): state-merge.mjs <base> <ours> <theirs>, the newer version into <ours>. Installed per node
// by `hub card merge-driver`; see hub/lib/statemerge.mjs. Any failure exits non-zero, and the
// driver command then keeps <ours> as git wrote it.
import { runStateDriver } from '../hub/lib/statemerge.mjs';

try { runStateDriver(process.argv.slice(2)); }
catch (e) { process.stderr.write('hubd state merge: ' + (e && e.message || e) + '\n'); process.exit(2); }
