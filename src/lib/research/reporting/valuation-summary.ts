import {artifactContent,researchObservations} from './data-views';
import {kpiCandidateKeys,parseUnit} from './dashboard-series';
import {readerText} from './presentation.mjs';
import {moneyMillions,percent,plainLabel,price} from './plain-english';
import {withheldValuationReason} from '../valuation/contracts';
type Row=Record<string,any>;

export const scenarioTypes=['bear','base','bull'] as const;
export type ScenarioType=typeof scenarioTypes[number];
export const scenarioNames:Record<ScenarioType,string>={bear:'Bear',base:'Base',bull:'Bull'};

export type ScenarioValue={type:ScenarioType;value:number;probability:number|null;return:number|null};
export type CalcRow={label:string;values:(number|null)[];strong?:boolean};
export type PriceTargets={years:number[];values:(number|null)[];returns:(number|null)[];interpolated:boolean[]};
export type Calculation={type:ScenarioType;years:number[];rows:CalcRow[];steps:{text:string;value:string}[];valuePerShare:number|null;endValue:number|null;anchor:number|null;note:string|null;priceTargets:PriceTargets|null};
export type AssumptionRow={label:string;values:(string|null)[]};
export type NoteGroup={type:ScenarioType;method:string|null;rationale:string|null;sourceNotes:string[];bridge:string|null;assumptions:{year:number;label:string;value:string;note:string}[]};
/** A scenario whose cash-flow model, at the end of its last year, does not give the scenario value. */
export type Disagreement={type:ScenarioType;year:number|null;model:number;scenario:number};
export type ValuationSummary={
  currency:string;terminalYear:number|null;weighted:number|null;weightedReturn:number|null;
  price:number|null;priceDate:string|null;priceVerified:boolean;notFinal:boolean;scenarios:ScenarioValue[];
  disagreements:Disagreement[];reasons:{title:string;text:string}[];calculations:Calculation[];method:string|null;
  assumptions:AssumptionRow[];priceImplies:string[];issues:string[];notes:NoteGroup[];omitted:{method:string;reason:string}[];
};

const num=(v:unknown)=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
const pick=(record:Row|undefined,keys:string[])=>{for(const k of keys){const v=num(record?.[k]);if(v!=null)return v;}return null;};
const revenueKeys=['consolidated_revenue','total_revenue','revenue','net_revenue','revenues'];
const profitKeys=['consolidated_operating_income','operating_income','income_from_operations','ebit'];
const capexKeys=['capex','capital_expenditure','capital_expenditures','purchases_of_property_and_equipment'];
const marginKeys=['consolidated_operating_margin','operating_margin'];
const range=(values:number[],format:(v:number)=>string)=>{const lo=Math.min(...values),hi=Math.max(...values);const a=format(lo),b=format(hi);return a===b?a:a.endsWith('%')&&b.endsWith('%')?`${a.slice(0,-1)}–${b}`:`${a}–${b}`;};
const pct0=(r:number)=>`${Math.round(r*100)}%`;
const pctRange=(values:number[])=>values.length?range(values,pct0):null;
/** 2026-10-12 → 12 October 2026 (the report's date style); other text is returned as is. */
export function longDate(value:unknown):string|null {
  const text=String(value??'').trim();if(!text)return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(text);if(!m)return text;
  return new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
}
const caseList=(types:ScenarioType[])=>{const n=types.map(t=>scenarioNames[t].toLowerCase());return n.length>1?`${n.slice(0,-1).join(', ')} and ${n.at(-1)} cases`:`${n[0]} case`;};
/** Gaps the valuation code writes, in reader terms; anything else goes through readerText. */
function gapText(gap:unknown):string {
  const text=readerText(gap);
  const bridge=/^Equity bridge items not captured: (.+?)\.?$/i.exec(text);
  if(bridge)return `Some balance-sheet items aren’t captured, so the step from business value to share value is incomplete: ${bridge[1].toLowerCase()}.`;
  if(/^No balance-sheet items were captured for the equity bridge/i.test(text))return 'No balance-sheet items were captured, so cash and debt aren’t counted in the value per share.';
  if(/^No dividend forecast/i.test(text))return 'No dividends are forecast, so the value per share includes none.';
  return text;
}
/** Rate as %, with one decimal only when needed (9%, 9.5%). */
const rate=(r:number|null)=>r==null?'–':percent(r,Math.round(r*1000)%10===0?0:1);

