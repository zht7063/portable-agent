#!/usr/bin/env node
/**
 * Dev/test-only CLI for @pa/core (not packaged into the desktop client).
 * Secrets are read from env vars only and never printed:
 *   PA_SERVER_URL, PA_USER, PA_PASS (login/register), PA_REDEEM_ENV (name of env var holding the code).
 */
import { join } from 'node:path';
import { createCore, DEFAULT_SERVER_URL, findCredentialLeaks, toPaError, type ChatMessage } from '@pa/core';
import { FileKeyVault, FileTokenStore } from './stores/file.js';

const HELP = `usage: pa <command>  (dev/test only)
  status | register | login | refresh | logout
  models [--key <id>] | balance | topup-info | redeem
  keys ls | keys new <name> | keys rename <id> <name> | keys toggle <id> | keys rm <id> | keys copy-check <id>
  chat [--stream] [--key <id>] [--max <n>] [--model <m>] <prompt>
env: PA_SERVER_URL, PA_USER, PA_PASS, PA_REDEEM_ENV (env var NAME holding the redeem code), PA_CLI_DIR`;

/** Print only credential-free data. */
function out(v: unknown) {
  const leaks = findCredentialLeaks(v);
  if (leaks.length) throw new Error(`refusing to print credential fields: ${leaks.join(',')}`);
  console.log(JSON.stringify(v, null, 2));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const bool = (args: string[], name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const need = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`env ${name} is required`); return v; };

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift() ?? 'help';
  const dir = process.env.PA_CLI_DIR;
  const store = new FileTokenStore(dir ? join(dir, 'session.json') : undefined);
  const vault = new FileKeyVault(dir ? join(dir, 'keys.json') : undefined);
  const core = createCore({ serverUrl: process.env.PA_SERVER_URL ?? DEFAULT_SERVER_URL, store, vault });
  if (core.http.insecure) console.error('warning: plain HTTP – prototype only, use test accounts');
  if (cmd !== 'help' && cmd !== 'register' && cmd !== 'login') await core.session.restore();

  switch (cmd) {
    case 'status': out(core.session.view()); return 0;
    case 'register': out(await core.auth.register({ username: need('PA_USER'), password: need('PA_PASS') })); return 0;
    case 'login': out(await core.auth.login({ username: need('PA_USER'), password: need('PA_PASS') })); return 0;
    case 'refresh': out(await core.auth.refresh()); return 0;
    case 'logout': out(await core.auth.logout()); await vault.clear(); return 0;
    case 'models': {
      const key = flag(args, '--key');
      out(key ? await core.models.listWithKey(await core.keys.secret(Number(key))) : await core.models.list());
      return 0;
    }
    case 'balance': out(await core.billing.balance()); return 0;
    case 'topup-info': out(await core.billing.topupInfo()); return 0;
    case 'redeem': {
      const envName = need('PA_REDEEM_ENV');
      out(await core.billing.redeem({ code: need(envName) }));
      return 0;
    }
    case 'keys': {
      const sub = args.shift();
      if (sub === 'ls') out(await core.keys.list());
      else if (sub === 'new') out(await core.keys.create({ name: args.join(' ') || 'pa-cli' }));
      else if (sub === 'rename') out(await core.keys.update({ id: Number(args[0]), name: args.slice(1).join(' ') }));
      else if (sub === 'toggle') {
        const k = (await core.keys.list()).find((x) => x.id === Number(args[0]));
        out(await core.keys.update({ id: Number(args[0]), status: k?.status === 1 ? 2 : 1 }));
      } else if (sub === 'rm') out(await core.keys.delete({ id: Number(args[0]) }));
      else if (sub === 'copy-check') {
        // Verifies reveal works without printing the key.
        const sk = await core.keys.secret(Number(args[0]));
        out({ id: Number(args[0]), prefixOk: sk.startsWith('sk-'), length: sk.length });
      } else { console.error(HELP); return 1; }
      return 0;
    }
    case 'chat': {
      const stream = bool(args, '--stream');
      const keyId = Number(flag(args, '--key'));
      const max = flag(args, '--max');
      const model = flag(args, '--model') ?? (await core.models.list())[0]?.id ?? '';
      const messages: ChatMessage[] = [{ role: 'user', content: args.join(' ') || 'Say hi' }];
      const req = { model, messages, keyId, ...(max ? { maxTokens: Number(max) } : {}) };
      if (!stream) { out(await core.chat.complete(req)); return 0; }
      const t0 = Date.now();
      let first: number | undefined;
      const counts: Record<string, number> = {};
      let content = '';
      let last: unknown;
      await core.chat.stream({ ...req, reqId: 'cli' }, (e) => {
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        if ((e.type === 'content' || e.type === 'reasoning') && first === undefined) first = Date.now() - t0;
        if (e.type === 'content') content += e.delta;
        if (e.type === 'usage' || e.type === 'done' || e.type === 'error') last = e;
        if (e.type === 'usage') counts.usageSeen = 1;
      });
      out({ model, events: counts, content, firstDeltaMs: first, totalMs: Date.now() - t0, last });
      return counts.error ? 1 : 0;
    }
    default:
      console.log(HELP);
      return cmd === 'help' ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { const p = toPaError(e); console.error(p.code === 'SERVER' && e instanceof Error && !('error' in e) ? e.message : `${p.code}: ${p.message}`); process.exit(1); },
);
