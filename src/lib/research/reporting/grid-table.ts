import { label, readerText } from './presentation.mjs';

/**
 * Code-computed tables stored as { columns, rows } (report_facts cases, financial_analytics series) as reader
 * records: plain column names, decimal ratios as percentages, years without separators, exit multiples in words.
 */

// Reader names for the columns of report_facts and financial_analytics tables. The case column reads "Scenario"
// so the report's record table puts it first.
const gridHeaders:Record<string,string>={
  case:'Scenario',probability:'Probability',method:'Method',discount_rate:'Discount rate',terminal:'Exit valuation',
  pv_per_share:'Value per share today',return_to_pv:'Return to value today',terminal_year:'Target year',
  terminal_price_target:'Price target',undiscounted_return_to_terminal:'Return to price target',
  tv_share_of_ev:'Terminal value ÷ enterprise value',value_beyond_explicit_share:'Value beyond forecast years ÷ total',
  explicit_cash_flow_sum:'Forecast-year cash flow, total',no_rerating_return:'Return without rerating',
  no_rerating_return_annualized:'Return without rerating, a year',period:'Period',metric:'Metric',n:'Periods',
  median:'Median',min:'Low',max:'High',latest:'Latest',latest_period:'Latest period',percentile:'Percentile',
};
// Columns stored as decimal ratios that read as percentages.
const percentColumn=(key:string)=>/^(probability|discount_rate|return_to_pv|undiscounted_return_to_terminal|no_rerating_return(_annualized)?|percentile)$/.test(key)||/(yoy|margin|yield|roic|growth)$/.test(key);
// In a metric-per-row table (historical ranges), the metric name says how its numbers read.
const rowKind=(metric:string):'percent'|'multiple'|'plain'=>/(yoy|margin|yield|roic|growth|_to_revenue)$/.test(metric)?'percent':/_to_/.test(metric)?'multiple':'plain';
const valueColumns=new Set(['median','min','max','latest']);

const words=(key:string)=>{
  const t=readerText(key.replace(/_/g,' ')).replace(/\bttm\b/gi,'TTM').replace(/\bfcf\b/gi,'FCF').replace(/\bocf\b/gi,'Operating cash flow')
    .replace(/\bpv\b/gi,'PV').replace(/\bda\b/gi,'depreciation').replace(/\byoy\b/gi,'YoY').replace(/\bsbc\b/gi,'stock-based pay').replace(/\broic\b/gi,'ROIC').replace(/\bppe\b/gi,'PP&E');
  return t.charAt(0).toUpperCase()+t.slice(1);
};
export const gridHeader=(key:string)=>gridHeaders[key]??words(key);

const pct=(ratio:number)=>{const p=ratio*100;return `${p<0?'−':''}${Math.abs(p).toFixed(Math.abs(p)<100?1:0)}%`;};
const plain=(n:number)=>{const a=Math.abs(n);return `${n<0?'−':''}${a.toLocaleString('en-US',{maximumFractionDigits:a<10?2:1})}`;};

/** One cell of a { columns, rows } table as reader text: percentages, years without separators, exit multiples in words. */
export function gridCell(key:string,cell:unknown,metric?:string):string {
  if(cell==null||cell==='')return '—';
  if(typeof cell==='number'&&Number.isFinite(cell)){
    if(/year/.test(key))return String(cell);
    if(percentColumn(key))return pct(cell);
    if(metric&&valueColumns.has(key)){const kind=rowKind(metric);if(kind==='percent')return pct(cell);if(kind==='multiple')return `${plain(cell)}x`;}
    return plain(cell);
  }
  const text=String(cell);
  const exit=/^([\d.]+)\s*x\s+([a-z_]+?)_(\d{4})$/i.exec(text);
  if(exit)return `${exit[1]}× ${label(exit[2]).toLowerCase()} in ${exit[3]}`;
  if(key==='case'&&/^(bear|base|bull)$/i.test(text))return text[0].toUpperCase()+text.slice(1).toLowerCase();
  if(key==='method'&&/^[a-z_]+$/.test(text))return text.toUpperCase();
  if(key==='metric'&&/^[a-z0-9_]+$/.test(text))return words(text);
  return text;
}
/** Records from a { columns: string[], rows: unknown[][] } table, or null for any other shape. */
export function columnTable(value:unknown):Record<string,string>[]|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const {columns,rows}=value as {columns?:unknown;rows?:unknown};
  if(!Array.isArray(columns)||!columns.length||!columns.every(c=>typeof c==='string')||!Array.isArray(rows)||!rows.length||!rows.every(Array.isArray))return null;
  const cols=columns as string[],metricAt=cols.indexOf('metric');
  return (rows as unknown[][]).map(row=>{
    const metric=metricAt>=0&&typeof row[metricAt]==='string'?String(row[metricAt]):undefined;
    return Object.fromEntries(cols.map((c,i)=>[gridHeader(c),gridCell(c,row[i],metric)]));
  });
}
