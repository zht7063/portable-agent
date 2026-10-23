#!/usr/bin/env node
/** pa-key entry point (bundled to key-helper.cjs for the desktop app). */
import { createKeyring } from './keyring.js';
import { runPaKey } from './cli.js';

runPaKey(process.argv.slice(2), createKeyring(), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then((c) => { process.exitCode = c; }, () => { process.stderr.write('pa-key: unexpected error\n'); process.exitCode = 1; });
