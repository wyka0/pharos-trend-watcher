/** Shared fixtures + helpers for the Trend Watcher test suite. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentTrendStore } from '@/lib/storage';
import type { ActionExecutor, RunCheckResult, TrendRule } from '@/lib/types';

/** Isolated temp data dir per test. */
export function mkTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `watcher-${label}-`));
}

export function makeRule(overrides: Partial<TrendRule> = {}): TrendRule {
  // NOTE: intentionally does NOT validate — tests must be able to build
  // deliberately invalid rules to assert on validateRule() itself.
  return {
    id: 'test-rule',
    name: 'test rule',
    mode: 'CONSECUTIVE_MONOTONIC',
    direction: 'FALLING',
    requiredObservations: 3,
    thresholdBps: 500,
    windowDurationMs: 180_000,
    rejectSingleSpike: true,
    spikeThresholdBps: 2_000,
    cooldownMs: 0,
    ...overrides,
  };
}

export interface SequenceOptions {
  t0?: number;
  dt?: number;
  block0?: number;
  blockStep?: number;
  metricSource?: string;
  actionExecutor?: ActionExecutor | null;
}

/** Fixed synthetic clock/blocks so every test is deterministic. */
export const T0 = 1_700_000_000_000;
export const DT = 10_000;

/** Run a value sequence through one store instance (one "process"). */
export async function runSequence(
  store: PersistentTrendStore,
  values: number[],
  opts: SequenceOptions = {},
): Promise<RunCheckResult[]> {
  const t0 = opts.t0 ?? T0;
  const dt = opts.dt ?? DT;
  const block0 = opts.block0 ?? 1_000;
  const blockStep = opts.blockStep ?? 1;
  const results: RunCheckResult[] = [];
  for (let i = 0; i < values.length; i++) {
    results.push(
      await store.runCheck({
        value: values[i] as number,
        metricSource: opts.metricSource ?? 'synthetic_scenario',
        blockNumber: block0 + i * blockStep,
        timestamp: t0 + i * dt,
        actionExecutor: opts.actionExecutor ?? null,
      }),
    );
  }
  return results;
}

export interface RecordedCall {
  ruleHash: string;
  proofDigest: string;
  index: number;
  windowLen: number;
  windowValues: number[];
}

/** Fake on-chain action executor that records every call. */
export function recordingExecutor(): {
  executor: ActionExecutor;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const executor: ActionExecutor = async (ctx) => {
    calls.push({
      ruleHash: ctx.trigger.ruleHash,
      proofDigest: ctx.trigger.trendProofDigest,
      index: ctx.trigger.triggerObservationIndex,
      windowLen: ctx.trigger.window.length,
      windowValues: ctx.trigger.window.map((o) => o.value),
    });
    return {
      txHash: `0x${'ab'.repeat(32)}`,
      explorerUrl: 'https://atlantic.pharosscan.xyz/tx/0xmock',
      mode: 'ANCHOR_CONTRACT',
    };
  };
  return { executor, calls };
}

export const MOCK_TX = `0x${'cd'.repeat(32)}`;
