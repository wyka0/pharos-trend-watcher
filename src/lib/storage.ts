/**
 * PersistentTrendStore (Requirement 01 + 03, Innovation 3 support).
 *
 * Durable, cross-run storage backed by:
 *   - `<dataDir>/watcher-state.json`          — committed state (atomic write-rename + fsync)
 *   - `<dataDir>/observations.wal.jsonl`      — append-only write-ahead log (fsync per append)
 *   - `<dataDir>/archive/`                    — archived states after reset()
 *
 * Guarantees:
 *  - ZERO reliance on in-memory process state between runs: every runCheck()
 *    loads prior history from disk, recovers any uncommitted WAL tail,
 *    appends + evaluates + persists, and exits.
 *  - Crash between WAL append and state commit loses nothing: the next run
 *    replays the WAL tail onto the committed state (exactly once — deduplicated
 *    by the deterministic observationId).
 *  - Replay of an already-observed (block, window, source) NEVER duplicates
 *    history: it increments `duplicatesIgnored` and appends a DUPLICATE_IGNORED
 *    WAL marker only.
 *  - History is tamper-evident: the keccak256 hash chain is re-verified on
 *    every load; a mismatch raises StoreIntegrityError and the store refuses
 *    to act.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalTimestampBucket,
  computeObservationId,
  verifyHashChain,
  ZERO_HASH,
} from './observation';
import { evaluateNewObservation, defaultTrendRule, validateRule } from './rules';
import { computeRuleHash, computeTrendProofDigest } from './proof';
import type {
  ActionResult,
  ActionExecutor,
  Observation,
  RunCheckInput,
  RunCheckResult,
  TrendRule,
  TriggerMomentRecord,
  WatcherState,
} from './types';

export const STATE_SCHEMA_VERSION = 1 as const;

/** Thrown when `simulateCrashAfter: 'wal'` fires — mimics a hard SIGKILL mid-run. */
export class SimulatedCrashError extends Error {
  constructor(pid: number) {
    super(`SIMULATED HARD CRASH after WAL append (pid ${pid}); state was NOT committed`);
    this.name = 'SimulatedCrashError';
  }
}

