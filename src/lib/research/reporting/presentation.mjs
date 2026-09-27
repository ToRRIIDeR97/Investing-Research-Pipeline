const names = {
  loan_loss_reserve:'Loan loss reserve', net_interest_income:'Net interest income',
  non_interest_income:'Non-interest income', noninterest_income_gaap:'Non-interest income · GAAP',
  credit_losses:'Credit losses', deposits:'Deposits', total_deposits:'Total deposits',
  stockholders_equity:'Shareholders’ equity', loans_held_for_investment_net:'Loans held for investment, net',
  loans_held_for_sale:'Loans held for sale', deposit_interest_expense:'Interest paid on deposits',
  financial_services_segment_contribution_profit_non_gaap:'Financial Services contribution profit · non-GAAP',
  financial_services_segment_net_revenue_gaap:'Financial Services revenue · GAAP',
  technology_platform_net_revenue_gaap:'Technology Platform revenue · GAAP',
  gaap:'GAAP', non_gaap:'Non-GAAP', usd:'USD', eps:'Earnings per share', bvps:'Book value per share',
  ttm:'Trailing 12 months', nim:'Net interest margin', cet1:'Common equity Tier 1',
  pending:'Pending review', blocked_source_gap:'Awaiting evidence', qualified:'Qualified', satisfied:'Covered',
  not_applicable:'Not applicable', base_return:'Base-case return', bear_return:'Bear-case return',
  bull_return:'Bull-case return', no_rerating_return:'Return without multiple expansion',
  probability_weighted_return:'Probability-weighted return', tangible_book_nav:'Tangible book value',
  residual_income:'Residual income', fiscal_year:'Year', fiscal_quarter:'Quarter', scenario_type:'Scenario',
  metric_key:'Measure', value_numeric:'Value', metric_type:'Basis', operating_values:'Operating forecast',
  per_share_values:'Per-share forecast', balance_sheet_values:'Balance sheet',
  resulting_financial_statements_json:'Financial forecast', forecast_revenue:'Forecast revenue',
  forecast_operating_income:'Forecast operating income', financial_services_products:'Financial Services products',
  source_gaps:'Missing evidence', must_be_true:'What must hold', causal_chain:'How the thesis works',
  thesis_statement:'Investment thesis', confidence:'Confidence', source_role:'Evidence basis',
  current_level:'Current level', bear_threshold:'Downside threshold', bull_threshold:'Upside threshold',
  terminal_anchor_base:'Base price target', terminal_anchor_bear:'Bear price target', terminal_anchor_bull:'Bull price target',
  price_target:'Price target', total_return_target:'Total return', probability_base:'Base probability',
  probability_bear:'Bear probability', probability_bull:'Bull probability', weighted_target:'Weighted price target',
  p_tbv_multiple:'Price / tangible book', cagr:'Annualized return', max_drawdown:'Maximum drawdown',
  combination_key:'Strategy combination', lead_bucket:'Leading signal', parameter_stability:'Parameter stability',
  reporting_basis:'Reporting basis', present:'Available', why_missing:'What is missing',
};
const internal = /^(confidence|confidence_score|artifact_type|metadata_json|restatement_version|system_generated|source_accession_number|source_document_id|source_id|id|created_at|updated_at|scope_key)$|(_ids?$)|(^supporting_observation)|(^supersedes_)/;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
export function label(key){
  if(names[key])return names[key];
  const value=String(key).replace(/_json$/,'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_.]+/g,' ').trim();
  return (value.charAt(0).toUpperCase()+value.slice(1)).replace(/\b(usd|gaap|ttm|nim|cet1|kpi|tam|fcf|nav|yoy)\b/gi,m=>m.toUpperCase());
}
export function readerText(value){
  return String(value).replace(uuid,'[reference]').replace(/\bevidence claim [a-f0-9]{8}\b/gi,'the cited evidence').replace(/\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b/g,label);
}
export function number(value,digits=6){
  if(value==null||!Number.isFinite(Number(value)))return 'Not disclosed';
  const n=Number(value),precision=n!==0&&Math.abs(n)<.001?12:digits;
  return new Intl.NumberFormat('en-US',{maximumFractionDigits:precision}).format(n).replace(/^-/,'−');
}
export function readerValue(value,key=''){
  if(value==null)return 'Not disclosed';
  if(typeof value==='boolean')return value?'Yes':'No';
  if(typeof value==='number')return number(value);
  if(typeof value==='string')return readerText(value);
  if(Array.isArray(value))return value.map(item=>readerValue(item,key));
  return Object.fromEntries(Object.entries(value).filter(([k])=>!internal.test(k)).map(([k,v])=>[label(k),readerValue(v,k)]));
}
export function safeUrl(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}}

