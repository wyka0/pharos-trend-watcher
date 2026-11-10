/**
 * Trend Rule Engine tests (Requirement 02 + 05).
 * Validation (requiredObservations >= 3), all three DSL modes, single-spike
 * rejection, 2-drop-then-recovery rejection, exact trigger pinpointing.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_OBSERVATIONS,
  MIN_WINDOW_DURATION_MS,
  RuleValidationError,
  defaultTrendRule,
  describeRule,
  evaluateNewObservation,
  expectedWindowLength,
  isWithTrendMove,
  validateRule,
} from '@/lib/rules';
import { ZERO_HASH } from '@/lib/observation';
import { runSequence, makeRule, mkTempRoot, T0, DT } from './helpers';
import { PersistentTrendStore } from '@/lib/storage';
import type { TrendRule } from '@/lib/types';

const okRule = (): TrendRule => makeRule();

function ruleWith(overrides: Partial<TrendRule>): TrendRule {
  return makeRule(overrides);
}

describe('rule validation — requiredObservations must be an integer >= 3', () => {
  const badValues: Array<{ label: string; value: number }> = [
    { label: '0', value: 0 },
    { label: '1 (single observation)', value: 1 },
    { label: '2 (two observations)', value: 2 },
    { label: 'negative', value: -3 },
    { label: 'non-integer', value: 2.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'too large', value: 1001 },
  ];

  for (const { label, value } of badValues) {
    it(`rejects requiredObservations = ${label}`, () => {
      expect(() => validateRule(ruleWith({ requiredObservations: value }))).toThrow(RuleValidationError);
    });
  }

  it('rejects non-integer via evaluate-time creation too', () => {
    expect(() => defaultTrendRule({ requiredObservations: 1.5 })).toThrow(RuleValidationError);
  });

  it('explains WHY 1 and 2 are forbidden', () => {
    try {
      validateRule(ruleWith({ requiredObservations: 1 }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleValidationError);
      const problems = (err as RuleValidationError).problems.join(' ');
      expect(problems).toContain('>= 3');
      expect(problems).toContain('single observation');
    }
  });

  it(`accepts the minimum ${MIN_OBSERVATIONS}`, () => {
    expect(() => validateRule(ruleWith({ requiredObservations: 3 }))).not.toThrow();
  });

  for (const n of [3, 4, 5, 6, 7, 8, 10, 1000]) {
    it(`accepts requiredObservations = ${n}`, () => {
      expect(() => validateRule(ruleWith({ requiredObservations: n }))).not.toThrow();
    });
  }
});

describe('rule validation — other fields', () => {
  it('rejects unknown mode', () => {
    expect(() => validateRule(ruleWith({ mode: 'MAGIC' as TrendRule['mode'] }))).toThrow(/mode/);
  });
  it('rejects unknown direction', () => {
    expect(() => validateRule(ruleWith({ direction: 'SIDEWAYS' as TrendRule['direction'] }))).toThrow(/direction/);
  });
  it('rejects CUMULATIVE_DELTA_BPS with thresholdBps = 0', () => {
    expect(() => validateRule(ruleWith({ mode: 'CUMULATIVE_DELTA_BPS', thresholdBps: 0 }))).toThrow(/thresholdBps/);
  });
  it('rejects CUMULATIVE_DELTA_BPS with negative thresholdBps', () => {
    expect(() => validateRule(ruleWith({ mode: 'CUMULATIVE_DELTA_BPS', thresholdBps: -50 }))).toThrow(/thresholdBps/);
  });
  it('rejects MOVING_WINDOW_DURATION below one minute', () => {
    expect(() =>
      validateRule(ruleWith({ mode: 'MOVING_WINDOW_DURATION', windowDurationMs: MIN_WINDOW_DURATION_MS - 1 })),
    ).toThrow(/windowDurationMs/);
  });
  it('accepts MOVING_WINDOW_DURATION of exactly one minute', () => {
    expect(() =>
      validateRule(ruleWith({ mode: 'MOVING_WINDOW_DURATION', windowDurationMs: MIN_WINDOW_DURATION_MS })),
    ).not.toThrow();
  });
  it('rejects spikeThresholdBps = 0', () => {
    expect(() => validateRule(ruleWith({ spikeThresholdBps: 0 }))).toThrow(/spikeThresholdBps/);
  });
  it('rejects negative cooldownMs', () => {
    expect(() => validateRule(ruleWith({ cooldownMs: -1 }))).toThrow(/cooldownMs/);
  });
  it('rejects empty id', () => {
    expect(() => validateRule(ruleWith({ id: ' ' }))).toThrow(/id/);
  });
  it('rejects empty name', () => {
    expect(() => validateRule(ruleWith({ name: '' }))).toThrow(/name/);
  });
  it('default rule passes validation with requiredObservations = 3', () => {
    const rule = defaultTrendRule();
    expect(() => validateRule(rule)).not.toThrow();
    expect(rule.requiredObservations).toBe(3);
  });
  it('RuleValidationError carries the problems list', () => {
    try {
      validateRule(ruleWith({ requiredObservations: 2, spikeThresholdBps: 0 }));
      expect.unreachable();
    } catch (err) {
      expect((err as RuleValidationError).problems.length).toBe(2);
      expect((err as RuleValidationError).name).toBe('RuleValidationError');
    }
  });
});

describe('CONSECUTIVE_MONOTONIC — falling, required 3 (Requirement 05 scenario)', () => {
  it('triggers EXACTLY at the 3rd consecutive drop (observation #4)', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('mono'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    expect(results.map((r) => r.triggered)).toEqual([false, false, false, true]);
    expect(results[3]?.triggerRecord?.triggerObservationIndex).toBe(4);
  });

  it('streak counts 0 → 1 → 2 → 3 across the window', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('mono2'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    expect(results.map((r) => r.observation?.streakCount)).toEqual([0, 1, 2, 3]);
  });

  it('statuses accumulate then TRIGGERED_ACTING', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('mono3'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    expect(results.map((r) => r.observation?.ruleStatus)).toEqual([
      'ACCUMULATING',
      'ACCUMULATING',
      'ACCUMULATING',
      'TRIGGERED_ACTING',
    ]);
  });

  it('trigger window = baseline + 3 drops, hashes in order', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('mono4'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    const window = results[3]?.triggerRecord?.window ?? [];
    expect(window.map((o) => o.value)).toEqual([100, 95, 91, 86]);
    expect(window[0]?.prevObservationHash).toBe(results[0]?.observation?.prevObservationHash);
    for (let i = 1; i < window.length; i++) {
      expect(window[i]?.prevObservationHash).toBe(window[i - 1]?.observationHash);
    }
  });

  it('requires the FULL streak: required 4 needs a 4th consecutive drop', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('mono5'), rule: ruleWith({ requiredObservations: 4 }) });
    const results = await runSequence(store, [100, 95, 91, 86, 80]);
    expect(results[3]?.triggered).toBe(false);
    expect(results[4]?.triggered).toBe(true);
    expect(results[4]?.triggerRecord?.triggerObservationIndex).toBe(5);
  });

  it('single big spike followed by recovery → SPIKE_REJECTED, never acts', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('spike1'), rule: okRule() });
    const results = await runSequence(store, [100, 75, 99]);
    expect(results.map((r) => r.triggered)).toEqual([false, false, false]);
    expect(results[1]?.observation?.isOutlier).toBe(true);
    expect(results[2]?.observation?.ruleStatus).toBe('SPIKE_REJECTED');
    expect(results[2]?.observation?.streakCount).toBe(0);
    expect(store.loadCommittedState().state?.triggerRecords.length).toBe(0);
  });

  it('2 consecutive drops then recovery → plain reset (ACCUMULATING, no trigger)', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('spike2'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 99]);
    expect(results.map((r) => r.triggered)).toEqual([false, false, false, false]);
    expect(results[3]?.observation?.ruleStatus).toBe('ACCUMULATING');
    expect(results[3]?.observation?.streakCount).toBe(0);
  });

  it('1 drop then recovery → ACCUMULATING', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('spike3'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 99]);
    expect(results[2]?.observation?.ruleStatus).toBe('ACCUMULATING');
    expect(results[2]?.observation?.streakCount).toBe(0);
  });

  it('flat line never accumulates a streak', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('flat'), rule: okRule() });
    const results = await runSequence(store, [100, 100, 100, 100]);
    expect(results.map((r) => r.observation?.streakCount)).toEqual([0, 0, 0, 0]);
    expect(results.every((r) => !r.triggered)).toBe(true);
  });

  it('a flat check in the middle breaks the streak', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('flat2'), rule: okRule() });
    const results = await runSequence(store, [100, 99, 99, 98]);
    expect(results.map((r) => r.observation?.streakCount)).toEqual([0, 1, 0, 1]);
    expect(results.every((r) => !r.triggered)).toBe(true);
  });

  it('spike excluded from streak: structural continuation re-baselines (100→75→74→73→72 acts at #5)', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('spike4'), rule: okRule() });
    const results = await runSequence(store, [100, 75, 74, 73, 72]);
    expect(results[1]?.observation?.isOutlier).toBe(true);
    expect(results[2]?.observation?.streakCount).toBe(1); // re-baselined after the spike
    expect(results[4]?.triggered).toBe(true);
    expect(results[4]?.triggerRecord?.triggerObservationIndex).toBe(5);
  });

  it('with rejectSingleSpike disabled, raw consecutive moves count (100→75→74 triggers at #3... no — 2 drops only)', async () => {
    const store = new PersistentTrendStore({
      dataDir: mkTempRoot('spike5'),
      rule: ruleWith({ rejectSingleSpike: false }),
    });
    const results = await runSequence(store, [100, 75, 74, 73]);
    expect(results[2]?.observation?.streakCount).toBe(2); // raw counting
    expect(results[3]?.triggered).toBe(true); // 3 raw drops
  });

  it('big mid-trend spike then recovery is rejected too', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('spike6'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 70, 96]);
    expect(results[2]?.observation?.isOutlier).toBe(true);
    expect(results[3]?.observation?.ruleStatus).toBe('SPIKE_REJECTED');
    expect(results.every((r) => !r.triggered)).toBe(true);
  });

  it('RISING direction mirror: 3 consecutive rises act at #4', async () => {
    const store = new PersistentTrendStore({
      dataDir: mkTempRoot('rise'),
      rule: ruleWith({ direction: 'RISING' }),
    });
    const results = await runSequence(store, [10, 11, 12, 13]);
    expect(results[3]?.triggered).toBe(true);
    expect(results[3]?.triggerRecord?.triggerObservationIndex).toBe(4);
  });

  it('RISING spike then drop is rejected', async () => {
    const store = new PersistentTrendStore({
      dataDir: mkTempRoot('rise2'),
      rule: ruleWith({ direction: 'RISING' }),
    });
    const results = await runSequence(store, [10, 20, 11]);
    expect(results[2]?.observation?.ruleStatus).toBe('SPIKE_REJECTED');
    expect(results.every((r) => !r.triggered)).toBe(true);
  });

  it('deltas recorded in bps with correct values', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('bps'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    expect(results[1]?.observation?.deltaFromPrev).toBe(-5);
    expect(results[1]?.observation?.deltaFromPrevBps).toBeCloseTo(-500, 6);
    expect(results[2]?.observation?.deltaFromPrevBps).toBeCloseTo(-421.0526, 3);
  });

  it('early observations have no MAD score yet', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('mad1'), rule: okRule() });
    const results = await runSequence(store, [100, 95]);
    expect(results[0]?.observation?.madScore).toBeNull();
    expect(results[1]?.observation?.madScore).toBeNull();
  });

  it('observations are hash-chained (prev link)', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('chain'), rule: okRule() });
    const results = await runSequence(store, [100, 95, 91, 86]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]?.observation?.prevObservationHash).toBe(results[i - 1]?.observation?.observationHash);
    }
  });
});

describe('CUMULATIVE_DELTA_BPS mode', () => {
  const deltaRule = (thresholdBps: number, direction: TrendRule['direction'] = 'FALLING'): TrendRule =>
    ruleWith({ mode: 'CUMULATIVE_DELTA_BPS', thresholdBps, direction });

  it('triggers when cumulative move crosses the threshold across 3 checks', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta1'), rule: deltaRule(150) });
    const results = await runSequence(store, [100, 99, 98, 97]); // -300 bps cumulative
    expect(results[3]?.triggered).toBe(true);
    expect(results[3]?.triggerRecord?.triggerObservationIndex).toBe(4);
  });

  it('does NOT trigger when cumulative move stays below the threshold', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta2'), rule: deltaRule(150) });
    const results = await runSequence(store, [100, 99.5, 99, 98.7]); // -130 bps
    expect(results[3]?.triggered).toBe(false);
    expect(results[3]?.observation?.ruleStatus).toBe('ACCUMULATING');
  });

  it('a counter-move in the window breaks the streak and blocks the trigger', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta3'), rule: deltaRule(150) });
    const results = await runSequence(store, [100, 99, 100, 97]);
    expect(results[3]?.triggered).toBe(false);
  });

  it('works in RISING direction', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta4'), rule: deltaRule(150, 'RISING') });
    const results = await runSequence(store, [10, 10.2, 10.4, 10.6]); // +600 bps
    expect(results[3]?.triggered).toBe(true);
  });

  it('threshold boundary: exactly at threshold triggers (<=)', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta5'), rule: deltaRule(300) });
    const results = await runSequence(store, [100, 99, 98, 97]); // exactly -300
    expect(results[3]?.triggered).toBe(true);
  });

  it('window slice is the last required+1 observations', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta6'), rule: deltaRule(150) });
    const results = await runSequence(store, [120, 100, 99, 98, 97]);
    const window = results[4]?.triggerRecord?.window ?? [];
    expect(window.map((o) => o.value)).toEqual([100, 99, 98, 97]);
  });

  it('single huge drop does not trigger delta mode alone (streak too short)', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('delta7'), rule: deltaRule(150) });
    const results = await runSequence(store, [100, 70]);
    expect(results[1]?.triggered).toBe(false);
  });
});

describe('MOVING_WINDOW_DURATION mode', () => {
  const durationRule = (windowDurationMs: number, requiredObservations = 3): TrendRule =>
    ruleWith({ mode: 'MOVING_WINDOW_DURATION', windowDurationMs, requiredObservations });

  it('does NOT trigger when the run spans less than the window', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('dur1'), rule: durationRule(60_000) });
    const results = await runSequence(store, [100, 99, 98, 97, 96], { dt: 10_000 }); // 40s span
    expect(results[4]?.triggered).toBe(false);
  });

  it('triggers when the run spans at least the window', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('dur2'), rule: durationRule(60_000) });
    const results = await runSequence(store, [100, 99, 98, 97, 96], { dt: 20_000 }); // 80s span
    expect(results[4]?.triggered).toBe(true);
    expect(results[4]?.triggerRecord?.triggerObservationIndex).toBe(5);
  });

  it('window includes the baseline and spans >= windowDurationMs', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('dur3'), rule: durationRule(60_000) });
    const results = await runSequence(store, [100, 99, 98, 97], { dt: 20_000 });
    const window = results[3]?.triggerRecord?.window ?? [];
    expect(window[0]?.value).toBe(100);
    const span = (window[window.length - 1]?.timestamp ?? 0) - (window[0]?.timestamp ?? 0);
    expect(span).toBeGreaterThanOrEqual(60_000);
  });

  it('a flat check resets the duration run', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('dur4'), rule: durationRule(60_000) });
    const results = await runSequence(store, [100, 99, 99, 98, 97, 96], { dt: 20_000 });
    // run restarts at obs3 (99 → 99 flat); span from obs3 to obs6 = 60s >= 60s, drops 3 → triggers at #6
    expect(results[5]?.triggered).toBe(true);
    const window = results[5]?.triggerRecord?.window ?? [];
    expect(window.map((o) => o.value)).toEqual([99, 98, 97, 96]);
  });

  it('rejects configuration below the one-minute minimum', () => {
    expect(() => validateRule(durationRule(59_999))).toThrow(RuleValidationError);
  });

  it('duration mode still requires >= 3 consecutive checks', async () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('dur5'), rule: durationRule(60_000) });
    const results = await runSequence(store, [100, 99, 98], { dt: 60_000 }); // span 120s but only 2 drops
    expect(results[2]?.triggered).toBe(false);
  });
});

describe('rule presentation helpers', () => {
  it('describeRule — monotonic', () => {
    expect(describeRule(ruleWith({ mode: 'CONSECUTIVE_MONOTONIC', requiredObservations: 3, direction: 'FALLING' }))).toBe(
      'Metric strictly falling for 3 checks in a row',
    );
  });
  it('describeRule — cumulative delta', () => {
    expect(describeRule(ruleWith({ mode: 'CUMULATIVE_DELTA_BPS', thresholdBps: 250, direction: 'FALLING' }))).toBe(
      'Metric falling >= 250 bps cumulatively across 3 consecutive checks',
    );
  });
  it('describeRule — moving window duration', () => {
    expect(describeRule(ruleWith({ mode: 'MOVING_WINDOW_DURATION', windowDurationMs: 120_000 }))).toBe(
      'Metric falling continuously across observations spanning >= 2 minutes (>= 3 checks)',
    );
  });
  it('describeRule — rising monotonic', () => {
    expect(describeRule(ruleWith({ direction: 'RISING' }))).toContain('rising');
  });
  it('expectedWindowLength — monotonic/delta = required+1, duration = variable', () => {
    expect(expectedWindowLength(ruleWith({ mode: 'CONSECUTIVE_MONOTONIC', requiredObservations: 3 }))).toBe(4);
    expect(expectedWindowLength(ruleWith({ mode: 'CUMULATIVE_DELTA_BPS', requiredObservations: 5 }))).toBe(6);
    expect(expectedWindowLength(ruleWith({ mode: 'MOVING_WINDOW_DURATION' }))).toBeNull();
  });
  it('isWithTrendMove — absolute direction test', () => {
    const falling = ruleWith({ direction: 'FALLING' });
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('move'), rule: falling });
    void store;
    const rising = ruleWith({ direction: 'RISING' });
    const obsA = { value: 10 } as never;
    const obsB = { value: 9 } as never;
    expect(isWithTrendMove(falling, obsA, obsB)).toBe(true);
    expect(isWithTrendMove(rising, obsA, obsB)).toBe(false);
  });
});

describe('evaluateNewObservation — pure function edge cases', () => {
  const base = okRule();

  it('baseline observation: streak 0, ACCUMULATING, no trigger', () => {
    const out = evaluateNewObservation({
      rule: base,
      history: [],
      value: 100,
      timestamp: T0,
      watcherId: 'w',
      blockNumber: 1,
      metricSource: 'synthetic_scenario',
      bucketSeconds: 60,
      pid: 1,
      prevHash: ZERO_HASH,
      cooldownActive: false,
    });
    expect(out.triggered).toBe(false);
    expect(out.observation.streakCount).toBe(0);
    expect(out.observation.ruleStatus).toBe('ACCUMULATING');
    expect(out.observation.index).toBe(1);
  });

  it('index continues from history', () => {
    const store = new PersistentTrendStore({ dataDir: mkTempRoot('idx'), rule: base });
    void store;
    const first = evaluateNewObservation({
      rule: base, history: [], value: 100, timestamp: T0, watcherId: 'w', blockNumber: 1,
      metricSource: 'synthetic_scenario', bucketSeconds: 60, pid: 1, prevHash: ZERO_HASH, cooldownActive: false,
    });
    const second = evaluateNewObservation({
      rule: base, history: [first.observation], value: 99, timestamp: T0 + 1000, watcherId: 'w', blockNumber: 2,
      metricSource: 'synthetic_scenario', bucketSeconds: 60, pid: 1, prevHash: first.observation.observationHash, cooldownActive: false,
    });
    expect(second.observation.index).toBe(2);
  });

  it('cooldownActive forces COOLDOWN + zero streak even on a falling check', () => {
    const out = evaluateNewObservation({
      rule: base,
      history: [],
      value: 90,
      timestamp: T0,
      watcherId: 'w',
      blockNumber: 1,
      metricSource: 'synthetic_scenario',
      bucketSeconds: 60,
      pid: 1,
      prevHash: ZERO_HASH,
      cooldownActive: true,
    });
    expect(out.observation.ruleStatus).toBe('COOLDOWN');
    expect(out.observation.streakCount).toBe(0);
    expect(out.triggered).toBe(false);
  });
});
