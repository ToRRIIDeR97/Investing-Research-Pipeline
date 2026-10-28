import test from 'node:test';
import assert from 'node:assert/strict';
import { kpiHealth, kpiStatus, quarterLabel } from '../src/lib/research/reporting/kpi-health';
import { formatInUnit, kpiGroup, kpiName, money, plainLabel } from '../src/lib/research/reporting/plain-english';
import { longDate, valuationSummary } from '../src/lib/research/reporting/valuation-summary';

const artifact = (artifact_type: string, content_json: Record<string, any>) => ({ artifact_type, artifact_version: 1, content_json });
const q = (metric_key: string, fiscal_year: number, fiscal_quarter: number, value_numeric: number) =>
  ({ metric_key, periodicity: 'quarterly', fiscal_year, fiscal_quarter, value_numeric, unit: 'USD', currency: 'USD', reporting_basis: 'gaap', segment: null, geography: null });

test('KPI status follows the bear line direction and a 5% caution band', () => {
  // Higher is better (bear below bull).
  assert.equal(kpiStatus(60801, 60000, 61600), 'caution');
  assert.equal(kpiStatus(18775, 16900, 19800), 'healthy');
  assert.equal(kpiStatus(60000, 60000, 61600), 'danger');
  assert.equal(kpiStatus(59000, 60000, 61600), 'danger');
  // Lower is better (bear above bull): capex and costs.
  assert.equal(kpiStatus(30116, 33000, 27500), 'healthy');
  assert.equal(kpiStatus(32000, 33000, 27500), 'caution');
  assert.equal(kpiStatus(33500, 33000, 27500), 'danger');
  // Negative lines: a smaller loss is better.
  assert.equal(kpiStatus(-4028, -5000, -3500), 'healthy');
  assert.equal(kpiStatus(-4900, -5000, -3500), 'caution');
  assert.equal(kpiStatus(-5100, -5000, -3500), 'danger');
  // Bear line at zero: the band is 5% of the bear–bull gap (600 of 12,000).
  assert.equal(kpiStatus(500, 0, 12000), 'caution');
  assert.equal(kpiStatus(1746, 0, 12000), 'healthy');
  assert.equal(kpiStatus(0, 0, 12000), 'danger');
  assert.equal(kpiStatus(null, 0, 12000), null);
  assert.equal(kpiStatus(100, null, 200), null);
});

test('KPI and driver names are plain English', () => {
  assert.equal(kpiName({ kpi: 'Revenue level', metric_key: 'total_revenue' }), 'Total revenue');
  assert.equal(kpiName({ kpi: 'Advertising engine revenue', metric_key: 'family_of_apps_revenue', segment: 'Family of Apps' }), 'Family of Apps revenue');
  assert.equal(kpiName({ kpi: 'x', metric_key: 'reality_labs_income_from_operations_gaap', segment: 'Reality Labs', bear_threshold: -5000, bull_threshold: -3500 }), 'Reality Labs operating loss');
  assert.equal(kpiName({ kpi: 'Capex intensity', metric_key: 'us_gaap_PaymentsToAcquirePropertyPlantAndEquipment' }), 'Capital expenditure');
  assert.equal(kpiName({ kpi: 'FCF', metric_key: 'free_cash_flow_company_defined_non_gaap' }), 'Free cash flow');
  assert.equal(kpiName({ kpi: 'Funded loan_volume', metric_key: 'unknown_key' }), 'Funded loan volume');
  assert.equal(plainLabel('foa_advertising_revenue_growth'), 'Family of Apps revenue growth');
  assert.equal(plainLabel('capex_purchases_of_property_and_equipment'), 'Capital expenditure');
  assert.equal(plainLabel('eu_dma_regulatory_revenue_haircut'), 'EU Digital Markets Act revenue impact');
  assert.equal(plainLabel('fcff_dcf_terminal_multiple'), 'Discounted free cash flow with an exit multiple');
  assert.equal(plainLabel('nopat_fy2028_after_tax_operating_income'), 'After-tax operating profit');
  assert.equal(plainLabel('reality_labs_operating_loss', ['Reality Labs']), 'Reality Labs operating loss');
  assert.equal(plainLabel('foa_operating_margin'), 'Family of Apps operating margin');
  assert.equal(kpiGroup({ metric_key: 'us_gaap_PaymentsToAcquirePropertyPlantAndEquipment', process_node: 'Reinvestment' }), 'Cash');
  assert.equal(kpiGroup({ metric_key: 'us_gaap_CostOfRevenue', process_node: 'Cost structure (depreciation and operations)' }), 'Profit and costs');
  assert.equal(kpiGroup({ metric_key: 'reality_labs_revenue', process_node: 'Value delivery (hardware and platform)' }), 'Revenue and demand');
  assert.equal(kpiGroup({ metric_key: 'loans', process_node: 'Underwriting (personal loans)' }), 'Underwriting');
  assert.equal(money(60_801e6), '$60.8B');
  assert.equal(money(431e6), '$431M');
  assert.equal(money(-4_028e6), '−$4.0B');
  assert.equal(money(0), '$0');
  assert.equal(formatInUnit(60801, 'USD millions'), '$60.8B');
  assert.equal(formatInUnit(38.5, '%'), '38.5%');
  assert.equal(quarterLabel('2026-Q2'), 'Q2 ’26');
});

