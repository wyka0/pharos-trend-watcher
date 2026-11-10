'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import RuleConfigurator from '@/components/RuleConfigurator';
import SimulatorControls, { type RunLogEntry } from '@/components/SimulatorControls';
import StateInspector from '@/components/StateInspector';
import TimelineChart from '@/components/TimelineChart';
import TriggerReceipt from '@/components/TriggerReceipt';
import type { StoreSnapshot } from '@/lib/storage';
import type { TrendRule } from '@/lib/types';

const ChainStatusCard = dynamic(() => import('@/components/ChainStatusCard'), { ssr: false });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default function Page() {
  const [snapshot, setSnapshot] = useState<StoreSnapshot | null>(null);
  const [log, setLog] = useState<RunLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const body = (await res.json()) as { ok: boolean } & StoreSnapshot;
      if (body.ok) setSnapshot({ state: body.state, integrity: body.integrity, files: body.files, walTail: body.walTail });
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const runOne = useCallback(
    async (payload: { value?: number; metric?: 'synthetic' | 'live'; replayLast?: boolean }, label: string): Promise<RunLogEntry> => {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, liveAction: true }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        deduplicated?: boolean;
        duplicatesIgnoredTotal?: number;
        triggered?: boolean;
        pid?: number;
        observation?: { index: number; value: number; blockNumber: number; ruleStatus: string; streakCount: number } | null;
        action?: { txHash: string | null } | null;
      };
      const entry: RunLogEntry = {
        ts: Date.now(),
        label,
        pid: body.pid ?? null,
        index: body.observation?.index ?? null,
        value: body.observation?.value ?? payload.value ?? null,
        blockNumber: body.observation?.blockNumber ?? null,
        ruleStatus: body.observation?.ruleStatus ?? (body.deduplicated ? 'DEDUPLICATED' : null),
        streak: body.observation?.streakCount ?? null,
        deduplicated: Boolean(body.deduplicated),
        triggered: Boolean(body.triggered),
        txHash: body.action?.txHash ?? null,
        error: body.ok ? null : (body.error ?? 'unknown error'),
      };
      setLog((prev) => [...prev, entry]);
      await refresh();
      if (!body.ok) setError(body.error ?? 'run failed');
      return entry;
    },
    [refresh],
  );

  const runScenario = useCallback(
    async (label: string, values: number[]) => {
      setBusy(true);
      setError(null);
      try {
        for (let i = 0; i < values.length; i++) {
          await runOne({ value: values[i], metric: 'synthetic' }, `${label} · step ${i + 1}/${values.length}`);
          if (i < values.length - 1) await sleep(1500); // land in a fresh block/time bucket
        }
      } finally {
        setBusy(false);
      }
    },
    [runOne],
  );

  const saveRule = useCallback(
    async (rule: TrendRule): Promise<string | null> => {
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rule }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string };
        if (!body.ok) return body.error ?? 'rejected';
        await refresh();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [refresh],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      setLog([]);
      setError(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const state = snapshot?.state ?? null;
  const latestTrigger = state?.triggerRecords.length ? (state.triggerRecords[state.triggerRecords.length - 1] ?? null) : null;
  const cooldownActive = state?.cooldownUntil != null && Date.now() < state.cooldownUntil;

  return (
    <main className="mx-auto max-w-7xl space-y-5 px-5 py-7">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">
            Trend Watcher <span className="text-teal-300">— Stateful Multi-Observation Skill</span>
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Persistent disk memory · hash-chained observations · ≥3-check trend enforcement · single-spike rejection ·
            on-chain Proof-of-Trend on Pharos Atlantic Testnet
          </p>
        </div>
        <ChainStatusCard />
      </header>

      {error && (
        <div className="rounded-md border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
          {error}{' '}
          <button className="ml-2 text-rose-400 underline" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Timeline + log */}
        <section className="panel space-y-4 p-5 xl:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Observation Timeline (stored history)</h2>
            <div className="flex items-center gap-2 text-xs">
              <span className={`badge border ${state?.phase === 'ACTED_LOCKED' ? 'border-amber-700 bg-amber-950/40 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>
                {state?.phase ?? 'IDLE'}
                {cooldownActive ? ' · cooldown' : ''}
              </span>
              <span className="text-slate-500">
                {state ? `${state.observations.length} obs · ${state.duplicatesIgnored} dup ignored · ${state.triggerRecords.length} trigger(s)` : 'no history on disk'}
              </span>
            </div>
          </div>
          <TimelineChart observations={state?.observations ?? []} />

          <div ref={logRef} className="mono max-h-48 overflow-auto rounded-md border border-slate-800 bg-slate-950/70 p-3 text-[11px] leading-relaxed text-slate-400">
            {log.length === 0 ? '// run log — every step is a full disk-backed cycle' : null}
            {log.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="flex flex-wrap gap-x-3">
                <span className="text-slate-600">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="text-slate-500">{e.label}</span>
                {e.deduplicated ? (
                  <span className="text-amber-300">DEDUP #{e.index ?? '—'} ignored (history intact)</span>
                ) : (
                  <span>
                    obs <span className="text-slate-200">#{e.index}</span> = <span className="text-slate-200">{e.value}</span>
                    {e.blockNumber !== null ? <span> @blk{e.blockNumber}</span> : null} →{' '}
                    <span className={e.ruleStatus === 'TRIGGERED_ACTING' ? 'text-emerald-300' : e.ruleStatus === 'SPIKE_REJECTED' ? 'text-rose-300' : 'text-indigo-300'}>
                      {e.ruleStatus}
                    </span>
                    {e.streak !== null ? <span> (streak {e.streak})</span> : null}
                    {e.txHash ? <span className="text-teal-300"> ⛓ {e.txHash.slice(0, 14)}…</span> : null}
                  </span>
                )}
                {e.error ? <span className="text-rose-400">⚠ {e.error}</span> : null}
              </div>
            ))}
          </div>
        </section>

        {/* Controls + trigger receipt */}
        <div className="space-y-5">
          <section className="panel space-y-4 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Simulator & Controls</h2>
            <SimulatorControls
              busy={busy}
              onRun={(payload) =>
                runOne(payload, payload.replayLast ? 'replay-last' : payload.metric === 'live' ? 'live check' : `observe ${payload.value}`)
              }
              onReset={reset}
              onRunScenario={runScenario}
            />
          </section>

          <section className="panel space-y-4 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Trigger Moment & On-Chain Receipt</h2>
            <TriggerReceipt record={latestTrigger} />
          </section>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <section className="panel space-y-4 p-5 xl:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Stored Disk State Inspector</h2>
          <StateInspector
            state={state}
            files={
              snapshot?.files ?? { stateFile: '—', walFile: '—', stateBytes: null, walBytes: null, walLines: 0 }
            }
            integrity={snapshot?.integrity ?? { integrity: 'MISSING', tamperIndex: null, reason: null }}
            walTail={snapshot?.walTail ?? []}
          />
        </section>

        <section className="panel space-y-4 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Rule Configurator</h2>
          <RuleConfigurator rule={state?.rule ?? null} onSave={saveRule} />
        </section>
      </div>

      <footer className="pb-6 text-center text-xs text-slate-600">
        Every observation is hash-chained (keccak256) and idempotent by (watcherId, blockNumber, metricSource,
        timestampBucket) — restart-safe, replay-proof, anchored on-chain when the confirmed trend fires.
      </footer>
    </main>
  );
}
