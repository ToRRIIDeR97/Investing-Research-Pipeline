import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossCheckStatus } from '../src/lib/research/history/market-history';

test('market history cross-check status carries the price sync outcome', () => {
  assert.deepEqual(crossCheckStatus(null).status, 'unknown');
  assert.deepEqual(crossCheckStatus({ status: 'synced', provider: 'yahoo', provider_symbol: 'X',
    cross_check: { provider: 'stooq', status: 'unavailable', reason: 'Stooq HTTP 403', verified: 0, mismatch: 0, unverified: 5 } }),
  { status: 'unavailable', reason: 'Stooq HTTP 403' });
  assert.deepEqual(crossCheckStatus({ status: 'synced', provider: 'yahoo', provider_symbol: 'X',
    cross_check: { provider: 'stooq', status: 'checked', verified: 5, mismatch: 0, unverified: 0 } }), { status: 'checked' });
  assert.deepEqual(crossCheckStatus({ status: 'failed', provider: 'yahoo', provider_symbol: 'X', error: 'timeout' }),
    { status: 'unavailable', reason: 'Price sync failed: timeout' });
});

test('the price sync summary is read from an accepted source review', { skip: process.env.RUN_DB_INTEGRATION !== '1' }, async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  if (!process.env.DATABASE_URL && existsSync('.env.local')) {
    const line = readFileSync('.env.local', 'utf8').split(/\r?\n/).find(l => l.startsWith('DATABASE_URL='));
    if (line) process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim().replace(/^['"]|['"]$/g, '');
  }
  const { default: postgres } = await import('postgres');
  const { latestPriceHistorySync } = await import('../src/lib/research/history/market-history');
  const sql = postgres(process.env.DATABASE_URL!);
  const assetId = crypto.randomUUID(), runId = crypto.randomUUID();
  const sync = (status: string) => ({ status: 'synced', provider: 'yahoo', provider_symbol: 'X',
    cross_check: { provider: 'stooq', status, verified: 5, mismatch: 0, unverified: 0 } });
  try {
    await sql`INSERT INTO assets (id, canonical_name, slug, asset_kind) VALUES (${assetId}, 'Sync Read Co', ${`sync-${assetId.slice(0, 8)}`}, 'equity')`;
    await sql`INSERT INTO research_runs (id, asset_id, run_type, status, pipeline_version) VALUES (${runId}, ${assetId}, 'deep_dive', 'running', 3)`;
    const review = (version: number, status: string, content: unknown) => sql`INSERT INTO research_artifacts
      (research_run_id, asset_id, artifact_type, scope_key, artifact_version, status, content_json, created_by)
      VALUES (${runId}, ${assetId}, 'source_review', 'run', ${version}, ${status}, ${sql.json(content as any)}, 'test')`;
    await review(1, 'validated', { price_history_sync: sync('unavailable') });
    await review(2, 'accepted', { price_history_sync: sync('checked') });
    await review(3, 'draft', { price_history_sync: sync('unavailable') });
    assert.deepEqual(crossCheckStatus(await latestPriceHistorySync(sql, runId)), { status: 'checked' });
  } finally {
    await sql`DELETE FROM research_artifacts WHERE research_run_id = ${runId}`;
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
    await sql`DELETE FROM assets WHERE id = ${assetId}`;
    await sql.end();
  }
});
