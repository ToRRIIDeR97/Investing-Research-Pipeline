import styles from './report-panels.module.css';
type Row=Record<string,any>;

/** The newest `stock_rating` artifact's content, or null. */
function latestRating(artifacts:Row[]):Row|null {
  let best:Row|null=null;
  for(const a of artifacts) if(a?.artifact_type==='stock_rating'&&(!best||Number(a.artifact_version??0)>Number(best.artifact_version??0)))best=a;
  const c=best?.content_json;
  return c&&typeof c==='object'?c as Row:null;
}

const pct=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?`${v<0?'−':'+'}${Math.abs(v*100).toFixed(1)}%`:'—';

/** Code-built grade and trend check (Pragma's PragValue bands and PragTrend conditions). Renders nothing without a rating. */
export function StockRatingPanel({artifacts}:{artifacts:Row[]}) {
  const r=latestRating(artifacts);
  if(!r)return null;
  const trend=(r.trend??{}) as Row;
  const rules=Array.isArray(trend.rules)?trend.rules as Row[]:[];
  return <div className={styles.targets} aria-label="Stock rating">
    {r.status==='rated'
      ? <table className={styles.numbers}>
          <tbody>
            <tr><th scope="row">Valuation grade</th><td><b>{r.valuation_grade}</b> · {r.valuation_label} ({pct(r.adjusted_deviation)} vs base value, confidence-adjusted)</td></tr>
            <tr><th scope="row">Combined grade</th><td><b>{r.composite_grade}</b> · {r.composite_label}{r.macro?.status==='unavailable'?' (no credit term yet)':''}</td></tr>
            <tr><th scope="row">Confidence</th><td>{r.confidence} / 100 · {String(r.data_quality).toLowerCase()} data quality</td></tr>
            <tr><th scope="row">Trend</th><td>{trend.score_label}{trend.rs_rating!=null?` · RS rating ${trend.rs_rating}`:''}{trend.mansfield?` · Mansfield RS ${trend.mansfield.value}`:''}</td></tr>
          </tbody>
        </table>
      : <>
          <p className={styles.caption}>Rating withheld: {r.withheld_reason}</p>
          <p className={styles.caption}>Trend: {trend.score_label}</p>
        </>}
    {!!rules.length&&<ul className={styles.caption}>
      {rules.map(x=><li key={x.key}>{x.status==='pass'?'✓':x.status==='fail'?'✗':'–'} {x.label}{x.status==='unavailable'&&x.reason?` (${x.reason})`:''}</li>)}
    </ul>}
  </div>;
}