test('KPI health table uses quarterly history, falls back to the current level, and counts statuses', () => {
  const observations = [2025, 2026].flatMap(y => [1, 2, 3, 4].filter(n => y < 2026 || n <= 2).map(n => q('total_revenue', y, n, (40_000 + (y - 2025) * 16_000 + n * 1000) * 1e6)));
  const health = kpiHealth([
    artifact('financial_statement_set', { observations }),
    artifact('monitoring_dashboard', { items: [
      { kpi: 'Revenue level', metric_key: 'total_revenue', unit: 'USD millions', reporting_basis: 'GAAP', process_node: 'Demand generation', current_level: 58000, bear_threshold: 57000, bull_threshold: 60000, definition: 'Consolidated revenue.' },
      { kpi: 'Reality Labs revenue', metric_key: 'reality_labs_revenue', segment: 'Reality Labs', unit: 'USD millions', process_node: 'Value delivery', current_level: 431, bear_threshold: 350, bull_threshold: 500 },
      { kpi: 'Capex intensity', metric_key: 'capex', unit: 'USD millions', process_node: 'Reinvestment', current_level: 34000, bear_threshold: 33000, bull_threshold: 27500 },
    ] }),
  ]);
  assert.equal(health.latestPeriod, '2026-Q2');
  assert.deepEqual(health.periods, ['2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1']);
  assert.deepEqual(health.counts, { healthy: 1, caution: 1, danger: 1 });
  const revenue = health.groups[0].rows[0];
  assert.equal(revenue.name, 'Total revenue');
  assert.deepEqual(revenue.history, ['$42.0B', '$43.0B', '$44.0B', '$57.0B']);
  assert.equal(revenue.latest, '$58.0B');
  assert.equal(revenue.status, 'caution');
  assert.equal(revenue.yoy, '+38.1%');
  assert.match(revenue.why, /within 5% of the danger line of \$57\.0B/);
  const lab = health.groups[0].rows[1];
  assert.deepEqual(lab.history, [null, null, null, null]);
  assert.equal(lab.latest, '$431M');
  assert.equal(lab.status, 'healthy');
  assert.equal(health.groups[1].name, 'Cash');
  assert.equal(health.groups[1].rows[0].status, 'danger');
  assert.match(health.groups[1].rows[0].why, /past the danger line/);
  assert.equal(health.withoutHistory, 2);
  for (const row of health.groups.flatMap(g => g.rows)) assert.doesNotMatch(JSON.stringify(row), /null_|_key|undefined|NaN/);
});

