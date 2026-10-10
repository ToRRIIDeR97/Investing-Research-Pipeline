import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHeadcount, filingPlainText, headcountObservations } from '../src/lib/research/history/headcount';
import { HistoricalObservation } from '../src/lib/research/history/contracts';
import { buildTTMSeries } from '../src/lib/research/history/diagnostics';

const fromHtml = (html: string) => extractHeadcount(filingPlainText(html));
const one = (html: string) => { const found = fromHtml(html); assert.equal(found.length, 1, JSON.stringify(found)); return found[0]; };

test('META quarterly phrasing with and without &#160;', () => {
  const plain = one('<p>• Headcount was 75,472 as of June 30, 2026, a decrease of 1% year-over-year.</p>');
  assert.deepEqual([plain.value, plain.as_of, plain.approximate], [75472, '2026-06-30', false]);
  assert.match(plain.evidence, /^• Headcount was 75,472 as of June 30, 2026/);
  const nbsp = one('<div><span>Headcount was 75,472 as of June&#160;30, 2026, a decrease of 1% year-over-year.</span></div>');
  assert.deepEqual([nbsp.value, nbsp.as_of], [75472, '2026-06-30']);
  assert.equal(nbsp.evidence, 'Headcount was 75,472 as of June 30, 2026, a decrease of 1% year-over-year.');
});

test('earnings-release bullet label and the following restructuring sentence', () => {
  const found = one('<tr><td>•</td><td>Headcount &#8211; Headcount was 75,472 as of June&#160;30, 2026, a decrease of 1% year-over-year. Our reported headcount includes approximately 8,000 employees impacted by the May 2026 headcount reduction, the majority of whom will no longer be reflected in our headcount.</td></tr>');
  assert.deepEqual([found.value, found.as_of], [75472, '2026-06-30']);
});

test('annual 10-K Human Capital phrasing', () => {
  const approx = one('<p>Human Capital</p><p>As of December&#160;31, 2025, we had approximately 78,000 full-time employees.</p>');
  assert.deepEqual([approx.value, approx.as_of, approx.approximate], [78000, '2025-12-31', true]);
  const workforce = one('<p>We had a global workforce of 78,865 employees as of December 31, 2025, and we have offices in more than 90 cities around the world.</p>');
  assert.deepEqual([workforce.value, workforce.as_of, workforce.approximate], [78865, '2025-12-31', false]);
  const breakdown = one('<p>As of December 31, 2024, we employed approximately 5,000 employees, of which approximately 76% were located in the United States and 24% were located internationally.</p>');
  assert.deepEqual([breakdown.value, breakdown.approximate], [5000, true]);
  assert.equal(one('<p>Headcount as of 31 March 2026 was about 1,200.</p>').as_of, '2026-03-31');
});

test('employee table by country uses only its Total row', () => {
  const html = '<p>The following table shows the number of our employees by country as of December 31, 2025:</p><table><tr><td>Country</td><td>Number of Employees</td></tr><tr><td>Brazil</td><td>61,139</td></tr><tr><td>Mexico</td><td>34,336</td></tr><tr><td>Total</td><td>123,670</td></tr></table>';
  const found = one(html);
  assert.deepEqual([found.value, found.as_of], [123670, '2025-12-31']);
  assert.match(found.evidence, /Total 123,670$/);
});

test('rejects forward-looking, subset, contractor, segment and undated counts', () => {
  for (const html of [
    '<p>We expect to add 12,000 employees by December 31, 2026.</p>',
    '<p>On December 31, 2022, we had 13,856 employees on our information technology and product development staff, an increase from 9,471 employees on December 31, 2021.</p>',
    '<p>As of December 31, 2025, we had approximately 10,000 employees and independent contractors.</p>',
    '<p>As of December 31, 2025, we had 10,000 employees, including contractors.</p>',
    '<p>As of December 31, 2025, excluding contractors, we had 9,000 employees.</p>',
    '<p>As of December 31, 2025, our Reality Labs segment had 17,000 employees.</p>',
    '<p>Reality Labs headcount was 17,000 as of December 31, 2025.</p>',
    '<p>In our payments segment, as of December 31, 2025, we had 4,000 employees.</p>',
    '<p>As of December 31, 2025, we had 3,000 employees in the United States.</p>',
    '<p>As of December 31, 2025, we had over 80,000 employees.</p>',
    '<p>We had approximately 78,000 full-time employees.</p>',
    '<p>Our reported headcount includes approximately 8,000 employees impacted by the May 2026 headcount reduction.</p>',
    '<p>We will have 90,000 employees as of December 31, 2027.</p>',
    '<p>The plan covers 4,200 employees, 12 directors and approximately 20 independent contractors.</p>',
    '<p>Headcount was 75,472 as of June 31, 2026.</p>',
  ]) assert.deepEqual(fromHtml(html), [], html);
});

