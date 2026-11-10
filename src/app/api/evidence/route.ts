import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/evidence — the auto-generated live verification evidence (if present). */
export async function GET() {
  const evidenceFile = path.join(process.cwd(), 'evidence', 'trend-run-evidence.json');
  if (!fs.existsSync(evidenceFile)) {
    return NextResponse.json(
      { ok: false, error: 'evidence not generated yet — run `npm run watcher:verify`' },
      { status: 404 },
    );
  }
  try {
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    return NextResponse.json({ ok: true, evidence });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
