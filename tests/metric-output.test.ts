import assert from 'node:assert/strict';
import test from 'node:test';
import { metricObservationRows } from '../src/lib/research/sources/corpus';

test('normalizer wrappers never become synthetic unnamed metric observations', () => {
  const zero = { metric_key: 'net_income', value_numeric: 0 };
  const loss = { metric_key: 'net_income', value_numeric: -12 };
  assert.deepEqual(metricObservationRows([{ artifact_type: 'normalized_observations', observations: [] }]), []);
  assert.deepEqual(metricObservationRows({ observations: [zero, loss] }), [zero, loss]);
  assert.deepEqual(metricObservationRows([{ observations: [zero, loss] }]), [zero, loss]);
  assert.deepEqual(metricObservationRows([zero, {}, { metric_key: '' }, loss]), [zero, loss]);
  assert.deepEqual(metricObservationRows(undefined), []);
});
