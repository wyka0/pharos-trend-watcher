import { NextResponse } from 'next/server';
import { RuleValidationError, validateRule } from '@/lib/rules';
import { StoreIntegrityError } from '@/lib/storage';
import { serverStore, withLock } from '@/lib/server-store';
import type { TrendRule } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConfigBody {
  rule?: Partial<TrendRule>;
  watcher?: string;
}

/** POST /api/config — update the persisted trend rule (validated: requiredObservations >= 3). */
export async function POST(request: Request) {
  let body: ConfigBody = {};
  try {
    body = (await request.json()) as ConfigBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  if (!body.rule || typeof body.rule !== 'object') {
    return NextResponse.json({ ok: false, error: 'body.rule is required' }, { status: 400 });
  }
  const watcherId = body.watcher ?? 'default';
  const store = serverStore(watcherId);

  try {
    const state = await withLock(`config:${watcherId}`, async () => {
      const current = store.loadCommittedState().state;
      const merged: TrendRule = { ...(current?.rule ?? store.defaultRule), ...body.rule } as TrendRule;
      validateRule(merged); // throws RuleValidationError when requiredObservations < 3
      return store.updateRule(merged);
    });
    return NextResponse.json({ ok: true, rule: state.rule });
  } catch (err) {
    if (err instanceof RuleValidationError) {
      return NextResponse.json({ ok: false, error: err.message, problems: err.problems }, { status: 400 });
    }
    if (err instanceof StoreIntegrityError) {
      return NextResponse.json({ ok: false, error: err.message, tamperIndex: err.tamperIndex }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** GET /api/config — current persisted rule. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const watcherId = url.searchParams.get('watcher') ?? 'default';
    const store = serverStore(watcherId);
    const loaded = store.loadCommittedState();
    return NextResponse.json({ ok: true, rule: loaded.state?.rule ?? null });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