/** Thrown when the on-disk hash chain fails verification — the store refuses to act. */
export class StoreIntegrityError extends Error {
  readonly tamperIndex: number | null;
  readonly reason: string | null;
  constructor(tamperIndex: number | null, reason: string | null) {
    super(`TAMPERED WATCHER HISTORY (badIndex=${tamperIndex}): ${reason ?? 'hash chain mismatch'} — refusing to act`);
    this.name = 'StoreIntegrityError';
    this.tamperIndex = tamperIndex;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Paths + atomic durable IO
// ---------------------------------------------------------------------------

export interface StorePaths {
  dataDir: string;
  stateFile: string;
  walFile: string;
  archiveDir: string;
}

export function defaultDataDir(): string {
  const fromEnv = process.env.WATCHER_DATA_DIR;
  if (fromEnv && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.join(process.cwd(), '.data');
}

/**
 * The default watcher uses the spec'd flat layout `.data/watcher-state.json`;
 * additional named watchers nest under `.data/watcher-<id>/`.
 */
export function watcherPaths(dataDir: string, watcherId: string): StorePaths {
  const dir = watcherId === 'default' ? dataDir : path.join(dataDir, `watcher-${watcherId}`);
  return {
    dataDir: dir,
    stateFile: path.join(dir, 'watcher-state.json'),
    walFile: path.join(dir, 'observations.wal.jsonl'),
    archiveDir: path.join(dir, 'archive'),
  };
}

/** Atomic + durable write: tmp file → fsync → rename over target → best-effort dir fsync. */
export function atomicWriteFileSync(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  // Directory fsync (POSIX only — Windows cannot open a directory handle).
  if (process.platform !== 'win32') {
    try {
      const dirFd = fs.openSync(path.dirname(target), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// WAL
// ---------------------------------------------------------------------------

export type WalEntry =
  | { type: 'OBSERVATION'; observation: Observation; appendedAt: number }
  | { type: 'DUPLICATE_IGNORED'; observationId: string; appendedAt: number; note: string };

export interface WalReadResult {
  entries: WalEntry[];
  malformedLines: number;
}

export function readWalFile(walFile: string): WalReadResult {
  if (!fs.existsSync(walFile)) return { entries: [], malformedLines: 0 };
  const content = fs.readFileSync(walFile, 'utf8');
  const entries: WalEntry[] = [];
  let malformedLines = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      entries.push(JSON.parse(trimmed) as WalEntry);
    } catch {
      malformedLines += 1; // a torn write from a hard crash mid-append — tolerated
    }
  }
  return { entries, malformedLines };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface PersistentTrendStoreOptions {
  dataDir?: string;
  watcherId?: string;
  chainId?: number;
  rule?: TrendRule;
  timestampBucketSeconds?: number;
  /** Used when RunCheckInput.blockNumber is omitted (live RPC in scripts). */
  blockNumberFetcher?: () => Promise<number>;
}

export interface IntegrityReport {
  integrity: 'OK' | 'TAMPERED' | 'MISSING';
  tamperIndex: number | null;
  reason: string | null;
}

export interface StoreSnapshot {
  state: WatcherState | null;
  integrity: IntegrityReport;
  files: { stateFile: string; walFile: string; stateBytes: number | null; walBytes: number | null; walLines: number };
  walTail: WalEntry[];
}

export class PersistentTrendStore {
  readonly watcherId: string;
  readonly chainId: number;
  readonly bucketSeconds: number;
  readonly paths: StorePaths;
  readonly defaultRule: TrendRule;
  private readonly blockNumberFetcher?: () => Promise<number>;

  constructor(opts: PersistentTrendStoreOptions = {}) {
    this.watcherId = opts.watcherId ?? 'default';
    this.chainId = opts.chainId ?? Number(process.env.PHAROS_CHAIN_ID ?? 688689);
    this.bucketSeconds = opts.timestampBucketSeconds ?? (Number(process.env.WATCHER_TIMESTAMP_BUCKET_SECONDS ?? 60) || 60);
    this.paths = watcherPaths(opts.dataDir ?? defaultDataDir(), this.watcherId);
    this.defaultRule = opts.rule ?? defaultTrendRule();
    validateRule(this.defaultRule);
    this.blockNumberFetcher = opts.blockNumberFetcher;
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.paths.dataDir, { recursive: true });
  }

  /** Load committed state from disk and verify its hash chain. */
  loadCommittedState(): { state: WatcherState | null } & IntegrityReport {
    if (!fs.existsSync(this.paths.stateFile)) {
      return { state: null, integrity: 'MISSING', tamperIndex: null, reason: null };
    }
    const state = JSON.parse(fs.readFileSync(this.paths.stateFile, 'utf8')) as WatcherState;
    const verdict = verifyHashChain(state.observations ?? [], state.watcherId, this.bucketSeconds);
    const integrity: IntegrityReport = {
      integrity: verdict.ok ? 'OK' : 'TAMPERED',
      tamperIndex: verdict.badIndex,
      reason: verdict.reason,
    };
    return { state, ...integrity };
  }

  private loadOrCreateState(): WatcherState {
    const loaded = this.loadCommittedState();
    if (loaded.state) {
      if (loaded.integrity === 'TAMPERED') {
        throw new StoreIntegrityError(loaded.tamperIndex, loaded.reason);
      }
      return loaded.state;
    }
    return this.freshState(this.defaultRule);
  }

  private freshState(rule: TrendRule): WatcherState {
    validateRule(rule);
    const now = Date.now();
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      watcherId: this.watcherId,
      chainId: this.chainId,
      rule,
      observations: [],
      lastObservationHash: ZERO_HASH,
      duplicatesIgnored: 0,
      triggerRecords: [],
      cooldownUntil: null,
      phase: 'IDLE',
      committedWatermark: 0,
      integrityStatus: 'OK',
      createdAt: now,
      updatedAt: now,
    };
  }

  // -- WAL ------------------------------------------------------------------

  appendWalEntry(entry: WalEntry): void {
    this.ensureDirs();
    fs.appendFileSync(this.paths.walFile, `${JSON.stringify(entry)}\n`, 'utf8');
    // Durability barrier: fsync the WAL so a hard crash cannot lose the append.
    const fd = fs.openSync(this.paths.walFile, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  readWal(): WalReadResult {
    return readWalFile(this.paths.walFile);
  }

  /**
   * Crash recovery (Requirement 03): replay any WAL tail that was appended but
   * never committed into watcher-state.json. Every replayed observation is
   * re-evaluated deterministically against the committed history; duplicates
   * (already present by observationId) are skipped. A replayed observation that
   * satisfies the rule produces a trigger record WITHOUT re-executing the
   * on-chain action (idempotency guard — the action itself is never re-broadcast).
   */
  recoverFromWal(state: WatcherState): { recovered: Observation[]; skippedDuplicates: number; malformedLines: number } {
    const { entries, malformedLines } = this.readWal();
    const known = new Set(state.observations.map((o) => o.observationId));
    const recovered: Observation[] = [];
    let skippedDuplicates = 0;

    for (const entry of entries) {
      if (entry.type !== 'OBSERVATION') continue;
      const walObs = entry.observation;
      if (known.has(walObs.observationId)) {
        skippedDuplicates += 1;
        continue;
      }
      if (walObs.index <= state.committedWatermark) {
        known.add(walObs.observationId); // stale pre-reset entry — ignore
        continue;
      }
      // Re-evaluate deterministically from raw inputs (crash could have hit
      // anywhere between WAL append and rule evaluation/commit).
      const verdict = evaluateNewObservation({
        rule: state.rule,
        history: state.observations,
        value: walObs.value,
        timestamp: walObs.timestamp,
        watcherId: state.watcherId,
        blockNumber: walObs.blockNumber,
        metricSource: walObs.metricSource,
        bucketSeconds: this.bucketSeconds,
        pid: walObs.runProcessPid,
        prevHash: state.lastObservationHash,
        cooldownActive: state.cooldownUntil !== null && walObs.timestamp < state.cooldownUntil,
      });
      const rebuilt: Observation = { ...verdict.observation, index: walObs.index, observationId: walObs.observationId };
      state.observations.push(rebuilt);
      state.lastObservationHash = rebuilt.observationHash;
      state.committedWatermark = rebuilt.index;
      known.add(rebuilt.observationId);
      recovered.push(rebuilt);

      if (rebuilt.ruleStatus === 'TRIGGERED_ACTING' && !state.triggerRecords.some((t) => t.observationId === rebuilt.observationId)) {
        state.triggerRecords.push({
          triggerObservationIndex: rebuilt.index,
          observationId: rebuilt.observationId,
          blockNumber: rebuilt.blockNumber,
          timestamp: rebuilt.timestamp,
          window: verdict.window ?? [],
          ruleHash: computeRuleHash(state.rule),
          trendProofDigest: computeTrendProofDigest(computeRuleHash(state.rule), (verdict.window ?? []).map((o) => o.observationHash)),
          txHash: null,
          explorerUrl: null,
          actionMode: null,
          anchoredAt: Date.now(),
          recoveredAfterCrash: true,
          actionError: 'recovered from WAL after crash; on-chain action intentionally NOT re-executed (idempotency guard)',
        });
      }
    }
    return { recovered, skippedDuplicates, malformedLines };
  }

  // -- Commit -----------------------------------------------------------------

  commitState(state: WatcherState): void {
    atomicWriteFileSync(this.paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  // -- The main cycle (Requirement 01) ---------------------------------------

  async runCheck(input: RunCheckInput): Promise<RunCheckResult> {
    this.ensureDirs();
    const state = this.loadOrCreateState();
    const { recovered } = this.recoverFromWal(state);
    const walRecovered = recovered.length;
    if (recovered.length > 0) this.commitState(state); // persist recovery before observing anew

    const timestamp = input.timestamp ?? Date.now();
    const bucket = canonicalTimestampBucket(timestamp, this.bucketSeconds);
    const blockNumber =
      input.blockNumber ?? (this.blockNumberFetcher ? await this.blockNumberFetcher() : 0);

    const observationId = computeObservationId({
      watcherId: state.watcherId,
      blockNumber,
      metricSource: input.metricSource,
      timestampBucket: bucket,
    });

    // ---- Idempotent replay: this block/window was already observed ----
    if (state.observations.some((o) => o.observationId === observationId)) {
      state.duplicatesIgnored += 1;
      state.updatedAt = Date.now();
      this.commitState(state);
      this.appendWalEntry({
        type: 'DUPLICATE_IGNORED',
        observationId,
        appendedAt: Date.now(),
        note: 'replay of already-observed block/window — history NOT duplicated',
      });
      return {
        deduplicated: true,
        duplicatesIgnoredTotal: state.duplicatesIgnored,
        walRecovered,
        observation: null,
        triggered: false,
        reason: 'duplicate replay ignored (idempotency key already observed)',
        action: null,
        triggerRecord: null,
        state,
        pid: process.pid,
      };
    }

    // ---- Observe → evaluate → WAL append (crash barrier) → act → commit ----
    const verdict = evaluateNewObservation({
      rule: state.rule,
      history: state.observations,
      value: input.value,
      timestamp,
      watcherId: state.watcherId,
      blockNumber,
      metricSource: input.metricSource,
      bucketSeconds: this.bucketSeconds,
      pid: process.pid,
      prevHash: state.lastObservationHash,
      cooldownActive: state.cooldownUntil !== null && timestamp < state.cooldownUntil,
    });
    const observation = verdict.observation;

    this.appendWalEntry({ type: 'OBSERVATION', observation, appendedAt: Date.now() });
    if (input.simulateCrashAfter === 'wal') {
      throw new SimulatedCrashError(process.pid);
    }

    state.observations.push(observation);
    state.lastObservationHash = observation.observationHash;
    state.committedWatermark = observation.index;

    let action: ActionResult | null = null;
    let triggerRecord: TriggerMomentRecord | null = null;

    if (verdict.triggered && verdict.window) {
      const ruleHash = computeRuleHash(state.rule);
      const windowHashes = verdict.window.map((o) => o.observationHash);
      const trendProofDigest = computeTrendProofDigest(ruleHash, windowHashes);
      triggerRecord = {
        triggerObservationIndex: observation.index,
        observationId: observation.observationId,
        blockNumber: observation.blockNumber,
        timestamp: observation.timestamp,
        window: verdict.window,
        ruleHash,
        trendProofDigest,
        txHash: null,
        explorerUrl: null,
        actionMode: null,
        anchoredAt: Date.now(),
      };
      if (input.actionExecutor) {
        try {
          action = await input.actionExecutor({ state, trigger: triggerRecord });
          triggerRecord.txHash = action.txHash;
          triggerRecord.explorerUrl = action.explorerUrl;
          triggerRecord.actionMode = action.mode;
          // Innovation 4: epoch cooldown / hysteresis lock (anchored to
          // observation time so synthetic clocks behave like wall clocks).
          state.cooldownUntil = observation.timestamp + state.rule.cooldownMs;
          state.phase = 'ACTED_LOCKED';
        } catch (err) {
          triggerRecord.actionError = err instanceof Error ? err.message : String(err);
        }
      } else {
        triggerRecord.actionError = 'dry run: no on-chain action executor wired';
      }
      state.triggerRecords.push(triggerRecord);
    }

    const lastTs = state.observations.length > 0 ? (state.observations[state.observations.length - 1] as Observation).timestamp : Date.now();
    state.phase =
      state.cooldownUntil !== null && lastTs < state.cooldownUntil
        ? 'ACTED_LOCKED'
        : state.observations.length <= 1
          ? 'IDLE'
          : 'ACCUMULATING';
    state.updatedAt = Date.now();
    this.commitState(state);

    return {
      deduplicated: false,
      duplicatesIgnoredTotal: state.duplicatesIgnored,
      walRecovered,
      observation,
      triggered: verdict.triggered,
      reason: verdict.reason,
      action,
      triggerRecord,
      state,
      pid: process.pid,
    };
  }

  // -- Maintenance / inspection ------------------------------------------------

  /** Archive + wipe all on-disk state; returns a fresh state (Requirement 01 hygiene). */
  reset(rule?: TrendRule): WatcherState {
    const nextRule = rule ?? this.defaultRule;
    validateRule(nextRule);
    this.ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(this.paths.stateFile)) {
      fs.mkdirSync(this.paths.archiveDir, { recursive: true });
      fs.copyFileSync(this.paths.stateFile, path.join(this.paths.archiveDir, `${stamp}-watcher-state.json`));
      fs.rmSync(this.paths.stateFile);
    }
    if (fs.existsSync(this.paths.walFile)) {
      fs.mkdirSync(this.paths.archiveDir, { recursive: true });
      fs.copyFileSync(this.paths.walFile, path.join(this.paths.archiveDir, `${stamp}-observations.wal.jsonl`));
      fs.rmSync(this.paths.walFile);
    }
    const fresh = this.freshState(nextRule);
    this.commitState(fresh);
    return fresh;
  }

  updateRule(rule: TrendRule): WatcherState {
    validateRule(rule);
    const loaded = this.loadCommittedState();
    if (loaded.state && loaded.integrity === 'TAMPERED') {
      throw new StoreIntegrityError(loaded.tamperIndex, loaded.reason);
    }
    const state = loaded.state ?? this.freshState(this.defaultRule);
    state.rule = rule;
    state.updatedAt = Date.now();
    this.commitState(state);
    return state;
  }

  /** Full inspection snapshot for the API/UI: state, integrity, files, WAL tail. */
  snapshot(): StoreSnapshot {
    const loaded = this.loadCommittedState();
    const wal = this.readWal();
    const size = (p: string): number | null => {
      try {
        return fs.statSync(p).size;
      } catch {
        return null;
      }
    };
    return {
      state: loaded.state,
      integrity: { integrity: loaded.integrity, tamperIndex: loaded.tamperIndex, reason: loaded.reason },
      files: {
        stateFile: this.paths.stateFile,
        walFile: this.paths.walFile,
        stateBytes: size(this.paths.stateFile),
        walBytes: size(this.paths.walFile),
        walLines: wal.entries.length,
      },
      walTail: wal.entries.slice(-10),
    };
  }

  /** Public integrity check (used by UI + verify script). */
  verifyIntegrity(): IntegrityReport {
    const loaded = this.loadCommittedState();
    return { integrity: loaded.integrity, tamperIndex: loaded.tamperIndex, reason: loaded.reason };
  }

  /**
   * Load committed state, replay any uncommitted WAL tail onto it, and commit.
   * Returns how many observations were recovered — used by the CLI's
   * --replay-last so the replay targets the post-recovery head and can report
   * the recovery in its JSON output.
   */
  recoverNow(): { state: WatcherState; walRecovered: number } {
    this.ensureDirs();
    const state = this.loadOrCreateState();
    const { recovered } = this.recoverFromWal(state);
    if (recovered.length > 0) this.commitState(state);
    return { state, walRecovered: recovered.length };
  }

  /** Load + recover + commit; returns just the state (API helper). */
  ensureRecovered(): WatcherState {
    return this.recoverNow().state;
  }
}
