import {parseUnit} from './dashboard-series';
type Row=Record<string,any>;

/**
 * Plain-English names and number formats for the report's KPI and valuation views.
 * Readers never see metric keys, snake_case or "null".
 */

// Normalised metric key (no us_gaap_ prefix, no basis suffix, snake_case) → reader name.
const metricNames:Record<string,string>={
  total_revenue:'Total revenue',revenue:'Total revenue',revenues:'Total revenue',net_revenue:'Total revenue',
  revenue_from_contract_with_customer_excluding_assessed_tax:'Total revenue',
  income_from_operations:'Operating income',operating_income:'Operating income',operating_income_loss:'Operating income',
  net_income:'Net income',net_income_loss:'Net income',
  operating_cash_flow:'Operating cash flow',net_cash_provided_by_operating_activities:'Operating cash flow',net_cash_provided_by_used_in_operating_activities:'Operating cash flow',
  capex:'Capital expenditure',capital_expenditures:'Capital expenditure',purchases_of_property_and_equipment:'Capital expenditure',payments_to_acquire_property_plant_and_equipment:'Capital expenditure',
  free_cash_flow:'Free cash flow',free_cash_flow_company_defined:'Free cash flow',
  cost_of_revenue:'Cost of revenue',research_and_development_expense:'Research and development',research_and_development:'Research and development',
  gross_profit:'Gross profit',selling_general_and_administrative_expense:'Selling, general and administrative costs',
  earnings_per_share_diluted:'Diluted earnings per share',weighted_average_number_of_diluted_shares_outstanding:'Diluted shares',
  net_interest_income:'Net interest income',noninterest_income:'Non-interest income',non_interest_income:'Non-interest income',
  deposits:'Deposits',total_deposits:'Total deposits',stockholders_equity:'Shareholders’ equity',
};

// Exact driver and method keys whose generic expansion would read poorly.
const exact:Record<string,string>={
  foa_advertising_revenue_growth:'Family of Apps revenue growth',
  capex_purchases_of_property_and_equipment:'Capital expenditure',
  eu_dma_regulatory_revenue_haircut:'EU Digital Markets Act revenue impact',
  fcff_dcf_terminal_multiple:'Discounted free cash flow with an exit multiple',
  fcff_dcf_perpetuity:'Discounted free cash flow with perpetual growth',
  fcff:'Discounted free cash flow',fcfe:'Discounted free cash flow to equity',dividend:'Discounted dividends',
  earnings_exit:'Earnings multiple at exit',book_exit:'Book value multiple at exit',tangible_book_exit:'Tangible book value multiple at exit',
};

// Abbreviations expanded token by token.
const tokens:Record<string,string>={
  foa:'Family of Apps',rl:'Reality Labs',eu:'EU',us:'US',uk:'UK',dma:'Digital Markets Act',capex:'capital expenditure',opex:'operating costs',
  fcf:'free cash flow',fcff:'free cash flow',fcfe:'free cash flow to equity',dcf:'discounted cash flow',nopat:'after-tax operating profit',
  ebit:'operating profit',ebitda:'EBITDA',sbc:'stock-based compensation',yoy:'year over year',qoq:'quarter over quarter',
  arpu:'ARPU',dau:'daily active users',mau:'monthly active users',gaap:'GAAP',ai:'AI',tam:'addressable market',pp:'percentage points',
};

const snake=(key:string)=>String(key??'').replace(/^us_gaap_/,'').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const slug=(v:unknown)=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const sentence=(text:string)=>text.charAt(0).toUpperCase()+text.slice(1);

/** Reader name for a driver, method or metric key. Proper names (e.g. segments) keep their capitals. */
export function plainLabel(key:unknown,properNames:string[]=[]):string {
  const raw=String(key??'').trim();
  if(!raw)return '';
  if(exact[raw])return exact[raw];
  let k=snake(raw);
  if(exact[k])return exact[k];
  if(/(^|_)(nopat|after_tax_operating)/.test(k))return 'After-tax operating profit';
  const metric=metricName(k);if(metric)return metric;
  const names=new Map(properNames.filter(Boolean).map(n=>[slug(n),n]));
  for(const [s] of names)k=`_${k}_`.replace(new RegExp(`_${s}_`,'g'),`_${s.replace(/_/g,'~')}_`).slice(1,-1);
  const words=k.split(/_+/).filter(w=>w&&!/^fy\d{2,4}$/.test(w)).map(w=>w.includes('~')?names.get(w.replace(/~/g,'_'))!:tokens[w]??w);
  return sentence(words.join(' ').replace(/\s+/g,' ').trim());
}

/** Known metric name for a key, ignoring GAAP/non-GAAP suffixes; null when unknown. */
export function metricName(key:unknown):string|null {
  const k=snake(String(key??'')).replace(/_(non_gaap|gaap)$/,'');
  return metricNames[k]??null;
}

