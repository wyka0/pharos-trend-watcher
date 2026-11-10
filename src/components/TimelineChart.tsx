'use client';

import type { Observation } from '@/lib/types';

const STATUS_COLORS: Record<string, string> = {
  ACCUMULATING: '#818cf8',
  SPIKE_REJECTED: '#fb7185',
  TRIGGERED_ACTING: '#34d399',
  COOLDOWN: '#fbbf24',
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? '#64748b';
}

/** Hand-rolled SVG timeline: value line + per-observation status markers. */
export default function TimelineChart({ observations }: { observations: Observation[] }) {
  const W = 860;
  const H = 280;
  const PAD_X = 46;
  const PAD_TOP = 26;
  const PAD_BOTTOM = 44;

  if (observations.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center text-sm text-slate-500">
        No observations yet — run a check or a scenario to populate the timeline.
      </div>
    );
  }

  const values = observations.map((o) => o.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.max(Math.abs(rawMax) * 0.1, 1);
  const min = rawMin - span * 0.12;
  const max = rawMax + span * 0.12;

  const x = (i: number): number =>
    observations.length === 1 ? W / 2 : PAD_X + (i * (W - 2 * PAD_X)) / (observations.length - 1);
  const y = (v: number): number => PAD_TOP + ((max - v) * (H - PAD_TOP - PAD_BOTTOM)) / (max - min);

  const points = observations.map((o, i) => `${x(i).toFixed(1)},${y(o.value).toFixed(1)}`).join(' ');

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Observation timeline">
        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const gy = PAD_TOP + f * (H - PAD_TOP - PAD_BOTTOM);
          const val = max - f * (max - min);
          return (
            <g key={f}>
              <line x1={PAD_X} y1={gy} x2={W - 12} y2={gy} stroke="#1e293b" strokeWidth={1} strokeDasharray="3 5" />
              <text x={8} y={gy + 4} fill="#64748b" fontSize={11} className="mono">
                {val >= 1000 ? val.toFixed(0) : val.toPrecision(5)}
              </text>
            </g>
          );
        })}

        <polyline points={points} fill="none" stroke="#5eead4" strokeWidth={2} strokeLinejoin="round" />

        {observations.map((o, i) => {
          const cx = x(i);
          const cy = y(o.value);
          const color = statusColor(o.ruleStatus);
          return (
            <g key={o.observationId}>
              {o.isOutlier && <circle cx={cx} cy={cy} r={9} fill="none" stroke="#fb7185" strokeDasharray="2 3" strokeWidth={1.5} />}
              <circle cx={cx} cy={cy} r={5.5} fill={color} stroke="#05070d" strokeWidth={1.5}>
                <title>{`#${o.index} · ${o.value} · ${o.ruleStatus} · streak ${o.streakCount} · block ${o.blockNumber} · pid ${o.runProcessPid}${o.isOutlier ? ' · OUTLIER' : ''}`}</title>
              </circle>
              <text x={cx} y={H - 24} textAnchor="middle" fill="#475569" fontSize={10} className="mono">
                #{o.index}
              </text>
              <text x={cx} y={H - 10} textAnchor="middle" fill={color} fontSize={9} className="mono">
                s{o.streakCount}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
        {Object.entries(STATUS_COLORS).map(([status, color]) => (
          <span key={status} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            {status}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-dashed border-rose-400" />
          MAD outlier (spike-suspect)
        </span>
        <span className="ml-auto text-slate-500">sN = streak after the check</span>
      </div>
    </div>
  );
}
