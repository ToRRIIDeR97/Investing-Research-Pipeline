import assert from 'node:assert/strict';
import test from 'node:test';
import { projectionSharesInMillions, projectionShareUnitErrors } from '../src/lib/research/valuation/share-denominator';

test('valuation projections reject ambiguous or contradictory share units before per-share scaling', () => {
  const errors = (balance_sheet_values: Record<string, number>) => projectionShareUnitErrors([{ balance_sheet_values }]);
  assert.ok(errors({ diluted_shares: 1351.99 }).length);
  assert.ok(errors({ diluted_shares_millions: 1351.99, diluted_shares: 1351.99 }).length);
  assert.ok(errors({ diluted_shares_millions: 1351.99, shares_outstanding_millions: 1.35199 }).length);
  assert.ok(errors({ diluted_shares_millions: 0 }).length);
  const valid = { diluted_shares_millions: 1351.99, diluted_shares: 1351990000 };
  assert.deepEqual(errors(valid), []);
  assert.equal(projectionSharesInMillions(valid, 1351.99), 1351.99);
  assert.deepEqual(errors({ diluted_shares_millions: 1500 }), []);
});
