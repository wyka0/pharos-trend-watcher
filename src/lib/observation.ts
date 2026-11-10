/**
 * Observation identity + hash-chain primitives (Requirement 03, Innovation 1).
 *
 * - `observationId` is a DETERMINISTIC idempotency key over
 *   (watcherId, blockNumber, metricSource, canonicalTimestampBucket).
 *   Re-polling the same chain block / time window always produces the SAME id,
 *   so replays after a crash are deduplicated instead of duplicated.
 *
 * - `observationHash` commits each observation to its predecessor:
 *   hash_i = keccak256(hash_{i-1}, blockNumber_i, value_i, observationId_i).
 *   Any tampering with the stored history breaks the chain and is detected.
 */
import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import type { Observation } from './types';

/** keccak256 of the empty byte string — chain genesis pointer. */
export const ZERO_HASH = keccak256(new Uint8Array(0));

/** Values are committed as 1e8 fixed-point integers for deterministic hashing. */
export const VALUE_SCALE = 100_000_000;

export function toFixedPoint(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`observation value must be finite, got: ${value}`);
  }
  return BigInt(Math.round(value * VALUE_SCALE));
}

/** Canonical timestamp bucket (seconds) baked into the idempotency key. */
export function canonicalTimestampBucket(timestampMs: number, bucketSeconds: number): number {
  if (bucketSeconds <= 0) throw new Error('bucketSeconds must be > 0');
  return Math.floor(timestampMs / 1000 / bucketSeconds);
}

export interface ObservationIdInput {
  watcherId: string;
  blockNumber: number;
  metricSource: string;
  timestampBucket: number;
}

/** observationId = keccak256(watcherId, blockNumber, metricSource, canonicalTimestampBucket) */
export function computeObservationId(input: ObservationIdInput): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }],
      [
        keccak256(toBytes(input.watcherId)),
        BigInt(Math.trunc(input.blockNumber)),
        keccak256(toBytes(input.metricSource)),
        BigInt(input.timestampBucket),
      ],
    ),
  );
}

export interface ObservationHashInput {
  prevHash: string;
  blockNumber: number;
  value: number;
  observationId: string;
}

/** hash_i = keccak256(hash_{i-1}, blockNumber_i, value_i, observationId_i) */
export function computeObservationHash(input: ObservationHashInput): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [
        input.prevHash as `0x${string}`,
        BigInt(Math.trunc(input.blockNumber)),
        toFixedPoint(input.value),
        input.observationId as `0x${string}`,
      ],
    ),
  );
}

export interface ChainVerification {
  ok: boolean;
  /** Index of the first observation that breaks the chain (when !ok). */
  badIndex: number | null;
  reason: string | null;
}

/**
 * Recompute the entire hash chain from the stored observations and compare.
 * Detects any mutation of value / blockNumber / metricSource / timestamp /
 * observationId / links — the tamper-evidence guarantee.
 */
export function verifyHashChain(
  observations: readonly Observation[],
  watcherId: string,
  bucketSeconds: number,
): ChainVerification {
  let prev: string = ZERO_HASH;
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i] as Observation;
    // Index continuity.
    if (o.index !== i + 1) {
      return { ok: false, badIndex: i, reason: `index discontinuity at position ${i}: ${o.index}` };
    }
    // Recompute the idempotency id from raw fields.
    const bucket = canonicalTimestampBucket(o.timestamp, bucketSeconds);
    const expectedId = computeObservationId({
      watcherId,
      blockNumber: o.blockNumber,
      metricSource: o.metricSource,
      timestampBucket: bucket,
    });
    if (expectedId !== o.observationId) {
      return { ok: false, badIndex: i, reason: `observationId mismatch at index ${o.index}` };
    }
    if (bucket !== o.timestampBucket) {
      return { ok: false, badIndex: i, reason: `timestampBucket mismatch at index ${o.index}` };
    }
    // Recompute the chain hash.
    const expectedHash = computeObservationHash({
      prevHash: prev,
      blockNumber: o.blockNumber,
      value: o.value,
      observationId: o.observationId,
    });
    if (expectedHash !== o.observationHash) {
      return { ok: false, badIndex: i, reason: `observationHash mismatch at index ${o.index}` };
    }
    if (o.prevObservationHash !== prev) {
      return { ok: false, badIndex: i, reason: `prevObservationHash link broken at index ${o.index}` };
    }
    prev = o.observationHash;
  }
  return { ok: true, badIndex: null, reason: null };
}