const years = (rev: number[], oi: number[], capex: number[]) => Object.fromEntries([2026, 2027, 2028].map((y, i) => [y, { consolidated_revenue: rev[i], consolidated_operating_income: oi[i], capex: capex[i] }]));
const schedule = (scenario_type: string, cash: number[], value_per_share: number, nopat: number) => ({
  method: 'fcff', scenario_type, currency: 'USD', discount_rate: 0.09, diluted_shares: 2566, equity_bridge: -83664,
  terminal: { type: 'multiple', metric: 'nopat_fy2028_after_tax_operating_income', metric_value: nopat, multiple: 18 },
  years: cash.map((cash_flow, i) => ({ fiscal_year: 2026 + i, cash_flow })), terminal_value: nopat * 18, equity_value: value_per_share * 2566, value_per_share,
  method_name: `FCFF ${scenario_type}`, rationale: 'Analyst note for 9a1b2c3d-1111-4222-8333-444455556666.', source_notes: ['10-Q'], equity_bridge_explanation: 'Less long-term debt.',
});
const valuationArtifacts = (extra: Record<string, any> = {}) => [
  artifact('valuation_scenario_set', {
    terminal_year: 2028, terminal_anchor_bear: 413.3, terminal_anchor_base: 563.5, terminal_anchor_bull: 672.2,
    probability_bear: 0.25, probability_base: 0.5, probability_bull: 0.25, weighted_target: 553.125, current_market_price: 719.87,
    methods: ['fcff_dcf_terminal_multiple'], source_gaps: ['No sourced future share issuance schedule.'],
    method_schedules: [schedule('bear', [-71942, -84367, -86430], 232.33, 63570), schedule('base', [-53700, -53078, -50028], 376, 84972), schedule('bull', [-39710, -29701, -19516], 481.88, 100484)],
    ...extra,
  }),
  artifact('operating_scenario_set', { scenarios: [
    { scenario_type: 'bear', resulting_financial_statements_json: { units: 'USD millions', years: years([240111, 263962, 285051], [67557, 68203, 71506], [132000, 145000, 150000]) },
      numeric_assumptions: [{ fiscal_year: 2028, driver_key: 'foa_advertising_revenue_growth', value: 0.08, unit: 'ratio (decimal)' }, { fiscal_year: 2028, driver_key: 'capex_purchases_of_property_and_equipment', value: 150000, unit: 'USD millions' }] },
    { scenario_type: 'base', resulting_financial_statements_json: { units: 'USD millions', years: years([243204, 279857, 313720], [75100, 86527, 95580], [120464, 130000, 135000]) },
      numeric_assumptions: [{ fiscal_year: 2028, driver_key: 'foa_advertising_revenue_growth', value: 0.12, unit: 'ratio (decimal)' }, { fiscal_year: 2027, driver_key: 'foa_advertising_revenue_growth', value: 0.15, unit: 'ratio (decimal)' }] },
    { scenario_type: 'bull', resulting_financial_statements_json: { units: 'USD millions', years: years([246474, 291479, 335751], [79067, 95949, 113042], [110000, 115000, 120000]) },
      numeric_assumptions: [{ fiscal_year: 2028, driver_key: 'foa_advertising_revenue_growth', value: 0.15, unit: 'ratio (decimal)' }] },
  ] }),
  artifact('expected_return_matrix', { bear_return: -0.425869, base_return: -0.21722, bull_return: -0.06622, probability_weighted_return: -0.231632 }),
  artifact('decision_record', { decision: 'pending' }),
  artifact('historical_record', { observations: [
    { metric_key: 'revenue', periodicity: 'annual', fiscal_year: 2025, value_numeric: 200_966e6, unit: 'USD', segment: null, geography: null },
    { metric_key: 'us_gaap_OperatingIncomeLoss', periodicity: 'annual', fiscal_year: 2025, value_numeric: 83_276e6, unit: 'USD', segment: null, geography: null },
  ] }),
];

