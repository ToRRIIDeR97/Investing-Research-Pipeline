import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildResearchMemo, exitText, formatLevel, memoStatus, parseBaseRange, signalPosition, splitLead, tidyProse,
} from '../src/lib/research/reporting/research-memo';
import { columnTable, gridCell } from '../src/lib/research/reporting/grid-table';

// SoFi run 0c9a2731 (18 Nov 2026): the memo inputs, trimmed from the stored run (public filing data only).
const fixture = JSON.parse(readFileSync('Implementations/research-memo/fixtures/sofi-0c9a2731.json', 'utf8'));
const memo = () => buildResearchMemo(fixture.artifacts, fixture.report_document, { runStatus: 'needs_more_work' })!;
const withArtifact = (type: string, change: (content: any) => any) =>
  fixture.artifacts.map((a: any) => a.artifact_type === type ? { ...a, content_json: change(structuredClone(a.content_json)) } : a);

test('the memo verdict shows value today from report_facts, not the 2030 targets', () => {
  const m = memo();
  assert.deepEqual(m.verdict.values, { bear: -1.79, base: 1.13, bull: 6.74 });
  assert.equal(m.verdict.weighted, 1.38);
  assert.equal(m.verdict.price, 14.28);
  assert.equal(m.verdict.priceVerified, false);
  assert.equal(m.verdict.gap, -0.9209);
  assert.equal(m.verdict.valuationComplete, true);
  assert.equal(m.verdict.confidence.level, 'low');
  assert.ok(m.verdict.confidence.openQuestions > 0);
  // The 2030 targets appear only as labelled targets in the case table.
  const base = m.valuation!.cases.find((c) => c.type === 'base')!;
  assert.equal(base.valueToday, 1.13);
  assert.equal(base.target, 9.36);
  assert.equal(base.targetYear, 2030);
  assert.equal(base.exit, '9× net income in 2030');
  assert.deepEqual(m.valuation!.cases.map((c) => c.probability), [0.3, 0.5, 0.2]);
});

test('the valuation bridge reproduces value today from the stored schedule', () => {
  const { bridge } = memo().valuation!;
  assert.deepEqual(bridge, { terminal: 5.06, explicit: -3.93, valueToday: 1.13, terminalYear: 2030 });
  assert.ok(Math.abs(bridge!.terminal + bridge!.explicit - bridge!.valueToday) <= 0.01);
});

test('the bridge is hidden when the schedule does not reproduce value today', () => {
  const artifacts = withArtifact('valuation_scenario_set', (v) => {
    v.method_schedules.find((s: any) => s.scenario_type === 'base').terminal_present_value += 500;
    return v;
  });
  const m = buildResearchMemo(artifacts, fixture.report_document)!;
  assert.equal(m.valuation!.bridge, null);
  assert.equal(m.valuation!.cases.length, 3);
});

test('the discount rate keeps the beta verification flag', () => {
  const d = memo().valuation!.discount!;
  assert.equal(d.rate, 0.1309);
  assert.equal(d.riskFree, 0.0512);
  assert.equal(d.premium, 0.0423);
  assert.equal(d.beta, 1.88);
  assert.equal(d.betaVerified, false);
});

