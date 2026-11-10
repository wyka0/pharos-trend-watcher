import { NextResponse } from 'next/server';
import { serverStore, withLock } from '@/lib/server-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/state — full disk-backed watcher snapshot (timeline, rule, files, WAL tail). */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const watcherId = url.searchParams.get('watcher') ?? 'default';
    const store = serverStore(watcherId);
    const snapshot = await withLock(`snapshot:${watcherId}`, async () => store.snapshot());
    return NextResponse.json({ ok: true, watcherId, ...snapshot });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
