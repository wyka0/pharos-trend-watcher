/**
 * PersistentTrendStore tests (Requirements 01 + 03).
 * Disk persistence across restarts, atomic writes, WAL crash recovery,
 * idempotency-key deduplication, tamper detection, reset/archival.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersistentTrendStore,
  SimulatedCrashError,
  StoreIntegrityError,
  atomicWriteFileSync,
  readWalFile,
  watcherPaths,
} from '@/lib/storage';
import { mkTempRoot, runSequence, T0, DT } from './helpers';
import { makeRule } from './helpers';
import { RuleValidationError } from '@/lib/rules';
import type { WalEntry } from '@/lib/storage';
import type { WatcherState } from '@/lib/types';

let root: string;

beforeEach(() => {
  root = mkTempRoot('store');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  it('writes the target with the exact content', () => {
    const target = path.join(root, 'nested', 'file.json');
    atomicWriteFileSync(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
  });
  it('creates missing parent directories', () => {
    const target = path.join(root, 'a', 'b', 'c', 'file.txt');
    atomicWriteFileSync(target, 'x');
    expect(fs.existsSync(target)).toBe(true);
  });
  it('leaves NO temp files behind', () => {
    const target = path.join(root, 'f.json');
    atomicWriteFileSync(target, 'one');
    atomicWriteFileSync(target, 'two');
    const siblings = fs.readdirSync(root);
    expect(siblings).toEqual(['f.json']);
  });
  it('atomically overwrites an existing target', () => {
    const target = path.join(root, 'f.json');
    atomicWriteFileSync(target, 'one');
    atomicWriteFileSync(target, 'two');
    expect(fs.readFileSync(target, 'utf8')).toBe('two');
  });
  it('writes are non-empty and parseable (JSON use case)', () => {
    const target = path.join(root, 's.json');
    const payload = JSON.stringify({ big: 'x'.repeat(50_000) });
    atomicWriteFileSync(target, payload);
    expect((JSON.parse(fs.readFileSync(target, 'utf8')) as { big: string }).big).toHaveLength(50_000);
  });
});

describe('fresh store → disk layout (Requirement 01)', () => {
  it('loadCommittedState reports MISSING before the first run', () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    expect(store.loadCommittedState().integrity).toBe('MISSING');
  });

  it('first runCheck creates watcher-state.json', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    expect(fs.existsSync(store.paths.stateFile)).toBe(true);
  });

  it('first runCheck creates observations.wal.jsonl with one OBSERVATION line', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    const wal = readWalFile(store.paths.walFile);
    expect(wal.entries).toHaveLength(1);
    expect(wal.entries[0]?.type).toBe('OBSERVATION');
    expect(wal.malformedLines).toBe(0);
  });

  it('created state has schemaVersion/watcherId/chainId', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule(), chainId: 688689 });
    await runSequence(store, [100]);
    const state = store.loadCommittedState().state as WatcherState;
    expect(state.schemaVersion).toBe(1);
    expect(state.watcherId).toBe('default');
    expect(state.chainId).toBe(688689);
  });

  it('default watcher uses the flat .data/watcher-state.json layout', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    expect(store.paths.stateFile).toBe(path.join(root, 'watcher-state.json'));
    expect(store.paths.walFile).toBe(path.join(root, 'observations.wal.jsonl'));
  });

  it('named watchers nest under watcher-<id>/', async () => {
    const store = new PersistentTrendStore({ dataDir: root, watcherId: 'verify', rule: makeRule() });
    await runSequence(store, [100]);
    expect(store.paths.stateFile).toBe(path.join(root, 'watcher-verify', 'watcher-state.json'));
    expect(fs.existsSync(store.paths.stateFile)).toBe(true);
  });

  it('watcherPaths is a pure layout function', () => {
    const p = watcherPaths('/tmp/x', 'default');
    expect(p.stateFile).toBe(path.join('/tmp/x', 'watcher-state.json'));
    expect(p.walFile).toBe(path.join('/tmp/x', 'observations.wal.jsonl'));
  });
});

describe('persistence across store instances (simulated restarts)', () => {
  it('a NEW store instance sees the full prior history', async () => {
    const storeA = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(storeA, [100, 95, 91]);
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const loaded = storeB.loadCommittedState().state;
    expect(loaded?.observations).toHaveLength(3);
    expect(loaded?.observations.map((o) => o.value)).toEqual([100, 95, 91]);
  });

  it('observation fields survive the disk round-trip', async () => {
    const storeA = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const [first] = await runSequence(storeA, [100]);
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const reloaded = storeB.loadCommittedState().state?.observations[0];
    expect(reloaded?.value).toBe(100);
    expect(reloaded?.runProcessPid).toBe(first?.observation?.runProcessPid);
    expect(reloaded?.observationId).toBe(first?.observation?.observationId);
    expect(reloaded?.blockNumber).toBe(1000);
    expect(reloaded?.timestamp).toBe(T0);
    expect(reloaded?.timestampBucket).toBe(Math.floor(T0 / 1000 / 60));
  });

  it('lastObservationHash + committedWatermark persist', async () => {
    const storeA = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(storeA, [100, 95, 91, 86]);
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const state = storeB.loadCommittedState().state;
    const last = state?.observations.at(-1);
    expect(state?.lastObservationHash).toBe(last?.observationHash);
    expect(state?.committedWatermark).toBe(4);
  });

  it('duplicatesIgnored persists', async () => {
    const storeA = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(storeA, [100]);
    for (let i = 0; i < 3; i++) {
      await storeA.runCheck({ value: 100, metricSource: 'synthetic_scenario', blockNumber: 1000, timestamp: T0 });
    }
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    expect(storeB.loadCommittedState().state?.duplicatesIgnored).toBe(3);
  });

  it('a CUSTOM rule persists and is reloaded by a new instance', async () => {
    const custom = makeRule({ requiredObservations: 5, thresholdBps: 999 });
    const storeA = new PersistentTrendStore({ dataDir: root, rule: custom });
    await runSequence(storeA, [100]);
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() }); // different in-memory default
    expect(storeB.loadCommittedState().state?.rule.requiredObservations).toBe(5);
    expect(storeB.loadCommittedState().state?.rule.thresholdBps).toBe(999);
  });

  it('ten sequential runs keep the state file parseable + chain intact', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const values = Array.from({ length: 10 }, (_, i) => 100 - i * 3); // 10 falling checks
    await runSequence(store, values);
    const loaded = store.loadCommittedState();
    expect(loaded.state?.observations).toHaveLength(10);
    expect(loaded.integrity).toBe('OK');
  });

  it('zero in-memory carryover: two stores alternating on the same dir stay consistent', async () => {
    const a = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const b = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await a.runCheck({ value: 100, metricSource: 's', blockNumber: 1, timestamp: T0 });
    const seenByB = await b.runCheck({ value: 95, metricSource: 's', blockNumber: 2, timestamp: T0 + DT });
    expect(seenByB.state.observations).toHaveLength(2);
    expect(seenByB.observation?.streakCount).toBe(1);
  });
});

describe('WAL behavior', () => {
  it('WAL grows append-only: one line per observation', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95, 91, 86]);
    expect(readWalFile(store.paths.walFile).entries).toHaveLength(4);
  });

  it('DUPLICATE_IGNORED lines are appended for replays', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    await store.runCheck({ value: 100, metricSource: 'synthetic_scenario', blockNumber: 1000, timestamp: T0 });
    const wal = readWalFile(store.paths.walFile);
    expect(wal.entries).toHaveLength(2);
    expect(wal.entries[1]?.type).toBe('DUPLICATE_IGNORED');
  });

  it('a malformed (torn) WAL line is tolerated and counted', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]);
    fs.appendFileSync(store.paths.walFile, '{"type":"OBSERVATION","observ\n'); // torn write
    expect(readWalFile(store.paths.walFile).malformedLines).toBe(1);
    const result = await store.runCheck({ value: 91, metricSource: 'synthetic_scenario', blockNumber: 1002, timestamp: T0 + 2 * DT });
    expect(result.state.observations).toHaveLength(3);
    expect(result.observation?.streakCount).toBe(2);
  });

  it('readWalFile on a missing file returns empty', () => {
    expect(readWalFile(path.join(root, 'nope.jsonl'))).toEqual({ entries: [], malformedLines: 0 });
  });
});

describe('crash recovery (Requirement 03)', () => {
  it('simulateCrashAfter=wal throws SimulatedCrashError', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    await expect(
      store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
  });

  it('after a crash: committed state unchanged, WAL has the uncommitted tail', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    await expect(
      store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
    // Committed state: still 1 observation.
    expect(store.loadCommittedState().state?.observations).toHaveLength(1);
    // WAL: has both entries.
    expect(readWalFile(store.paths.walFile).entries).toHaveLength(2);
  });

  it('the NEXT run replays the WAL tail and loses nothing', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    await expect(
      store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);

    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() }); // fresh process simulation
    const result = await storeB.runCheck({ value: 91, metricSource: 'synthetic_scenario', blockNumber: 1002, timestamp: T0 + 2 * DT });
    expect(result.walRecovered).toBe(1);
    expect(result.state.observations).toHaveLength(3);
    expect(result.state.observations.map((o) => o.value)).toEqual([100, 95, 91]);
    // The recovered observation was re-evaluated deterministically.
    expect(result.state.observations[1]?.streakCount).toBe(1);
    expect(result.observation?.streakCount).toBe(2);
  });

  it('recovery commits the tail BEFORE observing anew (state file up to date)', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    await expect(
      store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await storeB.runCheck({ value: 91, metricSource: 'synthetic_scenario', blockNumber: 1002, timestamp: T0 + 2 * DT });
    const state = storeB.loadCommittedState().state;
    expect(state?.committedWatermark).toBe(3);
    expect(state?.observations).toHaveLength(3);
  });

  it('a crash at the trigger moment records the trigger WITHOUT re-executing the action', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95, 91]);
    await expect(
      store.runCheck({ value: 86, metricSource: 'synthetic_scenario', blockNumber: 1003, timestamp: T0 + 3 * DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);

    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await storeB.runCheck({ value: 85, metricSource: 'synthetic_scenario', blockNumber: 1004, timestamp: T0 + 4 * DT });
    const state = storeB.loadCommittedState().state as WatcherState;
    const recoveredRecord = state.triggerRecords.find((t) => t.triggerObservationIndex === 4);
    expect(recoveredRecord).toBeDefined();
    expect(recoveredRecord?.recoveredAfterCrash).toBe(true);
    expect(recoveredRecord?.txHash).toBeNull();
  });

  it('already-committed WAL entries are never double-applied (skippedDuplicates)', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]); // both committed
    const { recovered, skippedDuplicates } = store.recoverFromWal(store.ensureRecovered());
    expect(recovered).toHaveLength(0);
    expect(skippedDuplicates).toBe(2);
  });

  it('ensureRecovered() commits a WAL tail so replay-last sees it', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    await expect(
      store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
    const state = store.ensureRecovered();
    expect(state.observations).toHaveLength(2);
    expect(state.committedWatermark).toBe(2);
  });
});

describe('idempotency-key deduplication (Requirement 03)', () => {
  it('replaying the same block 5 times produces exactly 1 entry', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    for (let i = 0; i < 5; i++) {
      const r = await store.runCheck({ value: 75 + i, metricSource: 'synthetic_scenario', blockNumber: 1000, timestamp: T0 });
      expect(r.deduplicated).toBe(true);
    }
    const state = store.loadCommittedState().state;
    expect(state?.observations).toHaveLength(1);
    expect(state?.duplicatesIgnored).toBe(5);
  });

  it('a replay returns observation=null and keeps the chain head', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]);
    const headBefore = store.loadCommittedState().state?.lastObservationHash;
    const r = await store.runCheck({ value: 94, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT });
    expect(r.deduplicated).toBe(true);
    expect(r.observation).toBeNull();
    expect(store.loadCommittedState().state?.lastObservationHash).toBe(headBefore);
  });

  it('different timestamp bucket (same block) is a NEW observation', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    const r = await store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1000, timestamp: T0 + 60_000 });
    expect(r.deduplicated).toBe(false);
    expect(r.state.observations).toHaveLength(2);
  });

  it('different block (same bucket) is a NEW observation', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    const r = await store.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 });
    expect(r.deduplicated).toBe(false);
    expect(r.state.observations).toHaveLength(2);
  });

  it('different metricSource is a NEW observation', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    const r = await store.runCheck({ value: 95, metricSource: 'onchain_erc20_balance:0xabc', blockNumber: 1000, timestamp: T0 });
    expect(r.deduplicated).toBe(false);
    expect(r.state.observations).toHaveLength(2);
  });

  it('different watcherIds produce different ids for identical inputs', async () => {
    const storeA = new PersistentTrendStore({ dataDir: root, watcherId: 'a', rule: makeRule() });
    const storeB = new PersistentTrendStore({ dataDir: root, watcherId: 'b', rule: makeRule() });
    const [ra] = await runSequence(storeA, [100]);
    const [rb] = await runSequence(storeB, [100]);
    expect(ra?.observation?.observationId).not.toBe(rb?.observation?.observationId);
  });

  it('duplicatesIgnoredTotal accumulates across many replays', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    for (let i = 1; i <= 10; i++) {
      const r = await store.runCheck({ value: 100, metricSource: 'synthetic_scenario', blockNumber: 1000, timestamp: T0 });
      expect(r.duplicatesIgnoredTotal).toBe(i);
    }
  });
});

describe('tamper detection (Innovation 1)', () => {
  async function seeded(): Promise<PersistentTrendStore> {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95, 91, 86]);
    return store;
  }

  function tamperStateFile(mutate: (state: WatcherState) => void): void {
    const stateFile = path.join(root, 'watcher-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as WatcherState;
    mutate(state);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  it('verifies OK right after normal runs', async () => {
    const store = await seeded();
    expect(store.verifyIntegrity().integrity).toBe('OK');
  });

  it('a tampered VALUE breaks the chain with a pinpointed index', async () => {
    await seeded();
    tamperStateFile((s) => {
      s.observations[2]!.value = 90.123;
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const report = store.verifyIntegrity();
    expect(report.integrity).toBe('TAMPERED');
    expect(report.tamperIndex).toBe(2);
  });

  it('a tampered metricSource breaks the chain', async () => {
    await seeded();
    tamperStateFile((s) => {
      s.observations[1]!.metricSource = 'forged';
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    expect(store.verifyIntegrity().integrity).toBe('TAMPERED');
  });

  it('a tampered TIMESTAMP (across a bucket boundary) breaks the chain', async () => {
    await seeded();
    tamperStateFile((s) => {
      s.observations[0]!.timestamp += 61_000; // crosses the 60s canonical bucket
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    expect(store.verifyIntegrity().integrity).toBe('TAMPERED');
  });

  it('intra-bucket timestamp drift is idempotency-tolerated (documented limit)', async () => {
    // The spec'd hash formula commits (prevHash, blockNumber, value, observationId);
    // the observationId commits the canonical BUCKET — sub-bucket drift is
    // intentionally outside the tamper envelope (a re-poll of the same window).
    await seeded();
    tamperStateFile((s) => {
      s.observations[0]!.timestamp += 1_000; // same 60s bucket
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    expect(store.verifyIntegrity().integrity).toBe('OK');
  });

  it('deleting an observation breaks the index continuity', async () => {
    await seeded();
    tamperStateFile((s) => {
      s.observations.splice(1, 1);
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const report = store.verifyIntegrity();
    expect(report.integrity).toBe('TAMPERED');
    expect(report.reason).toContain('index discontinuity');
  });

  it('runCheck REFUSES to act on tampered history', async () => {
    await seeded();
    tamperStateFile((s) => {
      s.observations[0]!.value = 999;
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await expect(
      store.runCheck({ value: 80, metricSource: 'synthetic_scenario', blockNumber: 2000, timestamp: T0 + 9 * DT }),
    ).rejects.toBeInstanceOf(StoreIntegrityError);
  });

  it('updateRule also refuses on tampered history', async () => {
    await seeded();
    tamperStateFile((s) => {
      s.observations[0]!.value = 999;
    });
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    expect(() => store.updateRule(makeRule({ requiredObservations: 4 }))).toThrow(StoreIntegrityError);
  });
});

describe('reset + archive', () => {
  it('reset archives the previous state file', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]);
    store.reset();
    const archiveDir = path.join(root, 'archive');
    const archived = fs.readdirSync(archiveDir).filter((f) => f.includes('watcher-state'));
    expect(archived).toHaveLength(1);
  });

  it('reset archives the WAL too', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]);
    store.reset();
    const archived = fs.readdirSync(path.join(root, 'archive')).filter((f) => f.includes('observations.wal'));
    expect(archived).toHaveLength(1);
  });

  it('post-reset state is fresh (0 observations, watermark 0)', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]);
    const fresh = store.reset();
    expect(fresh.observations).toHaveLength(0);
    expect(fresh.committedWatermark).toBe(0);
    expect(fresh.phase).toBe('IDLE');
    expect(fs.existsSync(store.paths.stateFile)).toBe(true);
  });

  it('reset with a custom rule persists it', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    store.reset(makeRule({ requiredObservations: 5 }));
    expect(store.loadCommittedState().state?.rule.requiredObservations).toBe(5);
  });

  it('reset on an empty store still creates a fresh state file', () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const fresh = store.reset();
    expect(fresh.observations).toHaveLength(0);
  });

  it('WAL is empty after reset (old entries archived, not replayed)', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95]);
    store.reset();
    expect(readWalFile(store.paths.walFile).entries).toHaveLength(0);
    const r = await store.runCheck({ value: 100, metricSource: 'synthetic_scenario', blockNumber: 1, timestamp: T0 });
    expect(r.observation?.index).toBe(1);
  });
});

describe('misc store behaviors', () => {
  it('runProcessPid equals the current process pid', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const [r] = await runSequence(store, [100]);
    expect(r?.observation?.runProcessPid).toBe(process.pid);
  });

  it('blockNumberFetcher supplies the block when omitted', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule(), blockNumberFetcher: async () => 424242 });
    const r = await store.runCheck({ value: 100, metricSource: 's' });
    expect(r.observation?.blockNumber).toBe(424242);
  });

  it('explicit blockNumber wins over the fetcher', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule(), blockNumberFetcher: async () => 424242 });
    const r = await store.runCheck({ value: 100, metricSource: 's', blockNumber: 7 });
    expect(r.observation?.blockNumber).toBe(7);
  });

  it('timestamps are preserved exactly (bucket derived)', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const r = await store.runCheck({ value: 100, metricSource: 's', blockNumber: 1, timestamp: 1_712_345_678_912 });
    expect(r.observation?.timestamp).toBe(1_712_345_678_912);
  });

  it('custom bucketSeconds feeds the idempotency id', async () => {
    const a = new PersistentTrendStore({ dataDir: mkTempRoot('b60'), rule: makeRule(), timestampBucketSeconds: 60 });
    const b = new PersistentTrendStore({ dataDir: mkTempRoot('b30'), rule: makeRule(), timestampBucketSeconds: 30 });
    const ra = await a.runCheck({ value: 100, metricSource: 's', blockNumber: 1, timestamp: 61_000 });
    const rb = await b.runCheck({ value: 100, metricSource: 's', blockNumber: 1, timestamp: 61_000 });
    expect(ra.observation?.timestampBucket).toBe(1);
    expect(rb.observation?.timestampBucket).toBe(2);
    expect(ra.observation?.observationId).not.toBe(rb.observation?.observationId);
  });

  it('constructor rejects an invalid default rule immediately', () => {
    expect(() => new PersistentTrendStore({ dataDir: root, rule: makeRule({ requiredObservations: 1 }) })).toThrow(
      RuleValidationError,
    );
  });

  it('state file ends with a newline and is pretty-printed', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100]);
    const content = fs.readFileSync(store.paths.stateFile, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content).toContain('\n  "watcherId"');
  });
});
