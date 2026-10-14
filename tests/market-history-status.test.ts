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