test('Valuation summary is derived from the scenario, schedule and return artifacts', () => {
  const s = valuationSummary(valuationArtifacts(), { conclusionStatus: 'withheld' })!;
  assert.equal(Math.round(s.weighted!), 553);
  assert.equal(Math.round(s.weightedReturn! * 100), -23);
  assert.deepEqual(s.scenarios.map(x => [x.type, x.value, x.probability]), [['bear', 413.3, 0.25], ['base', 563.5, 0.5], ['bull', 672.2, 0.25]]);
  assert.equal(s.price, 719.87);
  assert.equal(s.priceVerified, false);
  assert.equal(s.notFinal, true);
  assert.equal(s.terminalYear, 2028);
  assert.deepEqual(s.reasons.map(r => r.title), ['Growth slows.', 'Spending eats the cash.', 'Margins narrow.']);
  assert.equal(s.reasons[0].text, 'In the base case, revenue growth eases from about 21% in 2026 to 12% by 2028.');
  assert.match(s.reasons[1].text, /\$135\.0B a year by 2028, more than the \$85\.0B the business earns after tax that year, so free cash flow stays negative through 2028/);
  assert.equal(s.reasons[2].text, 'In the base case, operating margin settles at 30% by 2028 (25–34% across the three cases), against 41% in FY2025.');
  const base = s.calculations.find(c => c.type === 'base')!;
  assert.deepEqual(base.rows.map(r => r.label), ['Revenue', 'Operating profit', 'Capital expenditure', 'Free cash flow']);
  assert.deepEqual(base.rows[2].values, [-120464, -130000, -135000]);
  assert.deepEqual(base.steps.map(x => x.value), ['$1.53T', '$964.8B', '$376 a share']);
  assert.match(base.steps[1].text, /at 9% a year, then subtract \$83\.7B of debt/);
  assert.equal(base.note, null, 'the anchors equal the schedules\' end-of-2028 values');
  assert.deepEqual(s.assumptions[0], { label: 'Family of Apps revenue growth', values: ['8.0%', '12.0%', '15.0%'] });
  assert.deepEqual(s.assumptions.find(a => a.label === 'Capital expenditure')?.values, ['$150.0B', null, null]);
  assert.deepEqual(s.assumptions.find(a => a.label === 'Exit multiple')?.values, ['18×', '18×', '18×']);
  assert.equal(s.method, 'Discounted free cash flow with an exit multiple');
  const off = valuationSummary(valuationArtifacts({ terminal_anchor_base: 600 }), { conclusionStatus: 'withheld' })!;
  assert.match(off.calculations.find(c => c.type === 'base')!.note!, /At the end of 2028 this gives \$563, lower than the \$600 scenario value/);
  assert.deepEqual(off.disagreements.map(d => [d.type, d.year, Math.round(d.model), d.scenario]), [['base', 2028, 563, 600]]);
  assert.equal(off.issues[0], 'The cash-flow model and the scenario values disagree in the base case: the base model gives $563 at the end of 2028, against a scenario value of $600. Until they’re reconciled, the scenario values can change.');
  assert.deepEqual(s.disagreements, []);
  assert.ok(!s.issues.some(issue => /disagree/.test(issue)));
  assert.ok(s.issues.includes('$719.87 is an unchecked price snapshot, not a recorded close.'));
  assert.equal(s.priceDate, null);
  assert.ok(s.issues.includes('No sourced future share issuance schedule.'));
  assert.equal(s.notes[0].rationale, 'Analyst note for [reference].');
});

test('Valuation summary handles verified prices, reconciled schedules and missing artifacts', () => {
  assert.equal(valuationSummary([]), null);
  const verified = valuationSummary(valuationArtifacts({
    current_market_price_source: { provider: 'stooq', trading_date: '2026-06-30', verified: true }, source_gaps: [],
    method_schedules: undefined,
  }).filter(a => a.artifact_type !== 'decision_record'))!;
  assert.equal(verified.priceVerified, true);
  assert.equal(verified.notFinal, false);
  assert.deepEqual(verified.issues, []);
  assert.deepEqual(verified.calculations.find(c => c.type === 'base')!.steps, []);
  // Without schedules the reasons that need cash flow are omitted rather than invented.
  assert.deepEqual(verified.reasons.map(r => r.title), ['Growth slows.', 'Spending outpaces profit.', 'Margins narrow.']);
  const unverified = valuationSummary(valuationArtifacts({ current_market_price_source: { trading_date: '2026-06-30', verified: false, verification_status: 'single_source' } }))!;
  assert.equal(unverified.priceDate, '30 June 2026');
  assert.ok(unverified.issues.includes('The $719.87 close on 30 June 2026 hasn’t been checked against a second price source.'));
  const mismatch = valuationSummary(valuationArtifacts({ current_market_price_source: { trading_date: '2026-06-30', verified: false, verification_status: 'mismatch' } }))!;
  assert.ok(mismatch.issues.includes('The $719.87 close on 30 June 2026 doesn’t match the second price source.'));
});