/** Driver value as text: ratios as %, currency millions as $B, other numbers plain. */
function driverValue(value:unknown,unit:unknown,currency:string):string|null {
  const v=num(value);if(v==null)return null;
  const u=String(unit??'').toLowerCase();
  if(/ratio|percent|%|decimal|margin|growth|rate/.test(u)&&Math.abs(v)<=1.5)return percent(v);
  if(/million/.test(u)&&/\b[a-z]{3}\b/.test(u))return moneyMillions(v,currency);
  if(/thousand/.test(u)&&/\b[a-z]{3}\b/.test(u))return moneyMillions(v/1000,currency);
  return new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v);
}

/** Latest annual revenue and operating income from captured filings (whole currency units). */
function latestActual(artifacts:Row[]):{year:number;revenue:number;profit:number|null}|null {
  const annual=researchObservations(artifacts).filter(r=>r.periodicity==='annual'&&!r.segment&&!r.geography&&Number.isFinite(Number(r.value_numeric)));
  const find=(keys:string[],year:number)=>{const r=annual.find(r=>keys.includes(r.metric_key)&&r.fiscal_year===year&&parseUnit(r.unit)?.currency);return r?Number(r.value_numeric)*parseUnit(r.unit)!.scale:null;};
  const revKeys=kpiCandidateKeys('total_revenue'),opKeys=kpiCandidateKeys('income_from_operations');
  const years=[...new Set(annual.filter(r=>revKeys.includes(r.metric_key)).map(r=>Number(r.fiscal_year)))].sort((a,b)=>b-a);
  for(const year of years){const revenue=find(revKeys,year);if(revenue)return {year,revenue,profit:find(opKeys,year)};}
  return null;
}

