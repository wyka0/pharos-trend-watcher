/**
 * Shared spawn helper for the multi-process cold-start harness (Innovation 3).
 *
 * Every "check" in the verification suite is a BRAND-NEW OS process running
 * scripts/run-check.ts via tsx — fresh PID, fresh heap, zero in-memory state.
 * The child prints exactly one JSON line (RunCheckCliOutput) as the last
 * stdout line; human logs go to stderr.
 *
 * Implemented with ASYNC execFile (not spawnSync) so test workers keep their
 * event loop responsive while the child process runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunCheckCliOutput } from '../../src/lib/types';

const execFileP = promisify(execFile);

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const RUN_CHECK_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-check.ts');

function resolveTsxEntry(): string {
  const cli = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(cli)) return cli;
  return path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
}

export interface RunCheckSpawn {
  status: number | null;
  signal: NodeJS.Signals | null;
  childPid: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  json: RunCheckCliOutput | null;
}

export async function spawnRunCheck(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {},
): Promise<RunCheckSpawn> {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let status: number | null = null;
  let signal: NodeJS.Signals | null = null;

  try {
    const result = await execFileP(process.execPath, [resolveTsxEntry(), RUN_CHECK_SCRIPT, ...args], {
      cwd: opts.cwd ?? PROJECT_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: opts.timeoutMs ?? 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    status = 0;
  } catch (err) {
    const e = err as { code?: number | string; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    if (typeof e.code === 'number') status = e.code;
    else signal = e.signal ?? null;
  }

  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let json: RunCheckCliOutput | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line.startsWith('{')) {
      try {
        json = JSON.parse(line) as RunCheckCliOutput;
        break;
      } catch {
        /* not JSON — keep scanning */
      }
    }
  }

  return {
    status,
    signal,
    childPid: json?.pid ?? null,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    json,
  };
}
