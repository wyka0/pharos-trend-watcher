/**
 * Proof-of-Trend primitives tests (Innovation 1).
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, computeRuleHash, computeTrendProofDigest, windowObservationHashes } from '@/lib/proof';
import { mkTempRoot, runSequence } from './helpers';
import { makeRule } from './helpers';
import { PersistentTrendStore } from '@/lib/storage';
import type { Observation, TriggerMomentRecord } from '@/lib/types';

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('sorts nested keys recursively', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });
  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
  it('drops undefined values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it('handles strings with quotes', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
  });
  it('handles numbers and booleans', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });
  it('same semantic objects → identical strings', () => {
    expect(canonicalJson({ x: 1, y: [1, { b: 2, a: 3 }] })).toBe(canonicalJson({ y: [1, { a: 3, b: 2 }], x: 1 }));
  });
});

describe('computeRuleHash', () => {
  it('stable across structurally identical rules', () => {
    const a = makeRule();
    const b = makeRule();
    expect(computeRuleHash(a)).toBe(computeRuleHash(b));
  });
  it('changes with requiredObservations', () => {
    expect(computeRuleHash(makeRule({ requiredObservations: 3 }))).not.toBe(
      computeRuleHash(makeRule({ requiredObservations: 4 })),
    );
  });
  it('changes with thresholdBps', () => {
    expect(computeRuleHash(makeRule({ thresholdBps: 100 }))).not.toBe(computeRuleHash(makeRule({ thresholdBps: 200 })));
  });
  it('changes with direction', () => {
    expect(computeRuleHash(makeRule({ direction: 'FALLING' }))).not.toBe(computeRuleHash(makeRule({ direction: 'RISING' })));
  });
  it('is a 32-byte hex string', () => {
    expect(computeRuleHash(makeRule())).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('matches keccak256 of the canonical JSON', async () => {
    const { keccak256, toBytes } = await import('viem');
    const rule = makeRule();
    expect(computeRuleHash(rule)).toBe(keccak256(toBytes(canonicalJson(rule))));
  });
});

describe('trendProofDigest', () => {
  async function trigger(): Promise<{ record: TriggerMomentRecord; observations: Observation[] }> {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('proof'), rule: makeRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    const record = results[3]?.triggerRecord;
    if (!record) throw new Error('expected trigger');
    const observations = results.map((r) => r.observation).filter((o): o is Observation => !!o);
    return { record, observations };
  }

  it('digest = keccak256(ruleHash, windowHashes[]) — recomputable offline', async () => {
    const { record } = await trigger();
    expect(record.trendProofDigest).toBe(
      computeTrendProofDigest(record.ruleHash, windowObservationHashes(record.window)),
    );
  });

  it('changes when the window order changes', async () => {
    const { record } = await trigger();
    const reversed = [...windowObservationHashes(record.window)].reverse();
    expect(computeTrendProofDigest(record.ruleHash, reversed)).not.toBe(record.trendProofDigest);
  });

  it('changes when the ruleHash changes', async () => {
    const { record } = await trigger();
    expect(computeTrendProofDigest(`0x${'00'.repeat(32)}`, windowObservationHashes(record.window))).not.toBe(
      record.trendProofDigest,
    );
  });

  it('differs from the ruleHash itself', async () => {
    const { record } = await trigger();
    expect(record.trendProofDigest).not.toBe(record.ruleHash);
  });

  it('is a 32-byte hex string', async () => {
    const { record } = await trigger();
    expect(record.trendProofDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('windowObservationHashes maps in order', () => {
    const fake = [{ observationHash: '0x1' }, { observationHash: '0x2' }, { observationHash: '0x3' }] as unknown as Observation[];
    expect(windowObservationHashes(fake)).toEqual(['0x1', '0x2', '0x3']);
  });
});
