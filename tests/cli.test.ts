/**
 * Multi-Process Cold-Start CLI harness tests (Innovation 3).
 * Every test spawns REAL child processes (`scripts/run-check.ts` via tsx) —
 * fresh PIDs, fresh heaps — and asserts the disk-backed behavior.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTempRoot } from './helpers';
import { makeRule } from './helpers';
import { spawnRunCheck } from '../scripts/lib/spawn-check';
import { PersistentTrendStore } from '@/lib/storage';

let root: string;

beforeEach(() => {
  root = mkTempRoot('cli');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;
const DT = 10_000;

function args(extra: string[]): string[] {
  return ['--data-dir', root, '--watcher', 'cli', '--no-action', ...extra];
}

describe('cold-start process semantics', () => {
  it('a run produces valid JSON on stdout with a fresh child pid', async () => {
    const r = spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    expect(r.json).not.toBeNull();
    expect(r.json?.ok).toBe(true);
    expect(r.json?.pid).toBeGreaterThan(0);
    expect(r.json?.pid).not.toBe(process.pid);
    expect(r.status).toBe(0);
  }, 60_000);

  it('two consecutive runs have DIFFERENT pids (no shared process)', async () => {
    const r1 = spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    const r2 = spawnRunCheck(args(['--value', '95', '--timestamp', String(T0 + DT), '--block', '1001']));
    expect(r1.json?.pid).not.toBe(r2.json?.pid);
  }, 60_000);

  it('human logs go to stderr, JSON is the last stdout line', async () => {
    const r = spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    expect(r.stderr).toContain('[run-check');
    expect(r.stdout.trim().endsWith('}')).toBe(true);
  }, 60_000);

  it('exit code 0 on success', async () => {
    const r = spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    expect(r.status).toBe(0);
  }, 60_000);
});

describe('multi-process confirmed trend (Requirement 05 via CLI)', () => {
  it('100 → 95 → 91 → 86 across 4 OS processes triggers at the 4th', async () => {
    const seq = [100, 95, 91, 86];
    const runs = seq.map((v, i) =>
      spawnRunCheck(args(['--value', String(v), '--timestamp', String(T0 + i * DT), '--block', String(1000 + i)])),
    );
    expect(runs.map((r) => r.json?.deduplicated)).toEqual([false, false, false, false]);
    expect(runs.map((r) => r.json?.streakCount)).toEqual([0, 1, 2, 3]);
    expect(runs[3]?.json?.triggered).toBe(true);
    expect(runs[3]?.json?.ruleStatus).toBe('TRIGGERED_ACTING');
    expect(runs[3]?.json?.historyLength).toBe(4);
    expect(runs[3]?.json?.index).toBe(4);
  }, 90_000);

  it('single spike 100 → 75 → 99 across 3 OS processes NEVER triggers', async () => {
    const seq = [100, 75, 99];
    const runs = seq.map((v, i) =>
      spawnRunCheck(args(['--value', String(v), '--timestamp', String(T0 + i * DT), '--block', String(1000 + i)])),
    );
    expect(runs.every((r) => r.json?.triggered === false)).toBe(true);
    expect(runs[2]?.json?.ruleStatus).toBe('SPIKE_REJECTED');
    expect(runs[2]?.json?.streakCount).toBe(0);
  }, 90_000);
});

describe('restart + replay dedup via CLI (Requirement 03)', () => {
  it('--replay-last re-polls the same block and ignores the duplicate', async () => {
    spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    spawnRunCheck(args(['--value', '95', '--timestamp', String(T0 + DT), '--block', '1001']));
    const replay = spawnRunCheck(args(['--replay-last']));
    expect(replay.json?.deduplicated).toBe(true);
    expect(replay.json?.duplicatesIgnoredTotal).toBe(1);
    expect(replay.json?.historyLength).toBe(2);
  }, 90_000);

  it('SIGKILL crash mid-run loses NOTHING: WAL recovery + dedup in the next process', async () => {
    spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    // Hard-killed process: WAL appended, state NOT committed.
    const crashed = spawnRunCheck(args(['--value', '95', '--timestamp', String(T0 + DT), '--block', '1001', '--inject-crash', 'sigkill']));
    expect(crashed.signal === 'SIGKILL' || crashed.status === 137 || crashed.status === null || crashed.status === 1).toBe(true);

    // Next cold process: recovers the WAL tail, then the replay dedups.
    const recovery = spawnRunCheck(args(['--replay-last']));
    expect(recovery.json?.ok).toBe(true);
    expect(recovery.json?.walRecovered).toBe(1);
    expect(recovery.json?.deduplicated).toBe(true);
    expect(recovery.json?.duplicatesIgnoredTotal).toBe(1);
    expect(recovery.json?.historyLength).toBe(2);

    // History on disk is intact and untampered.
    const store = new PersistentTrendStore({ dataDir: root, watcherId: 'cli', rule: makeRule() });
    expect(store.verifyIntegrity().integrity).toBe('OK');
    expect(store.loadCommittedState().state?.observations.map((o) => o.value)).toEqual([100, 95]);
  }, 120_000);

  it('--inject-crash=wal exits 137 and reports the crash', async () => {
    spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
    const crashed = spawnRunCheck(args(['--value', '95', '--timestamp', String(T0 + DT), '--block', '1001', '--inject-crash', 'wal']));
    expect(crashed.status).toBe(137);
    expect(crashed.json?.ok).toBe(false);
    expect(crashed.json?.crashed).toBe('wal');
  }, 120_000);
});

describe('CLI data-dir isolation', () => {
  it('two data dirs keep fully independent histories', async () => {
    const other = mkTempRoot('cli-other');
    try {
      spawnRunCheck(args(['--value', '100', '--timestamp', String(T0), '--block', '1000']));
      spawnRunCheck(['--data-dir', other, '--watcher', 'cli', '--no-action', '--value', '55', '--timestamp', String(T0), '--block', '1000']);
      const a = spawnRunCheck(args(['--replay-last']));
      const b = spawnRunCheck(['--data-dir', other, '--watcher', 'cli', '--no-action', '--replay-last']);
      expect(a.json?.deduplicated).toBe(true);
      expect(b.json?.deduplicated).toBe(true);
      const storeA = new PersistentTrendStore({ dataDir: root, watcherId: 'cli', rule: makeRule() });
      const storeB = new PersistentTrendStore({ dataDir: other, watcherId: 'cli', rule: makeRule() });
      expect(storeA.loadCommittedState().state?.observations[0]?.value).toBe(100);
      expect(storeB.loadCommittedState().state?.observations[0]?.value).toBe(55);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);

  it('--no-action dry run: triggered trend records no tx', async () => {
    const seq = [100, 95, 91, 86];
    const runs = seq.map((v, i) =>
      spawnRunCheck(args(['--value', String(v), '--timestamp', String(T0 + i * DT), '--block', String(1000 + i)])),
    );
    expect(runs[3]?.json?.triggered).toBe(true);
    expect(runs[3]?.json?.action).toBeNull();
    expect(runs[3]?.json?.actionError).toContain('dry run');
  }, 120_000);
});
