"use client";
import {useState} from 'react';
import {LineChart,Line,ResponsiveContainer,Tooltip,XAxis} from 'recharts';
import {artifactContent,kpiMetricKey,researchObservations} from '@/lib/research/reporting/data-views';
import {forecastTableRows,kpiSeries} from '@/lib/research/reporting/dashboard-series';
import {label,number,safeUrl} from '@/lib/research/reporting/presentation.mjs';
import styles from './financial-statements.module.css';
type Row=Record<string,any>;
const fmt=(value:unknown)=>number(value,3);
const rateParameter=(key:string)=>['cost_of_equity','discount_rate','wacc','terminal_growth_rate'].includes(key);
const parameter=(t:Row)=>rateParameter(t.valuation_parameter_key)?`${fmt(t.valuation_parameter_value*100)}%`:`${fmt(t.valuation_parameter_value)} ×`;
export function KPIDashboard({artifacts,compact=false,onRefresh,refreshing=false}:{artifacts:Row[];compact?:boolean;onRefresh?:()=>void;refreshing?:boolean}) {
 const observations=researchObservations(artifacts);const items:Row[]=artifactContent(artifacts,'monitoring_dashboard').items??[];
 const [query,setQuery]=useState('');
 return <section className={compact?styles.embedded:styles.financials}>
   <header className={styles.heading}><div>{compact?<h2>KPIs to monitor</h2>:<h1>KPI Dashboard</h1>}<p>Quarterly performance and thesis thresholds</p></div>{onRefresh&&<button className={styles.textLink} disabled={refreshing} onClick={onRefresh}>{refreshing?'Refreshing…':'Refresh data'}</button>}</header>
   {!compact&&<input className={styles.search} type="search" placeholder="Find a KPI" aria-label="Find a KPI" value={query} onChange={e=>setQuery(e.target.value)}/>}
   <p className={styles.note}>Updates reflect captured company disclosures. Thresholds are analyst assumptions.</p>
   {!items.length&&<p className={styles.empty}>No monitoring KPIs have been defined for this run.</p>}
   {items.filter(item=>String(item.kpi).toLowerCase().includes(query.toLowerCase())).map((item,i)=>{
     const series=kpiSeries(item,observations,kpiMetricKey(item,observations));const latest=series.points.at(-1);const prior=series.points.at(-2);
     const ordinal=(p:string)=>Number(p.slice(0,4))*4+Number(p.at(-1));
     const consecutive=latest&&prior&&ordinal(latest.period)-ordinal(prior.period)===1;
     const delta=consecutive&&latest?.value!=null&&prior?.value!=null?latest.value-prior.value:null;
     const percentUnit=['%','percent','percentage points'].includes(String(series.unit).toLowerCase());
     const change=!percentUnit&&delta!==null&&prior?.value?delta/Math.abs(prior.value)*100:null;
     const latestRow=series.rows.at(-1);const url=safeUrl(latestRow?.metadata_json?.source_url);
     return <section className={styles.kpi} key={`${item.kpi}-${i}`}><div><h3>{item.kpi}</h3>{item.definition&&<p className={styles.note}>{item.definition}</p>}<p className={styles.kpiValue}>{!series.reason&&latest?.value!=null?fmt(latest.value):fmt(item.current_level)} <small>{!series.reason?series.unit:item.unit??''}</small></p><p className={styles.note}>{latest?.period??item.period_end??'Latest saved observation'}{delta!==null?` · ${delta>0?'+':''}${fmt(delta)} ${percentUnit?'percentage points':series.unit} QoQ${change!==null?` (${fmt(change)}%)`:''}`:' · Comparable prior quarter unavailable'}</p>{url&&<a className={styles.textLink} href={url} target="_blank" rel="noreferrer">Source filing</a>}</div>
     <div>{series.reason?<p className={styles.note}>Quarterly series unavailable. {series.reason}</p>:<><div className={styles.kpiChart} role="img" aria-label={`${item.kpi} quarterly history, ${series.unit}`}><ResponsiveContainer width="100%" height="100%"><LineChart data={series.points} margin={{top:12,right:8,bottom:4,left:8}}><XAxis dataKey="period" tick={{fontSize:11}}/><Line dataKey="value" stroke="#596b88" dot={{r:3}} connectNulls={false} isAnimationActive={false}/><Tooltip/></LineChart></ResponsiveContainer></div><details className={styles.chartData}><summary>Quarterly values</summary><ul>{series.points.map(p=><li key={p.period}>{p.period}: {fmt(p.value)} {series.unit}</li>)}</ul></details></>}</div>
     <dl className={styles.thresholds}><div><dt>Bear</dt><dd>{fmt(item.bear_threshold)} {item.unit??latestRow?.unit??'Unit not specified'}</dd></div><div><dt>Base</dt><dd>{item.base_range}</dd></div><div><dt>Bull</dt><dd>{fmt(item.bull_threshold)} {item.unit??latestRow?.unit??'Unit not specified'}</dd></div><div><dt>Affects</dt><dd>{label(item.model_input_affected)}</dd></div></dl></section>;
   })}
 </section>;
}

