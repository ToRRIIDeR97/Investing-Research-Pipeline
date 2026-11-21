"use client";

import { useState } from 'react';
import type { BuiltExhibit } from '@/lib/research/reporting/exhibits';
import { ChartPlot } from '../report-visual';
import styles from '../research-report.module.css';

const FIRST_ROWS=12;

/** The formatted cells of a code-built exhibit. Numeric columns are right-aligned; the first column labels the row. */
function ExhibitTable({table,title}:{table:BuiltExhibit['table'];title:string}) {
  const [all,setAll]=useState(false);
  const rows=all?table.rows:table.rows.slice(0,FIRST_ROWS);
  return <>
    <div className={styles.tableScroll} role="region" tabIndex={0} aria-label={title}>
      <table>
        <caption className={styles.srOnly}>{title}</caption>
        <thead><tr>{table.columns.map(c=><th key={c.key} scope="col" className={c.numeric?styles.num:undefined}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((row,i)=><tr key={i}>{row.map((cell,j)=>j===0
          ?<th key={j} scope="row" className={table.columns[j]?.numeric?styles.num:undefined}>{cell}</th>
          :<td key={j} className={table.columns[j]?.numeric?styles.num:undefined}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {table.rows.length>FIRST_ROWS&&<button className={styles.textButton} aria-expanded={all} onClick={()=>setAll(!all)}>{all?`Show first ${FIRST_ROWS} rows`:`Show all ${table.rows.length} rows`}</button>}
  </>;
}

/**
 * One exhibit that code built from stored artifacts (reports of standard adaptive-3). A table exhibit shows its
 * formatted cells; a chart exhibit draws the chart and keeps its data table one click away. Every number comes from
 * buildExhibits; this component only lays them out.
 */
export function ExhibitTile({exhibit,id}:{exhibit:BuiltExhibit;id:string}) {
  return <section id={id} className={styles.tile} data-tile data-exhibit data-exhibit-key={exhibit.key}>
    <header className={styles.tileHead}><h3 data-tile-title>{exhibit.title}</h3></header>
    <div className={styles.tileBody}>
      {exhibit.caption&&<p className={styles.caption}>{exhibit.caption}</p>}
      {exhibit.kind==='chart'?<>
        <ChartPlot chart={exhibit.chart} title={exhibit.title}/>
        {exhibit.notes.map(n=><p className={styles.chartNote} key={n}>{n}</p>)}
        <details className={styles.figureSources}><summary>View underlying data</summary><ExhibitTable table={exhibit.table} title={`${exhibit.title} values`}/></details>
      </>:<>
        <ExhibitTable table={exhibit.table} title={exhibit.title}/>
        {exhibit.notes.map(n=><p className={styles.chartNote} key={n}>{n}</p>)}
      </>}
    </div>
  </section>;
}
