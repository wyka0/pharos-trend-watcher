import { NextResponse } from 'next/server';
import { RuleValidationError, defaultTrendRule } from '@/lib/rules';
import { serverStore, withLock } from '@/lib/server-store';
import type { TrendRule } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResetBody {
  rule?: TrendRule;
  watcher?: string;
}

/**
 * POST /api/reset — archive the current state + WAL to .data/archive/ and
 * start a fresh watcher. Prior history remains inspectable in the archive.
 */
export async function POST(request: Request) {
  let body: ResetBody = {};
  try {
    body = (await request.json()) as ResetBody;
  } catch {
    body = {};
  }
  const watcherId = body.watcher ?? 'default';
  const store = serverStore(watcherId);

  try {
    const state = await withLock(`reset:${watcherId}`, async () => store.reset(body.rule ?? defaultTrendRule()));
    return NextResponse.json({ ok: true, state });
  } catch (err) {
    if (err instanceof RuleValidationError) {
      return NextResponse.json({ ok: false, error: err.message, problems: err.problems }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
