import assert from 'node:assert/strict';
import test from 'node:test';
import { metricObservationRows, recentFredObservations } from '../src/lib/research/sources/corpus';

test('normalizer wrappers never become synthetic unnamed metric observations', () => {
  const zero = { metric_key: 'net_income', value_numeric: 0 };
  const loss = { metric_key: 'net_income', value_numeric: -12 };
  assert.deepEqual(metricObservationRows([{ artifact_type: 'normalized_observations', observations: [] }]), []);
  assert.deepEqual(metricObservationRows({ observations: [zero, loss] }), [zero, loss]);
  assert.deepEqual(metricObservationRows([{ observations: [zero, loss] }]), [zero, loss]);
  assert.deepEqual(metricObservationRows([zero, {}, { metric_key: '' }, loss]), [zero, loss]);
  assert.deepEqual(metricObservationRows(undefined), []);
});

test('FRED macro source keeps the latest observations up to the cutoff, not the 1962 start of the series', () => {
  const csv = 'observation_date,DGS10\n1962-01-02,4.06\n2026-10-05,4.10\n2026-10-06,4.12\n2026-10-07,4.15\n';
  assert.equal(recentFredObservations(csv, '2026-10-06', 2), 'observation_date,DGS10\n2026-10-05,4.10\n2026-10-06,4.12');
});