function NumericTable({title,columns,rows}:{title:string;columns:string[];rows:(string|number|null|undefined)[][]}) {
 return <section className={styles.schedule}><h3>{title}</h3><div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}><table><thead><tr>{columns.map((c,i)=><th key={i} scope="col">{c}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{r.map((v,j)=>j===0?<th key={j} scope="row">{v}</th>:<td key={j}>{typeof v==='number'?fmt(v):v??'Unavailable'}</td>)}</tr>)}</tbody></table></div></section>;
}
export function ValuationDashboard({artifacts}:{artifacts:Row[]}) {
 const path=artifactContent(artifacts,'annual_price_target_path'),scenarios=artifactContent(artifacts,'operating_scenario_set');
 const projections:Row[]=path.annual_projections??[], targets:Row[]=path.price_target_path??[];
 const cases=['bear','base','bull'];const years=[...new Set(targets.map(t=>t.fiscal_year))].sort();
 const assumptions:Row[]=(scenarios.scenarios??[]).flatMap((s:Row)=>(s.numeric_assumptions??[]).map((a:Row)=>({...a,scenario:s.scenario_type})));
 const forecastRows=(group:string)=>forecastTableRows(projections,group,path.currency);
 const valuation=artifactContent(artifacts,'valuation_scenario_set');const models:Row[]=valuation.method_schedules??[];
 return <div className={styles.embedded}>
 <NumericTable title="Scenario assumptions" columns={['Case','Year','Assumption','Value','Unit','Rationale']} rows={assumptions.length?assumptions.map(a=>[label(a.scenario),String(a.fiscal_year),label(a.driver_key),a.value,a.unit,a.rationale]):targets.map(t=>[label(t.scenario_type),String(t.fiscal_year),label(t.valuation_parameter_key),rateParameter(t.valuation_parameter_key)?t.valuation_parameter_value*100:t.valuation_parameter_value,rateParameter(t.valuation_parameter_key)?'%':'×',label(t.valuation_method)])}/>
 {!assumptions.length&&<p className={styles.note}>Recorded valuation inputs. Operating-driver assumptions were not saved as a numerical schedule.</p>}
 {projections.length>0&&['operating_values','balance_sheet_values','per_share_values'].map((group,i)=><NumericTable key={group} title={['Annual operating forecast','Capital and share forecast','Per-share forecast'][i]} columns={['Measure',...projections.map((p,i)=>`Year ${i+1} · ${p.fiscal_year}`)]} rows={forecastRows(group)}/>)}
 <NumericTable title={`Bear, Base and Bull price targets · ${path.currency??''} per share`} columns={['Year',...cases.map(label)]} rows={years.map(y=>[y,...cases.map(c=>targets.find(t=>t.fiscal_year===y&&t.scenario_type===c)?.price_target)])}/>
 {cases.map(c=><NumericTable key={c} title={`${label(c)} valuation schedule`} columns={['Year','Method','Operating input','Input value','Parameter','Parameter value','Value / share']} rows={targets.filter(t=>t.scenario_type===c).map(t=>[t.fiscal_year,label(t.valuation_method),label(t.operating_metric_key),t.operating_metric_value,label(t.valuation_parameter_key),parameter(t),t.price_target])}/>)}
 {models.map((m,i)=><section key={i}><h3>{m.method_name} · {label(m.scenario_type)}</h3><p className={styles.note}>{m.rationale}</p><p>Discount rate: {fmt(m.discount_rate*100)}% · Amounts and diluted shares in millions</p><p>{m.terminal?.type==='perpetuity'?`Terminal growth: ${fmt(m.terminal.growth_rate*100)}%`:`Terminal ${label(m.terminal?.metric)}: ${fmt(m.terminal?.metric_value)} × ${fmt(m.terminal?.multiple)}`}</p><NumericTable title={`Year-by-year valuation · ${m.currency}`} columns={['Year',m.cash_flow_label??'Cash flow','Discount factor','Present value']} rows={(m.years??[]).map((y:Row)=>[y.fiscal_year,y.cash_flow,y.discount_factor,y.present_value])}/><p>Terminal value: {fmt(m.terminal_value)} · Present value of terminal: {fmt(m.terminal_present_value)} · Equity bridge: {fmt(m.equity_bridge)} · Equity value: {fmt(m.equity_value)} · Diluted shares: {fmt(m.diluted_shares)} · Value per share: {fmt(m.value_per_share)}</p><p className={styles.note}>{m.equity_bridge_explanation}</p></section>)}
 {(valuation.omitted_methods??[]).map((m:Row,i:number)=><p className={styles.note} key={i}>{label(m.method)}: {m.reason}</p>)}
 {!models.length&&<p className={styles.note}>This saved run has no complete discounted cash-flow schedule. The tables above show its recorded valuation calculations.</p>}
 </div>;
}
