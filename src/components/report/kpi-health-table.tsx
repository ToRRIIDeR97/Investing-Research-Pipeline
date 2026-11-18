"use client";
import {Fragment,useId,useMemo,useState} from 'react';
import {kpiHealth,quarterLabel,statusLabels,type KpiStatus} from '@/lib/research/reporting/kpi-health';
import {label,readerText} from '@/lib/research/reporting/presentation.mjs';
import styles from './report-panels.module.css';
type Row=Record<string,any>;
type Shown=KpiStatus|'stale'|'single'|'none';
/** A count without a noun ("16M") takes one from the KPI name: members, shares, products, accounts. */
const nounFor=(value:string,name:string)=>!/^[−-]?[\d,.]+[MBK]?$/.test(value)?'':/member/i.test(name)?'members':/share|dilution/i.test(name)?'shares':/product/i.test(name)?'products':/account/i.test(name)?'accounts':'';
const shownLabels:Record<Shown,string>={...statusLabels,stale:'Stale',single:'One reading',none:'No reading'};
const shownTitles:Partial<Record<Shown,string>>={stale:'The latest reading is from an earlier quarter, so it says nothing about now.',single:'Only one reading has been captured, so there is no trend to judge.'};
const shownOf=(r:{status:KpiStatus|null;stale:boolean;hasHistory:boolean}):Shown=>r.status==null?'none':r.stale?'stale':!r.hasHistory?'single':r.status;

const Chevron=()=><svg className={styles.chev} width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6 4 9.5" stroke="#6b7280" strokeWidth="1.6" fill="none" strokeLinecap="round"/></svg>;

export function KpiHealthTable({artifacts,compact=false,onRefresh,refreshing=false}:{artifacts:Row[];compact?:boolean;onRefresh?:()=>void;refreshing?:boolean}) {
  const model=useMemo(()=>kpiHealth(artifacts),[artifacts]);
  const [open,setOpen]=useState<Record<string,boolean>>({});
  const uid=useId();
  const Heading=compact?'h3':'h1';
  const rows=model.groups.reduce((n,g)=>n+g.rows.length,0);
  const counts=model.groups.flatMap(g=>g.rows).reduce((c,r)=>{const k=shownOf(r);c[k]=(c[k]??0)+1;return c;},{} as Partial<Record<Shown,number>>);
  const order:Shown[]=['healthy','caution','danger','single','stale','none'];
  const all=model.groups.flatMap(g=>g.rows);
  // A quarter with no reading for any KPI adds a column of dashes; leave it out.
  const keep=model.periods.map((_,j)=>all.some(r=>r.history[j]!=null));
  const periods=model.periods.filter((_,j)=>keep[j]);
  // Two KPIs with the same series (the run sometimes defines one measure twice) show once.
  const groups=model.groups.map(g=>{const seen=new Map<string,{row:typeof g.rows[number];names:string[]}>();
    for(const r of g.rows){const key=JSON.stringify([r.history,r.latest,r.latestPeriod]);const hit=r.latest!=='–'?seen.get(key):undefined;if(hit)hit.names.push(r.name);else seen.set(r.latest!=='–'?key:`${key}${r.name}`,{row:r,names:[r.name]});}
    return {...g,rows:[...seen.values()].map(x=>({...x.row,also:x.names.slice(1)}))};});
  const columns=periods.length+4;
  return <section className={compact?styles.embedded:styles.page} aria-labelledby={`${uid}-heading`}>
    <Heading id={`${uid}-heading`} className={styles.srOnly}>KPI health</Heading>
    <div className={styles.toolbar}>
      {rows>0&&<div className={styles.chips} role="list" aria-label="KPI status summary">{order.filter(k=>counts[k]||['healthy','caution','danger'].includes(k)).map(k=><span role="listitem" key={k} data-status={k}><span className={styles.dot} aria-hidden="true"/><b>{counts[k]??0}</b> {shownLabels[k].toLowerCase()}</span>)}</div>}
      {onRefresh&&<button className={styles.refresh} disabled={refreshing} onClick={onRefresh}>{refreshing?'Refreshing…':'Refresh data'}</button>}
    </div>
    {!rows?<p className={styles.muted}>No monitoring KPIs have been defined for this run.</p>:<>
      <div className={styles.tableCard} role="region" aria-label="KPI health table" tabIndex={0}>
        <table className={styles.kpiTable}>
          <thead><tr>
            <th scope="col">KPI</th>
            {periods.map(p=><th scope="col" key={p}>{quarterLabel(p)}</th>)}
            <th scope="col" className={styles.latestHead}>{model.latestPeriod?quarterLabel(model.latestPeriod):'Latest'}</th>
            <th scope="col" className={styles.statusHead}>Status</th>
            <th scope="col">vs a year ago</th>
          </tr></thead>
          <tbody>{groups.map((g,gi)=><Fragment key={g.name}>
            <tr className={styles.groupRow}><th colSpan={columns} scope="colgroup">{label(g.name)}</th></tr>
            {g.rows.map((r,i)=>{const id=`${uid}-${gi}-${i}`,expanded=!!open[id];
              return <Fragment key={id}>
                <tr className={styles.kRow}>
                  <th scope="row"><button type="button" className={styles.nameButton} aria-expanded={expanded} aria-controls={`${id}-detail`} onClick={()=>setOpen(o=>({...o,[id]:!o[id]}))}><Chevron/><span>{r.name}{nounFor(r.latest,r.name)&&<span className={styles.unitNote}> · {nounFor(r.latest,r.name)}</span>}{r.also.length?<small className={styles.also} title={r.also.join('; ')}>Also reported as: {r.also.join('; ')}</small>:null}</span></button></th>
                  {r.history.filter((_,j)=>keep[j]).map((v,j)=><td key={j} className={styles.hist}>{v??'–'}</td>)}
                  <td className={styles.latestCell}><span className={styles.latest} data-status={shownOf(r)}>{r.stale?'–':r.latest}</span></td>
                  <td className={styles.statusCell}><span className={styles.status} data-status={shownOf(r)} title={shownTitles[shownOf(r)]}><span className={styles.dot} aria-hidden="true"/>{shownLabels[shownOf(r)]}{r.stale&&r.latestPeriod?` · ${r.latest} ${quarterLabel(r.latestPeriod)}`:''}</span></td>
                  <td className={styles.yoy}>{r.yoy}</td>
                </tr>
                {expanded&&<tr className={styles.detailRow} id={`${id}-detail`}><td colSpan={columns}>{r.definition&&<p>{readerText(r.definition)}</p>}<p>{r.why}{r.stale&&r.latestPeriod?` Latest captured quarter: ${quarterLabel(r.latestPeriod)}.`:''}</p></td></tr>}
              </Fragment>;})}
          </Fragment>)}</tbody>
        </table>
      </div>
      <p className={styles.legend}>Healthy: clear of the danger line. Caution: within 5% of the danger line. In danger: at or past the bear-case level. Only the latest quarter is coloured, because the lines are forward-looking. Stale and one-reading rows stay grey: there is no current trend to judge. Open a row to see why it has its status.{model.withoutHistory?' Rows without captured quarterly history show only the latest value.':''}</p>
    </>}
  </section>;
}
