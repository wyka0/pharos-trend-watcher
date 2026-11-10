'use client';

import type { TriggerMomentRecord } from '@/lib/types';

function short(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : '—';
}

/** Trigger Moment + PharosScan receipt card (Requirement 04, Innovation 1). */
export default function TriggerReceipt({ record }: { record: TriggerMomentRecord | null }) {
  if (!record) {
    return (
      <p className="text-sm text-slate-500">
        No trigger moment yet. The watcher only acts when <span className="mono text-slate-300">≥ 3 consecutive</span>{' '}
        directional checks satisfy the rule — never on a single spike.
      </p>
    );
  }

  const modeBadge =
    record.actionMode === 'ANCHOR_CONTRACT'
      ? 'border-teal-700 bg-teal-950/50 text-teal-300'
      : record.actionMode === 'NATIVE_CALDATA'
        ? 'border-indigo-700 bg-indigo-950/50 text-indigo-300'
        : 'border-slate-700 bg-slate-900 text-slate-400';

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge border ${modeBadge}`}>{record.actionMode ?? 'NO_ACTION'}</span>
        {record.recoveredAfterCrash && <span className="badge border border-amber-700 bg-amber-950/50 text-amber-300">RECOVERED (no re-exec)</span>}
        <span className="text-xs text-slate-400">
          triggered at observation <span className="mono text-slate-200">#{record.triggerObservationIndex}</span> · block{' '}
          <span className="mono text-slate-200">{record.blockNumber}</span> ·{' '}
          <span className="mono text-slate-200">{new Date(record.timestamp).toISOString()}</span>
        </span>
      </div>

      <div className="mono space-y-1 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-400">
        <div>ruleHash: <span className="text-slate-300">{short(record.ruleHash)}</span></div>
        <div>proofDigest: <span className="text-teal-300">{short(record.trendProofDigest)}</span></div>
      </div>

      {record.txHash && (
        <a
          className="mono block truncate rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300 hover:bg-emerald-900/40"
          href={record.explorerUrl ?? `#tx-${record.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          ⛓ tx {record.txHash} — view on PharosScan ↗
        </a>
      )}
      {record.actionError && <p className="text-xs text-amber-400">⚠ {record.actionError}</p>}

      <div>
        <p className="mb-1 text-xs text-slate-500">Window slice ({record.window.length} observations) — the exact sequence that authorized the action:</p>
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">value</th>
              <th className="py-1 pr-2">Δbps</th>
              <th className="py-1 pr-2">streak</th>
              <th className="py-1 pr-2">block</th>
              <th className="py-1">observationHash</th>
            </tr>
          </thead>
          <tbody className="mono text-slate-300">
            {record.window.map((o) => (
              <tr key={o.observationId} className="border-t border-slate-800/60">
                <td className="py-1 pr-2">{o.index}</td>
                <td className="py-1 pr-2">{o.value}</td>
                <td className="py-1 pr-2 text-rose-300">{o.deltaFromPrevBps !== null ? o.deltaFromPrevBps.toFixed(1) : '—'}</td>
                <td className="py-1 pr-2">{o.streakCount}</td>
                <td className="py-1 pr-2">{o.blockNumber}</td>
                <td className="py-1 text-slate-500">{short(o.observationHash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
