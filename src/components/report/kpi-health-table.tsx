"use client";
import {Fragment,useId,useMemo,useState} from 'react';
import {kpiHealth,quarterLabel,statusLabels,type KpiStatus} from '@/lib/research/reporting/kpi-health';
import {readerText} from '@/lib/research/reporting/presentation.mjs';
import styles from './report-panels.module.css';
type Row=Record<string,any>;

const Chevron=()=><svg className={styles.chev} width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5L7.5 6 4 9.5" stroke="#8a919c" strokeWidth="1.6" fill="none" strokeLinecap="round"/></svg>;

export function KpiHealthTable({artifacts,compact=false,onRefresh,refreshing=false}:{artifacts:Row[];compact?:boolean;onRefresh?:()=>void;refreshing?:boolean}) {
  const model=useMemo(()=>kpiHealth(artifacts),[artifacts]);
  const [open,setOpen]=useState<Record<string,boolean>>({});
  const uid=useId();
  const Heading=compact?'h3':'h1';
  const rows=model.groups.reduce((n,g)=>n+g.rows.length,0);
  const columns=model.periods.length+4;
  return <section className={compact?styles.embedded:styles.page} aria-labelledby={`${uid}-heading`}>
    <Heading id={`${uid}-heading`} className={styles.srOnly}>KPI health</Heading>
    <div className={styles.toolbar}>
      {rows>0&&<div className={styles.chips} role="list" aria-label="KPI status summary">{(Object.keys(statusLabels) as KpiStatus[]).map(s=><span role="listitem" key={s} data-status={s}><span className={styles.dot} aria-hidden="true"/><b>{model.counts[s]}</b> {statusLabels[s].toLowerCase()}</span>)}</div>}
      {onRefresh&&<button className={styles.refresh} disabled={refreshing} onClick={onRefresh}>{refreshing?'Refreshing…':'Refresh data'}</button>}
    </div>
    {!rows?<p className={styles.muted}>No monitoring KPIs have been defined for this run.</p>:<>
      <div className={styles.tableCard} role="region" aria-label="KPI health table" tabIndex={0}>
        <table className={styles.kpiTable}>
          <thead><tr>
            <th scope="col">KPI</th>
            {model.periods.map(p=><th scope="col" key={p}>{quarterLabel(p)}</th>)}
            <th scope="col" className={styles.latestHead}>{model.latestPeriod?quarterLabel(model.latestPeriod):'Latest'}</th>
            <th scope="col" className={styles.statusHead}>Status</th>
            <th scope="col">vs a year ago</th>
          </tr></thead>
          <tbody>{model.groups.map((g,gi)=><Fragment key={g.name}>
            <tr className={styles.groupRow}><th colSpan={columns} scope="colgroup">{g.name}</th></tr>
            {g.rows.map((r,i)=>{const id=`${uid}-${gi}-${i}`,expanded=!!open[id];
              return <Fragment key={id}>
                <tr className={styles.kRow}>
                  <th scope="row"><button type="button" className={styles.nameButton} aria-expanded={expanded} aria-controls={`${id}-detail`} onClick={()=>setOpen(o=>({...o,[id]:!o[id]}))}><Chevron/><span>{r.name}</span></button></th>
                  {r.history.map((v,j)=><td key={j} className={styles.hist}>{v??'–'}</td>)}
                  <td className={styles.latestCell}><span className={styles.latest} data-status={r.status??undefined}>{r.latest}{r.stale&&r.latestPeriod&&<small>{quarterLabel(r.latestPeriod)}</small>}</span></td>
                  <td className={styles.statusCell}><span className={styles.status} data-status={r.status??undefined}><span className={styles.dot} aria-hidden="true"/>{r.status?statusLabels[r.status]:'No reading'}</span></td>
                  <td className={styles.yoy}>{r.yoy}</td>
                </tr>
                {expanded&&<tr className={styles.detailRow} id={`${id}-detail`}><td colSpan={columns}>{r.definition&&<p>{readerText(r.definition)}</p>}<p>{r.why}{r.stale&&r.latestPeriod?` Latest captured quarter: ${quarterLabel(r.latestPeriod)}.`:''}</p></td></tr>}
              </Fragment>;})}
          </Fragment>)}</tbody>
        </table>
      </div>
      <p className={styles.legend}>Healthy: clear of the danger line. Caution: within 5% of the danger line. In danger: at or past the bear-case level. Only the latest quarter is coloured, because the lines are forward-looking. Open a row to see why it has its colour.{model.withoutHistory?' Rows without captured quarterly history show only the latest value.':''}</p>
    </>}
  </section>;
}
