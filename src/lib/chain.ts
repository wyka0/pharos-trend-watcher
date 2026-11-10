/**
 * Pharos Atlantic Testnet (chainId 688689) client + on-chain action layer.
 *
 * The protective action executed at the exact trigger moment anchors the
 * trendProofDigest on-chain (Innovation 1):
 *   1. ANCHOR_CONTRACT — the TrendAnchor contract stores the digest + emits a
 *      TrendAnchored event carrying every window observation hash; or
 *   2. NATIVE_CALDATA — a native PHRS self-transfer whose calldata carries the
 *      ABI-encoded proof (visible in the tx input on PharosScan).
 * `WATCHER_ACTION_MODE=auto` (default) deploys/uses the anchor and falls back
 * to the native proof tx if the contract path is unavailable.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  formatUnits,
  http,
  type Abi,
  type Account,
  type Chain,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployContract, waitForTransactionReceipt } from 'viem/actions';
import { defaultDataDir } from './storage';
import anchorArtifact from '../generated/anchor.json';
import type { ActionResult, ActionContext } from './types';

export const PHAROS_ATLANTIC_CHAIN_ID = 688689;
export const PHAROS_ATLANTIC_RPC = 'https://atlantic.dplabs-internal.com';
export const PHAROS_ATLANTIC_EXPLORER = 'https://atlantic.pharosscan.xyz';
/** Official Atlantic Testnet token registry (docs.pharos.xyz). */
export const PHAROS_USDC = '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B' as const;
export const PHAROS_WPHRS = '0x838800b758277CC111B2d48Ab01e5E164f8E9471' as const;

export const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export const ANCHOR_ABI = anchorArtifact.abi as Abi;
export const ANCHOR_BYTECODE = anchorArtifact.bytecode as `0x${string}`;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface PharosEnv {
  rpcUrl: string;
  chainId: number;
  explorerUrl: string;
  usdcAddress: `0x${string}`;
  usdcDecimals: number;
  wphrsAddress: `0x${string}` | null;
  payToAddress: `0x${string}` | null;
  privateKey: `0x${string}` | null;
}

export function loadPharosEnv(): PharosEnv {
  const usdcAddress = (process.env.PHAROS_USDC_ADDRESS ?? PHAROS_USDC) as `0x${string}`;
  const wphrs = process.env.PHAROS_WPHRS_ADDRESS ?? PHAROS_WPHRS;
  const payTo = process.env.PHAROS_PAY_TO_ADDRESS ?? process.env.PAY_TO_ADDRESS ?? null;
  return {
    rpcUrl: process.env.PHAROS_RPC_URL ?? PHAROS_ATLANTIC_RPC,
    chainId: Number(process.env.PHAROS_CHAIN_ID ?? PHAROS_ATLANTIC_CHAIN_ID),
    explorerUrl: process.env.PHAROS_EXPLORER_URL ?? PHAROS_ATLANTIC_EXPLORER,
    usdcAddress,
    usdcDecimals: Number(process.env.USDC_DECIMALS ?? 6),
    wphrsAddress: (wphrs && wphrs !== '' ? wphrs : null) as `0x${string}` | null,
    payToAddress: (payTo && payTo !== '' ? payTo : null) as `0x${string}` | null,
    privateKey: (process.env.TEST_USER_PRIVATE_KEY ?? process.env.PHAROS_PRIVATE_KEY ?? null) as `0x${string}` | null,
  };
}

let cachedChain: Chain | null = null;

export function pharosAtlanticChain(env: PharosEnv = loadPharosEnv()): Chain {
  if (!cachedChain) {
    cachedChain = defineChain({
      id: env.chainId,
      name: 'Pharos Atlantic Testnet',
      nativeCurrency: { name: 'Pharos', symbol: 'PHRS', decimals: 18 },
      rpcUrls: { default: { http: [env.rpcUrl] } },
      blockExplorers: { default: { name: 'PharosScan', url: env.explorerUrl } },
      testnet: true,
    });
  }
  return cachedChain;
}

