import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';

export type RunOptions = Partial<ExecSyncOptionsWithStringEncoding>;

export type RunResult = { ok: true; out: string } | { ok: false; err: Error };

/**
 * Runs a command and returns its stdout, letting a non-zero exit throw.
 */
export function run(cmd: string, opts: RunOptions = {}): string {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

/**
 * Runs a command, turning a non-zero exit into a value rather than a throw.
 * Most of what this script asks git and gh is a question it can live without
 * an answer to, so the failure belongs in the control flow instead of in a
 * try/catch around every call.
 */
export function safeRun(cmd: string, opts: RunOptions = {}): RunResult {
  try {
    return { ok: true, out: run(cmd, opts) };
  } catch (err) {
    return { ok: false, err: err as Error };
  }
}