export function valuationSummary(artifacts:Row[],options:{conclusionStatus?:string}={}):ValuationSummary|null {
  const valuation=artifactContent(artifacts,'valuation_scenario_set');
  // A withheld valuation has zero placeholder anchors, never price targets.
  if(withheldValuationReason(valuation))return null;
  const operating=artifactContent(artifacts,'operating_scenario_set');
  const returns=artifactContent(artifacts,'expected_return_matrix');
  const decision=artifactContent(artifacts,'decision_record');
  const reconciliation=artifactContent(artifacts,'top_down_bottom_up_reconciliation');
  const path=artifactContent(artifacts,'annual_price_target_path');
  const segments=[...((artifactContent(artifacts,'segment_model').segments??[]) as Row[]).map(s=>s.segment_name),...((artifactContent(artifacts,'monitoring_dashboard').items??[]) as Row[]).map(i=>i.segment)].filter((n):n is string=>typeof n==='string'&&!!n.trim());
  const label=(key:unknown)=>plainLabel(key,segments);
  const schedules:Row[]=Array.isArray(valuation.method_schedules)?valuation.method_schedules:[];
  const opScenarios:Row[]=Array.isArray(operating.scenarios)?operating.scenarios:[];
  const anchors=Object.fromEntries(scenarioTypes.map(t=>[t,num(valuation[`terminal_anchor_${t}`])])) as Record<ScenarioType,number|null>;
  if(!scenarioTypes.some(t=>anchors[t]!=null)&&!schedules.length)return null;

  const currency=String(schedules[0]?.currency??path.currency??'USD');
  const terminalYear=num(valuation.terminal_year);
  const marketPrice=num(valuation.current_market_price);
  const source=valuation.current_market_price_source;
  const priceVerified=!!source&&source.verified===true;
  const probability=(t:ScenarioType)=>num(valuation[`probability_${t}`])??num(operating[`probability_${t}`]);
  const ret=(value:number|null,stored:unknown)=>num(stored)??(value!=null&&marketPrice?value/marketPrice-1:null);
  const scenarios=scenarioTypes.flatMap(t=>anchors[t]==null?[]:[{type:t,value:anchors[t]!,probability:probability(t),return:ret(anchors[t],returns[`${t}_return`])}]);
  const weighted=num(valuation.weighted_target)??(scenarios.length===3&&scenarios.every(s=>s.probability!=null)?scenarios.reduce((n,s)=>n+s.value*s.probability!,0):null);
  const weightedReturn=ret(weighted,returns.probability_weighted_return);

  const schedule=(t:ScenarioType)=>schedules.find(s=>s.scenario_type===t&&s.method==='fcff')??schedules.find(s=>s.scenario_type===t);
  const statement=(t:ScenarioType)=>opScenarios.find(s=>s.scenario_type===t)?.resulting_financial_statements_json;
  const yearRecord=(t:ScenarioType,y:number)=>statement(t)?.years?.[y]??statement(t)?.years?.[String(y)];
  const statementScale=(t:ScenarioType)=>{const u=parseUnit(statement(t)?.units);return u?u.scale/1e6:1;};
  const line=(t:ScenarioType,y:number,keys:string[])=>{const v=pick(yearRecord(t,y),keys);return v==null?null:v*statementScale(t);};
  const margin=(t:ScenarioType,y:number)=>{const m=pick(yearRecord(t,y),marginKeys);if(m!=null)return m;const r=line(t,y,revenueKeys),p=line(t,y,profitKeys);return r&&p!=null?p/r:null;};

  // Yearly value per share from the annual price-target path, per scenario.
  const pathRows:Row[]=Array.isArray(path.price_target_path)?path.price_target_path:[];
  const priceTargets=(t:ScenarioType):PriceTargets|null=>{
    const rows=pathRows.filter(r=>r.scenario_type===t&&num(r.fiscal_year)!=null).sort((a,b)=>Number(a.fiscal_year)-Number(b.fiscal_year));
    if(!rows.some(r=>num(r.price_target)!=null))return null;
    const values=rows.map(r=>num(r.price_target));
    return {years:rows.map(r=>Number(r.fiscal_year)),values,
      returns:rows.map((r,i)=>num(r.total_return_target)??(values[i]!=null&&marketPrice?values[i]!/marketPrice-1:null)),
      interpolated:rows.map(r=>r.is_interpolated===true)};
  };

  // How the value is calculated, per scenario.
  const calculations:Calculation[]=scenarioTypes.flatMap(t=>{
    const s=schedule(t);
    const targets=priceTargets(t);
    const years:number[]=s?.years?.length?s.years.map((y:Row)=>Number(y.fiscal_year)):Object.keys(statement(t)?.years??{}).map(Number).filter(Number.isFinite).sort();
    if(!years.length&&!targets)return [];
    const rows:CalcRow[]=[
      {label:'Revenue',values:years.map(y=>line(t,y,revenueKeys))},
      {label:'Operating profit',values:years.map(y=>line(t,y,profitKeys))},
      {label:'Capital expenditure',values:years.map(y=>{const v=line(t,y,capexKeys);return v==null?null:-Math.abs(v);})},
      {label:'Free cash flow',values:years.map(y=>num(s?.years?.find((r:Row)=>Number(r.fiscal_year)===y)?.cash_flow)),strong:true},
    ].filter(r=>r.values.some(v=>v!=null));
    const steps:{text:string;value:string}[]=[];const m=(v:unknown)=>moneyMillions(num(v),currency);
    if(s){
      const last=years.at(-1),tv=num(s.terminal_value);
      if(s.terminal?.type==='multiple'&&tv!=null)steps.push({text:`Value the business at the end of ${last} at ${s.terminal.multiple} times ${plainLabel(s.terminal.metric).toLowerCase()}`,value:m(tv)});
      else if(s.terminal?.type==='perpetuity'&&tv!=null)steps.push({text:`Value the business beyond ${last} assuming cash flow grows ${rate(num(s.terminal.growth_rate))} a year`,value:m(tv)});
      const bridge=num(s.equity_bridge),discount=num(s.discount_rate);
      if(num(s.equity_value)!=null&&discount!=null){
        const adjust=bridge==null||bridge===0?'':bridge<0?`, then subtract ${m(-bridge)} of debt`:`, then add ${m(bridge)} of net cash`;
        steps.push({text:`Bring that and the ${years.length} years of cash flow back to today at ${rate(discount)} a year${adjust}`,value:m(s.equity_value)});
      }
      const shares=num(s.diluted_shares),vps=num(s.value_per_share);
      if(shares!=null&&vps!=null)steps.push({text:`Divide by ${Math.round(shares).toLocaleString('en-US')}M shares`,value:`${price(vps,currency)} a share`});
    }
    // The anchor is a terminal-year value, so it is checked against the schedule's value at the end of its last year.
    const vps=num(s?.value_per_share),anchor=anchors[t],tv=num(s?.terminal_value),shares=num(s?.diluted_shares);
    const endValue=tv!=null&&shares?(tv+(num(s?.equity_bridge)??0))/shares:null;
    const note=endValue!=null&&anchor!=null&&Math.abs(endValue-anchor)>0.01*Math.abs(anchor)
      ?`At the end of ${years.at(-1)} this gives ${price(endValue,currency)}, ${endValue<anchor?'lower':'higher'} than the ${price(anchor,currency)} scenario value above. The two haven’t been reconciled yet, which is why the result is marked not final.`:null;
    return [{type:t,years,rows,steps,valuePerShare:vps,endValue,anchor,note,priceTargets:targets}];
  });

  // Three reasons, computed from the base case (omitted when the data is not there).
  const reasons:{title:string;text:string}[]=[];
  const base=calculations.find(c=>c.type==='base');
  const actual=latestActual(artifacts);
  const ty=terminalYear??base?.years.at(-1)??null;
  if(base?.years.length){
    const rev=base.years.map(y=>line('base',y,revenueKeys));
    const prior=(i:number)=>i>0?rev[i-1]:actual&&actual.year===base.years[0]-1?actual.revenue/1e6:null;
    const growth=rev.map((v,i)=>{const p=prior(i);return v!=null&&p?v/p-1:null;});
    const gi=growth.findIndex(g=>g!=null),first=gi<0?null:growth[gi],last=growth.at(-1);
    if(first!=null&&last!=null&&gi<growth.length-1){
      const verb=last<first-0.01?'eases':last>first+0.01?'rises':'holds';
      reasons.push({title:verb==='eases'?'Growth slows.':verb==='rises'?'Growth speeds up.':'Growth holds steady.',
        text:`In the base case, revenue growth ${verb} from about ${pct0(first)} in ${base.years[gi]} to ${pct0(last)} by ${base.years.at(-1)}.`});
    }
    const capex=base.years.map(y=>line('base',y,capexKeys)),cash=base.rows.find(r=>r.label==='Free cash flow')?.values??[];
    const s=schedule('base'),lastYear=base.years.at(-1)!;
    const afterTax=s?.terminal?.type==='multiple'&&/nopat|after[_\s-]*tax/i.test(String(s.terminal.metric))?num(s.terminal.metric_value):null;
    const profit=line('base',lastYear,profitKeys),lastCapex=capex.at(-1);
    if(lastCapex!=null&&(afterTax!=null||profit!=null)){
      const known=capex.filter((v):v is number=>v!=null);
      const negative=cash.length&&cash.every(v=>v!=null&&v<0),positive=cash.length&&cash.every(v=>v!=null&&v>0);
      const earn=afterTax??profit!,more=lastCapex>earn,first=known[0],m=(v:number)=>moneyMillions(v,currency);
      const comparison=afterTax!=null?`${more?'more':'less'} than the ${m(afterTax)} the business earns after tax that year`:`${more?'more':'less'} than that year’s operating profit of ${m(profit!)}`;
      const falls=lastCapex<first*0.95;
      const path=lastCapex>first*1.05?`climbs from ${m(first)} to ${m(lastCapex)} a year by ${lastYear}`:falls?`falls from ${m(first)} to ${m(lastCapex)} a year by ${lastYear}`:`stays around ${range(known,m)} a year through ${lastYear}`;
      // The first year from which free cash flow stays positive, when it starts negative.
      const turn=!cash.length||negative||positive?undefined:base.years.find((_,i)=>cash.slice(i).every(v=>v!=null&&v>0));
      const tail=negative?`, so free cash flow stays negative through ${lastYear}`:positive?', leaving positive free cash flow':turn!=null?`. Free cash flow turns positive in ${turn}`:'';
      reasons.push({title:negative?'Spending eats the cash.':falls&&turn!=null?'Spending peaks, then eases.':more?'Spending outpaces profit.':'Spending is covered.',
        text:`In the base case, capital expenditure ${path}, ${falls?'still ':''}${comparison}${tail}.`});
    }
    const endMargin=(t:ScenarioType)=>{const y=calculations.find(c=>c.type===t)?.years.at(-1);return y==null?null:margin(t,y);};
    const margins=scenarioTypes.map(endMargin).filter((v):v is number=>v!=null),baseMargin=endMargin('base');
    if(baseMargin!=null&&actual?.profit!=null){
      const was=actual.profit/actual.revenue;
      reasons.push({title:baseMargin<was-0.01?'Margins narrow.':baseMargin>was+0.01?'Margins widen.':'Margins hold.',
        text:`In the base case, operating margin settles at ${pct0(baseMargin)} by ${lastYear}${margins.length>1?` (${range(margins,pct0)} across the ${margins.length===3?'three':'two'} cases)`:''}, against ${pct0(was)} in FY${actual.year}.`});
    }
  }

  // Key assumptions for the terminal year, across scenarios.
  const assumptionRows=new Map<string,(string|null)[]>();
  for(const s of opScenarios){
    const i=scenarioTypes.indexOf(s.scenario_type);if(i<0)continue;
    for(const a of (s.numeric_assumptions??[]) as Row[]){
      if(ty==null||Number(a.fiscal_year)!==ty)continue;
      const name=label(a.driver_key);const values=assumptionRows.get(name)??[null,null,null];
      values[i]=driverValue(a.value,a.unit,currency);assumptionRows.set(name,values);
    }
  }
  const assumptions:AssumptionRow[]=[...assumptionRows].map(([label,values])=>({label,values}));
  const perScenario=(f:(s:Row)=>string|null)=>scenarioTypes.map(t=>{const s=schedule(t);return s?f(s):null;});
  const multiples=perScenario(s=>s.terminal?.type==='multiple'&&num(s.terminal.multiple)!=null?`${s.terminal.multiple}×`:null);
  if(multiples.some(Boolean))assumptions.push({label:'Exit multiple',values:multiples});
  const growthRates=perScenario(s=>s.terminal?.type==='perpetuity'?percent(num(s.terminal.growth_rate)):null);
  if(growthRates.some(Boolean))assumptions.push({label:'Long-run growth',values:growthRates});
  const rates=perScenario(s=>num(s.discount_rate)==null?null:rate(num(s.discount_rate)));
  if(rates.some(Boolean))assumptions.push({label:'Discount rate',values:rates});
  const methodKey=Array.isArray(valuation.methods)&&valuation.methods.length===1?valuation.methods[0]:schedules[0]?(schedules[0].method==='fcff'?`fcff_dcf_${schedules[0].terminal?.type==='multiple'?'terminal_multiple':'perpetuity'}`:schedules[0].method):null;

  // Why it's not final.
  const issues:string[]=[];
  const disagreements:Disagreement[]=calculations.filter(c=>c.note).map(c=>({type:c.type,year:c.years.at(-1)??null,model:c.endValue!,scenario:c.anchor!}));
  if(disagreements.length)issues.push(`The cash-flow model and the scenario values disagree in the ${caseList(disagreements.map(d=>d.type))}: ${disagreements.map(d=>
    `the ${scenarioNames[d.type].toLowerCase()} model gives ${price(d.model,currency)}${d.year!=null?` at the end of ${d.year}`:''}, against a scenario value of ${price(d.scenario,currency)}`).join('; ')}. Until they’re reconciled, the scenario values can change.`);
  const priceDate=longDate(source?.trading_date);
  if(marketPrice!=null&&!priceVerified)issues.push(!priceDate
    ?`${price(marketPrice,currency,true)} is an unchecked price snapshot, not a recorded close.`
    :source?.verification_status==='mismatch'
      ?`The ${price(marketPrice,currency,true)} close on ${priceDate} doesn’t match the second price source.`
      :`The ${price(marketPrice,currency,true)} close on ${priceDate} hasn’t been checked against a second price source.`);
  if(decision.decision==='pending')issues.push('The investment decision is still pending human review.');
  else if(options.conclusionStatus==='withheld')issues.push('The report’s conclusion is withheld until open evidence gaps are resolved.');
  for(const gap of (Array.isArray(valuation.source_gaps)?valuation.source_gaps:[]))issues.push(gapText(gap));
  if(reconciliation.reconciliation_status&&!/^(reconciled|satisfied|passed|complete)/.test(reconciliation.reconciliation_status))
    issues.push('The bottom-up revenue forecast hasn’t been checked against a sourced market-size limit yet.');
  if(valuation.segments_reconciled===false)issues.push('Segment forecasts don’t yet add up to the consolidated forecast.');
  const notFinal=issues.length>0||options.conclusionStatus==='withheld';

  // Sources and analyst notes: raw text, kept for checking the work.
  const notes:NoteGroup[]=scenarioTypes.flatMap(t=>{
    const s=schedule(t),o=opScenarios.find(x=>x.scenario_type===t);
    if(!s&&!o)return [];
    const assumptions=((o?.numeric_assumptions??[]) as Row[]).map(a=>({year:Number(a.fiscal_year),label:label(a.driver_key),value:driverValue(a.value,a.unit,currency)??'–',note:a.rationale?readerText(a.rationale):''}));
    return [{type:t,method:s?.method_name?readerText(s.method_name):null,rationale:s?.rationale?readerText(s.rationale):null,
      sourceNotes:(s?.source_notes??[]).map((n:unknown)=>readerText(n)),bridge:s?.equity_bridge_explanation?readerText(s.equity_bridge_explanation):null,assumptions}];
  });
  // A free-text method name keeps its capitals (EV/EBITDA); only keys are relabelled.
  const methodName=(v:unknown)=>/\s/.test(String(v??'').trim())?readerText(String(v).trim()):plainLabel(v);
  const omitted=((valuation.omitted_methods??[]) as Row[]).map(m=>({method:methodName(m.method),reason:readerText(m.reason)}));

  // What the price implies: the reverse valuation set against the scenarios' own margins and growth.
  const priceImplies:string[]=[];
  const reverse=artifactContent(artifacts,'reverse_valuation');
  if(marketPrice!=null&&reverse.artifact_type==='reverse_valuation'){
    const impliedMargin=num(reverse.implied_margin),impliedGrowth=num(reverse.implied_growth);
    const modelled=calculations.flatMap(c=>c.years.map(y=>({t:c.type,y})));
    const scenarioMargins=modelled.map(({t,y})=>margin(t,y)).filter((v):v is number=>v!=null);
    const scenarioGrowth=modelled.flatMap(({t,y})=>{const r=line(t,y,revenueKeys),p=line(t,y-1,revenueKeys)??(actual?.year===y-1?actual.revenue/1e6:null);return r!=null&&p?[r/p-1]:[];});
    const through=ty!=null?` through ${ty}`:'',at=`the ${price(marketPrice,currency)} last price`;
    const compare=(implied:number,values:number[])=>{
      const r=pctRange(values);if(!r)return '';
      return implied>Math.max(...values)+0.005?` Every scenario assumes less: ${r}.`:implied<Math.min(...values)-0.005?` Every scenario assumes more: ${r}.`:` The scenarios assume ${r}.`;
    };
    const lead=`To be worth ${at}, the base case would need`;
    if(impliedMargin!=null)priceImplies.push(`${lead} an operating margin of about ${pct0(impliedMargin)} a year${through} (at base-case growth).${compare(impliedMargin,scenarioMargins)}`);
    if(impliedGrowth!=null)priceImplies.push(`${impliedMargin!=null?'Or':lead} revenue growth of about ${pct0(impliedGrowth)} a year${through} (at base-case margins).${compare(impliedGrowth,scenarioGrowth)}`);
    if(impliedMargin==null&&impliedGrowth==null)priceImplies.push(`No operating margin or growth rate in the range tested makes the base case worth ${at}.`);
    // Code-built reverse valuations record their method; older ones were written by the analyst.
    else if(!reverse.method)priceImplies.push('These figures are the analyst’s own estimate, not solved from the cash-flow model, so treat them as unchecked.');
  }

  return {currency,terminalYear:ty,weighted,weightedReturn,price:marketPrice,priceDate,priceVerified,notFinal,scenarios,disagreements,reasons,calculations,
    method:methodKey?plainLabel(methodKey):null,assumptions,priceImplies,issues,notes,omitted};
}
