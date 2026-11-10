/**
 * Proof-of-Trend primitives (Innovation 1).
 *
 * - `ruleHash` — keccak256 over the canonical (sorted-key) JSON of the rule,
 *   so the on-chain anchor proves WHICH rule authorized the action.
 * - `trendProofDigest` — keccak256(ruleHash, windowObservationHashes[]),
 *   committed on Pharos Atlantic Testnet at the exact trigger moment, proving
 *   cryptographically which sequence of observations authorized the agent.
 */
import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import type { Observation, TrendRule } from './types';

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** keccak256(canonicalJson(rule)) — stable across processes and runs. */
export function computeRuleHash(rule: TrendRule): string {
  return keccak256(toBytes(canonicalJson(rule)));
}

export function windowObservationHashes(window: readonly Observation[]): string[] {
  return window.map((o) => o.observationHash);
}

/**
 * trendProofDigest = keccak256(abi.encode(ruleHash, windowObservationHashes[])).
 * This exact digest is embedded in the on-chain action (TrendAnchor contract
 * event/storage or native calldata) when the trend triggers.
 */
export function computeTrendProofDigest(ruleHash: string, windowHashes: readonly string[]): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32[]' }],
      [ruleHash as `0x${string}`, windowHashes as `0x${string}`[]],
    ),
  );
}
