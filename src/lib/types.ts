/**
 * Shared domain types for the Pharos Trend Watcher skill.
 *
 * The watcher is a STATEFUL, MULTI-OBSERVATION agent skill: every `runCheck()`
 * observes a metric once, appends a hash-chained observation to a durable
 * on-disk log, evaluates a configurable trend rule that REQUIRES >= 3
 * consecutive directional moves, and — only when the rule is exactly satisfied
 * — executes an on-chain protective action on Pharos Atlantic Testnet.
 */

export type TrendDirection = 'FALLING' | 'RISING';

export type RuleMode =
  | 'CONSECUTIVE_MONOTONIC'
  | 'CUMULATIVE_DELTA_BPS'
  | 'MOVING_WINDOW_DURATION';

export type RuleStatus =
  | 'ACCUMULATING'
  | 'SPIKE_REJECTED'
  | 'TRIGGERED_ACTING'
  | 'COOLDOWN';

export type ActionMode = 'ANCHOR_CONTRACT' | 'NATIVE_CALDATA' | 'SIMULATED';

/** Configuration of a trend rule. `requiredObservations` MUST be >= 3. */
export interface TrendRule {
  id: string;
  name: string;
  mode: RuleMode;
  direction: TrendDirection;
  /**
   * Minimum number of consecutive directional moves (drops for FALLING,
   * rises for RISING) required before the rule triggers. Enforced >= 3:
   * a single observation — or even two — is never enough to act on.
   */
  requiredObservations: number;
  /** CUMULATIVE_DELTA_BPS only: minimum absolute cumulative move, in bps. */
  thresholdBps: number;
  /** MOVING_WINDOW_DURATION only: minimum span of the trend run, in ms (>= 60_000). */
  windowDurationMs: number;
  /** Noise filter: a single huge jump is flagged and must be confirmed by follow-ups. */
  rejectSingleSpike: boolean;
  /** A single-check move (bps) with |delta| >= this is a suspected spike/flash event. */
  spikeThresholdBps: number;
  /** Hysteresis: after an on-chain action, no new action for this long (ms). */
  cooldownMs: number;
}

export interface Observation {
  /** 1-based, strictly monotonic index across the watcher's lifetime. */
  index: number;
  /** Deterministic idempotency key: keccak256(watcherId, blockNumber, metricSource, bucket). */
  observationId: string;
  /** Hash-chain commit: keccak256(prevHash, blockNumber, value, observationId). */
  observationHash: string;
  prevObservationHash: string;
  /** OS pid of the process that produced this observation (cold-start proof). */
  runProcessPid: number;
  blockNumber: number;
  /** Wall-clock epoch ms of the check. */
  timestamp: number;
  /** Canonical bucket (floor(timestamp/1000 / bucketSeconds)) baked into the idempotency key. */
  timestampBucket: number;
  metricSource: string;
  value: number;
  deltaFromPrev: number | null;
  deltaFromPrevBps: number | null;
  /** Consecutive confirmed directional moves ending at this observation. */
  streakCount: number;
  ruleStatus: RuleStatus;
  /** MAD / threshold outlier verdict (single-spike suspicion). */
  isOutlier: boolean;
  /** Robust z-score (|x - median| / (1.4826 * MAD)) when MAD is available. */
  madScore: number | null;
}

/** The exact moment the trend rule fired — pinpointed to observation, block, and tx. */
export interface TriggerMomentRecord {
  triggerObservationIndex: number;
  observationId: string;
  blockNumber: number;
  timestamp: number;
  /** The N-observation window slice whose hashes satisfied the rule. */
  window: Observation[];
  ruleHash: string;
  trendProofDigest: string;
  txHash: string | null;
  explorerUrl: string | null;
  actionMode: ActionMode | null;
  anchoredAt: number;
  /** Set when the trigger was reconstructed from the WAL after a crash. */
  recoveredAfterCrash?: boolean;
  actionError?: string;
}

export type WatcherPhase = 'IDLE' | 'ACCUMULATING' | 'ACTED_LOCKED';

export interface WatcherState {
  schemaVersion: 1;
  watcherId: string;
  chainId: number;
  rule: TrendRule;
  observations: Observation[];
  lastObservationHash: string;
  duplicatesIgnored: number;
  triggerRecords: TriggerMomentRecord[];
  cooldownUntil: number | null;
  phase: WatcherPhase;
  /** Highest observation index durably committed to watcher-state.json. */
  committedWatermark: number;
  integrityStatus: 'OK' | 'TAMPERED' | 'UNKNOWN';
  createdAt: number;
  updatedAt: number;
}

export interface ActionResult {
  txHash: string;
  explorerUrl: string | null;
  mode: ActionMode;
  anchorAddress?: string;
}

export interface ActionContext {
  state: WatcherState;
  /** Trigger record with txHash still null — the executor fills it in on-chain. */
  trigger: TriggerMomentRecord;
}

export type ActionExecutor = (ctx: ActionContext) => Promise<ActionResult>;

export interface RunCheckInput {
  value: number;
  metricSource: string;
  /** Fetched live from the RPC when omitted and a fetcher is wired. */
  blockNumber?: number;
  /** Date.now() when omitted. */
  timestamp?: number;
  /** Injected on-chain action executor (real in scripts, fake in tests). */
  actionExecutor?: ActionExecutor | null;
  /** Crash-injection hook: throws right after the WAL append, before commit. */
  simulateCrashAfter?: 'wal' | null;
}

export interface RunCheckResult {
  deduplicated: boolean;
  duplicatesIgnoredTotal: number;
  walRecovered: number;
  observation: Observation | null;
  triggered: boolean;
  /** Human-readable rule evaluation reason for the newest observation. */
  reason: string;
  action: ActionResult | null;
  triggerRecord: TriggerMomentRecord | null;
  state: WatcherState;
  pid: number;
}

/** Structured JSON line printed by scripts/run-check.ts (parsed by parents/tests). */
export interface RunCheckCliOutput {
  ok: boolean;
  error?: string;
  crashed?: 'wal' | 'sigkill';
  pid: number;
  watcherId: string;
  dataDir: string;
  mode: 'observe' | 'replay-last';
  metricSource: string | null;
  deduplicated: boolean;
  duplicatesIgnoredTotal: number;
  walRecovered: number;
  index: number | null;
  observationId: string | null;
  blockNumber: number | null;
  timestamp: number | null;
  value: number | null;
  deltaFromPrev: number | null;
  deltaFromPrevBps: number | null;
  streakCount: number | null;
  ruleStatus: string | null;
  isOutlier: boolean | null;
  madScore: number | null;
  triggered: boolean;
  reason: string;
  actionError?: string | null;
  action: { txHash: string | null; explorerUrl: string | null; mode: string | null; anchorAddress?: string | null } | null;
  cooldownUntil: number | null;
  phase: string;
  historyLength: number;
}
