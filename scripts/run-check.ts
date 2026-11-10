/**
 * Multi-Process Cold-Start CLI Harness (Innovation 3).
 *
 * Each invocation is ONE observation made by ONE fresh OS process:
 *   node ... tsx scripts/run-check.ts [--value 100] [--metric synthetic_scenario]
 *        [--watcher verify] [--data-dir <dir>] [--replay-last] [--no-action]
 *        [--inject-crash=wal|sigkill]
 *
 * The process loads its FULL history from disk (watcher-state.json + WAL
 * recovery), appends the new observation, evaluates the configured trend rule,
 * persists to disk, prints exactly one JSON line on stdout, and exits. No
 * in-memory state survives — kill it and run again, history is intact.
 *
 * Human-readable logs go to stderr; the machine-readable result is the LAST
 * stdout line (pure JSON).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';import { loadEnvLocal } from '../src/lib/env';
import { createClients, executeProtectiveAction, fetchBlockNumber, readErc20Balance, readNativeBalance } from '../src/lib/chain';
import { defaultDataDir, PersistentTrendStore, SimulatedCrashError, StoreIntegrityError } from '../src/lib/storage';
import { defaultTrendRule } from '../src/lib/rules';
import type { ActionExecutor, RunCheckCliOutput, TrendRule } from '../src/lib/types';

loadEnvLocal();

interface CliArgs {
  values: Record<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      values[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1] as string | undefined;
      if (next !== undefined && !next.startsWith('--')) {
        values[arg.slice(2)] = next;
        i++;
      } else {
        flags.add(arg.slice(2));
      }
    }
  }
  return { values, flags };
}

function out(json: unknown): void {
  process.stdout.write(`${JSON.stringify(json)}\n`);
}

function fail(json: RunCheckCliOutput, message: string, exitCode: number): never {
  out({ ...json, ok: false, error: message });
  process.exit(exitCode);
}

async function resolveMetric(args: CliArgs): Promise<{
  value: number;
  metricSource: string;
  blockNumber: number | undefined;
  timestamp: number | undefined;
}> {
  const metricFlag = args.values['metric'] ?? 'synthetic_scenario';
  const [metricKind, metricArg] = metricFlag.split(':') as [string, string | undefined];

  // Explicit value → synthetic observation (live block anchoring optional).
  if (args.values['value'] !== undefined) {
    return { value: Number(args.values['value']), metricSource: metricKind, blockNumber: undefined, timestamp: undefined };
  }

  const clients = createClients();
  const blockNumber = await fetchBlockNumber(clients.publicClient);

  if (metricKind === 'onchain_erc20_balance') {
    const token = (metricArg ?? process.env.PHAROS_USDC_ADDRESS ?? '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B') as `0x${string}`;
    const decimals = Number(process.env.USDC_DECIMALS ?? 6);
    const balance = await readErc20Balance(clients.publicClient, token, clients.account.address, decimals);
    return { value: balance.formatted, metricSource: `onchain_erc20_balance:${token}`, blockNumber, timestamp: undefined };
  }
  if (metricKind === 'onchain_native_balance') {
    const balance = await readNativeBalance(clients.publicClient, clients.account.address);
    return { value: balance.formatted, metricSource: 'onchain_native_balance', blockNumber, timestamp: undefined };
  }
  fail(
    emptyCli(),
    `no metric value available: pass --value <n> or use a live metric source (onchain_erc20_balance[:token] | onchain_native_balance)`,
    2,
  );
}

function emptyCli(): RunCheckCliOutput {
  return {
    ok: true,
    pid: process.pid,
    watcherId: 'default',
    dataDir: '',
    mode: 'observe',
    metricSource: null,
    deduplicated: false,
    duplicatesIgnoredTotal: 0,
    walRecovered: 0,
    index: null,
    observationId: null,
    blockNumber: null,
    timestamp: null,
    value: null,
    deltaFromPrev: null,
    deltaFromPrevBps: null,
    streakCount: null,
    ruleStatus: null,
    isOutlier: null,
    madScore: null,
    triggered: false,
    reason: '',
    action: null,
    cooldownUntil: null,
    phase: 'IDLE',
    historyLength: 0,
  };
}

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.values['data-dir'] ? path.resolve(args.values['data-dir']) : defaultDataDir();
  const watcherId = args.values['watcher'] ?? 'default';
  const mode: 'observe' | 'replay-last' = args.flags.has('replay-last') ? 'replay-last' : 'observe';
  const injectCrash = args.values['inject-crash'] ?? null;
  const noAction = args.flags.has('no-action');

  const cli: RunCheckCliOutput = { ...emptyCli(), watcherId, dataDir, mode };
  let replayWalRecovered = 0;
  const rule: TrendRule = defaultTrendRule();
  const store = new PersistentTrendStore({
    dataDir,
    watcherId,
    rule,
    chainId: Number(process.env.PHAROS_CHAIN_ID ?? 688689),
  });
  cli.dataDir = store.paths.dataDir;

  try {
    // ---- determine what this fresh process observes ----
    let value: number;
    let metricSource: string;
    let blockNumber: number | undefined;
    let timestamp: number | undefined;

    if (mode === 'replay-last') {
      const { state, walRecovered: replayRecovered } = store.recoverNow();
      replayWalRecovered = replayRecovered;
      const last = state.observations[state.observations.length - 1];
      if (!last) fail(cli, 'nothing to replay: watcher history is empty', 2);
      value = (last as { value: number }).value;
      metricSource = (last as { metricSource: string }).metricSource;
      blockNumber = (last as { blockNumber: number }).blockNumber;
      timestamp = (last as { timestamp: number }).timestamp; // same canonical bucket → same idempotency id
      process.stderr.write(`[run-check ${process.pid}] replay-last: re-polling observation #${last?.index} (expect dedup)\n`);
    } else {
      const metric = await resolveMetric(args);
      value = metric.value;
      metricSource = metric.metricSource;
      blockNumber = metric.blockNumber;
      timestamp = metric.timestamp;
      if (!Number.isFinite(value)) fail(cli, `metric value is not finite: ${value}`, 2);
      if (blockNumber === undefined && args.flags.has('fetch-block')) {
        try {
          const clients = createClients();
          blockNumber = await fetchBlockNumber(clients.publicClient);
        } catch {
          blockNumber = 0; // offline (tests) — observation still stored, id stays deterministic
        }
      }
      // Deterministic overrides (multi-process test harness / replay tooling).
      if (args.values['block'] !== undefined) blockNumber = Number(args.values['block']);
      if (args.values['timestamp'] !== undefined) timestamp = Number(args.values['timestamp']);
      process.stderr.write(
        `[run-check ${process.pid}] observing ${metricSource} = ${value} (block ${blockNumber ?? 'n/a'})\n`,
      );
    }

    // ---- wire the on-chain action executor (real by default, testable) ----
    let actionExecutor: ActionExecutor | null = null;
    if (!noAction) {
      actionExecutor = (ctx) => executeProtectiveAction(ctx, { dataDir: store.paths.dataDir });
    } else {
      process.stderr.write(`[run-check ${process.pid}] --no-action: dry run (no tx will be broadcast)\n`);
    }

    // ---- the full stateful cycle: load disk → recover WAL → observe → evaluate → persist ----
    const result = await store.runCheck({
      value,
      metricSource,
      blockNumber,
      timestamp,
      actionExecutor,
      // Both crash modes abort right after the durable WAL append, before the
      // state commit; 'sigkill' additionally terminates the process hard.
      simulateCrashAfter: injectCrash === 'wal' || injectCrash === 'sigkill' ? 'wal' : null,
    });

    const obs = result.observation;
    out({
      ...cli,
      ok: true,
      pid: process.pid,
      metricSource,
      deduplicated: result.deduplicated,
      duplicatesIgnoredTotal: result.duplicatesIgnoredTotal,
      walRecovered: Math.max(result.walRecovered, replayWalRecovered),
      index: obs?.index ?? null,
      observationId: obs?.observationId ?? null,
      blockNumber: obs?.blockNumber ?? null,
      timestamp: obs?.timestamp ?? null,
      value: obs?.value ?? value,
      deltaFromPrev: obs?.deltaFromPrev ?? null,
      deltaFromPrevBps: obs?.deltaFromPrevBps ?? null,
      streakCount: obs?.streakCount ?? null,
      ruleStatus: obs?.ruleStatus ?? null,
      isOutlier: obs?.isOutlier ?? null,
      madScore: obs?.madScore ?? null,
      triggered: result.triggered,
      reason: result.reason,
      actionError: result.triggerRecord?.actionError ?? null,
      action: result.action
        ? { txHash: result.action.txHash, explorerUrl: result.action.explorerUrl, mode: result.action.mode }
        : null,
      cooldownUntil: result.state.cooldownUntil,
      phase: result.state.phase,
      historyLength: result.state.observations.length,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof SimulatedCrashError) {
      // Simulated hard crash: WAL durably appended, state NOT committed.
      process.stderr.write(`[run-check ${process.pid}] ${err.message}\n`);
      if (injectCrash === 'sigkill') {
        // The strongest possible crash semantics: terminate THIS process
        // immediately (no exit handlers, no stdout flush) — like a SIGKILL.
        process.kill(process.pid, 'SIGKILL');
        return; // unreachable on platforms that honor SIGKILL
      }
      out({ ...cli, ok: false, crashed: 'wal', error: err.message });
      process.exit(137);
    }
    if (err instanceof StoreIntegrityError) {
      process.stderr.write(`[run-check ${process.pid}] ${err.message}\n`);
      fail(cli, err.message, 3);
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`[run-check ${process.pid}] FATAL: ${message}\n`);
    fail(cli, message, 1);
  }
}

void main();