const statementMetrics = {
  income: ['net_revenue','contract_revenue','net_income','net_interest_income','non_interest_income','noninterest_income_gaap','credit_losses','deposit_interest_expense'],
  balance: ['total_assets','total_liabilities','stockholders_equity','deposits','total_deposits','loan_loss_reserve','loans_held_for_sale','loans_held_for_investment_net'],
  cashflow: ['operating_cash_flow','investing_cash_flow','financing_cash_flow'],
};
export function financialStatements(observations, periodicity = 'quarterly') {
  const result = {income:[], balance:[], cashflow:[], other:[], missingCashFlows:[]};
  const categories = {income_statement:'income', balance_sheet:'balance', cash_flow:'cashflow'};
  for (const row of observations) {
    if (row.periodicity !== periodicity) continue;
    const category = row.metadata_json?.metric_category;
    const group = Object.keys(statementMetrics).find(key => statementMetrics[key].includes(row.metric_key))
      || (Object.hasOwn(categories,category) ? categories[category] : 'other');
    result[group].push(row);
  }
  result.missingCashFlows = statementMetrics.cashflow.filter(key =>
    !result.cashflow.some(row => row.metric_key === key && Number.isFinite(row.value_numeric)));
  return result;
}

export function financialPeriod(row) {
  if (!Number.isInteger(row.fiscal_year)) return null;
  if (row.periodicity === 'annual') return String(row.fiscal_year);
  return Number.isInteger(row.fiscal_quarter) && row.fiscal_quarter >= 1 && row.fiscal_quarter <= 4
    ? `${row.fiscal_year}-Q${row.fiscal_quarter}` : null;
}
export function financialWindow(observations, frequency = 'quarterly', end = '') {
  const periods = [...new Set(observations.filter(r => r.periodicity === frequency).map(financialPeriod).filter(Boolean))].sort();
  const index = periods.indexOf(end);
  const last = index < 0 ? periods.length - 1 : index;
  const first = Math.max(0, last - 4);
  return {periods:periods.slice(first,last+1), all:periods,
    earlier:first > 0 ? periods[Math.max(0,last-5)] : null,
    later:last < periods.length-1 ? periods[Math.min(periods.length-1,last+5)] : null};
}

/** Refuse ambiguous series; keep missing periods as gaps instead of joining across them. */
export function financialSeries(observations, metric, periods) {
  const rows = observations.filter(r => r.metric_key === metric && !r.segment && !r.geography);
  const signatures = new Set(rows.map(r => JSON.stringify([r.unit,r.currency,r.reporting_basis,r.periodicity])));
  if (!rows.length) return {reason:'No consolidated observations available.', points:[], unit:''};
  if (signatures.size !== 1) return {reason:'Multiple reporting bases or units. See the separate table rows.', points:[], unit:''};
  const currency = rows[0].unit === rows[0].currency && /^[A-Z]{3}$/.test(rows[0].currency || '');
  const unit = currency ? `${rows[0].currency} millions` : label(rows[0].unit || 'Value');
  const points = [];
  for (const period of periods) {
    const matches = rows.filter(r => financialPeriod(r) === period);
    if (matches.length > 1) return {reason:'Multiple observations for a period. See the reported values in the table.', points:[], unit};
    const raw = matches[0]?.value_numeric;
    points.push({period, value:Number.isFinite(raw) ? raw/(currency ? 1e6 : 1) : null});
  }
  return {reason:points.filter(p => p.value !== null).length < 2 ? 'At least two numeric observations are needed for a chart.' : '', points, unit};
}

export function historyMatrix(observations){
  const periodKey=r=>`${r.fiscal_year}-${String(r.periodicity==='annual'?0:r.fiscal_quarter||0).padStart(2,'0')}`;
  const ordered=[...new Set(observations.map(periodKey))].sort();
  const periods=ordered.map(p=>{const[y,q]=p.split('-');return Number(q)?`Q${Number(q)} ${y}`:y;});
  const groups=new Map();
  for(const r of observations){
    const signature=JSON.stringify([r.metric_key,r.unit,r.currency,r.segment,r.geography,r.periodicity,r.reporting_basis]);
    if(!groups.has(signature)){
      const currency=r.unit===r.currency&&/^[A-Z]{3}$/.test(r.unit||'');
      groups.set(signature,{metric_key:r.metric_key,name:r.metadata_json?.statement_label||label(r.metric_key),unit:currency?`${r.currency} millions`:label(r.unit||'Value'),
        basis:[r.reporting_basis,r.segment,r.geography].filter(Boolean).map(label).join(' · '),currency,
        values:ordered.map(()=>[]),exact:ordered.map(()=>[]),observations:ordered.map(()=>[])});
    }
    const group=groups.get(signature),index=ordered.indexOf(periodKey(r));
    const value=r.value_numeric??r.value_text??null;
    const display=typeof value==='number'?number(group.currency?value/1e6:value,3):readerValue(value);
    group.values[index].push(display);
    group.observations[index].push(r);
    group.exact[index].push(`${number(r.value_numeric,12)} ${r.unit||''}`.trim());
  }
  return {periods,observationCount:observations.length,rows:[...groups.values()].map(g=>({...g,
    values:g.values.map(v=>v.length?v.join(' / '):'Not disclosed'),exact:g.exact.map(v=>v.join(' / '))}))};
}

