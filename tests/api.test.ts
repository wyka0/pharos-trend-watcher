/**
 * Next.js API route tests (node runtime): /api/state, /api/run, /api/config,
 * /api/reset, /api/evidence — exercised with real Request objects against an
 * isolated WATCHER_DATA_DIR.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkTempRoot } from './helpers';
import { makeRule } from './helpers';
import { PersistentTrendStore } from '@/lib/storage';
import type { TrendRule } from '@/lib/types';

let root: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  root = mkTempRoot('api');
  originalDataDir = process.env.WATCHER_DATA_DIR;
  process.env.WATCHER_DATA_DIR = root;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.WATCHER_DATA_DIR;
  else process.env.WATCHER_DATA_DIR = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runRoute(): Promise<typeof import('@/app/api/run/route')> {
  return import('@/app/api/run/route');
}

describe('GET /api/state', () => {
  it('empty dir → ok with state=null and integrity MISSING', async () => {
    const mod = await import('@/app/api/state/route');
    const res = await mod.GET(new Request('http://localhost/api/state'));
    const body = (await res.json()) as { ok: boolean; state: null; integrity: { integrity: string } };
    expect(body.ok).toBe(true);
    expect(body.state).toBeNull();
    expect(body.integrity.integrity).toBe('MISSING');
  });

  it('after runs → full snapshot with observations, files, WAL tail', async () => {
    const run = await runRoute();
    await run.POST(jsonRequest('/api/run', { value: 100 }));
    await run.POST(jsonRequest('/api/run', { value: 95 }));
    const mod = await import('@/app/api/state/route');
    const res = await mod.GET(new Request('http://localhost/api/state'));
    const body = (await res.json()) as {
      ok: boolean;
      state: { observations: unknown[]; duplicatesIgnored: number } | null;
      integrity: { integrity: string };
      files: { stateFile: string; walLines: number };
      walTail: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.state?.observations).toHaveLength(2);
    expect(body.integrity.integrity).toBe('OK');
    expect(body.files.stateFile).toContain('watcher-state.json');
    expect(body.files.walLines).toBe(2);
    expect(body.walTail.length).toBe(2);
  });
});

describe('POST /api/run', () => {
  it('synthetic observation is stored with an index', async () => {
    const run = await runRoute();
    const res = await run.POST(jsonRequest('/api/run', { value: 100 }));
    const body = (await res.json()) as { ok: boolean; observation: { index: number; value: number } | null };
    expect(body.ok).toBe(true);
    expect(body.observation?.index).toBe(1);
    expect(body.observation?.value).toBe(100);
  });

  it('single-spike sequence → SPIKE_REJECTED with no trigger', async () => {
    const run = await runRoute();
    await run.POST(jsonRequest('/api/run', { value: 100 }));
    await run.POST(jsonRequest('/api/run', { value: 75 }));
    const res = await run.POST(jsonRequest('/api/run', { value: 99 }));
    const body = (await res.json()) as {
      triggered: boolean;
      observation: { ruleStatus: string; streakCount: number; isOutlier: boolean } | null;
    };
    expect(body.triggered).toBe(false);
    expect(body.observation?.ruleStatus).toBe('SPIKE_REJECTED');
    expect(body.observation?.streakCount).toBe(0);
  });

  it('trend sequence with liveAction=false → triggered, txHash null, dry-run note', async () => {
    const run = await runRoute();
    for (const v of [100, 95, 91]) await run.POST(jsonRequest('/api/run', { value: v, liveAction: false }));
    const res = await run.POST(jsonRequest('/api/run', { value: 86, liveAction: false }));
    const body = (await res.json()) as {
      triggered: boolean;
      triggerRecord: { txHash: string | null; actionError: string | null } | null;
    };
    expect(body.triggered).toBe(true);
    expect(body.triggerRecord?.txHash).toBeNull();
    expect(body.triggerRecord?.actionError).toContain('dry run');
  });

  it('replayLast → deduplicated with history intact', async () => {
    const run = await runRoute();
    await run.POST(jsonRequest('/api/run', { value: 100 }));
    await run.POST(jsonRequest('/api/run', { value: 95 }));
    const res = await run.POST(jsonRequest('/api/run', { replayLast: true }));
    const body = (await res.json()) as { deduplicated: boolean; duplicatesIgnoredTotal: number; state: { observations: unknown[] } };
    expect(body.deduplicated).toBe(true);
    expect(body.duplicatesIgnoredTotal).toBe(1);
    expect(body.state.observations).toHaveLength(2);
  });

  it('non-finite synthetic value → 400', async () => {
    const run = await runRoute();
    const res = await run.POST(jsonRequest('/api/run', { value: 'not-a-number' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('finite');
  });

  it('tampered history → 409 StoreIntegrityError mapping', async () => {
    const run = await runRoute();
    await run.POST(jsonRequest('/api/run', { value: 100 }));
    const stateFile = `${root}/watcher-state.json`;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { observations: Array<{ value: number }> };
    state.observations[0]!.value = 42.42;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const res = await run.POST(jsonRequest('/api/run', { value: 95 }));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/config', () => {
  it('rejects requiredObservations = 2 with the problems list', async () => {
    const mod = await import('@/app/api/config/route');
    const res = await mod.POST(jsonRequest('/api/config', { rule: { requiredObservations: 2 } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; problems: string[] };
    expect(body.ok).toBe(false);
    expect(body.problems.join(' ')).toContain('>= 3');
  });

  it('accepts requiredObservations = 5 and persists it', async () => {
    const mod = await import('@/app/api/config/route');
    const res = await mod.POST(jsonRequest('/api/config', { rule: { requiredObservations: 5 } }));
    const body = (await res.json()) as { ok: boolean; rule: TrendRule };
    expect(body.ok).toBe(true);
    expect(body.rule.requiredObservations).toBe(5);
    const get = await mod.GET(new Request('http://localhost/api/config'));
    const getBody = (await get.json()) as { rule: TrendRule | null };
    expect(getBody.rule?.requiredObservations).toBe(5);
  });

  it('rejects invalid JSON body', async () => {
    const mod = await import('@/app/api/config/route');
    const res = await mod.POST(new Request('http://localhost/api/config', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing rule object', async () => {
    const mod = await import('@/app/api/config/route');
    const res = await mod.POST(jsonRequest('/api/config', {}));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/reset', () => {
  it('archives + wipes history', async () => {
    const run = await runRoute();
    await run.POST(jsonRequest('/api/run', { value: 100 }));
    const mod = await import('@/app/api/reset/route');
    const res = await mod.POST(jsonRequest('/api/reset', {}));
    const body = (await res.json()) as { ok: boolean; state: { observations: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.state.observations).toHaveLength(0);
    const archiveDir = `${root}/archive`;
    expect(fs.existsSync(archiveDir)).toBe(true);
  });

  it('reset with a custom rule persists it', async () => {
    const mod = await import('@/app/api/reset/route');
    const res = await mod.POST(jsonRequest('/api/reset', { rule: makeRule({ requiredObservations: 4 }) }));
    const body = (await res.json()) as { ok: boolean; state: { rule: { requiredObservations: number } } };
    expect(body.ok).toBe(true);
    expect(body.state.rule.requiredObservations).toBe(4);
  });

  it('invalid rule in reset body → 400', async () => {
    const mod = await import('@/app/api/reset/route');
    const res = await mod.POST(jsonRequest('/api/reset', { rule: makeRule({ requiredObservations: 1 }) }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/evidence', () => {
  it('404 before evidence generation', async () => {
    const evidencePath = `${process.cwd()}/evidence/trend-run-evidence.json`;
    const exists = fs.existsSync(evidencePath);
    if (exists) return; // evidence already generated in this checkout — 404 path not testable
    const mod = await import('@/app/api/evidence/route');
    const res = await mod.GET();
    expect(res.status).toBe(404);
  });

  it('200 with parsed evidence when the file exists', async () => {
    const evidencePath = `${process.cwd()}/evidence/trend-run-evidence.json`;
    const existed = fs.existsSync(evidencePath);
    if (!existed) {
      fs.mkdirSync(`${process.cwd()}/evidence`, { recursive: true });
      fs.writeFileSync(evidencePath, JSON.stringify({ phases: 'sample' }));
    }
    try {
      const mod = await import('@/app/api/evidence/route');
      const res = await mod.GET();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; evidence: unknown };
      expect(body.ok).toBe(true);
      expect(body.evidence).toBeTruthy();
    } finally {
      if (!existed) fs.rmSync(evidencePath, { force: true });
    }
  });
});
