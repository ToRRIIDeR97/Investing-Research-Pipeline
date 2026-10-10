import {artifactContent,kpiMetricKey,researchObservations} from './data-views';
import {kpiSeries,parseUnit} from './dashboard-series';
import {formatInUnit,groupRank,kpiGroup,kpiName} from './plain-english';
type Row=Record<string,any>;

export type KpiStatus='healthy'|'caution'|'danger';
export const statusLabels:Record<KpiStatus,string>={healthy:'Healthy',caution:'Caution',danger:'In danger'};

/**
 * Health of the latest reading against the bear-case (danger) line.
 * Lower is better when the bear threshold sits above the bull threshold.
 * In danger: at or past the bear line. Caution: within 5% of it (5% of the bear–bull gap when the bear line is 0).
 */
export function kpiStatus(value:unknown,bear:unknown,bull:unknown):KpiStatus|null {
  const v=Number(value),b=Number(bear),u=bull==null?NaN:Number(bull);
  if(value==null||bear==null||!Number.isFinite(v)||!Number.isFinite(b))return null;
  const lowerIsBetter=Number.isFinite(u)&&b>u;
  if(lowerIsBetter?v>=b:v<=b)return 'danger';
  const scale=b!==0?Math.abs(b):Number.isFinite(u)?Math.abs(u-b):0;
  return scale>0&&Math.abs(v-b)<=0.05*scale?'caution':'healthy';
}

const quarterIndex=(period:string)=>Number(period.slice(0,4))*4+Number(period.at(-1))-1;
const quarterName=(index:number)=>`${Math.floor(index/4)}-Q${index%4+1}`;
/** "2026-Q2" → "Q2 ’26". */
export const quarterLabel=(period:string)=>/^\d{4}-Q[1-4]$/.test(period)?`${period.slice(5)} ’${period.slice(2,4)}`:period;

export type KpiHealthRow={name:string;group:string;definition:string;unit:string;history:(string|null)[];latest:string;latestPeriod:string|null;
  stale:boolean;status:KpiStatus|null;yoy:string;why:string;hasHistory:boolean};
export type KpiHealth={periods:string[];latestPeriod:string|null;groups:{name:string;rows:KpiHealthRow[]}[];counts:Record<KpiStatus,number>;withoutHistory:number};

function changeText(latest:number|null,prior:number|null,unit:string):string {
  if(latest==null||prior==null||!Number.isFinite(latest)||!Number.isFinite(prior))return '–';
  const percentUnit=parseUnit(unit)?.base==='%';
  const sign=(n:number)=>n>=0?'+':'−';
  if(percentUnit){const d=latest-prior;return `${sign(d)}${Math.abs(d).toFixed(1)} pts`;}
  if(prior===0)return '–';
  const c=(latest-prior)/Math.abs(prior)*100;return `${sign(c)}${Math.abs(c).toFixed(1)}%`;
}

/** KPI health table model from the run's monitoring dashboard and captured quarterly observations. */
export function kpiHealth(artifacts:Row[],historyQuarters=4):KpiHealth {
  const items:Row[]=artifactContent(artifacts,'monitoring_dashboard').items??[];
  const observations=researchObservations(artifacts);
  const prepared=items.map(item=>{
    const series=kpiSeries(item,observations,kpiMetricKey(item,observations));
    const filled=series.points.filter(p=>p.value!=null);
    return {item,series,last:filled.at(-1)??null};
  });
  const lastIndexes=prepared.flatMap(p=>p.last?[quarterIndex(p.last.period)]:[]);
  const latestIndex=lastIndexes.length?Math.max(...lastIndexes):null;
  const latestPeriod=latestIndex==null?null:quarterName(latestIndex);
  const periods=latestIndex==null?[]:Array.from({length:historyQuarters},(_,i)=>quarterName(latestIndex-historyQuarters+i));
  const counts:Record<KpiStatus,number>={healthy:0,caution:0,danger:0};let withoutHistory=0;
  const rows=prepared.map(({item,series,last}):KpiHealthRow=>{
    const unit=series.points.length?series.unit:String(item.unit??'');
    const valueAt=(period:string)=>series.points.find(p=>p.period===period)?.value??null;
    const current=item.current_level==null||!Number.isFinite(Number(item.current_level))?null:Number(item.current_level);
    // Latest reading: the newest captured quarter; the analyst's current level when the series is missing or older.
    let value:number|null=null,period:string|null=null;
    if(last&&(last.period===latestPeriod||current==null)){value=last.value;period=last.period;}
    else if(current!=null){value=current;period=latestPeriod;}
    const stale=!!period&&!!latestPeriod&&period!==latestPeriod;
    const hasHistory=series.points.filter(p=>p.value!=null).length>=2;if(!hasHistory)withoutHistory++;
    const status=kpiStatus(value,item.bear_threshold,item.bull_threshold);if(status)counts[status]++;
    const line=formatInUnit(Number(item.bear_threshold),unit),shown=formatInUnit(value,unit);
    const lowerIsBetter=Number(item.bear_threshold)>Number(item.bull_threshold);
    const why=status==='danger'?`In danger: ${shown} is past the danger line of ${line}.`
      :status==='caution'?`Caution: ${shown} is within 5% of the danger line of ${line}.`
      :status==='healthy'?`Healthy: ${shown} is clear of the danger line of ${line} (${lowerIsBetter?'higher':'lower'} would be worse).`
      :value==null?'No reading has been captured for this KPI yet.':'No danger line has been set for this KPI.';
    const prior=period?valueAt(quarterName(quarterIndex(period)-4)):null;
    return {name:kpiName(item),group:kpiGroup(item),definition:String(item.definition??'').trim(),unit,
      history:periods.map(p=>p===period?null:hasHistory?(valueAt(p)==null?null:formatInUnit(valueAt(p),unit)):null),
      latest:shown,latestPeriod:period,stale,status,yoy:changeText(value,prior,unit),why,hasHistory};
  });
  const names=[...new Set(rows.map(r=>r.group))].sort((a,b)=>groupRank(a)-groupRank(b));
  return {periods,latestPeriod,groups:names.map(name=>({name,rows:rows.filter(r=>r.group===name)})),counts,withoutHistory};
}
