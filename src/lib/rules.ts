/**
 * Configurable Multi-Observation Trend Rule Engine (Requirement 02, 05).
 *
 * Hard invariants:
 *  - `requiredObservations` MUST be an integer >= 3 (a trend is never confirmed
 *    from one or two observations; single-spike acting is structurally forbidden).
 *  - Three DSL modes: CONSECUTIVE_MONOTONIC, CUMULATIVE_DELTA_BPS,
 *    MOVING_WINDOW_DURATION — all driven by the same consecutive-streak core,
 *    with mode-specific trigger gates and a per-observation noise filter.
 *  - Single-spike rejection: a suspected flash move (MAD outlier / above
 *    spikeThresholdBps) cannot anchor a confirmed streak; if the very next
 *    check recovers, the streak is zeroed and the status is SPIKE_REJECTED.
 */
import { analyzeOutlier, recentDeltas, type OutlierVerdict } from './outliers';
import { canonicalTimestampBucket, computeObservationHash, computeObservationId } from './observation';
import type { Observation, TrendDirection, TrendRule } from './types';

export const MIN_OBSERVATIONS = 3;
/** MOVING_WINDOW_DURATION requires a window of at least one minute. */
export const MIN_WINDOW_DURATION_MS = 60_000;

const RULE_MODES = ['CONSECUTIVE_MONOTONIC', 'CUMULATIVE_DELTA_BPS', 'MOVING_WINDOW_DURATION'] as const;
const DIRECTIONS = ['FALLING', 'RISING'] as const;