const lowerFirst=(s:string)=>s.charAt(0).toLowerCase()+s.slice(1);

/** Plain KPI name: segment + metric name when the metric key is known, otherwise the analyst's name. */
export function kpiName(item:Row):string {
  const key=snake(String(item.metric_key??'')),segment=String(item.segment??'').trim();
  let base=key,prefix='';
  if(segment&&key.startsWith(`${slug(segment)}_`)){base=key.slice(slug(segment).length+1);prefix=segment;}
  let name=metricName(base);
  if(name&&prefix)name=`${prefix} ${lowerFirst(name.replace(/^Total /,''))}`;
  if(name&&/operating income$/i.test(name)&&Number(item.bear_threshold)<0&&Number(item.bull_threshold)<=0)name=name.replace(/operating income$/i,'operating loss');
  if(name)return name;
  const kpi=String(item.kpi??'').trim();
  return kpi?sentence(kpi.replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi,m=>lowerFirst(plainLabel(m)))):plainLabel(item.metric_key)||'Unnamed KPI';
}

const groupOrder=['Revenue and demand','Profit and costs','Cash','Balance sheet'];
/** Readable thesis-pillar group for a KPI (from its process node, with cash measures grouped by metric). */
export function kpiGroup(item:Row):string {
  const key=snake(String(item.metric_key??'')),node=String(item.process_node??'');
  if(/cash_flow|capex|capital_expend|property_plant|property_and_equipment/.test(key))return 'Cash';
  if(/revenue|demand|customer|pricing|value delivery|volume|users|subscri|sales/i.test(node))return 'Revenue and demand';
  if(/cost|margin|profit|earning|tax|reinvest|expense|income/i.test(node))return 'Profit and costs';
  if(/cash/i.test(node))return 'Cash';
  if(/balance|capital|liquid|debt|credit|funding|deposit/i.test(node))return 'Balance sheet';
  const short=node.replace(/\([^)]*\)/g,'').trim();
  return short?sentence(short):'Other measures';
}
export const groupRank=(name:string)=>{const i=groupOrder.indexOf(name);return i<0?groupOrder.length:i;};

const symbols:Record<string,string>={USD:'$',EUR:'€',GBP:'£',JPY:'¥'};
const minus=(v:number)=>v<0?'−':'';
/** Compact money: $60.8B, $431M, −$4.5B, $1.53T. Amount is in whole currency units. */
export function money(amount:number|null|undefined,currency='USD'):string {
  if(amount==null||!Number.isFinite(amount))return '–';
  const symbol=symbols[currency.toUpperCase()]??`${currency.toUpperCase()} `,a=Math.abs(amount);
  const body=a===0?'0':a>=1e12?`${(a/1e12).toFixed(2)}T`:a>=1e9?`${(a/1e9).toFixed(1)}B`:a>=1e6?`${Math.round(a/1e6)}M`:a>=100?`${Math.round(a)}`:a.toFixed(2);
  return `${minus(amount)}${symbol}${body}`;
}
/** Money given in millions (the forecast and valuation convention). */
export const moneyMillions=(value:number|null|undefined,currency='USD')=>value==null||!Number.isFinite(value)?'–':money(value*1e6,currency);
export const percent=(ratio:number|null|undefined,digits=1)=>ratio==null||!Number.isFinite(ratio)?'–':`${minus(ratio)}${Math.abs(ratio*100).toFixed(digits)}%`;
/** Per-share price: $553 above 100, $12.34 below (or always to the cent when exact). */
export function price(value:number|null|undefined,currency='USD',exact=false):string {
  if(value==null||!Number.isFinite(value))return '–';
  const symbol=symbols[currency.toUpperCase()]??`${currency.toUpperCase()} `,a=Math.abs(value);
  return `${minus(value)}${symbol}${!exact&&a>=100?Math.round(a).toLocaleString('en-US'):a.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

/** A value in a KPI's display unit ("USD millions", "%", "million shares"), formatted for reading. */
export function formatInUnit(value:number|null|undefined,unit:unknown):string {
  if(value==null||!Number.isFinite(value))return '–';
  const u=parseUnit(unit);
  if(u?.currency)return money(value*u.scale,u.base.toUpperCase());
  if(u?.base==='%')return `${minus(value)}${Math.abs(value).toFixed(1)}%`;
  const n=new Intl.NumberFormat('en-US',{maximumFractionDigits:Math.abs(value)<10?2:0}).format(Math.abs(value));
  const suffix=String(unit??'').replace(/_/g,' ').trim();
  return `${minus(value)}${n}${suffix?` ${suffix}`:''}`;
}
