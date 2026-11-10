import { NextResponse } from 'next/server';
import { canonicalTimestampBucket, computeObservationId } from '@/lib/observation';
import { BadRequestError } from '@/lib/api-errors';
import { RuleValidationError } from '@/lib/rules';
import { StoreIntegrityError } from '@/lib/storage';
import {
  fetchLiveBlock,
  readLiveMetric,
  serverActionExecutor,
  serverStore,
  withLock,
  type MetricSelector,
} from '@/lib/server-store';
import type { RunCheckResult } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RunBody {
  value?: number;
  metric?: MetricSelector;
  replayLast?: boolean;
  liveAction?: boolean;
  watcher?: string;
  /** Deterministic overrides (tests / replay tooling) — used only when provided. */
  timestamp?: number;
  blockNumber?: number;
}

/**
 * POST /api/run — one observation cycle. Persists to disk, evaluates the rule,
 * and (when the rule fires and liveAction is not false) executes the real
 * protective action on Pharos Atlantic Testnet.
 */
export async function POST(request: Request) {
  let body: RunBody = {};
  try {
    body = (await request.json()) as RunBody;
  } catch {
    body = {};
  }
  const watcherId = body.watcher ?? 'default';
  const store = serverStore(watcherId);

  try {
    const result = await withLock(`run:${watcherId}`, async (): Promise<RunCheckResult> => {
      if (body.replayLast) {
        const state = store.ensureRecovered();
        const last = state.observations[state.observations.length - 1];
        if (!last) throw new Error('nothing to replay: watcher history is empty');
        return store.runCheck({
          value: last.value,
          metricSource: last.metricSource,
          blockNumber: last.blockNumber, // same block + same canonical bucket → same idempotency id
          timestamp: last.timestamp,
          actionExecutor: null, // replays never re-execute actions
        });
      }

      const metric: MetricSelector = body.metric ?? (body.value !== undefined ? 'synthetic' : 'live');
      let value: number;
      let metricSource: string;
      let blockNumber: number | null = null;
      let timestamp: number | undefined = body.timestamp;

      if (metric === 'synthetic') {
        if (body.value === undefined || !Number.isFinite(Number(body.value))) {
          throw new BadRequestError('synthetic observation requires a finite numeric "value"');
        }
        value = Number(body.value);
        metricSource = 'synthetic_scenario';
        blockNumber = body.blockNumber ?? (await fetchLiveBlock());
        // Scenario sequences run checks seconds apart; if the live block (and
        // bucket) is unchanged the idempotency id would collide. Bump the
        // synthetic block anchor until the id is fresh so every scenario step
        // appends (live-metric runs keep the pure dedup semantics).
        const state = store.ensureRecovered();
        const bucket = canonicalTimestampBucket(timestamp ?? Date.now(), 60);
        let candidate = blockNumber ?? 0;
        for (let bump = 0; bump < 16; bump++) {
          const id = computeObservationId({
            watcherId: state.watcherId,
            blockNumber: candidate,
            metricSource,
            timestampBucket: bucket,
          });
          if (!state.observations.some((o) => o.observationId === id)) break;
          candidate += 1;
        }
        blockNumber = candidate;
      } else {
        const live = await readLiveMetric(metric);
        value = live.value;
        metricSource = live.metricSource;
        blockNumber = live.blockNumber;
      }

      return store.runCheck({
        value,
        metricSource,
        blockNumber: blockNumber ?? 0,
        timestamp,
        actionExecutor: body.liveAction === false ? null : serverActionExecutor(store.paths.dataDir),
      });
    });

    return NextResponse.json({
      ok: true,
      deduplicated: result.deduplicated,
      duplicatesIgnoredTotal: result.duplicatesIgnoredTotal,
      walRecovered: result.walRecovered,
      observation: result.observation,
      triggered: result.triggered,
      reason: result.reason,
      action: result.action,
      triggerRecord: result.triggerRecord,
      pid: result.pid,
      state: result.state,
    });
  } catch (err) {
    if (err instanceof BadRequestError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    if (err instanceof RuleValidationError) {
      return NextResponse.json({ ok: false, error: err.message, problems: err.problems }, { status: 400 });
    }
    if (err instanceof StoreIntegrityError) {
      return NextResponse.json(
        { ok: false, error: err.message, tamperIndex: err.tamperIndex },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