export function getAccount(env: PharosEnv = loadPharosEnv()): PrivateKeyAccount {
  if (!env.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(env.privateKey)) {
    throw new Error(
      'TEST_USER_PRIVATE_KEY missing/invalid — cannot execute on-chain actions. ' +
        'Copy the burnable Pharos Atlantic test key into .env.local (see .env.example).',
    );
  }
  return privateKeyToAccount(env.privateKey);
}

export interface PharosClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
  chain: Chain;
  env: PharosEnv;
}

export function createClients(env: PharosEnv = loadPharosEnv()): PharosClients {
  const chain = pharosAtlanticChain(env);
  const account = getAccount(env);
  const publicClient = createPublicClient({ chain, transport: http(env.rpcUrl, { timeout: 30_000 }) });
  const walletClient = createWalletClient({ chain, account, transport: http(env.rpcUrl, { timeout: 30_000 }) });
  return { publicClient, walletClient, account, chain, env };
}

// ---------------------------------------------------------------------------
// Reads + simple transfers (used for live metric observation & Phase C drains)
// ---------------------------------------------------------------------------

export async function fetchBlockNumber(client: PublicClient): Promise<number> {
  return Number(await client.getBlockNumber());
}

export async function readErc20Balance(
  client: PublicClient,
  token: `0x${string}`,
  holder: `0x${string}`,
  decimals = 6,
): Promise<{ raw: bigint; formatted: number }> {
  const raw = (await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] })) as bigint;
  return { raw, formatted: Number(formatUnits(raw, decimals)) };
}

export async function readNativeBalance(
  client: PublicClient,
  holder: `0x${string}`,
): Promise<{ raw: bigint; formatted: number }> {
  const raw = await client.getBalance({ address: holder });
  return { raw, formatted: Number(formatUnits(raw, 18)) };
}

export async function transferErc20(
  clients: PharosClients,
  token: `0x${string}`,
  to: `0x${string}`,
  rawAmount: bigint,
): Promise<string> {
  const hash = await clients.walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, rawAmount],
    account: clients.account,
    chain: clients.chain,
  });
  const receipt = await waitForTransactionReceipt(clients.publicClient, { hash, timeout: 120_000, pollingInterval: 1_000 });
  if (receipt.status !== 'success') throw new Error(`ERC-20 transfer reverted: ${hash}`);
  return hash;
}

export async function transferNative(
  clients: PharosClients,
  to: `0x${string}`,
  rawAmount: bigint,
): Promise<string> {
  const hash = await clients.walletClient.sendTransaction({ to, value: rawAmount, account: clients.account, chain: clients.chain });
  const receipt = await waitForTransactionReceipt(clients.publicClient, { hash, timeout: 120_000, pollingInterval: 1_000 });
  if (receipt.status !== 'success') throw new Error(`native transfer reverted: ${hash}`);
  return hash;
}

export function txExplorerUrl(explorerUrl: string, txHash: string): string | null {
  if (!explorerUrl) return null;
  return `${explorerUrl.replace(/\/$/, '')}/tx/${txHash}`;
}

// ---------------------------------------------------------------------------
// Proof encoding
// ---------------------------------------------------------------------------

/** Calldata payload embedded in the native fallback action. */
export function encodeProofCalldata(
  ruleHash: string,
  proofDigest: string,
  triggerIndex: number,
  windowHashes: readonly string[],
): `0x${string}` {
  return encodeAbiParameters(
    [
      { name: 'ruleHash', type: 'bytes32' },
      { name: 'proofDigest', type: 'bytes32' },
      { name: 'triggerIndex', type: 'uint256' },
      { name: 'windowObservationHashes', type: 'bytes32[]' },
    ],
    [ruleHash as `0x${string}`, proofDigest as `0x${string}`, BigInt(triggerIndex), windowHashes as `0x${string}`[]],
  );
}

