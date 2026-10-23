#!/usr/bin/env node
import { createCore, DEFAULT_SERVER_URL, toPaError } from '@pa/core';
import { FileTokenStore } from './stores/file.js';

const COMMANDS = ['status', 'login', 'refresh', 'logout', 'models', 'balance', 'redeem', 'keys', 'chat'] as const;

async function main(argv: string[]): Promise<number> {
  const [cmd = 'help'] = argv;
  const core = createCore({ serverUrl: process.env.PA_SERVER_URL ?? DEFAULT_SERVER_URL, store: new FileTokenStore(process.env.PA_SESSION_FILE) });
  if (cmd === 'status') {
    console.log(JSON.stringify(await core.session.restore(), null, 2));
    if (core.http.insecure) console.warn('warning: plain HTTP – prototype only, use test accounts');
    return 0;
  }
  if ((COMMANDS as readonly string[]).includes(cmd)) {
    console.error(`pa ${cmd}: not implemented yet (M2)`);
    return 2;
  }
  console.log(`usage: pa <${COMMANDS.join('|')}>  (dev/test only)`);
  return cmd === 'help' ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { console.error(toPaError(e).message); process.exit(1); },
);