test('signals run from bear (0) to bull (1) whichever way the metric improves', () => {
  // Higher is better: bear 10, bull 16.9.
  assert.equal(signalPosition(10, 10, 16.9), 0);
  assert.equal(signalPosition(16.9, 10, 16.9), 1);
  // Lower is better: credit losses bear 2.5, bull 1.5. A lower level sits further right.
  assert.equal(signalPosition(2.5, 2.5, 1.5), 0);
  assert.equal(signalPosition(1.5, 2.5, 1.5), 1);
  assert.ok(signalPosition(1.62, 2.5, 1.5) > signalPosition(2.0, 2.5, 1.5));
  // Past either threshold is clamped.
  assert.equal(signalPosition(0.5, 2.5, 1.5), 1);

  const signals = memo().signals;
  const credit = signals.find((s) => s.label === 'Credit losses')!;
  assert.equal(credit.display, '1.62%');
  assert.equal(credit.bearDisplay, '2.5%');
  assert.equal(credit.status, 'base');
  assert.ok(credit.baseFrom! < credit.position && credit.position < credit.baseTo!);
  const shares = signals.find((s) => s.label === 'Share count and dilution')!;
  assert.equal(shares.display, '1.30bn');
  assert.ok(shares.position > 0.9, 'a share count at the bull level sits at the right');
  assert.equal(signals.find((s) => s.label === 'Cash conversion')!.display, '−$8.8B');
  assert.equal(signals.find((s) => s.label === 'Dilution pace')!.display, '7.6%');
});

test('base ranges parse in the KPI unit', () => {
  assert.deepEqual(parseBaseRange('1.30bn to 1.36bn', 'shares'), [1.3e9, 1.36e9]);
  assert.deepEqual(parseBaseRange('14.5% to 17%', 'percent'), [14.5, 17]);
  assert.deepEqual(parseBaseRange('0% to 8%', 'ratio (decimal)'), [0, 0.08]);
  assert.deepEqual(parseBaseRange('-9000 to 0', 'USD millions'), [-9000, 0]);
  assert.equal(parseBaseRange('stable', 'percent'), null);
  assert.equal(formatLevel(14.9, 'percent'), '14.9%');
  assert.equal(formatLevel(-8793, 'USD millions'), '−$8.8B');
});

test('blocked questions are listed as untestable and lead the open questions', () => {
  const m = memo();
  assert.ok(m.untestable.length > 0);
  assert.ok(m.untestable.every((q) => q.status === 'blocked'));
  assert.equal(m.openQuestions[0].status, 'blocked');
  assert.ok(m.openQuestions.every((q) => q.status !== 'answered'));
});

test('reasons are the lead sentences of evidence-bearing conclusion paragraphs', () => {
  const { reasons, evidence } = memo();
  assert.deepEqual(reasons.map((r) => r.headline), [
    'Capital has absorbed much of the growth.',
    'Growth is also being paid for in shares.',
    'Cash conversion is the weakest part of the record.',
  ]);
  for (const reason of reasons) {
    assert.ok(reason.evidenceIds.length > 0);
    for (const id of reason.evidenceIds) assert.ok(evidence[id]?.quote, `evidence ${id} has a quote for the source drawer`);
  }
  assert.doesNotMatch(reasons.map((r) => r.detail).join(' '), /\d thousand\b/);
});

test('the snapshot compares the latest quarter with the same quarter a year earlier', () => {
  const s = memo().snapshot!;
  assert.equal(s.period, 'Q3 2026');
  assert.equal(s.prior, 'Q3 2025');
  const revenue = s.rows.find((r) => r.label === 'Revenue')!;
  assert.equal(revenue.latestDisplay, '$1.4B');
  assert.equal(revenue.change, 0.4404);
  const cash = s.rows.find((r) => r.label === 'Cash from operations')!;
  assert.equal(cash.change, null);
  assert.equal(cash.better, false);
});

test('top risks are ranked by likelihood × severity', () => {
  const risks = memo().risks;
  assert.equal(risks.length, 4);
  assert.equal(risks[0].name, 'Cash conversion: earnings do not reach distributable cash');
  assert.ok(risks.every((r, i) => i === 0 || (risks[i - 1].score ?? 0) >= (r.score ?? 0)));
});

test('a withheld valuation gives a verdict without numbers', () => {
  const artifacts = withArtifact('report_facts', (f) => ({ ...f, valuation_status: 'withheld', withheld_reason: 'No equity method could be built.' }));
  const m = buildResearchMemo(artifacts, fixture.report_document)!;
  assert.equal(m.verdict.valuationComplete, false);
  assert.equal(m.verdict.withheldReason, 'No equity method could be built.');
  assert.deepEqual(m.verdict.values, { bear: null, base: null, bull: null });
  assert.equal(m.verdict.weighted, null);
  assert.equal(m.valuation, null);
});

