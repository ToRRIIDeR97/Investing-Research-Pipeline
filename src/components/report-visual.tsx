"use client";

import { Fragment } from 'react';
import { Users, Landmark, FileText, ChartNoAxesColumnIncreasing, Building2, Laptop, Settings, MoveRight } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ReportDocument } from '@/lib/research/reporting/report';
import { buildVisual, historySeries, type BuiltVisual, type ChartVisual, type VisualSpec } from '@/lib/research/reporting/visuals';
import { SERIES_COLORS } from '@/lib/research/reporting/chart-series';
import { readerText } from '@/lib/research/reporting/presentation.mjs';
import styles from './research-report.module.css';

const icons={people:Users,bank:Landmark,document:FileText,chart:ChartNoAxesColumnIncreasing,building:Building2,technology:Laptop,settings:Settings};
export function ReportVisual({visual,document,onSource}:{visual:VisualSpec;document:ReportDocument;onSource:(id:string)=>void}) {
  const sources=(ids:string[])=>ids.map(id=><button key={id} className={styles.citation} onClick={()=>onSource(id)} aria-label={`Read source ${document.evidence.findIndex(e=>e.id===id)+1}`}>[{document.evidence.findIndex(e=>e.id===id)+1}]</button>);
  if(visual.kind==='organization'){
    const branch=(parent:string|null):React.ReactNode=><ul className={styles.orgChart}>{visual.people.filter(p=>p.reports_to===parent).map(p=><li key={p.id}><div><strong>{p.name}</strong><span>{p.role}</span>{sources(p.evidence_ids)}</div>{visual.people.some(child=>child.reports_to===p.id)&&branch(p.id)}</li>)}</ul>;
    return <figure className={styles.figure}><figcaption><h3>{visual.title}</h3><p>{visual.caption}</p><small>As of {visual.as_of}</small></figcaption>{branch(null)}</figure>;
  }
  if (visual.kind==='process') return <figure className={styles.figure}>
    <figcaption><h3>{readerText(visual.title)}</h3><p>{readerText(visual.caption)}</p></figcaption>
    {visual.lanes.map((lane,i)=><div className={styles.flowLane} key={i}>
      <ol className={styles.flow} aria-label={`Business pathway ${i+1}`}>
        {lane.nodes.map((node,j)=>{const Icon=icons[node.icon];return <Fragment key={j}>
          {j>0&&<li className={styles.connector} aria-hidden="true" data-hypothesis={lane.relationship==='hypothesis'}><MoveRight size={48} strokeWidth={1} preserveAspectRatio="none"/></li>}
          <li className={styles.flowNode}><span><Icon size={32} strokeWidth={1.5} aria-hidden="true"/></span><strong>{readerText(node.label)}</strong></li>
        </Fragment>;})}
      </ol>
      <p className={styles.flowNote}>{lane.relationship==='hypothesis'&&<em>Proposed relationship. </em>}{readerText(lane.note)}{sources(lane.evidence_ids)}</p>
    </div>)}
    <details className={styles.figureSources}><summary>Diagram sources and interpretation</summary>
      <p>Arrows summarize the supplied research. They do not represent measured cash volumes or prove causal effects.</p>
      {visual.lanes.map((lane,i)=><div key={i}><strong>{lane.nodes[0].label}</strong>{sources(lane.evidence_ids)}
        {lane.artifact_ids.map(id=><p key={id}>{readerText(document.artifacts.find(a=>a.id===id)?.artifact_type ?? 'Research')}</p>)}
      </div>)}
    </details>
  </figure>;
  if (visual.kind!=='history') return <ChartFigure visual={visual} chart={buildVisual(visual,document.artifacts)}/>;
  const series=historySeries(visual,document.artifacts);
  return <figure className={styles.figure}>
    <figcaption><h3>{readerText(visual.title)}</h3><p>{readerText(visual.caption)}</p><small>{series.unit} · Selected reported periods</small></figcaption>
    <div className={styles.chart} role="img" aria-label={`${visual.title}. ${series.unit}. Exact observations are in the data table below.`}>
      <ResponsiveContainer width="100%" height="100%"><BarChart data={series.points} margin={{top:16,right:12,bottom:32,left:12}} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="#e1e4e6"/><XAxis dataKey="period" tick={{fontSize:11,fill:'#626b78'}} angle={-30} textAnchor="end" height={50}/>
        <YAxis tick={{fontSize:11,fill:'#626b78'}} width={54} domain={[(v:number)=>Math.min(0,v),(v:number)=>Math.max(0,v)]} tickFormatter={v=>Number(v).toLocaleString('en-US',{notation:'compact'})}/>
        <Tooltip formatter={(v)=>[Number(v).toLocaleString('en-US',{maximumFractionDigits:3}),series.unit]}/>
        <Bar dataKey="value" fill="#515d70" isAnimationActive={false}/>
      </BarChart></ResponsiveContainer>
    </div>
    <details className={styles.figureSources}><summary>View underlying data</summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${visual.title} observations`}><table><thead><tr><th scope="col">Period</th><th scope="col">Reported value</th></tr></thead><tbody>{series.points.map(p=><tr key={p.key}><th scope="row">{p.period}</th><td>{p.exact}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

const TICK={fontSize:11,fill:'#626b78'};
const SCENARIO_COLORS=['#b5523f','#3d4a5f','#3f8f6b'];
// Amber marks pending or qualified status in the report, so charts leave it out.
const REPORT_COLORS=SERIES_COLORS.filter(c=>c!=='#c0862a');
const compact=(v:number)=>Number(v).toLocaleString('en-US',{notation:'compact',maximumFractionDigits:1});
const zeroDomain:[(v:number)=>number,(v:number)=>number]=[v=>Math.min(0,v),v=>Math.max(0,v)];
/** Series, ratio, scenario and bridge charts. Every number comes from buildVisual; exact values sit in the table below. */
function ChartFigure({visual,chart}:{visual:ChartVisual;chart:BuiltVisual}) {
  const colors=visual.kind==='scenarios'&&chart.display==='lines'?SCENARIO_COLORS:visual.kind==='ratio'?['#515d70']:REPORT_COLORS;
  const waterfall=chart.display==='waterfall',percent=chart.unit==='%';
  const data=chart.points.map(p=>({period:p.period,base:p.base,...Object.fromEntries(p.values.map((v,i)=>[`s${i}`,v==null?null:waterfall?Math.abs(v):v]))}));
  const format=(v:unknown)=>`${Number(v).toLocaleString('en-US',{maximumFractionDigits:percent?1:2})}${percent?'%':''}`;
  const slanted=chart.display==='lines'||chart.display==='stacked';
  return <figure className={styles.figure}>
    <figcaption><h3>{readerText(visual.title)}</h3><p>{readerText(visual.caption)}</p><small>{chart.unit}</small></figcaption>
    {chart.labels.length>1&&<ul className={styles.chartLegend}>{chart.labels.map((l,i)=><li key={l}><span aria-hidden="true" style={{background:colors[i%colors.length]}}/>{l}</li>)}</ul>}
    <div className={styles.chart} role="img" aria-label={`${visual.title}. ${chart.unit}. Exact values are in the data table below.`}>
      <ResponsiveContainer width="100%" height="100%"><ComposedChart data={data} margin={{top:16,right:12,bottom:slanted?32:8,left:12}} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="#e1e4e6"/>
        {slanted?<XAxis dataKey="period" tick={TICK} angle={-30} textAnchor="end" height={50}/>:<XAxis dataKey="period" tick={{...TICK,fontSize:10}} interval={0}/>}
        <YAxis tick={TICK} width={54} domain={chart.display==='lines'&&!percent?['auto','auto']:zeroDomain} tickFormatter={v=>percent?`${compact(v)}%`:compact(v)}/>
        <ReferenceLine y={0} stroke="#9aa1ab"/>
        {chart.reference&&<ReferenceLine y={chart.reference.value} ifOverflow="extendDomain" stroke="#626b78" strokeDasharray="5 4" label={{value:chart.reference.label,position:'insideTopRight',fontSize:11,fill:'#626b78'}}/>}
        <Tooltip isAnimationActive={false} formatter={(v,name,item)=>[waterfall?chart.points.find(p=>p.period===item?.payload?.period)?.exact[0]:format(v),chart.labels[Number(String(name).slice(1))]??String(name)]}/>
        {waterfall&&<Bar dataKey="base" stackId="w" fill="transparent" tooltipType="none" isAnimationActive={false}/>}
        {waterfall?<Bar dataKey="s0" name="s0" stackId="w" maxBarSize={64} isAnimationActive={false}>{chart.points.map(p=><Cell key={p.key} fill={p.total?'#515d70':(p.values[0]??0)<0?'#b5523f':'#3f8f6b'}/>)}</Bar>
          :chart.labels.map((l,i)=>chart.display==='lines'
            ?<Line key={l} dataKey={`s${i}`} name={`s${i}`} stroke={colors[i%colors.length]} strokeWidth={2} dot={{r:3,fill:'#fbfbf9',stroke:colors[i%colors.length],strokeWidth:2}} connectNulls={false} isAnimationActive={false}/>
            :<Bar key={l} dataKey={`s${i}`} name={`s${i}`} fill={colors[i%colors.length]} stackId={chart.display==='stacked'?'s':undefined} maxBarSize={64} isAnimationActive={false}/>)}
      </ComposedChart></ResponsiveContainer>
    </div>
    {chart.notes.map(n=><p className={styles.chartNote} key={n}>{n}</p>)}
    <details className={styles.figureSources}><summary>View underlying data</summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${visual.title} values`}><table>
      <thead><tr><th scope="col">{chart.category}</th>{chart.columns.map(c=><th scope="col" key={c}>{c}</th>)}</tr></thead>
      <tbody>{chart.points.map(p=><tr key={p.key}><th scope="row">{p.period}</th>{p.exact.map((v,i)=><td key={i}>{v}</td>)}</tr>)}</tbody>
    </table></div></details>
  </figure>;
}
