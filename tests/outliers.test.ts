/**
 * MAD / robust z-score outlier + whip-saw filter tests (Innovation 2).
 */
import { describe, expect, it } from 'vitest';
import {
  MAD_CONSISTENCY,
  MAD_OUTLIER_Z,
  MAD_WINDOW,
  analyzeOutlier,
  median,
  medianAbsoluteDeviation,
  recentDeltas,
} from '@/lib/outliers';

describe('median', () => {
  it('odd-length list', () => expect(median([1, 2, 3])).toBe(2));
  it('even-length list', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it('unsorted input', () => expect(median([5, 1, 3])).toBe(3));
  it('single element', () => expect(median([42])).toBe(42));
  it('negative values', () => expect(median([-5, -1, -3])).toBe(-3));
  it('empty list throws', () => expect(() => median([])).toThrow());
  it('does not mutate the input', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('medianAbsoluteDeviation', () => {
  it('identical values → 0', () => expect(medianAbsoluteDeviation([1, 1, 1])).toBe(0));
  it('simple spread', () => expect(medianAbsoluteDeviation([1, 2, 3, 4])).toBe(1));
  it('a single huge outlier cannot drag the MAD (robustness)', () => {
    // deviations from median 10: [0, 0, 0, 990] → median deviation 0
    expect(medianAbsoluteDeviation([10, 10, 10, 1000])).toBe(0);
  });
  it('symmetric spread', () => expect(medianAbsoluteDeviation([90, 100, 110])).toBe(10));
  it('empty list throws', () => expect(() => medianAbsoluteDeviation([])).toThrow());
});

describe('constants', () => {
  it('consistency constant matches the normal-distribution factor', () => {
    expect(MAD_CONSISTENCY).toBeCloseTo(1.4826, 4);
  });
  it('outlier z threshold is 3.5', () => expect(MAD_OUTLIER_Z).toBe(3.5));
  it('rolling window is 8 deltas', () => expect(MAD_WINDOW).toBe(8));
});

describe('analyzeOutlier — threshold fallback (short history)', () => {
  it('empty history + huge delta → outlier via THRESHOLD', () => {
    const v = analyzeOutlier([], -2500, 2000);
    expect(v.isOutlier).toBe(true);
    expect(v.method).toBe('THRESHOLD');
    expect(v.madScore).toBeNull();
  });
  it('empty history + normal delta → NONE', () => {
    const v = analyzeOutlier([], -500, 2000);
    expect(v.isOutlier).toBe(false);
    expect(v.method).toBe('NONE');
  });
  it('two history deltas still use the fallback', () => {
    const v = analyzeOutlier([-100, -100], -5000, 2000);
    expect(v.isOutlier).toBe(true);
    expect(v.method).toBe('THRESHOLD');
  });
  it('boundary: exactly at the threshold is an outlier (>=)', () => {
    expect(analyzeOutlier([], -2000, 2000).isOutlier).toBe(true);
  });
  it('just below the threshold is not', () => {
    expect(analyzeOutlier([], -1999, 2000).isOutlier).toBe(false);
  });
  it('works symmetrically for rises', () => {
    expect(analyzeOutlier([], 2500, 2000).isOutlier).toBe(true);
  });
  it('NaN delta is always a suspect', () => {
    expect(analyzeOutlier([], Number.NaN, 2000).isOutlier).toBe(true);
  });
  it('+Infinity delta is always a suspect', () => {
    expect(analyzeOutlier([], Number.POSITIVE_INFINITY, 2000).isOutlier).toBe(true);
  });
  it('-Infinity delta is always a suspect', () => {
    expect(analyzeOutlier([], Number.NEGATIVE_INFINITY, 2000).isOutlier).toBe(true);
  });
});

describe('analyzeOutlier — MAD path (>= 3 history deltas)', () => {
  it('flash-loan style single spike among noisy normal deltas → MAD outlier', () => {
    const history = [100, 120, 90, 110, 105, 95]; // med 102.5, MAD 7.5 → sigma ~11.1
    const v = analyzeOutlier(history, -800, 2000);
    expect(v.method).toBe('MAD');
    expect(v.isOutlier).toBe(true);
    expect(v.madScore as number).toBeGreaterThan(MAD_OUTLIER_Z);
  });
  it('normal delta within the noise band → no outlier', () => {
    const history = [100, 120, 90, 110, 105, 95];
    const v = analyzeOutlier(history, 110, 2000);
    expect(v.isOutlier).toBe(false);
    expect(v.madScore as number).toBeLessThan(MAD_OUTLIER_Z);
  });
  it('degenerate MAD (all identical) falls back to the threshold', () => {
    const v = analyzeOutlier([-20, -20, -20], -20, 2000);
    expect(v.isOutlier).toBe(false);
    expect(v.madScore).toBeNull();
  });
  it('degenerate MAD + huge delta → threshold outlier', () => {
    const v = analyzeOutlier([-20, -20, -20], -5000, 2000);
    expect(v.isOutlier).toBe(true);
    expect(v.madScore).toBeNull();
  });
  it('positive-direction spike detected symmetrically', () => {
    const history = [100, 110, 95, 105, 100, 98];
    const v = analyzeOutlier(history, 9000, 2000);
    expect(v.isOutlier).toBe(true);
  });
  it('madScore is the absolute robust z-score', () => {
    const history = [0, 0, 0, 0, 0]; // med 0, MAD 0 → degenerate
    expect(analyzeOutlier(history, 1, 10_000).madScore).toBeNull();
  });
  it('above the robust z threshold counts as outlier (MAD path)', () => {
    // med 0, MAD 0.6745 → sigma ≈ 1 → z(delta) ≈ delta
    const history = [-0.6745, 0, 0.6745];
    const v = analyzeOutlier(history, 3.6, 1_000_000);
    expect(v.isOutlier).toBe(true);
    expect(v.madScore as number).toBeGreaterThan(MAD_OUTLIER_Z);
  });
  it('below the robust z threshold does not outlier (MAD path)', () => {
    const history = [-0.6745, 0, 0.6745];
    const v = analyzeOutlier(history, 3.4, 1_000_000);
    expect(v.isOutlier).toBe(false);
    expect(v.madScore as number).toBeLessThan(MAD_OUTLIER_Z);
  });
});

describe('recentDeltas', () => {
  it('filters null deltas (baselines)', () => {
    expect(recentDeltas([{ deltaFromPrevBps: null }, { deltaFromPrevBps: -10 }, { deltaFromPrevBps: -20 }])).toEqual([-10, -20]);
  });
  it('caps at the rolling window size', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ deltaFromPrevBps: i }));
    expect(recentDeltas(history)).toHaveLength(MAD_WINDOW);
    expect(recentDeltas(history)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });
  it('returns empty for empty history', () => expect(recentDeltas([])).toEqual([]));
});