export class RuleValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid trend rule: ${problems.join(' | ')}`);
    this.name = 'RuleValidationError';
    this.problems = problems;
  }
}

export function validateRule(rule: TrendRule): void {
  const problems: string[] = [];
  if (!rule || typeof rule !== 'object') {
    throw new RuleValidationError(['rule must be an object']);
  }
  if (!Number.isInteger(rule.requiredObservations) || rule.requiredObservations < MIN_OBSERVATIONS) {
    problems.push(
      `requiredObservations must be an integer >= ${MIN_OBSERVATIONS} (got ${String(rule.requiredObservations)}); ` +
        'a trend requires at least 3 consecutive observations — acting on a single observation is forbidden',
    );
  }
  if (rule.requiredObservations > 1000) {
    problems.push('requiredObservations must be <= 1000');
  }
  if (!(RULE_MODES as readonly string[]).includes(rule.mode)) {
    problems.push(`mode must be one of ${RULE_MODES.join(' | ')} (got ${String(rule.mode)})`);
  }
  if (!(DIRECTIONS as readonly string[]).includes(rule.direction)) {
    problems.push(`direction must be FALLING or RISING (got ${String(rule.direction)})`);
  }
  if (rule.mode === 'CUMULATIVE_DELTA_BPS' && (!Number.isFinite(rule.thresholdBps) || rule.thresholdBps <= 0)) {
    problems.push('thresholdBps must be a positive finite number for CUMULATIVE_DELTA_BPS');
  }
  if (rule.mode === 'MOVING_WINDOW_DURATION' && (!Number.isFinite(rule.windowDurationMs) || rule.windowDurationMs < MIN_WINDOW_DURATION_MS)) {
    problems.push(`windowDurationMs must be >= ${MIN_WINDOW_DURATION_MS} for MOVING_WINDOW_DURATION`);
  }
  if (!Number.isFinite(rule.spikeThresholdBps) || rule.spikeThresholdBps <= 0) {
    problems.push('spikeThresholdBps must be a positive finite number');
  }
  if (!Number.isInteger(rule.cooldownMs) || rule.cooldownMs < 0) {
    problems.push('cooldownMs must be a non-negative integer');
  }
  if (typeof rule.id !== 'string' || rule.id.trim() === '') problems.push('id must be a non-empty string');
  if (typeof rule.name !== 'string' || rule.name.trim() === '') problems.push('name must be a non-empty string');
  if (problems.length > 0) throw new RuleValidationError(problems);
}

export function defaultTrendRule(overrides: Partial<TrendRule> = {}): TrendRule {
  const rule: TrendRule = {
    id: 'vault-drawdown-guard',
    name: 'Vault drawdown guard — 3 consecutive checks',
    mode: 'CONSECUTIVE_MONOTONIC',
    direction: 'FALLING',
    requiredObservations: 3,
    thresholdBps: 500,
    windowDurationMs: 180_000,
    rejectSingleSpike: true,
    spikeThresholdBps: 2_000,
    cooldownMs: 30 * 60_000,
    ...overrides,
  };
  validateRule(rule);
  return rule;
}

// ---------------------------------------------------------------------------
// Move analysis
// ---------------------------------------------------------------------------

export type MoveKind = 'BASELINE' | 'WITH_TREND' | 'AGAINST_TREND' | 'FLAT';

export interface MoveAnalysis {
  kind: MoveKind;
  deltaFromPrev: number | null;
  deltaFromPrevBps: number | null;
}

/** Absolute directional test: did the metric move with the rule's direction? */
export function isWithTrendMove(rule: TrendRule, from: Observation, to: Observation): boolean {
  return rule.direction === 'FALLING' ? to.value < from.value : to.value > from.value;
}

export function analyzeMove(rule: TrendRule, prev: Observation | null, value: number): MoveAnalysis {
  if (!prev || !Number.isFinite(prev.value)) {
    return { kind: 'BASELINE', deltaFromPrev: null, deltaFromPrevBps: null };
  }
  const deltaFromPrev = value - prev.value;
  const deltaFromPrevBps = prev.value === 0 ? null : (deltaFromPrev / Math.abs(prev.value)) * 10_000;
  const moved = rule.direction === 'FALLING' ? value < prev.value : value > prev.value;
  const opposed = rule.direction === 'FALLING' ? value > prev.value : value < prev.value;
  const kind: MoveKind = moved ? 'WITH_TREND' : opposed ? 'AGAINST_TREND' : 'FLAT';
  return { kind, deltaFromPrev, deltaFromPrevBps };
}

// ---------------------------------------------------------------------------
// Evaluation of a brand-new observation (pure; used by the store and tests)
// ---------------------------------------------------------------------------

export interface EvaluateNewObservationInput {
  rule: TrendRule;
  /** Full stored history WITHOUT the new observation. */
  history: readonly Observation[];
  value: number;
  timestamp: number;
  watcherId: string;
  blockNumber: number;
  metricSource: string;
  bucketSeconds: number;
  pid: number;
  /** Hash-chain head (state.lastObservationHash). */
  prevHash: string;
  cooldownActive: boolean;
}

export interface EvaluateNewObservationOutput {
  observation: Observation;
  triggered: boolean;
  /** The N-observation window slice that satisfied the rule (when triggered). */
  window: Observation[] | null;
  reason: string;
  spikeRejected: boolean;
  outlier: OutlierVerdict;
}

export function evaluateNewObservation(input: EvaluateNewObservationInput): EvaluateNewObservationOutput {
  const { rule, history, value, timestamp } = input;
  const prev = history.length > 0 ? (history[history.length - 1] as Observation) : null;
  const index = (prev?.index ?? 0) + 1;
  const bucket = canonicalTimestampBucket(timestamp, input.bucketSeconds);
  const observationId = computeObservationId({
    watcherId: input.watcherId,
    blockNumber: input.blockNumber,
    metricSource: input.metricSource,
    timestampBucket: bucket,
  });

  const move = analyzeMove(rule, prev, value);
  const outlier = analyzeOutlier(recentDeltas(history), move.deltaFromPrevBps ?? 0, rule.spikeThresholdBps);

  // --- streak + spike rejection (Requirement 05) ---
  let streakCount = 0;
  let spikeRejected = false;
  if (prev && move.kind === 'WITH_TREND') {
    // A suspected single spike can never anchor a confirmed streak: the next
    // confirmed move re-baselines the streak to 1 (measured from the spike).
    // With rejectSingleSpike disabled, raw consecutive moves are trusted instead.
    streakCount = prev.isOutlier && rule.rejectSingleSpike ? 1 : prev.streakCount + 1;
  } else if (prev && move.kind === 'AGAINST_TREND') {
    if (rule.rejectSingleSpike && prev.isOutlier) {
      // Massive single-check move followed by recovery → SPIKE_REJECTED, no action, ever.
      spikeRejected = true;
      streakCount = 0;
    } else {
      streakCount = 0; // ordinary 2-drop-then-recovery style reset
    }
  } // FLAT / BASELINE → streak 0
  if (input.cooldownActive) streakCount = 0; // hysteresis: a fresh full trend is required after unlock

  const candidate: Observation = {
    index,
    observationId,
    observationHash: computeObservationHash({ prevHash: input.prevHash, blockNumber: input.blockNumber, value, observationId }),
    prevObservationHash: input.prevHash,
    runProcessPid: input.pid,
    blockNumber: input.blockNumber,
    timestamp,
    timestampBucket: bucket,
    metricSource: input.metricSource,
    value,
    deltaFromPrev: move.deltaFromPrev,
    deltaFromPrevBps: move.deltaFromPrevBps,
    streakCount,
    ruleStatus: 'ACCUMULATING',
    isOutlier: outlier.isOutlier,
    madScore: outlier.madScore,
  };

  // --- mode-specific trigger gates ---
  let triggered = false;
  let window: Observation[] | null = null;
  let reason: string;

  if (spikeRejected) {
    reason = 'single-spike recovery: huge one-check move followed by a counter-move — streak reset, NO action';
  } else if (input.cooldownActive) {
    reason = 'cooldown lock (ACTED_LOCKED): hysteresis guard active, no new action';
  } else if (streakCount < rule.requiredObservations) {
    reason = `accumulating: ${streakCount}/${rule.requiredObservations} consecutive ${rule.direction.toLowerCase()} checks`;
  } else {
    const all: Observation[] = [...history, candidate];
    if (rule.mode === 'CONSECUTIVE_MONOTONIC') {
      window = all.slice(-(rule.requiredObservations + 1));
      triggered = true;
      reason = `${rule.requiredObservations} consecutive ${rule.direction.toLowerCase()} checks confirmed`;
    } else if (rule.mode === 'CUMULATIVE_DELTA_BPS') {
      window = all.slice(-(rule.requiredObservations + 1));
      const first = window[0] as Observation;
      const last = window[window.length - 1] as Observation;
      const cumulativeBps = first.value === 0 ? null : ((last.value - first.value) / Math.abs(first.value)) * 10_000;
      const target = rule.direction === 'FALLING' ? -rule.thresholdBps : rule.thresholdBps;
      triggered = cumulativeBps !== null && (rule.direction === 'FALLING' ? cumulativeBps <= target : cumulativeBps >= target);
      reason = triggered
        ? `cumulative move ${cumulativeBps?.toFixed(1)} bps crossed the ${rule.thresholdBps} bps threshold across ${rule.requiredObservations} checks`
        : `cumulative move ${cumulativeBps?.toFixed(1) ?? 'n/a'} bps has not crossed the ±${rule.thresholdBps} bps threshold yet`;
    } else {
      // MOVING_WINDOW_DURATION: walk back over the full continuous run. After
      // the walk, the move into `all[start]` is NOT with-trend (or start == 0),
      // so `all[start]` is the baseline the first run-move originated from.
      let start = all.length - 1;
      while (start > 0 && isWithTrendMove(rule, all[start - 1] as Observation, all[start] as Observation)) start--;
      window = all.slice(start);
      const first = window[0] as Observation;
      const last = window[window.length - 1] as Observation;
      const spanMs = last.timestamp - first.timestamp;
      const movesInRun = all.length - 1 - start;
      triggered = movesInRun >= rule.requiredObservations && spanMs >= rule.windowDurationMs;
      reason = triggered
        ? `continuous ${rule.direction.toLowerCase()} run across ${(spanMs / 60_000).toFixed(1)} min (>= ${Math.round(rule.windowDurationMs / 60_000)} min) with ${movesInRun} checks`
        : `run has ${movesInRun}/${rule.requiredObservations} checks spanning ${(spanMs / 60_000).toFixed(1)} min (needs >= ${Math.round(rule.windowDurationMs / 60_000)} min)`;
    }
  }

  candidate.ruleStatus = spikeRejected ? 'SPIKE_REJECTED' : input.cooldownActive ? 'COOLDOWN' : triggered ? 'TRIGGERED_ACTING' : 'ACCUMULATING';

  return { observation: candidate, triggered, window, reason, spikeRejected, outlier };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Human-readable DSL sentence for the rule (used in UI, evidence, docs). */
export function describeRule(rule: TrendRule): string {
  const dir = rule.direction.toLowerCase();
  const n = rule.requiredObservations;
  switch (rule.mode) {
    case 'CONSECUTIVE_MONOTONIC':
      return `Metric strictly ${dir} for ${n} checks in a row`;
    case 'CUMULATIVE_DELTA_BPS':
      return `Metric ${dir} >= ${rule.thresholdBps} bps cumulatively across ${n} consecutive checks`;
    case 'MOVING_WINDOW_DURATION':
      return `Metric ${dir} continuously across observations spanning >= ${Math.round(rule.windowDurationMs / 60_000)} minutes (>= ${n} checks)`;
  }
}

/** Window length for MONOTONIC/DELTA modes (baseline + N moves); null = variable. */
export function expectedWindowLength(rule: TrendRule): number | null {
  return rule.mode === 'MOVING_WINDOW_DURATION' ? null : rule.requiredObservations + 1;
}
