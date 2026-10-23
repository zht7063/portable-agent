/** Injected subprocess runner (node impl below; fakes in tests). Never pass secrets via args. */
export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export interface ExecOptions { timeoutMs: number; env?: Record<string, string>; input?: string }
export type ExecFn = (cmd: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

export const nodeExec: ExecFn = async (cmd, args, opts) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env ?? (process.env as Record<string, string>), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { resolve({ code: null, stdout: '', stderr: 'spawn failed' }); return; }
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < 4_000_000) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 64_000) stderr += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(t); resolve({ code: null, stdout: '', stderr: 'spawn failed', timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(opts.input ?? '');
  });
};
