import test from 'node:test';
import assert from 'node:assert/strict';
import { backtestLines, metricName, metricValue, providerLabel, sourceTypeLabel, words } from '../src/lib/research/reporting/audit-format';

test('metric values read in their stored unit', () => {
  assert.equal(metricValue('240989000', 'USD'), '$241M');
  assert.equal(metricValue(8485.6, 'USD_millions'), '$8.5B');
  assert.equal(metricValue(4528978, 'USD_thousands'), '$4.5B');
  assert.equal(metricValue(1.62, 'percent'), '1.62%');
  assert.equal(metricValue(6.68, 'percent_annualized'), '6.68% a year');
  assert.equal(metricValue(156, 'basis_points'), '156 bp');
  assert.equal(metricValue(-36, 'basis_points_change'), '−36 bp');
  assert.equal(metricValue(1296617325, 'shares'), '1.30bn shares');
  assert.equal(metricValue(null, 'USD'), '—');
  assert.equal(metricValue('n/m', 'USD'), 'n/m');
});

test('provider, source type and key names are plain words', () => {
  assert.equal(providerLabel('sec_companyfacts'), 'SEC company facts');
  assert.equal(providerLabel('metric-reconciler'), 'Computed from filings');
  assert.equal(providerLabel('some_new_feed'), 'Some new feed');
  assert.equal(sourceTypeLabel('sec_filing_def_14a'), 'SEC proxy statement (DEF 14A)');
  assert.equal(sourceTypeLabel('sec_filing_20_f'), 'SEC filing (20-F)');
  assert.equal(sourceTypeLabel('peer_industry_context'), 'Peer and industry context');
  assert.equal(sourceTypeLabel('web_new_dataset'), 'New dataset (web)');
  assert.equal(words('basis_points_change'), 'Basis points change');
  assert.equal(metricName({ metric_display_name: 'Net interest margin', metric_key: 'nim' }), 'Net interest margin');
  assert.equal(metricName({ metric_key: 'net_income' }), 'Net income');
  assert.equal(metricName({ metric_display_name: 'total_net_charge_off_ratio', metric_key: 'total_net_charge_off_ratio' }), 'Total net charge off ratio');
  assert.equal(metricName({}), 'Unnamed metric');
});

test('backtest results show the in-sample and out-of-sample split', () => {
  const { lines, splitDate, verdict } = backtestLines({
    cagr: 0.13626, sharpe: 0.6613, max_drawdown: -0.38869, total_return: 1.11321, win_rate: 0.4492, status: 'Needs review', split_date: '2025-02-13',
    in_sample: { cagr: 0.32866, sharpe: 1.2368, max_drawdown: -0.2242, number_of_trades: 54 },
    out_of_sample: { cagr: -0.21102, sharpe: -1.3006, max_drawdown: -0.3536, number_of_trades: 27 },
  });
  assert.equal(splitDate, '2025-02-13');
  assert.equal(verdict, 'Needs review');
  const by = Object.fromEntries(lines.map((l) => [l.label, l]));
  assert.deepEqual(by['Return a year'], { label: 'Return a year', full: '13.6%', inSample: '32.9%', outOfSample: '−21.1%' });
  assert.equal(by['Sharpe ratio'].outOfSample, '−1.3');
  assert.equal(by['Largest fall'].full, '−39%');
  assert.equal(by['Total return'].full, '111%');
  assert.equal(by['Trades'].full, '—');
  assert.equal(by['Trades'].inSample, '54');
  assert.deepEqual(backtestLines(null).lines, []);
});
