/**
 * Full runCheck integration tests: observe → evaluate → act → persist with a
 * recording executor, plus cross-instance continuity and crash+recovery mixes.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersistentTrendStore, SimulatedCrashError } from '@/lib/storage';
import { computeRuleHash, computeTrendProofDigest } from '@/lib/proof';
import { windowObservationHashes } from '@/lib/proof';
import { mkTempRoot, runSequence, recordingExecutor, T0, DT } from './helpers';
import { makeRule } from './helpers';

let root: string;

beforeEach(() => {
  root = mkTempRoot('runcheck');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('on-chain action executor wiring', () => {
  it('single-spike sequence NEVER calls the executor', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 75, 99], { actionExecutor: executor });
    expect(calls).toHaveLength(0);
  });

  it('confirmed 3-drop trend calls the executor EXACTLY once', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    expect(calls).toHaveLength(1);
  });

  it('executor is called with the trigger index (4) and the full window values', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    expect(calls[0]?.index).toBe(4);
    expect(calls[0]?.windowValues).toEqual([100, 95, 91, 86]);
    expect(calls[0]?.windowLen).toBe(4);
  });

  it('executor receives the correct ruleHash', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    expect(calls[0]?.ruleHash).toBe(computeRuleHash(results[0]?.state.rule as never));
  });

  it('executor receives the verifiable trendProofDigest', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    const ruleHash = computeRuleHash(results[0]?.state.rule as never);
    const windowHashes = windowObservationHashes(results[3]?.triggerRecord?.window ?? []);
    expect(calls[0]?.proofDigest).toBe(computeTrendProofDigest(ruleHash, windowHashes));
  });

  it('action result fields land on the trigger record', async () => {
    const { executor } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    const record = results[3]?.triggerRecord;
    expect(record?.txHash).toBe(`0x${'ab'.repeat(32)}`);
    expect(record?.explorerUrl).toContain('pharosscan');
    expect(record?.actionMode).toBe('ANCHOR_CONTRACT');
  });

  it('a THROWING executor records the error but still persists the observation', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86], {
      actionExecutor: async () => {
        throw new Error('insufficient funds for gas');
      },
    });
    const record = results[3]?.triggerRecord;
    expect(record?.txHash).toBeNull();
    expect(record?.actionError).toContain('insufficient funds');
    expect(results[3]?.observation?.ruleStatus).toBe('TRIGGERED_ACTING');
    expect(results[3]?.state.observations).toHaveLength(4);
  });

  it('no executor (dry run) records a dry-run marker', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    expect(results[3]?.triggered).toBe(true);
    expect(results[3]?.action).toBeNull();
    expect(results[3]?.triggerRecord?.txHash).toBeNull();
    expect(results[3]?.triggerRecord?.actionError).toContain('dry run');
  });

  it('the run result carries the evaluation reason', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95]);
    expect(results[1]?.reason).toContain('1/3');
    expect(results[1]?.reason).toContain('falling');
  });
});

describe('cooldown + hysteresis via runCheck (Innovation 4)', () => {
  it('cooldownUntil is anchored to the observation timestamp + cooldownMs', async () => {
    const { executor } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule({ cooldownMs: 60_000 }) });
    const results = await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    expect(results[3]?.state.cooldownUntil).toBe((results[3]?.observation?.timestamp ?? 0) + 60_000);
    expect(results[3]?.state.phase).toBe('ACTED_LOCKED');
  });

  it('observations inside the cooldown window get COOLDOWN status and never act', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule({ cooldownMs: 60_000 }) });
    await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor, dt: DT });
    // Continue falling — a fresh full trend DURING cooldown.
    await runSequence(store, [85, 84, 83, 82], { actionExecutor: executor, t0: T0 + 4 * DT, block0: 1004 });
    expect(calls).toHaveLength(1); // never a second action
    const state = store.loadCommittedState().state;
    expect(state?.observations[4]?.ruleStatus).toBe('COOLDOWN');
    expect(state?.triggerRecords).toHaveLength(1);
  });

  it('after cooldown expiry a NEW full trend can act again (MAD re-arms after the idle gap)', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule({ cooldownMs: 30_000 }) });
    await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor }); // cooldown till T0+3DT+30s
    // Wait past the cooldown, then a fresh falling trend from a new baseline.
    // Note: after the idle gap the MAD filter re-arms (the first post-gap drop
    // is "unusual" vs pre-gap deltas), so the fresh trend needs 4 drops: the
    // first is re-baselined as a spike-suspect, then 3 confirmed drops act.
    const tLater = T0 + 3 * DT + 31_000;
    await runSequence(store, [86, 85, 84, 83, 82], { actionExecutor: executor, t0: tLater, block0: 2000 });
    expect(calls).toHaveLength(2);
    const state = store.loadCommittedState().state;
    expect(state?.triggerRecords).toHaveLength(2);
    expect(state?.observations.at(-1)?.ruleStatus).toBe('TRIGGERED_ACTING');
  });

  it('cooldownMs = 0 re-arms immediately (but the trigger record stays)', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule({ cooldownMs: 0 }) });
    await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    await runSequence(store, [85, 84, 83], { actionExecutor: executor, t0: T0 + 4 * DT, block0: 1004 });
    expect(calls).toHaveLength(2);
  });

  it('cooldown survives a restart (persisted)', async () => {
    const { executor } = recordingExecutor();
    const storeA = new PersistentTrendStore({ dataDir: root, rule: makeRule({ cooldownMs: 600_000 }) });
    await runSequence(storeA, [100, 95, 91, 86], { actionExecutor: executor });
    const storeB = new PersistentTrendStore({ dataDir: root, rule: makeRule({ cooldownMs: 600_000 }) });
    const r = await storeB.runCheck({ value: 85, metricSource: 'synthetic_scenario', blockNumber: 1004, timestamp: T0 + 4 * DT });
    expect(r.observation?.ruleStatus).toBe('COOLDOWN');
  });
});

describe('cross-instance continuity + mixed crash/dedup flows', () => {
  it('instance A crashes, instance B recovers, instance B triggers and acts', async () => {
    const { executor, calls } = recordingExecutor();
    const a = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(a, [100, 95]);
    await expect(
      a.runCheck({ value: 91, metricSource: 'synthetic_scenario', blockNumber: 1002, timestamp: T0 + 2 * DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);

    const b = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await b.runCheck({ value: 86, metricSource: 'synthetic_scenario', blockNumber: 1003, timestamp: T0 + 3 * DT, actionExecutor: executor });
    expect(calls).toHaveLength(1);
    const state = b.loadCommittedState().state;
    expect(state?.observations).toHaveLength(4);
    expect(state?.observations[2]?.streakCount).toBe(2); // recovered + re-evaluated
    expect(state?.triggerRecords).toHaveLength(1);
  });

  it('crash + WAL replay + replay-dedup produce EXACTLY one stored observation for the crashed check', async () => {
    const a = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(a, [100]);
    await expect(
      a.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);

    const b = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const recovered = await b.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT });
    expect(recovered.walRecovered).toBe(1);
    // Same inputs as the WAL tail → same idempotency id → dedup, NOT duplication.
    expect(recovered.deduplicated).toBe(true);
    expect(recovered.state.observations).toHaveLength(2);
    expect(recovered.state.observations.at(-1)?.observationId).toBe(recovered.state.observations[1]?.observationId);
  });

  it('hash chain remains intact after crash + recovery + dedup mix', async () => {
    const a = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(a, [100]);
    await expect(
      a.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT, simulateCrashAfter: 'wal' }),
    ).rejects.toBeInstanceOf(SimulatedCrashError);
    const b = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await b.runCheck({ value: 95, metricSource: 'synthetic_scenario', blockNumber: 1001, timestamp: T0 + DT }); // recovery + dedup
    await b.runCheck({ value: 91, metricSource: 'synthetic_scenario', blockNumber: 1002, timestamp: T0 + 2 * DT });
    expect(b.verifyIntegrity().integrity).toBe('OK');
    expect(b.loadCommittedState().state?.observations).toHaveLength(3);
  });

  it('value precision survives the round-trip', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const r = await store.runCheck({ value: 86.35, metricSource: 's', blockNumber: 1, timestamp: T0 });
    const reloaded = store.loadCommittedState().state?.observations[0];
    expect(r.observation?.value).toBe(86.35);
    expect(reloaded?.value).toBe(86.35);
  });

  it('metricSource with a token address is recorded verbatim', async () => {
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const src = 'onchain_erc20_balance:0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B';
    const r = await store.runCheck({ value: 5, metricSource: src, blockNumber: 1, timestamp: T0 });
    expect(r.observation?.metricSource).toBe(src);
    expect(store.loadCommittedState().state?.observations[0]?.metricSource).toBe(src);
  });

  it('trigger window contains the exact stored observation objects', async () => {
    const { executor } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    const record = results[3]?.triggerRecord;
    const stored = results.map((r) => r.observation).filter((o) => o !== null);
    expect(record?.window.map((o) => o.observationId)).toEqual(stored.map((o) => o?.observationId));
  });

  it('dedup does not create trigger records', async () => {
    const { executor, calls } = recordingExecutor();
    const store = new PersistentTrendStore({ dataDir: root, rule: makeRule() });
    await runSequence(store, [100, 95, 91, 86], { actionExecutor: executor });
    const before = store.loadCommittedState().state?.triggerRecords.length;
    await store.runCheck({
      value: 86,
      metricSource: 'synthetic_scenario',
      blockNumber: 1003,
      timestamp: T0 + 3 * DT,
      actionExecutor: executor,
    });
    expect(store.loadCommittedState().state?.triggerRecords.length).toBe(before);
    expect(calls).toHaveLength(1);
  });
});
