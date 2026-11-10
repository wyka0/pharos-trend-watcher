/**
 * Server-side store factory + executor wiring for the Next.js API routes.
 * Every request constructs (or re-loads) the store from DISK — the server
 * process itself holds no watcher state, exactly like the CLI processes.
 */
import path from 'node:path';
import { PersistentTrendStore, defaultDataDir } from '@/lib/storage';
import {
  createClients,
  executeProtectiveAction,
  fetchBlockNumber,
  readErc20Balance,
  readNativeBalance,
} from '@/lib/chain';
import { defaultTrendRule } from '@/lib/rules';
import type { ActionExecutor, TrendRule } from '@/lib/types';

export function serverDataDir(): string {
  const configured = process.env.WATCHER_DATA_DIR;
  if (configured && configured.trim() !== '') return path.resolve(configured);
  return path.join(process.cwd(), '.data');
}

export function serverStore(watcherId = 'default', rule?: TrendRule): PersistentTrendStore {
  return new PersistentTrendStore({
    dataDir: serverDataDir(),
    watcherId,
    rule: rule ?? defaultTrendRule(),
    chainId: Number(process.env.PHAROS_CHAIN_ID ?? 688689),
  });
}

/** Serialize run/reset/config mutations within this server process. */
const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** Live Pharos block number, or null when the RPC is unreachable. */
export async function fetchLiveBlock(): Promise<number | null> {
  try {
    const { publicClient } = createClients();
    return await fetchBlockNumber(publicClient);
  } catch {
    return null;
  }
}

export type MetricSelector = 'synthetic' | 'live' | 'live_erc20' | 'live_native';

export interface LiveMetric {
  value: number;
  metricSource: string;
  blockNumber: number | null;
}

/** Read a live metric off Pharos Atlantic state (USDC balance by default). */
export async function readLiveMetric(selector: MetricSelector): Promise<LiveMetric> {
  const { publicClient, account, env } = createClients();
  const blockNumber = await fetchBlockNumber(publicClient);
  if (selector === 'live_native') {
    const balance = await readNativeBalance(publicClient, account.address);
    return { value: balance.formatted, metricSource: 'onchain_native_balance', blockNumber };
  }
  const balance = await readErc20Balance(publicClient, env.usdcAddress, account.address, env.usdcDecimals);
  return {
    value: balance.formatted,
    metricSource: `onchain_erc20_balance:${env.usdcAddress}`,
    blockNumber,
  };
}

/** Real on-chain action executor (TrendAnchor contract, native-calldata fallback). */
export function serverActionExecutor(dataDir = serverDataDir()): ActionExecutor {
  return (ctx) => executeProtectiveAction(ctx, { dataDir });
}

export { defaultDataDir, defaultTrendRule };