// ---------------------------------------------------------------------------
// TrendAnchor contract deployment/cache
// ---------------------------------------------------------------------------

export interface AnchorInfo {
  address: `0x${string}`;
  txHash: string | null;
  deployedAt: number | null;
}

function anchorCacheFile(dataDir: string): string {
  return path.join(dataDir, 'anchor-contract.json');
}

export async function ensureAnchorContract(opts: {
  clients: PharosClients;
  dataDir?: string;
  allowDeploy?: boolean;
}): Promise<AnchorInfo | null> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const cacheFile = anchorCacheFile(dataDir);

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as AnchorInfo;
      const code = await opts.clients.publicClient.getCode({ address: cached.address });
      if (code && code !== '0x') return cached;
    } catch {
      /* stale cache — fall through */
    }
  }

  if (!opts.allowDeploy) return null;

  const hash = await deployContract(opts.clients.walletClient, {
    abi: ANCHOR_ABI,
    bytecode: ANCHOR_BYTECODE,
    account: opts.clients.account as Account,
    chain: opts.clients.chain,
  });
  const receipt = await waitForTransactionReceipt(opts.clients.publicClient, { hash, timeout: 180_000, pollingInterval: 1_000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`TrendAnchor deployment failed: ${hash}`);
  }
  const info: AnchorInfo = { address: receipt.contractAddress, txHash: hash, deployedAt: Date.now() };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

// ---------------------------------------------------------------------------
// The protective action executed at the exact trigger moment
// ---------------------------------------------------------------------------

export async function executeProtectiveAction(
  ctx: ActionContext,
  opts: { dataDir?: string } = {},
): Promise<ActionResult> {
  const clients = createClients();
  const mode = (process.env.WATCHER_ACTION_MODE ?? 'auto').toLowerCase();
  const { ruleHash, trendProofDigest, triggerObservationIndex, window } = ctx.trigger;
  const windowHashes = window.map((o) => o.observationHash) as `0x${string}`[];

  if (mode !== 'native') {
    try {
      const anchor = await ensureAnchorContract({
        clients,
        dataDir: opts.dataDir,
        allowDeploy: mode === 'auto' || mode === 'anchor',
      });
      if (anchor) {
        const hash = await clients.walletClient.writeContract({
          address: anchor.address,
          abi: ANCHOR_ABI,
          functionName: 'anchor',
          args: [ruleHash as `0x${string}`, trendProofDigest as `0x${string}`, BigInt(triggerObservationIndex), windowHashes],
          gas: 400_000n,
          account: clients.account,
          chain: clients.chain,
        });
        const receipt = await waitForTransactionReceipt(clients.publicClient, { hash, timeout: 180_000, pollingInterval: 1_000 });
        if (receipt.status !== 'success') throw new Error(`anchor tx reverted: ${hash}`);
        return {
          txHash: hash,
          explorerUrl: txExplorerUrl(clients.env.explorerUrl, hash),
          mode: 'ANCHOR_CONTRACT',
          anchorAddress: anchor.address,
        };
      }
      if (mode === 'anchor') throw new Error('TrendAnchor unavailable and deployment disabled');
    } catch (err) {
      if (mode === 'anchor') throw err;
      // 'auto': fall through to the native calldata proof
    }
  }

  const data = encodeProofCalldata(ruleHash, trendProofDigest, triggerObservationIndex, windowHashes);
  const hash = await clients.walletClient.sendTransaction({
    to: clients.account.address,
    value: 1n, // 1 wei self-transfer carrying the proof calldata
    data,
    account: clients.account,
    chain: clients.chain,
  });
  const receipt = await waitForTransactionReceipt(clients.publicClient, { hash, timeout: 180_000, pollingInterval: 1_000 });
  if (receipt.status !== 'success') throw new Error(`native proof tx reverted: ${hash}`);
  return {
    txHash: hash,
    explorerUrl: txExplorerUrl(clients.env.explorerUrl, hash),
    mode: 'NATIVE_CALDATA',
  };
}