test('no memo field carries a raw float or a snake_case key', () => {
  const m = memo();
  const strings: string[] = [];
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string' && !['id', 'url', 'quote', 'claim', 'publishedAt', 'key', 'status', 'conclusionStatus'].includes(key)) strings.push(v);
    else if (typeof v === 'number') assert.ok(Number.isInteger(v) || String(v).split('.')[1].length <= 4, `${key}=${v} is rounded`);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk({ ...m, evidence: {} });
  for (const s of strings) assert.doesNotMatch(s, /\b[a-z]+_[a-z_]+\b/, `"${s}" has no snake_case key`);
});

test('a run status maps to one vocabulary', () => {
  assert.equal(memoStatus({ runStatus: 'waiting_for_human' })!.label, 'Needs your decision');
  assert.equal(memoStatus({ runStatus: 'needs_more_work' })!.label, 'Needs more work');
  assert.equal(memoStatus({ runStatus: 'running' })!.label, 'Researching');
  assert.equal(memoStatus({ runStatus: 'completed' })!.label, 'Decided');
  assert.equal(memoStatus({ runStatus: 'waiting_for_human', latestDecision: 'watchlist' })!.label, 'Decided');
  assert.equal(memoStatus({ runStatus: 'failed' })!.label, 'Failed');
  assert.equal(memoStatus({}), null);
});

test('prose helpers keep decimals and convert thousands', () => {
  assert.deepEqual(splitLead('The price is 14.28 today. Next point.'), { lead: 'The price is 14.28 today.', rest: 'Next point.' });
  assert.equal(tidyProse('net income was 240,989 thousand in Q3'), 'net income was 241.0 million in Q3');
  assert.equal(tidyProse('CET1 capital of 9,520,479 thousand'), 'CET1 capital of 9.52 billion');
  assert.equal(exitText('11x net_income_2030'), '11× net income in 2030');
});

test('a { columns, rows } exhibit becomes reader records', () => {
  const facts = fixture.artifacts.find((a: any) => a.artifact_type === 'report_facts').content_json;
  const rows = columnTable(facts.cases)!;
  assert.equal(rows.length, 3);
  assert.equal(rows[1]['Scenario'], 'Base');
  assert.equal(Object.keys(rows[1])[0], 'Scenario');
  assert.equal(rows[1]['Probability'], '50.0%');
  assert.equal(rows[1]['Discount rate'], '13.1%');
  assert.equal(rows[1]['Value per share today'], '1.13');
  assert.equal(rows[1]['Target year'], '2030');
  assert.equal(rows[1]['Exit valuation'], '9× net income in 2030');
  assert.equal(rows[1]['Return to price target'], '−34.5%');
  assert.equal(gridCell('explicit_cash_flow_sum', -6966.2), '−6,966.2');
  assert.equal(gridCell('tv_share_of_ev', null), '—');
  // A metric-per-row table formats each row by what its metric measures.
  const ranges = columnTable({ columns: ['metric', 'n', 'median', 'latest', 'percentile'], rows: [['revenue_yoy', 19, 0.3963, 0.4404, 0.79], ['capex_to_da', 19, 0.64, 1.11, 1], ['fcf_ttm', 19, -3984.9, -8793, 0.16]] })!;
  assert.deepEqual(ranges[0], { Metric: 'Revenue YoY', Periods: '19', Median: '39.6%', Latest: '44.0%', Percentile: '79.0%' });
  assert.equal(ranges[1]['Latest'], '1.11x');
  assert.equal(ranges[2]['Metric'], 'FCF TTM');
  assert.equal(ranges[2]['Latest'], '−8,793');
  assert.equal(columnTable([1, 2]), null);
  assert.equal(columnTable({ columns: ['a'], rows: [] }), null);
});
