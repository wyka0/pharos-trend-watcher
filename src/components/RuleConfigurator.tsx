'use client';

import { useEffect, useState } from 'react';
import { describeRule } from '@/lib/rules';
import type { TrendRule } from '@/lib/types';

interface Props {
  rule: TrendRule | null;
  onSave: (rule: TrendRule) => Promise<string | null>; // returns error message or null
}

/** Rule Configurator — persisted rule DSL with hard >= 3 observation validation. */
export default function RuleConfigurator({ rule, onSave }: Props) {
  const [draft, setDraft] = useState<TrendRule | null>(rule);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(rule);
  }, [rule]);

  if (!draft) {
    return <p className="text-sm text-slate-500">Loading persisted rule…</p>;
  }

  const set = (patch: Partial<TrendRule>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
    setError(null);
  };

  const localProblem =
    !Number.isInteger(draft.requiredObservations) || draft.requiredObservations < 3
      ? `requiredObservations must be an integer >= 3 — a trend is never confirmed from ${JSON.stringify(draft.requiredObservations)} observation(s).`
      : null;

  const save = async () => {
    if (localProblem) {
      setError(localProblem);
      return;
    }
    setBusy(true);
    const err = await onSave(draft);
    setBusy(false);
    setError(err);
    if (!err) setSaved(true);
  };

  const inputCls =
    'mono w-full rounded-md border border-slate-700 bg-slate-950/70 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-teal-400';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs text-slate-400">
          Mode (trend DSL)
          <select
            className={inputCls}
            value={draft.mode}
            onChange={(e) => set({ mode: e.target.value as TrendRule['mode'] })}
          >
            <option value="CONSECUTIVE_MONOTONIC">CONSECUTIVE_MONOTONIC</option>
            <option value="CUMULATIVE_DELTA_BPS">CUMULATIVE_DELTA_BPS</option>
            <option value="MOVING_WINDOW_DURATION">MOVING_WINDOW_DURATION</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          Direction
          <select
            className={inputCls}
            value={draft.direction}
            onChange={(e) => set({ direction: e.target.value as TrendRule['direction'] })}
          >
            <option value="FALLING">FALLING (drawdown guard)</option>
            <option value="RISING">RISING (surge detector)</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          Required observations (min 3)
          <input
            type="number"
            min={3}
            max={1000}
            className={`${inputCls} ${localProblem ? 'border-rose-500' : ''}`}
            value={draft.requiredObservations}
            onChange={(e) => set({ requiredObservations: Number(e.target.value) })}
          />
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          Spike threshold (bps)
          <input
            type="number"
            min={1}
            className={inputCls}
            value={draft.spikeThresholdBps}
            onChange={(e) => set({ spikeThresholdBps: Number(e.target.value) })}
          />
        </label>
        <label className={`space-y-1 text-xs ${draft.mode === 'CUMULATIVE_DELTA_BPS' ? 'text-slate-400' : 'text-slate-600'}`}>
          Cumulative threshold (bps)
          <input
            type="number"
            min={1}
            disabled={draft.mode !== 'CUMULATIVE_DELTA_BPS'}
            className={`${inputCls} disabled:opacity-40`}
            value={draft.thresholdBps}
            onChange={(e) => set({ thresholdBps: Number(e.target.value) })}
          />
        </label>
        <label className={`space-y-1 text-xs ${draft.mode === 'MOVING_WINDOW_DURATION' ? 'text-slate-400' : 'text-slate-600'}`}>
          Window duration (minutes, ≥ 1)
          <input
            type="number"
            min={1}
            disabled={draft.mode !== 'MOVING_WINDOW_DURATION'}
            className={`${inputCls} disabled:opacity-40`}
            value={Math.round(draft.windowDurationMs / 60_000)}
            onChange={(e) => set({ windowDurationMs: Math.max(60_000, Number(e.target.value) * 60_000) })}
          />
        </label>
        <label className="space-y-1 text-xs text-slate-400">
          Cooldown / hysteresis (minutes)
          <input
            type="number"
            min={0}
            className={inputCls}
            value={Math.round(draft.cooldownMs / 60_000)}
            onChange={(e) => set({ cooldownMs: Number(e.target.value) * 60_000 })}
          />
        </label>
        <label className="flex items-end gap-2 pb-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            className="h-4 w-4 accent-teal-400"
            checked={draft.rejectSingleSpike}
            onChange={(e) => set({ rejectSingleSpike: e.target.checked })}
          />
          Reject single spikes (noise filter)
        </label>
      </div>

      <p className="mono rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-teal-300">
        {describeRule(draft)}
      </p>

      {error && (
        <p className="rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">⛔ {error}</p>
      )}
      {saved && !error && <p className="text-xs text-emerald-400">✓ rule persisted to .data/watcher-state.json</p>}

      <button
        onClick={save}
        disabled={busy}
        className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-teal-400 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save rule'}
      </button>
    </div>
  );
}
