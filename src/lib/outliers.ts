/**
 * MAD / robust z-score outlier + whip-saw filter (Innovation 2).
 *
 * Distinguishes flash-loan / single-block oracle manipulation spikes from
 * genuine structural trends. Uses a rolling Median Absolute Deviation over the
 * most recent per-check deltas (in bps) — a robust estimator that a single
 * huge spike cannot drag — alongside the configurable absolute spike threshold.
 */

/** Consistency constant so MAD estimates sigma for normally distributed data. */
export const MAD_CONSISTENCY = 1.4826;
/** Robust z-score above which a delta is declared an outlier. */
export const MAD_OUTLIER_Z = 3.5;
/** Number of trailing deltas used for the rolling MAD window. */
export const MAD_WINDOW = 8;

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median() of empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Median Absolute Deviation about the median. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

export interface OutlierVerdict {
  isOutlier: boolean;
  /** Robust z-score when MAD was computable, else null. */
  madScore: number | null;
  /** Which detector fired: rolling MAD, the absolute bps threshold, or none. */
  method: 'MAD' | 'THRESHOLD' | 'NONE';
}

/**
 * Decide whether a single-check delta (bps) is a suspected spike.
 *
 * - With fewer than 3 historical deltas (or a degenerate MAD == 0) we fall
 *   back to the absolute threshold: |deltaBps| >= spikeThresholdBps.
 * - Otherwise the delta is an outlier when the robust z-score >= 3.5 OR it
 *   exceeds the absolute spike threshold (belt and braces).
 */
export function analyzeOutlier(
  recentDeltaBps: readonly number[],
  deltaBps: number,
  spikeThresholdBps: number,
): OutlierVerdict {
  // Non-finite deltas (NaN/±Infinity from broken oracles) are always suspects.
  const overThreshold = !Number.isFinite(deltaBps) || Math.abs(deltaBps) >= spikeThresholdBps;

  if (recentDeltaBps.length < 3) {
    return { isOutlier: overThreshold, madScore: null, method: overThreshold ? 'THRESHOLD' : 'NONE' };
  }

  const med = median(recentDeltaBps);
  const mad = medianAbsoluteDeviation(recentDeltaBps);
  const sigma = mad * MAD_CONSISTENCY;

  if (sigma <= 0) {
    // All recent deltas identical — MAD is degenerate; use absolute threshold.
    return { isOutlier: overThreshold, madScore: null, method: overThreshold ? 'THRESHOLD' : 'NONE' };
  }

  const z = Math.abs(deltaBps - med) / sigma;
  const isOutlier = z >= MAD_OUTLIER_Z || overThreshold;
  return { isOutlier, madScore: z, method: 'MAD' };
}

/** Rolling window helper: the trailing deltas (oldest → newest, max MAD_WINDOW). */
export function recentDeltas(history: readonly { deltaFromPrevBps: number | null }[]): number[] {
  return history
    .slice(-MAD_WINDOW)
    .map((o) => o.deltaFromPrevBps)
    .filter((d): d is number => d !== null && Number.isFinite(d));
}
