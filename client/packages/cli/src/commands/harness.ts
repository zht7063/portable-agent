import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { HARNESS_IDS, isHarnessId, type HarnessId } from '@pa/core';
import { ControlledFs, createHarness, nodeExec, nodeFsOps, StateStore, type ExecFn } from '@pa/core/harness';
import { accountFor, createKeyring, keyringStatus, type Keyring } from '@pa/key-helper';

export const HARNESS_HELP = `pa harness detect | plan <id> --profile <pid> | apply <id> --profile <pid> --yes
          | rollback <id> [--first-write] --yes | status | env-scan [--no-login-shell] | key-check <profileId> [<harness>]
  --home <dir>   use <dir> as HOME (tests: point at a temp dir); data dir defaults to <home>/.config/portable-agent-cli/harness`;

export interface HarnessCliDeps {
  out(v: unknown): void;
  err(s: string): void;
  env?: Record<string, string | undefined>;
  exec?: ExecFn;
  keyring?: Keyring;
  platform?: NodeJS.Platform;
}

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const has = (args: string[], name: string) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };

/** Dev/test harness commands. Never prints key values (key-check reports presence only). */
export async function runHarness(argv: string[], d: HarnessCliDeps): Promise<number> {
  const args = [...argv];
  const env = d.env ?? process.env;
  const homeArg = take(args, '--home');
  if (homeArg !== undefined && !isAbsolute(homeArg)) { d.err('--home must be an absolute path'); return 1; }
  const home = resolve(homeArg ?? env.HOME ?? homedir());
  const dataDir = resolve(env.PA_CLI_DIR ?? join(home, '.config', 'portable-agent-cli'));
  const fs = new ControlledFs({ ops: nodeFsOps, roots: [home, dataDir], dataDir });
  const state = new StateStore(fs);
  const keyring = d.keyring ?? createKeyring({ env });
  const platform = d.platform ?? process.platform;
  const harness = createHarness({
    fs, state, exec: d.exec ?? nodeExec,
    env: { home, env: { ...env, HOME: home }, platform },
    keyringStatus: async (pid) => keyringStatus(keyring, pid !== undefined ? [pid] : Object.keys((await state.load()).profiles)),
  });
  const sub = args.shift();
  const id = (): HarnessId => { const v = args.shift(); if (!isHarnessId(v)) throw new Error(`harness must be one of ${HARNESS_IDS.join('|')}`); return v; };
  switch (sub) {
    case 'detect': d.out({ harnesses: await harness.detect(), registered: harness.registered() }); return 0;
    case 'plan': { const h = id(); d.out(await harness.plan(h, take(args, '--profile') ?? 'default')); return 0; }
    case 'apply': {
      const h = id(); const pid = take(args, '--profile') ?? 'default';
      if (!has(args, '--yes')) { d.err('apply requires --yes'); return 1; }
      d.out(await harness.apply(h, await harness.plan(h, pid)));
      return 0;
    }
    case 'rollback': {
      const h = id(); const first = has(args, '--first-write');
      if (!has(args, '--yes')) { d.err('rollback requires --yes'); return 1; }
      d.out(await harness.rollback(h, first ? 'first-write' : 'last'));
      return 0;
    }
    case 'status': {
      const s = await state.load();
      d.out({
        dataDir,
        profiles: Object.keys(s.profiles),
        files: Object.entries(s.files).map(([path, f]) => ({ path, harness: f.harness, updatedAt: f.updatedAt })),
        snapshots: (await fs.listSnapshots()).length,
        keyring: await harness.keyringStatus(),
      });
      return 0;
    }
    case 'env-scan': d.out(await harness.envScan([...HARNESS_IDS], {}, { loginShell: !has(args, '--no-login-shell') })); return 0;
    case 'key-check': {
      const pid = args.shift() ?? '';
      const hs = args.length ? [id()] : [...HARNESS_IDS];
      const avail = await keyring.available();
      if (!avail.ok) { d.out({ available: false, backend: keyring.backend, fallback: 'env', reason: avail.reason }); return 1; }
      const results = [];
      for (const h of hs) {
        let found = false;
        try { found = (await keyring.get(accountFor(pid, h))) !== null; } catch { found = false; }
        results.push({ harness: h, found });
      }
      d.out({ available: true, backend: keyring.backend, profileId: pid, results });
      return results.every((r) => r.found) ? 0 : 1;
    }
    default: d.err(HARNESS_HELP); return 1;
  }
}
