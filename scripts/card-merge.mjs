#!/usr/bin/env node
// The git merge driver for project cards: card-merge.mjs <base> <ours> <theirs>, result into <ours>.
// Installed per node by `hub card merge-driver`; see hub/lib/cardmerge.mjs. Any failure exits
// non-zero, and the driver command then falls back to git's union merge.
import { runDriver } from '../hub/lib/cardmerge.mjs';

try { runDriver(process.argv.slice(2)); }
catch (e) { process.stderr.write('hubd card merge: ' + (e && e.message || e) + '\n'); process.exit(2); }
