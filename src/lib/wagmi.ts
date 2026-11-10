/**
 * wagmi v2 configuration for Pharos Atlantic Testnet (chainId 688689).
 * Used by the console UI for live chain status (block height / chain id).
 */
import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';

export const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://atlantic.dplabs-internal.com';
export const explorerUrl = process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://atlantic.pharosscan.xyz';

export const pharosAtlantic = defineChain({
  id: 688689,
  name: 'Pharos Atlantic Testnet',
  nativeCurrency: { name: 'Pharos', symbol: 'PHRS', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: 'PharosScan', url: explorerUrl } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [pharosAtlantic],
  transports: {
    [pharosAtlantic.id]: http(rpcUrl),
  },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
