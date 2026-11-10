/**
 * Observation identity + hash-chain tests (Requirement 03, Innovation 1).
 */
import { describe, expect, it } from 'vitest';
import {
  ZERO_HASH,
  canonicalTimestampBucket,
  computeObservationHash,
  computeObservationId,
  toFixedPoint,
  verifyHashChain,
} from '@/lib/observation';
import { mkTempRoot, runSequence } from './helpers';
import { makeRule } from './helpers';
import { PersistentTrendStore } from '@/lib/storage';
import type { Observation } from '@/lib/types';

const id = (over: Partial<{ watcherId: string; blockNumber: number; metricSource: string; timestampBucket: number }> = {}): string =>
  computeObservationId({ watcherId: 'w', blockNumber: 100, metricSource: 'src', timestampBucket: 10, ...over });

describe('canonicalTimestampBucket', () => {
  it('buckets at 60s boundaries', () => {
    expect(canonicalTimestampBucket(0, 60)).toBe(0);
    expect(canonicalTimestampBucket(59_999, 60)).toBe(0);
    expect(canonicalTimestampBucket(60_000, 60)).toBe(1);
    expect(canonicalTimestampBucket(119_999, 60)).toBe(1);
    expect(canonicalTimestampBucket(120_000, 60)).toBe(2);
  });
  it('supports other bucket sizes', () => {
    expect(canonicalTimestampBucket(30_000, 30)).toBe(1);
    expect(canonicalTimestampBucket(3_600_000, 3600)).toBe(1);
  });
  it('bucketSeconds = 0 throws', () => {
    expect(() => canonicalTimestampBucket(1000, 0)).toThrow();
  });
  it('negative bucketSeconds throws', () => {
    expect(() => canonicalTimestampBucket(1000, -5)).toThrow();
  });
});

