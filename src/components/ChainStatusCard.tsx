'use client';

import { useBlockNumber, useChainId } from 'wagmi';

/** Live chain status via wagmi v2 (public reads — no wallet required). */
export default function ChainStatusCard() {
  const chainId = useChainId();
  const { data: blockNumber, isError } = useBlockNumber({ watch: true });

  return (
    <div className="panel flex items-center gap-4 px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${isError ? 'bg-rose-400' : 'bg-emerald-400 animate-pulse'}`} />
        <span className="text-slate-300">Pharos Atlantic</span>
      </div>
      <div className="text-slate-500">|</div>
      <div>
        <span className="text-slate-500">chainId </span>
        <span className="mono text-teal-300">{chainId}</span>
      </div>
      <div className="text-slate-500">|</div>
      <div>
        <span className="text-slate-500">block </span>
        <span className="mono text-indigo-300">{blockNumber !== undefined ? Number(blockNumber).toLocaleString() : isError ? 'unreachable' : '…'}</span>
      </div>
    </div>
  );
}
