'use client';

import { useState } from 'react';
import type { WalEntry } from '@/lib/storage';
import type { WatcherState } from '@/lib/types';

interface FilesInfo {
  stateFile: string;
  walFile: string;
  stateBytes: number | null;
  walBytes: number | null;
  walLines: number;
}

interface Props {
  state: WatcherState | null;
  files: FilesInfo;
  integrity: { integrity: string; tamperIndex: number | null; reason: string | null };
  walTail: WalEntry[];
}

/** Stored Disk State Inspector — raw persisted state + WAL tail + integrity. */
export default function StateInspector({ state, files, integrity, walTail }: Props) {
  const [open, setOpen] = useState(false);

  const integrityColor =
    integrity.integrity === 'OK'
      ? 'text-emerald-300 border-emerald-800 bg-emerald-950/40'
      : integrity.integrity === 'TAMPERED'
        ? 'text-rose-300 border-rose-800 bg-rose-950/40'
        : 'text-slate-400 border-slate-700 bg-slate-900/60';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
        <div className="mono rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-slate-400">
          <div>state: <span className="text-slate-300">{files.stateFile}</span></div>
          <div>wal: <span className="text-slate-300">{files.walFile}</span></div>
        </div>
        <div className="mono flex flex-col justify-center gap-1 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-slate-400">
          <span>
            state file: <span className="text-slate-300">{files.stateBytes !== null ? `${files.stateBytes.toLocaleString()} B` : 'missing'}</span>
            {' · '}wal: <span className="text-slate-300">{files.walBytes !== null ? `${files.walBytes.toLocaleString()} B / ${files.walLines} lines` : 'missing'}</span>
          </span>
          <span>
            hash-chain:{' '}
            <span className={`badge border ${integrityColor}`}>
              {integrity.integrity}
              {integrity.tamperIndex !== null ? ` @idx ${integrity.tamperIndex}` : ''}
            </span>
          </span>
        </div>
      </div>

      <button className="text-xs text-indigo-300 underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
        {open ? '▾ hide raw watcher-state.json' : '▸ show raw watcher-state.json'}
      </button>
      {open && (
        <pre className="mono max-h-96 overflow-auto rounded-md border border-slate-800 bg-slate-950/80 p-3 text-[11px] leading-relaxed text-slate-300">
          {state ? JSON.stringify(state, null, 2) : '// no state on disk yet'}
        </pre>
      )}

      {walTail.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-slate-500">WAL tail (append-only observations.wal.jsonl, last {walTail.length}):</p>
          <pre className="mono max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950/80 p-3 text-[11px] text-slate-400">
            {walTail
              .map((e) =>
                e.type === 'OBSERVATION'
                  ? `OBSERVATION      idx=${String(e.observation.index).padStart(3)} value=${e.observation.value} ${e.observation.ruleStatus} id=${e.observation.observationId.slice(0, 18)}…`
                  : `DUPLICATE_IGNORED id=${e.observationId.slice(0, 26)}…`,
              )
              .join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
}