test('Valuation summary puts code-written gaps, omitted methods and dates in plain English', () => {
  assert.equal(longDate('2026-10-12'), '12 October 2026');
  assert.equal(longDate('2026-10-12T00:00:00Z'), '12 October 2026');
  assert.equal(longDate(null), null);
  const s = valuationSummary(valuationArtifacts({
    source_gaps: ['Equity bridge items not captured: current_debt, finance_lease_liabilities.', 'No dividend forecast: dividend_per_share is 0 in every year.'],
    omitted_methods: [{ method: 'P/E and EV/EBITDA peer multiples', reason: 'No peers.' }, { method: 'fcfe', reason: 'Not a bank.' }],
  }))!;
  assert.ok(s.issues.includes('Some balance-sheet items aren’t captured, so the step from business value to share value is incomplete: current debt, finance lease liabilities.'));
  assert.ok(s.issues.includes('No dividends are forecast, so the value per share includes none.'));
  assert.deepEqual(s.omitted.map(m => m.method), ['P/E and EV/EBITDA peer multiples', 'Discounted free cash flow to equity']);
  assert.equal(plainLabel('family_dap_growth'), 'Family daily active people growth');
  assert.equal(plainLabel('da_to_revenue'), 'Depreciation as a share of revenue');
  assert.equal(plainLabel('capex_intensity'), 'Capital expenditure as a share of revenue');
  assert.equal(plainLabel('non_interest_expense'), 'Non-interest expense');
  assert.equal(plainLabel('pre_tax_income'), 'Pre-tax income');
});

test('Falling capital expenditure with free cash flow turning positive reads as spending that eases', () => {
  const spend = (capex: number[], cash: number[]) => {
    const ops = valuationArtifacts().map(a => a.artifact_type !== 'operating_scenario_set' ? a : artifact('operating_scenario_set', { scenarios: (a.content_json.scenarios as any[]).map(sc =>
      sc.scenario_type !== 'base' ? sc : { ...sc, resulting_financial_statements_json: { units: 'USD millions', years: years([252600, 288000, 322500], [85600, 103700, 122600], capex) } }) }));
    return valuationSummary(ops.map(a => a.artifact_type !== 'valuation_scenario_set' ? a : artifact('valuation_scenario_set', { ...a.content_json,
      method_schedules: [schedule('bear', [-71942, -84367, -86430], 232.33, 63570), schedule('base', cash, 395, 98500), schedule('bull', [-39710, -29701, -19516], 481.88, 100484)],
      terminal_anchor_base: (98500 * 18 - 83664) / 2566 })))!.reasons[1];
  };
  const text = 'In the base case, capital expenditure falls from $137.5B to $103.2B a year by 2028, still more than the $98.5B the business earns after tax that year. Free cash flow turns positive in 2028.';
  // Falling from the first forecast year is not a peak.
  assert.deepEqual(spend([137500, 115200, 103200], [-46000, -6000, 24300]), { title: 'Spending eases.', text });
  // Capex stored as a negative outflow reads the same way.
  assert.deepEqual(spend([-137500, -115200, -103200], [-46000, -6000, 24300]), { title: 'Spending eases.', text });
  assert.equal(spend([120000, 137500, 103200], [-46000, -6000, 24300]).title, 'Spending peaks, then eases.');
  // Free cash flow that starts positive turns positive only after a negative year.
  assert.match(spend([137500, 115200, 103200], [5000, -3000, 4000]).text, /Free cash flow turns positive in 2028\.$/);
  assert.doesNotMatch(spend([137500, 115200, 103200], [5000, 3000, -4000]).text, /turns positive/);
});

