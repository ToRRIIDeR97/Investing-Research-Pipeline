import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseArtifactVersions, type ArtifactMeta } from '../src/lib/research/reporting/report-pins';

const usable = (status: string) => status === 'validated' || status === 'accepted';
const meta = (artifact_type: string, id: string, artifact_version: number, status: string, created_at: string): ArtifactMeta => ({ artifact_type, id, artifact_version, status, created_at });

// SoFi run 9cd97f72 in the preview database: the report was built on valuation v1 (18 Nov); a re-valuation stored
// v2 (21 Nov) afterwards. The workbench showed v2 while the report showed v1.
const sofi = [
  meta('valuation_scenario_set', 'vss-v1', 1, 'validated', '2026-11-18T11:36:00Z'),
  meta('valuation_scenario_set', 'vss-v2', 2, 'validated', '2026-11-21T16:49:00Z'),
  meta('operating_scenario_set', 'oss-v1', 1, 'validated', '2026-11-18T11:00:00Z'),
  meta('financial_analytics', 'fa-v1', 1, 'validated', '2026-11-18T10:00:00Z'),
];

test('a run with a report reads the valuation the report was built from and flags the newer one', () => {
  const out = chooseArtifactVersions(sofi, { valuation_scenario_set: 'vss-v1', operating_scenario_set: 'oss-v1' }, usable);
  assert.equal(out.chosen.valuation_scenario_set, 'vss-v1');
  assert.equal(out.pinned.valuation_scenario_set, true);
  assert.deepEqual(out.newer.valuation_scenario_set, { artifact_type: 'valuation_scenario_set', id: 'vss-v2', artifact_version: 2, created_at: '2026-11-21T16:49:00.000Z' });
  assert.equal(out.newer.operating_scenario_set, undefined);
  // Types the report did not record fall back to their latest usable version.
  assert.equal(out.chosen.financial_analytics, 'fa-v1');
  assert.equal(out.pinned.financial_analytics, false);
});

test('without a report, the latest usable version is read and nothing is flagged', () => {
  const out = chooseArtifactVersions(sofi, {}, usable);
  assert.equal(out.chosen.valuation_scenario_set, 'vss-v2');
  assert.equal(out.pinned.valuation_scenario_set, false);
  assert.deepEqual(out.newer, {});
});

test('the pinned version is read even after it was superseded, and unusable newer versions are not flagged', () => {
  const rows = [
    meta('valuation_scenario_set', 'v1', 1, 'superseded', '2026-11-18T00:00:00Z'),
    meta('valuation_scenario_set', 'v2', 2, 'needs_more_work', '2026-11-19T00:00:00Z'),
  ];
  const out = chooseArtifactVersions(rows, { valuation_scenario_set: 'v1' }, usable);
  assert.equal(out.chosen.valuation_scenario_set, 'v1');
  assert.deepEqual(out.newer, {});
});

test('a pin to a version that is no longer stored falls back to the latest usable one', () => {
  const out = chooseArtifactVersions(sofi, { valuation_scenario_set: 'deleted' }, usable);
  assert.equal(out.chosen.valuation_scenario_set, 'vss-v2');
  assert.equal(out.pinned.valuation_scenario_set, false);
});

test('an older version stored with a higher created_at is not mistaken for a newer valuation', () => {
  const rows = [
    meta('valuation_scenario_set', 'v2', 2, 'validated', '2026-11-18T00:00:00Z'),
    meta('valuation_scenario_set', 'v1', 1, 'validated', '2026-11-20T00:00:00Z'),
  ];
  const out = chooseArtifactVersions(rows, { valuation_scenario_set: 'v2' }, usable);
  assert.equal(out.chosen.valuation_scenario_set, 'v2');
  assert.deepEqual(out.newer, {});
});