export function pricePath(rows){
  const years=[...new Set(rows.map(r=>r.fiscal_year))].sort();
  return {columns:['Year','Bear','Base','Bull'],rows:years.map(year=>[String(year),...['bear','base','bull'].map(s=>{
    const matches=rows.filter(r=>r.fiscal_year===year&&r.scenario_type===s);
    return matches.length?matches.map(r=>`$${Number(r.price_target).toFixed(2)}`).join(' / '):'Not disclosed';
  })])};
}

export function exhibitTitle(table){
  const paths={statistics:'Historical ranges and averages',diagnoses:'Trends and changes',unexplained_inflections:'Changes that still need an explanation',
    items:'Measures and monitoring thresholds',source_alignment:'Data used in the backtest',top_ten:'Leading backtest strategies',
    benchmark_conclusion:'Performance against benchmarks',required_historical_metrics:'Historical measures required',
    process_nodes:'Business activities and constraints',customer_groups:'Customers and decision criteria',drivers:'Operating assumptions and time lags',
    bottlenecks:'Constraints on growth',source_gaps:'Missing evidence',risks:'Risks and warning signs',catalysts:'Events that could change the outlook',
    assessments:'Evidence for competitive advantage',attacks:'Challenges to the competitive advantage',competitors:'How competitors could respond',
    scenarios:'Bear, base and bull assumptions',must_be_true:'What must hold for the thesis',breakers:'Conditions that would break the thesis',
    status_counts:'Backtest outcomes',framework_gate:'Backtest validation checks',weak_or_failed:'Lessons from weak and failed strategies',
    dilution_assumption:'Share count and dilution assumptions',tangible_book_nav_cross_check:'Tangible book value cross-check',
    terminal_anchor_base:'Base-case terminal price target',material_claims:'Evidence for the company’s origins',present_day_implications:'What the origins mean today',
    motivations:'Founder motivations',events:'Important decisions and their consequences',decision_patterns:'Patterns in management decisions'};
  if(paths[table.path])return paths[table.path];
  if(table.path==='observations')return 'Quarterly financial history';
  if(table.path==='ttm_series')return 'Trailing 12-month financial history';
  if(table.path==='price_target_path')return 'Price targets by scenario';
  if(table.path==='coverage.cells')return 'Historical data availability';
  if(table.path==='coverage.gaps')return 'Missing historical observations';
  if(table.path==='annual_projections')return 'Annual operating and per-share forecast';
  const titles={'decision record':'Investment decision','decision record rationale and decision status':'Investment decision and rationale',
    'expected return matrix':'Scenario return comparison','valuation scenario set':'Valuation assumptions',
    'valuation scenario set and probabilities':'Valuation assumptions and probabilities','no-moat counterfactual fields':'Economics without a durable advantage',
    'no-moat counterfactual':'Economics without a durable advantage','segment model segments':'How each business segment earns revenue',
    'top-down reconciliation blocked state':'Market size and forecast reconciliation','reverse valuation outputs':'Expectations implied by the current price'};
  return titles[table.title.toLowerCase()]||readerText(table.title).replace(/\bArtifact\b/gi,'Research').replace(/\bmatrix\b/gi,'comparison').replace(/\bregister\b/gi,'assessment');
}

export const chapterNames={
  executive_judgment_preview:'Investment perspective',genesis_and_founding_problem:'Origins',
  strategic_identity_evolution:'Business evolution',evidence_quality_and_conventions:'Evidence & limitations',
  reported_history_ttm:'Financial history',business_processes_customer_decisions:'How the business works',
  funding_liquidity_capital_constraints:'Funding & capital',lending_credit_capital_markets:'Lending & credit',
  financial_services_galileo_technisys:'Financial Services & technology',moat_test:'Competitive advantage',
  management_ownership_per_share:'Management & ownership',operating_drivers_reinvestment:'Growth & reinvestment',
  scenario_architecture:'Scenarios',valuation_residual_income_nav_reverse:'Valuation',
  downside_permanent_impairment:'Downside & permanent loss',monitoring_final_decision:'Monitoring & decision',
};