test('What the last price implies compares the reverse valuation with the scenarios', () => {
  const reverse = (content: Record<string, any>) => artifact('reverse_valuation', { artifact_type: 'reverse_valuation', ...content });
  const engine = valuationSummary([...valuationArtifacts(), reverse({ method: 'fcff', implied_margin: 0.640418, implied_growth: 0.432409 })])!;
  assert.deepEqual(engine.priceImplies, [
    'To be worth the $720 last price, the base case would need an operating margin of about 64% a year through 2028 (at base-case growth). Every scenario assumes less: 25–34%.',
    'Or revenue growth of about 43% a year through 2028 (at base-case margins). Every scenario assumes less: 8–23%.',
  ]);
  const analyst = valuationSummary([...valuationArtifacts(), reverse({ implied_margin: 0.3, implied_growth: 0.056 })])!;
  assert.deepEqual(analyst.priceImplies, [
    'At the $720 last price, the analyst’s reverse valuation implies an operating margin of about 30%. The scenarios assume 25–34%.',
    'It also implies revenue growth of about 6%. Every scenario assumes more: 8–23%.',
    'These figures are the analyst’s own estimate, not solved from the cash-flow model, so treat them as unchecked.',
  ]);
  // An analyst-written method is still not the code solver.
  const named = valuationSummary([...valuationArtifacts(), reverse({ method: 'current_market_price_relative_to_discounted_residual_income', implied_margin: 0.3, implied_growth: null })])!;
  assert.deepEqual(named.priceImplies, [
    'At the $720 last price, the analyst’s reverse valuation implies an operating margin of about 30%. The scenarios assume 25–34%.',
    'These figures are the analyst’s own estimate, not solved from the cash-flow model, so treat them as unchecked.',
  ]);
  const analystNone = valuationSummary([...valuationArtifacts(), reverse({ method: 'residual_income', implied_margin: null, implied_growth: null })])!;
  assert.deepEqual(analystNone.priceImplies, ['The analyst’s reverse valuation gives no implied operating margin or growth rate for the $720 last price.']);
  const none = valuationSummary([...valuationArtifacts(), reverse({ method: 'fcff', implied_margin: null, implied_growth: null })])!;
  assert.deepEqual(none.priceImplies, ['No operating margin or growth rate in the range tested makes the base case worth the $720 last price.']);
  assert.deepEqual(valuationSummary(valuationArtifacts())!.priceImplies, []);
});

test('Yearly value per share comes from the annual price-target path, per scenario', () => {
  const target = (scenario_type: string, fiscal_year: number, price_target: number, extra: Record<string, any> = {}) =>
    ({ scenario_type, fiscal_year, price_target, valuation_method: 'fcff_dcf_terminal_multiple', dividend_per_share: 0, is_interpolated: false, ...extra });
  const path = artifact('annual_price_target_path', { currency: 'USD', price_target_path: [
    target('base', 2028, 563.5, { total_return_target: -0.21722 }),
    target('base', 2026, 433.6, { total_return_target: -0.397669 }),
    target('base', 2027, 500, { is_interpolated: true }),
    target('bear', 2026, 284.2, { total_return_target: -0.605206 }),
  ] });
  const s = valuationSummary([...valuationArtifacts(), path])!;
  const base = s.calculations.find(c => c.type === 'base')!.priceTargets!;
  assert.deepEqual(base.years, [2026, 2027, 2028]);
  assert.deepEqual(base.values, [433.6, 500, 563.5]);
  assert.deepEqual(base.interpolated, [false, true, false]);
  assert.equal(base.returns[0], -0.397669);
  assert.equal(base.returns[1]!.toFixed(4), (500 / 719.87 - 1).toFixed(4)); // recomputed when missing
  assert.deepEqual(s.calculations.find(c => c.type === 'bear')!.priceTargets!.values, [284.2]);
  assert.equal(s.calculations.find(c => c.type === 'bull')!.priceTargets, null);
  // No price-target artifact: the table is hidden.
  assert.ok(valuationSummary(valuationArtifacts())!.calculations.every(c => c.priceTargets === null));
});

test('the view page keeps the run it shows and stops polling a finished run (#130)', async () => {
  const { listRows, pickShownRun, runIsTerminal } = await import('../src/lib/research/reporting/data-views');
  const runs = [{ id: 'new' }, { id: 'old' }];
  assert.equal(pickShownRun(runs, null, null)?.id, 'new');
  assert.equal(pickShownRun(runs, null, 'old')?.id, 'old', 'a newer run started elsewhere does not replace the shown one');
  assert.equal(pickShownRun(runs, null, 'gone')?.id, 'new');
  assert.equal(pickShownRun(runs, 'old', 'new')?.id, 'old');
  assert.equal(pickShownRun(runs, 'missing', null), undefined);
  assert.equal(pickShownRun([], null, null), null);
  for (const status of ['completed', 'cancelled']) assert.equal(runIsTerminal(status), true, status);
  for (const status of ['running', 'waiting_for_human', 'needs_more_work', 'pending', undefined]) assert.equal(runIsTerminal(status), false, String(status));
  // The run page reads model calls as a bare array today and as a paged object if the route returns one.
  assert.deepEqual(listRows([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(listRows({ items: [{ id: 2 }], next: 'x' }), [{ id: 2 }]);
  assert.deepEqual(listRows({ rows: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(listRows(null), []);
  assert.deepEqual(listRows({ error: 'nope' }), []);
});
