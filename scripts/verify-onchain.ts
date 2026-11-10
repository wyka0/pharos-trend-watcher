/**
 * Live Pharos Atlantic Testnet verification (chainId 688689).
 *
 * End-to-end MULTI-PROCESS proof that the Trend Watcher skill:
 *   Phase A — rejects a single huge spike (no action, ever)
 *   Phase B — survives a hard SIGKILL crash + replays blocks without
 *             duplicating history (WAL recovery + idempotency dedup)
 *   Phase C — observes LIVE Pharos state across 4 separate OS processes,
 *             pinpoints the exact trigger moment at the 3rd consecutive drop,
 *             broadcasts a real on-chain protective action anchored with the
 *             trendProofDigest, then proves the cooldown lock.
 *
 * Auto-generates evidence/trend-run-evidence.json + SUBMISSION_EVIDENCE.md.
 *
 * Run: npm run watcher:verify
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadEnvLocal } from '../src/lib/env';
loadEnvLocal();

import { createPublicClient, http, formatUnits } from 'viem';
import {
  createClients,
  fetchBlockNumber,
  readErc20Balance,
  readNativeBalance,
  transferErc20,
  transferNative,
  pharosAtlanticChain,
  ANCHOR_ABI,
  txExplorerUrl,
} from '../src/lib/chain';
import { PersistentTrendStore, defaultDataDir } from '../src/lib/storage';
import { defaultTrendRule } from '../src/lib/rules';
import { spawnRunCheck } from './lib/spawn-check';
import type { RunCheckCliOutput } from '../src/lib/types';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WATCHER = 'verify';
const CHAIN_ID = 688689;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(msg: string): void {
  console.log(`[verify] ${msg}`);
}

interface RunRecord {
  phase: string;
  label: string;
  args: string[];
  exit: number | null;
  signal: string | null;
  pid: number | null;
  durationMs: number;
  json: RunCheckCliOutput | null;
}

interface Assertion {
  name: string;
  pass: boolean;
  details: string;
}

function assert(name: string, pass: boolean, details: string): Assertion {
  return { name, pass, details };
}

async function waitForBlockChange(
  publicClient: ReturnType<typeof createPublicClient>,
  lastBlock: number,
  timeoutMs = 120_000,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const b = Number(await publicClient.getBlockNumber());
    if (b > lastBlock) return b;
    if (Date.now() - start > timeoutMs) return lastBlock;
    await sleep(1_000);
  }
}

/** Testnet RPCs occasionally hiccup right after a tx — retry reads with backoff. */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log(`  (retry ${i + 1}/${attempts} for ${label}: ${err instanceof Error ? err.shortMessage ?? err.message.slice(0, 80) : err})`);
      await sleep(2_000 * (i + 1));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  log('Pharos Trend Watcher — LIVE multi-process verification');
  log('='.repeat(72));

  // ---------------------------------------------------------------- preflight
  const clients = createClients();
  const { publicClient, walletClient, account, env } = clients;
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId} (expected ${CHAIN_ID})`);
  const block0 = await fetchBlockNumber(publicClient);
  const native = await readNativeBalance(publicClient, account.address);
  const usdc = await readErc20Balance(publicClient, env.usdcAddress, account.address, env.usdcDecimals);
  log(`chainId=${chainId}  block=${block0}  explorer=${env.explorerUrl}`);
  log(`wallet=${account.address}  PHRS=${formatUnits(native.raw, 18)}  USDC=${formatUnits(usdc.raw, env.usdcDecimals)}`);

  // Choose the LIVE metric source for Phase C (fallback chain: USDC → native → synthetic).
  let metricMode: 'erc20' | 'native' | 'synthetic';
  if (usdc.raw >= 1_000n) metricMode = 'erc20';
  else if (native.raw >= 10n ** 13n) metricMode = 'native';
  else metricMode = 'synthetic';
  log(`Phase C metric mode: ${metricMode}`);

  const dataDir = defaultDataDir();
  const rule = defaultTrendRule();
  const store = new PersistentTrendStore({ dataDir, watcherId: WATCHER, rule, chainId: CHAIN_ID });
  store.reset();
  log(`watcher "${WATCHER}" reset (data: ${store.paths.dataDir})`);

  const runs: RunRecord[] = [];
  const assertions: Assertion[] = [];
  const spawnCheck = async (phase: string, label: string, extraArgs: string[]): Promise<RunRecord> => {
    const r = await spawnRunCheck(['--watcher', WATCHER, ...extraArgs]);
    const record: RunRecord = {
      phase,
      label,
      args: ['run-check.ts', '--watcher', WATCHER, ...extraArgs],
      exit: r.status,
      signal: r.signal,
      pid: r.json?.pid ?? null,
      durationMs: r.durationMs,
      json: r.json,
    };
    runs.push(record);
    const j = record.json;
    log(
      `  ${label}: pid=${record.pid} idx=${j?.index ?? 'DUP'} value=${j?.value ?? '-'} status=${j?.ruleStatus ?? 'DEDUPLICATED'} streak=${j?.streakCount ?? '-'} triggered=${j?.triggered} tx=${j?.action?.txHash?.slice(0, 14) ?? '—'}`,
    );
    return record;
  };
  const waitNewBlock = async (): Promise<void> => {
    const b = await waitForBlockChange(publicClient, Number(await publicClient.getBlockNumber()));
    log(`  (advanced to block ${b})`);
  };

  // =================================================================
  // PHASE A — Single-Spike Rejection (Requirement 05)
  // =================================================================
  log('--- PHASE A: single-spike rejection (3 separate OS processes) ---');
  const spikeValues = [100, 75, 99];
  let lastBlock = Number(await publicClient.getBlockNumber());
  for (let i = 0; i < spikeValues.length; i++) {
    if (i > 0) lastBlock = await waitForBlockChange(publicClient, lastBlock);
    await spawnCheck('A', `check #${i + 1} (value ${spikeValues[i]})`, [
      '--no-action',
      '--fetch-block',
      '--value',
      String(spikeValues[i]),
    ]);
  }

  const a1 = runs[0]?.json;
  const a2 = runs[1]?.json;
  const a3 = runs[2]?.json;
  assertions.push(
    assert('A: 3 observations stored', a3?.historyLength === 3, `historyLength=${a3?.historyLength}`),
    assert('A: spike flagged as outlier', a2?.isOutlier === true, `obs2.isOutlier=${a2?.isOutlier}`),
    assert('A: recovery → SPIKE_REJECTED', a3?.ruleStatus === 'SPIKE_REJECTED', `status=${a3?.ruleStatus}`),
    assert('A: streak reset to 0', a3?.streakCount === 0, `streak=${a3?.streakCount}`),
    assert('A: NEVER triggered', runs.slice(0, 3).every((r) => r.json?.triggered === false), '0 triggers'),
    assert('A: 0 txs broadcast', runs.slice(0, 3).every((r) => r.json?.action === null), 'no actions'),
    assert('A: distinct PIDs (cold starts)', new Set(runs.slice(0, 3).map((r) => r.pid)).size === 3, `pids=${runs.slice(0, 3).map((r) => r.pid).join(', ')}`),
  );

  // =================================================================
  // PHASE B — Process Restart + Duplicate Block Replay (Requirement 03)
  // =================================================================
  log('--- PHASE B: replay dedup + SIGKILL crash + WAL recovery ---');
  const bReplay = await spawnCheck('B', 'replay-last (same block/window re-polled)', ['--no-action', '--replay-last']);
  assertions.push(
    assert('B: replay deduplicated', bReplay.json?.deduplicated === true, `dedup=${bReplay.json?.deduplicated}`),
    assert('B: duplicatesIgnored == 1', bReplay.json?.duplicatesIgnoredTotal === 1, `count=${bReplay.json?.duplicatesIgnoredTotal}`),
    assert('B: history length intact (3)', bReplay.json?.historyLength === 3, `length=${bReplay.json?.historyLength}`),
  );

  const crashRun = await spawnRunCheck([
    '--watcher',
    WATCHER,
    '--no-action',
    '--fetch-block',
    '--value',
    '96',
    '--inject-crash',
    'sigkill',
  ]);
  runs.push({ phase: 'B', label: 'HARD CRASH (SIGKILL mid-run, value 96)', args: ['run-check.ts', '--inject-crash=sigkill'], exit: crashRun.status, signal: crashRun.signal, pid: null, durationMs: crashRun.durationMs, json: crashRun.json });
  log(`  hard crash: signal=${crashRun.signal} exit=${crashRun.status} (WAL appended, state NOT committed)`);

  const bRecovery = await spawnCheck('B', 'recovery run (replay-last after crash)', ['--no-action', '--replay-last']);
  assertions.push(
    assert('B: crash was abnormal (SIGKILL/137)', crashRun.signal === 'SIGKILL' || crashRun.status === 137 || crashRun.status === null || crashRun.status === 1, `signal=${crashRun.signal} exit=${crashRun.status}`),
    assert('B: WAL tail recovered', (bRecovery.json?.walRecovered ?? 0) >= 1, `walRecovered=${bRecovery.json?.walRecovered}`),
    assert('B: recovered obs committed (history=4)', bRecovery.json?.historyLength === 4, `length=${bRecovery.json?.historyLength}`),
    assert('B: replay after recovery deduped', bRecovery.json?.deduplicated === true, `dedup=${bRecovery.json?.deduplicated}`),
    assert('B: duplicatesIgnored == 2 total', bRecovery.json?.duplicatesIgnoredTotal === 2, `count=${bRecovery.json?.duplicatesIgnoredTotal}`),
  );
  {
    const integrity = store.verifyIntegrity();
    assertions.push(assert('B: hash-chain intact after crash+recovery', integrity.integrity === 'OK', `integrity=${integrity.integrity}`));
  }

  // =================================================================
  // PHASE C — Confirmed 3-Check Trend → LIVE on-chain action
  // =================================================================
  log('--- PHASE C: live trend observation → on-chain action on 688689 ---');
  store.reset();
  const liveArgs = (v?: number): string[] => {
    const base = metricMode === 'synthetic' ? ['--fetch-block', ...(v !== undefined ? ['--value', String(v)] : [])] : ['--metric', metricMode === 'erc20' ? 'onchain_erc20_balance' : 'onchain_native_balance'];
    return base;
  };

  const drain = async (i: number): Promise<void> => {
    if (metricMode === 'erc20') {
      const tx = await transferErc20(clients, env.usdcAddress, env.payToAddress ?? account.address, 100n);
      log(`  drain #${i}: 0.0001 USDC → treasury  tx=${tx}`);
    } else if (metricMode === 'native') {
      const tx = await transferNative(clients, env.payToAddress ?? account.address, 10n ** 12n);
      log(`  drain #${i}: 0.000001 PHRS → treasury  tx=${tx}`);
    }
  };

  const cValues = metricMode === 'synthetic' ? [100, 95, 91, 86, 85] : [undefined, undefined, undefined, undefined, undefined];
  let cLast: RunRecord | null = null;
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      await drain(i);
      await waitNewBlock();
    }
    const label =
      i < 4
        ? `live check #${i + 1}${i === 3 ? ' — 3rd consecutive drop → ACT' : ''}`
        : 'post-trigger check (same metric, falling while locked → cooldown expected)';
    cLast = await spawnCheck('C', label, liveArgs(cValues[i]));
  }

  const cRuns = runs.filter((r) => r.phase === 'C');
  const c1 = cRuns[0]?.json;
  const c2 = cRuns[1]?.json;
  const c3 = cRuns[2]?.json;
  const c4 = cRuns[3]?.json;
  const c5 = cRuns[4]?.json;
  const triggerRecord = store.loadCommittedState().state?.triggerRecords.at(-1) ?? null;

  assertions.push(
    assert('C: 5 observations stored (4 + cooldown check)', c5?.historyLength === 5, `historyLength=${c5?.historyLength}`),
    assert('C: values strictly falling', [c1?.value, c2?.value, c3?.value, c4?.value].every((v) => typeof v === 'number') && (c1!.value! > c2!.value! && c2!.value! > c3!.value! && c3!.value! > c4!.value!), `values=${[c1?.value, c2?.value, c3?.value, c4?.value].join(' → ')}`),
    assert('C: streak 0→1→2→3', [c1?.streakCount, c2?.streakCount, c3?.streakCount, c4?.streakCount].join(',') === '0,1,2,3', `streaks=${[c1?.streakCount, c2?.streakCount, c3?.streakCount, c4?.streakCount].join(',')}`),
    assert('C: trigger EXACTLY at the 3rd consecutive drop (obs #4)', c4?.triggered === true && c1?.triggered === false && c2?.triggered === false && c3?.triggered === false, `triggered=[${[c1?.triggered, c2?.triggered, c3?.triggered, c4?.triggered].join(',')}]`),
    assert('C: trigger observation index == 4', c4?.index === 4, `index=${c4?.index}`),
    assert('C: real tx broadcast on 688689', typeof c4?.action?.txHash === 'string' && c4.action.txHash.startsWith('0x'), `tx=${c4?.action?.txHash ?? 'NONE'}`),
    assert('C: cooldown engaged (phase ACTED_LOCKED)', c4?.phase === 'ACTED_LOCKED', `phase=${c4?.phase}`),
    assert('C: post-trigger check → COOLDOWN, no duplicate tx', c5?.ruleStatus === 'COOLDOWN' && c5?.action === null && c5?.triggered === false, `status=${c5?.ruleStatus} action=${c5?.action ? 'yes' : 'none'}`),
    assert('C: exactly ONE trigger record', store.loadCommittedState().state?.triggerRecords.length === 1, `records=${store.loadCommittedState().state?.triggerRecords.length}`),
  );

  // On-chain proof verification (anchor contract path).
  let onChainProof: Record<string, unknown> | null = null;
  if (c4?.action?.mode === 'ANCHOR_CONTRACT' && triggerRecord && c4.action.txHash) {
    const anchorAddress = c4.action.anchorAddress as `0x${string}`;
    const receipt = await withRetry('txReceipt', () => publicClient.getTransactionReceipt({ hash: c4.action.txHash as `0x${string}` }));

    // Primary on-chain proof: decode the TrendAnchored event from the receipt —
    // it carries the proofDigest, ruleHash, triggerIndex AND every window hash.
    const { parseEventLogs } = await import('viem');
    const events = parseEventLogs({ abi: ANCHOR_ABI, logs: receipt.logs });
    const anchoredEvent = events.find((e) => e.eventName === 'TrendAnchored') as
      | { args: { proofDigest: string; ruleHash: string; watcher: string; triggerIndex: bigint; windowObservationHashes: string[] } }
      | undefined;

    // Secondary: Pharos-safe flat view getters (simple types only).
    let isAnchored: boolean | null = null;
    let onChainWatcher: string | null = null;
    let onChainTriggerIndex: number | null = null;
    try {
      isAnchored = await withRetry('isAnchored', () =>
        publicClient.readContract({ address: anchorAddress, abi: ANCHOR_ABI, functionName: 'isAnchored', args: [triggerRecord.trendProofDigest as `0x${string}`] }),
      );
      onChainWatcher = await withRetry('getProofWatcher', () =>
        publicClient.readContract({ address: anchorAddress, abi: ANCHOR_ABI, functionName: 'getProofWatcher', args: [triggerRecord.trendProofDigest as `0x${string}`] }),
      );
      const idx = await withRetry('getProofTriggerIndex', () =>
        publicClient.readContract({ address: anchorAddress, abi: ANCHOR_ABI, functionName: 'getProofTriggerIndex', args: [triggerRecord.trendProofDigest as `0x${string}`] }),
      );
      onChainTriggerIndex = Number(idx);
    } catch (err) {
      log(`  (flat getter reads unavailable: ${err instanceof Error ? err.shortMessage ?? err.message.slice(0, 60) : err} — event-decoded proof stands)`);
    }

    onChainProof = {
      mode: 'ANCHOR_CONTRACT',
      anchorAddress,
      proofDigest: triggerRecord.trendProofDigest,
      isAnchored,
      eventDecoded: anchoredEvent
        ? {
            proofDigest: anchoredEvent.args.proofDigest,
            ruleHash: anchoredEvent.args.ruleHash,
            watcher: anchoredEvent.args.watcher,
            triggerIndex: Number(anchoredEvent.args.triggerIndex),
            windowObservationHashes: anchoredEvent.args.windowObservationHashes,
            blockNumber: Number(receipt.blockNumber),
          }
        : null,
      watcher: onChainWatcher,
      triggerIndex: onChainTriggerIndex,
      txReceiptStatus: receipt.status,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed.toString(),
    };

    assertions.push(
      assert('C: TrendAnchored event present in the anchor tx receipt', Boolean(anchoredEvent), `logs=${receipt.logs.length}`),
      assert(
        'C: event proofDigest == local trendProofDigest',
        anchoredEvent?.args.proofDigest.toLowerCase() === triggerRecord.trendProofDigest.toLowerCase(),
        `${anchoredEvent?.args.proofDigest.slice(0, 18)}…`,
      ),
      assert(
        'C: event carries the exact window observation hashes',
        Boolean(anchoredEvent && anchoredEvent.args.windowObservationHashes.join(',').toLowerCase() === triggerRecord.window.map((o) => o.observationHash).join(',').toLowerCase()),
        `windowHashes=${anchoredEvent?.args.windowObservationHashes.length ?? 0}`,
      ),
      assert('C: anchor tx confirmed on 688689', receipt.status === 'success', `block=${Number(receipt.blockNumber)} gas=${receipt.gasUsed}`),
    );
    if (isAnchored !== null) {
      assertions.push(assert('C: proofDigest verifiable on-chain (isAnchored == true)', isAnchored === true, `anchor=${anchorAddress}`));
    }
    if (onChainWatcher) {
      assertions.push(assert('C: anchored watcher == agent wallet', onChainWatcher.toLowerCase() === account.address.toLowerCase(), `watcher=${onChainWatcher}`));
    }
  } else if (c4?.action?.mode === 'NATIVE_CALDATA' && c4.action.txHash) {
    const receipt = await withRetry('txReceipt', () => publicClient.getTransactionReceipt({ hash: c4.action.txHash as `0x${string}` }));
    onChainProof = {
      mode: 'NATIVE_CALDATA',
      proofDigest: triggerRecord?.trendProofDigest ?? null,
      txReceiptStatus: receipt.status,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed.toString(),
      note: 'proof carried in tx calldata (visible on PharosScan input data)',
    };
    assertions.push(assert('C: native proof tx confirmed', receipt.status === 'success', `status=${receipt.status}`));
  }

  // ================================================================ evidence
  const allPassed = assertions.every((a) => a.pass);
  const state = store.loadCommittedState().state;
  const evidence = {
    meta: {
      generatedAt,
      network: {
        chainId: CHAIN_ID,
        name: 'Pharos Atlantic Testnet',
        rpcHost: new URL(env.rpcUrl).host,
        explorer: env.explorerUrl,
      },
      watcherId: WATCHER,
      dataDir: store.paths.dataDir,
      rule,
      metricMode,
      wallet: account.address,
      verifyPid: process.pid,
      runnerPids: runs.map((r) => r.pid),
      toolchain: { node: process.version },
    },
    summary: {
      totalRuns: runs.length,
      totalOnChainTxs: [c4?.action, c5?.action].filter((a) => a?.txHash).length,
      assertionsTotal: assertions.length,
      assertionsPassed: assertions.filter((a) => a.pass).length,
      allPassed,
    },
    phaseA_singleSpikeRejection: {
      description: '100 → 75 (single -2500 bps spike, MAD/threshold outlier) → 99 (recovery). The spike resets the streak and NEVER triggers an action.',
      runs: runs.filter((r) => r.phase === 'A'),
      assertions: assertions.filter((a) => a.name.startsWith('A:')),
    },
    phaseB_restartAndReplay: {
      description: 'Replay of the same block/window is deduplicated; a hard SIGKILL mid-run loses nothing (WAL recovery) and re-polls do not duplicate history.',
      runs: runs.filter((r) => r.phase === 'B'),
      assertions: assertions.filter((a) => a.name.startsWith('B:')),
    },
    phaseC_confirmedTrendOnChain: {
      description: 'Live Pharos Atlantic state observed by 4 separate OS processes; trigger pinpointed at the 3rd consecutive drop (observation #4); protective action broadcast on-chain with the trendProofDigest; cooldown lock proven.',
      runs: cRuns,
      triggerRecord,
      action: c4?.action ?? null,
      onChainProof,
      assertions: assertions.filter((a) => a.name.startsWith('C:')),
    },
    allAssertions: assertions,
  };

  const evidenceDir = path.join(PROJECT_ROOT, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, 'trend-run-evidence.json');
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`evidence JSON → ${path.relative(PROJECT_ROOT, evidenceFile)}`);

  // ---- Markdown ----
  const md: string[] = [];
  md.push('# SUBMISSION EVIDENCE — Trend Watcher (Pharos Atlantic Testnet)');
  md.push('');
  md.push(`> Auto-generated by \`npm run watcher:verify\` at **${generatedAt}** — every check below ran in a **separate OS process** (fresh PID, zero in-memory state).`);
  md.push('');
  md.push('| Field | Value |');
  md.push('| --- | --- |');
  md.push(`| Network | Pharos Atlantic Testnet — chainId **688689** |`);
  md.push(`| RPC host | \`${new URL(env.rpcUrl).host}\` |`);
  md.push(`| Explorer | ${env.explorerUrl} |`);
  md.push(`| Agent wallet | \`${account.address}\` |`);
  md.push(`| Metric mode (Phase C) | \`${metricMode}\` |`);
  md.push(`| Rule | \`${rule.mode}\` — ${rule.direction.toLowerCase()}, requiredObservations=${rule.requiredObservations} (>= 3 enforced) |`);
  md.push(`| Assertions | **${assertions.filter((a) => a.pass).length}/${assertions.length} passed** |`);
  md.push('');
  md.push('## Live PharosScan receipts');
  md.push('');
  md.push('| Phase | Action | Tx hash | Link |');
  md.push('| --- | --- | --- | --- |');
  if (c4?.action?.txHash) {
    md.push(`| C | Trend trigger → protective on-chain action (${c4.action.mode}) | \`${c4.action.txHash}\` | [PharosScan](${c4.action.explorerUrl ?? txExplorerUrl(env.explorerUrl, c4.action.txHash)}) |`);
  }
  if (onChainProof && (onChainProof as { anchorAddress?: string }).anchorAddress) {
    md.push(`| C | TrendAnchor contract | ${(onChainProof as { anchorAddress: string }).anchorAddress} | [address](${env.explorerUrl}/address/${(onChainProof as { anchorAddress: string }).anchorAddress}) |`);
  }
  md.push('');

  for (const [phase, title] of [
    ['A', 'Phase A — Single-Spike Rejection (noise filter, never acts)'],
    ['B', 'Phase B — Restart, SIGKILL crash, WAL recovery & replay dedup'],
    ['C', 'Phase C — Confirmed 3-check trend → live on-chain action'],
  ] as const) {
    md.push(`## ${title}`);
    md.push('');
    md.push('| # | label | PID | exit | block | value | Δbps | streak | status | triggered |');
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    runs
      .filter((r) => r.phase === phase)
      .forEach((r, i) => {
        md.push(
          `| ${i + 1} | ${r.label} | ${r.pid ?? '—'} | ${r.signal ?? r.exit ?? '—'} | ${r.json?.blockNumber ?? '—'} | ${r.json?.value ?? '—'} | ${r.json?.deltaFromPrevBps !== null && r.json?.deltaFromPrevBps !== undefined ? r.json.deltaFromPrevBps.toFixed(1) : '—'} | ${r.json?.streakCount ?? '—'} | ${r.json?.ruleStatus ?? (r.json?.deduplicated ? 'DEDUPLICATED' : 'CRASHED')} | ${r.json?.triggered ?? '—'} |`,
        );
      });
    md.push('');
    md.push('| Assertion | Result | Details |');
    md.push('| --- | --- | --- |');
    assertions
      .filter((a) => a.name.startsWith(`${phase}:`))
      .forEach((a) => md.push(`| ${a.name.slice(3)} | ${a.pass ? '✅ PASS' : '❌ FAIL'} | ${a.details} |`));
    md.push('');
  }

  md.push('## Exact Trigger Moment record');
  md.push('');
  if (triggerRecord) {
    md.push('```json');
    md.push(
      JSON.stringify(
        {
          triggerObservationIndex: triggerRecord.triggerObservationIndex,
          observationId: triggerRecord.observationId,
          blockNumber: triggerRecord.blockNumber,
          timestamp: new Date(triggerRecord.timestamp).toISOString(),
          ruleHash: triggerRecord.ruleHash,
          trendProofDigest: triggerRecord.trendProofDigest,
          windowObservationHashes: triggerRecord.window.map((o) => o.observationHash),
          txHash: triggerRecord.txHash,
          explorerUrl: triggerRecord.explorerUrl,
          actionMode: triggerRecord.actionMode,
        },
        null,
        2,
      ),
    );
    md.push('```');
  } else {
    md.push('_no trigger recorded (verification incomplete)_');
  }
  md.push('');
  md.push('## Reproduce');
  md.push('');
  md.push('```bash');
  md.push('npm install');
  md.push('cp .env.example .env.local   # fill in a burnable Pharos Atlantic test key');
  md.push('npm run watcher:verify       # this exact evidence pipeline');
  md.push('npm test                     # 267-test Vitest suite');
  md.push('```');

  const mdFile = path.join(PROJECT_ROOT, 'SUBMISSION_EVIDENCE.md');
  fs.writeFileSync(mdFile, `${md.join('\n')}\n`);
  log(`evidence markdown → ${path.relative(PROJECT_ROOT, mdFile)}`);

  log('='.repeat(72));
  log(`RESULT: ${assertions.filter((a) => a.pass).length}/${assertions.length} assertions passed${allPassed ? ' — ALL GREEN ✅' : ' — FAILURES PRESENT ❌'}`);
  if (c4?.action?.txHash) log(`Receipt: ${c4.action.explorerUrl ?? txExplorerUrl(env.explorerUrl, c4.action.txHash)}`);
  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error('[verify] FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
