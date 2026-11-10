'use client';

import { useState } from 'react';export interface RunLogEntry {
  ts: number;
  label: string;
  pid: number | null;
  index: number | null;
  value: number | null;
  blockNumber: number | null;
  ruleStatus: string | null;
  streak: number | null;
  deduplicated: boolean;
  triggered: boolean;
  txHash: string | null;
  error: string | null;
}

interface Props {
  busy: boolean;
  onRun: (payload: { value?: number; metric?: 'synthetic' | 'live'; replayLast?: boolean }) => Promise<RunLogEntry>;
  onReset: () => Promise<void>;
  onRunScenario: (label: string, values: number[]) => Promise<void>;
}

/** Simulator buttons: live checks, single-spike vs confirmed-trend demos, restart/replay, reset. */
export default function SimulatorControls({ busy, onRun, onReset, onRunScenario }: Props) {
  const [manualValue, setManualValue] = useState<string>('');

  const btn =
    'rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
  const primary = `${btn} bg-indigo-500/90 text-white hover:bg-indigo-400`;
  const danger = `${btn} bg-rose-500/20 text-rose-300 border border-rose-900 hover:bg-rose-500/30`;
  const neutral = `${btn} bg-slate-800 text-slate-200 hover:bg-slate-700`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <button className={primary} disabled={busy} onClick={() => onRun({ metric: 'live' })}>
          ▶ Run live check
        </button>
        <div className="flex gap-2">
          <input
            className="mono w-full rounded-md border border-slate-700 bg-slate-950/70 px-2.5 text-sm text-slate-200 outline-none focus:border-indigo-400"
            placeholder="value, e.g. 88.5"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
          />
          <button
            className={neutral}
            disabled={busy || manualValue.trim() === ''}
            onClick={async () => {
              const v = Number(manualValue);
              if (Number.isFinite(v)) {
                await onRun({ value: v, metric: 'synthetic' });
                setManualValue('');
              }
            }}
          >
            Observe
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <button className={neutral} disabled={busy} onClick={() => onRunScenario('Single-spike (100 → 75 → 99)', [100, 75, 99])}>
          ⚡ Single-spike scenario: 100 → 75 → 99 (must NEVER act)
        </button>
        <button className={neutral} disabled={busy} onClick={() => onRunScenario('3-check trend (100 → 95 → 91 → 86)', [100, 95, 91, 86])}>
          📉 3-check trend scenario: 100 → 95 → 91 → 86 (acts at drop #3)
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button className={neutral} disabled={busy} onClick={() => onRun({ replayLast: true })}>
            ♻ Restart & replay last (dedup proof)
          </button>
          <button className={danger} disabled={busy} onClick={() => onReset()}>
            ⟲ Reset watcher (archives history)
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Every scenario step is a separate POST <span className="mono">/api/run</span> cycle: load disk → recover WAL →
        observe → evaluate → persist. The trend scenario pauses between checks so each one lands in a fresh chain
        block / time bucket (idempotency keys stay unique).
      </p>
    </div>
  );
}