test('conflicting counts for one date are dropped; distinct dates are kept', () => {
  assert.deepEqual(fromHtml('<p>Headcount was 75,472 as of June 30, 2026.</p><p>Headcount was 75,900 as of June 30, 2026.</p>'), []);
  const both = fromHtml('<p>Headcount was 75,472 as of June 30, 2026.</p><p>Headcount was 70,799 as of June 30, 2024.</p>');
  assert.deepEqual(both.map(f => [f.as_of, f.value]), [['2024-06-30', 70799], ['2026-06-30', 75472]]);
});

test('headcount observations follow the fiscal calendar and prefer the latest periodic filing', () => {
  const finding = (value: number, as_of: string) => ({ value, as_of, approximate: false, evidence: `Headcount was ${value} as of ${as_of}.`, offset: 10 });
  const source = (id: string, form: string, published_at: string) => ({ id: `00000000-0000-4000-8000-00000000000${id}`, url: `https://www.sec.gov/${id}`, form, published_at });
  const { observations, unplaced } = headcountObservations([
    { source: source('1', '8-K', '2026-07-29'), findings: [finding(75472, '2026-06-30')] },
    { source: source('2', '10-Q', '2026-07-30'), findings: [finding(75472, '2026-06-30')] },
    { source: source('3', '10-K', '2026-01-29'), findings: [finding(78865, '2025-12-31'), finding(74067, '2024-12-31')] },
    { source: source('4', '8-K', '2026-01-28'), findings: [finding(78000, '2026-02-15')] },
  ], [{ end: '2026-06-30', fiscal_year: 2026, fiscal_quarter: 2 }, { end: '2025-12-31', fiscal_year: 2025, fiscal_quarter: 4 }]);
  const rows = observations.map(o => HistoricalObservation.parse(o));
  assert.deepEqual(rows.map(o => [o.period_end, o.periodicity, o.fiscal_year, o.fiscal_quarter, o.value_numeric]), [
    ['2024-12-31', 'quarterly', 2024, 4, 74067], ['2024-12-31', 'annual', 2024, null, 74067],
    ['2025-12-31', 'quarterly', 2025, 4, 78865], ['2025-12-31', 'annual', 2025, null, 78865],
    ['2026-06-30', 'quarterly', 2026, 2, 75472],
  ]);
  const june = rows.at(-1)!;
  assert.equal(june.source_document_id, '00000000-0000-4000-8000-000000000002');
  assert.equal(june.unit, 'persons');
  assert.equal(june.available_at, '2026-07-30');
  assert.equal(june.metadata_json.evidence, 'Headcount was 75472 as of 2026-06-30.');
  assert.equal(june.metadata_json.source_locator, 'text-offset:10');
  assert.equal(june.metadata_json.period_type, 'instant');
  assert.deepEqual(unplaced.map(u => u.as_of), ['2026-02-15']);
  // Headcount is a stock: no trailing-twelve-month sum.
  assert.deepEqual(buildTTMSeries(rows.filter(r => r.periodicity === 'quarterly'), ['employees'], 2024, 4, 2025, 4), []);
});

test('a later filing with a different count for the same date supersedes and is versioned', () => {
  const f = (value: number) => [{ value, as_of: '2025-12-31', approximate: false, evidence: 'x', offset: 0 }];
  const { observations } = headcountObservations([
    { source: { id: 'a', url: '', form: '10-K', published_at: '2026-01-29' }, findings: f(78865) },
    { source: { id: 'b', url: '', form: '10-K/A', published_at: '2026-03-01' }, findings: f(78900) },
  ], [{ end: '2025-12-31', fiscal_year: 2025, fiscal_quarter: 4 }]);
  assert.deepEqual(observations.map(o => [o.source_document_id, o.value_numeric, o.restatement_version]), [['b', 78900, 1], ['b', 78900, 1]]);
});