describe('computeObservationId — deterministic idempotency key', () => {
  it('is deterministic across calls', () => {
    expect(id()).toBe(id());
  });
  it('changes with watcherId', () => expect(id({ watcherId: 'w2' })).not.toBe(id()));
  it('changes with blockNumber', () => expect(id({ blockNumber: 101 })).not.toBe(id()));
  it('changes with metricSource', () => expect(id({ metricSource: 'other' })).not.toBe(id()));
  it('changes with timestampBucket', () => expect(id({ timestampBucket: 11 })).not.toBe(id()));
  it('is a 32-byte hex string', () => {
    expect(id()).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('differing ONLY by watcherId yields different ids (isolation)', () => {
    const a = computeObservationId({ watcherId: 'watcher-a', blockNumber: 1, metricSource: 'm', timestampBucket: 1 });
    const b = computeObservationId({ watcherId: 'watcher-b', blockNumber: 1, metricSource: 'm', timestampBucket: 1 });
    expect(a).not.toBe(b);
  });
  it('truncates fractional blockNumbers deterministically', () => {
    expect(id({ blockNumber: 100.9 })).toBe(id({ blockNumber: 100 }));
  });
});

describe('toFixedPoint', () => {
  it('scales integers to 1e8 fixed point', () => expect(toFixedPoint(100)).toBe(10_000_000_000n));
  it('scales fractions exactly', () => expect(toFixedPoint(0.5)).toBe(50_000_000n));
  it('rounds to the nearest 1e8 unit', () => expect(toFixedPoint(86.35)).toBe(8_635_000_000n));
  it('handles negatives', () => expect(toFixedPoint(-1)).toBe(-100_000_000n));
  it('rejects NaN', () => expect(() => toFixedPoint(Number.NaN)).toThrow());
  it('rejects Infinity', () => expect(() => toFixedPoint(Number.POSITIVE_INFINITY)).toThrow());
});

describe('computeObservationHash — hash-chain commit', () => {
  const h = (over: Partial<{ prevHash: string; blockNumber: number; value: number; observationId: string }> = {}): string =>
    computeObservationHash({
      prevHash: `0x${'aa'.repeat(32)}`,
      blockNumber: 5,
      value: 86.35,
      observationId: `0x${'bb'.repeat(32)}`,
      ...over,
    });

  it('is deterministic', () => expect(h()).toBe(h()));
  it('changes with the previous hash (chaining)', () => expect(h({ prevHash: `0x${'cc'.repeat(32)}` })).not.toBe(h()));
  it('changes with the value', () => expect(h({ value: 86.36 })).not.toBe(h()));
  it('changes with the blockNumber', () => expect(h({ blockNumber: 6 })).not.toBe(h()));
  it('changes with the observationId', () => expect(h({ observationId: `0x${'dd'.repeat(32)}` })).not.toBe(h()));
  it('is a 32-byte hex string', () => expect(h()).toMatch(/^0x[0-9a-f]{64}$/));
  it('minuscule value changes are detected (1e8 fixed-point resolution)', () => {
    expect(h({ value: 100.00000001 })).not.toBe(h({ value: 100 }));
  });
});

describe('ZERO_HASH', () => {
  it('is keccak256 of the empty string (known constant)', () => {
    expect(ZERO_HASH).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });
  it('is a 32-byte hex string', () => expect(ZERO_HASH).toMatch(/^0x[0-9a-f]{64}$/));
});

describe('verifyHashChain', () => {
  async function buildHistory(values: number[]): Promise<{ observations: Observation[]; store: PersistentTrendStore }> {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('chain'), rule: makeRule() });
    const results = await runSequence(store, values);
    const observations = results.map((r) => r.observation).filter((o): o is Observation => o !== null);
    return { observations, store };
  }

  it('a freshly stored chain verifies OK', async () => {
    const { observations } = await buildHistory([100, 95, 91, 86]);
    expect(verifyHashChain(observations, 'default', 60)).toEqual({ ok: true, badIndex: null, reason: null });
  });

  it('a single observation chain verifies OK (genesis = ZERO_HASH)', async () => {
    const { observations } = await buildHistory([100]);
    expect(observations[0]?.prevObservationHash).toBe(ZERO_HASH);
    expect(verifyHashChain(observations, 'default', 60).ok).toBe(true);
  });

  it('detects a tampered VALUE and pinpoints the index', async () => {
    const { observations } = await buildHistory([100, 95, 91, 86]);
    const tampered = observations.map((o, i) => (i === 2 ? { ...o, value: 90.5 } : o));
    const verdict = verifyHashChain(tampered, 'default', 60);
    expect(verdict.ok).toBe(false);
    expect(verdict.badIndex).toBe(2);
    expect(verdict.reason).toContain('observationHash');
  });

  it('detects a tampered metricSource (id recomputation)', async () => {
    const { observations } = await buildHistory([100, 95]);
    const tampered = observations.map((o, i) => (i === 1 ? { ...o, metricSource: 'evil' } : o));
    const verdict = verifyHashChain(tampered, 'default', 60);
    expect(verdict.ok).toBe(false);
    expect(verdict.badIndex).toBe(1);
  });

  it('detects a tampered timestamp (bucket recomputation)', async () => {
    const { observations } = await buildHistory([100, 95]);
    const tampered = observations.map((o, i) => (i === 1 ? { ...o, timestamp: o.timestamp + 3_600_000 } : o));
    const verdict = verifyHashChain(tampered, 'default', 60);
    expect(verdict.ok).toBe(false);
  });

  it('detects a removed middle observation (index discontinuity)', async () => {
    const { observations } = await buildHistory([100, 95, 91, 86]);
    const removed = [observations[0], observations[2], observations[3]].filter((o): o is Observation => !!o);
    const verdict = verifyHashChain(removed, 'default', 60);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('index discontinuity');
  });

  it('detects a broken prevObservationHash link', async () => {
    const { observations } = await buildHistory([100, 95, 91]);
    const tampered = observations.map((o, i) => (i === 2 ? { ...o, prevObservationHash: ZERO_HASH } : o));
    const verdict = verifyHashChain(tampered, 'default', 60);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('link');
  });

  it('detects tampering of an EARLY observation (cascading mismatch)', async () => {
    const { observations } = await buildHistory([100, 95, 91, 86]);
    const tampered = observations.map((o, i) => (i === 0 ? { ...o, value: 101 } : o));
    const verdict = verifyHashChain(tampered, 'default', 60);
    expect(verdict.ok).toBe(false);
    expect(verdict.badIndex).toBe(0);
  });

  it('verifies the empty chain as OK', () => {
    expect(verifyHashChain([], 'w', 60).ok).toBe(true);
  });
});
