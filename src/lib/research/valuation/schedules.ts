import {z} from 'zod/v4';

// Cash amounts and shares are both in millions; their quotient is currency/share.
const YearBuild = z.object({
  starting_profit:z.number(),depreciation_amortization:z.number(),capital_expenditures:z.number(),
  change_in_net_working_capital:z.number(),other_adjustments:z.number(),
});
const MethodFields = {
  method:z.enum(['fcff','fcfe','dividend','earnings_exit','book_exit','tangible_book_exit']),
  method_name:z.string().min(1), scenario_type:z.enum(['bear','base','bull']),
  rationale:z.string().min(1), currency:z.string().length(3),
  cash_flow_label:z.string().min(1), discount_rate:z.number().min(0).max(1),
  equity_bridge:z.number(), equity_bridge_explanation:z.string().min(1),
  diluted_shares:z.number().positive(), source_notes:z.array(z.string().min(1)).min(1),
};
const PerpetuityTerminal = z.object({type:z.literal('perpetuity'),growth_rate:z.number().min(-1).max(1)});
const MultipleTerminal = z.object({type:z.literal('multiple'),metric:z.string().min(1),metric_value:z.number(),multiple:z.number().nonnegative()});

/** The schedule shape a model writes (equity methods): explicit years and a perpetuity or multiple terminal. */
export const ModelMethodInput = z.object({
  ...MethodFields,
  // build shows how a cash-flow year is derived: cash_flow = starting_profit + D&A - capex - change in NWC + other.
  years:z.array(z.object({fiscal_year:z.number().int(),cash_flow:z.number(),build:YearBuild.optional()})).min(1).max(15),
  terminal:z.discriminatedUnion('type',[PerpetuityTerminal, MultipleTerminal]),
});

/**
 * A stored schedule. Code-built FCFF schedules may also carry fade years (code-generated after the explicit
 * forecast, `fade: true`), a value-driver terminal on the final NOPAT, TV = NOPAT x (1 + g) x (1 - g / RONIC) / (r - g),
 * and timing: the first year is discounted over the fraction of it left after the valuation date, and only its
 * cash flow after the year-to-date already reported counts.
 */
export const ValuationMethodInput = z.object({
  ...MethodFields,
  years:z.array(z.object({fiscal_year:z.number().int(),cash_flow:z.number(),build:YearBuild.optional(),fade:z.boolean().optional()})).min(1).max(25),
  terminal:z.discriminatedUnion('type',[
    PerpetuityTerminal, MultipleTerminal,
    z.object({type:z.literal('value_driver'),metric:z.literal('nopat'),metric_value:z.number(),growth_rate:z.number().min(-1).max(1),ronic:z.number().positive()}),
  ]),
  timing:z.object({
    valuation_date:z.string().min(10), first_year_fraction:z.number().gt(0).max(1),
    first_year_reported_cash_flow:z.number(), reported_basis:z.enum(['reported','pro_rata','none']),
  }).optional(),
});
export type ValuationMethodInput=z.infer<typeof ValuationMethodInput>;

/** Years from the valuation date to each year end: whole years without timing, else the first-year fraction plus i. */
export const yearTimes=(model:Pick<ValuationMethodInput,'years'|'timing'>)=>model.years.map((_,i)=>model.timing?model.timing.first_year_fraction+i:i+1);

export function calculateValuationSchedule(value:unknown) {
  const model=ValuationMethodInput.parse(value);
  if(model.years.some((y,i)=>i>0&&y.fiscal_year!==model.years[i-1].fiscal_year+1))throw new Error('Valuation years must be consecutive and increasing.');
  if(model.method.endsWith('_exit')&&model.terminal.type!=='multiple')throw new Error('Exit valuation requires a terminal multiple.');
  if(model.method!=='fcff'&&model.equity_bridge!==0)throw new Error('Equity methods cannot subtract net debt again.');
  const r=model.discount_rate, times=yearTimes(model);
  // Without timing every cash flow counts in full; with it the first year counts only what is left after the reported part.
  const years=model.years.map((y,i)=>{
    const counted=i===0&&model.timing?y.cash_flow-model.timing.first_year_reported_cash_flow:y.cash_flow;
    const discount_factor=1/(1+r)**times[i];
    return {...y,discount_factor,present_value:counted*discount_factor,...(model.timing?{years_from_valuation_date:times[i],counted_cash_flow:counted}:{})};
  });
  const t=model.terminal;
  if(t.type!=='multiple'&&t.growth_rate>=r)throw new Error('Terminal growth must be below the discount rate.');
  const terminal_value=t.type==='multiple'?t.metric_value*t.multiple
    :t.type==='value_driver'?t.metric_value*(1+t.growth_rate)*(1-t.growth_rate/t.ronic)/(r-t.growth_rate)
    :years.at(-1)!.cash_flow*(1+t.growth_rate)/(r-t.growth_rate);
  const terminal_present_value=terminal_value*years.at(-1)!.discount_factor;
  const explicit_present_value=years.reduce((n,y)=>n+y.present_value,0);
  const equity_value=explicit_present_value+terminal_present_value+model.equity_bridge;
  const value_per_share=equity_value/model.diluted_shares;
  if(!Number.isFinite(value_per_share))throw new Error('Valuation calculation is not finite.');
  const enterprise_value=explicit_present_value+terminal_present_value;
  return {...model,years,terminal_value,terminal_present_value,equity_value,value_per_share,explicit_present_value,enterprise_value,
    tv_share_of_ev:enterprise_value>0?terminal_present_value/enterprise_value:null};
}

export function validateMethodInputs(models:ValuationMethodInput[]) {
  const seen=new Set<string>();
  for(const model of models){calculateValuationSchedule(model);const key=`${model.method}:${model.scenario_type}`;if(seen.has(key))throw new Error(`Duplicate valuation method/case: ${key}`);seen.add(key);}
  for(const method of new Set(models.map(m=>m.method)))for(const scenario of ['bear','base','bull'])if(!seen.has(`${method}:${scenario}`))throw new Error(`${method} requires Bear, Base and Bull schedules.`);
}

/**
 * Cash-flow methods must add back depreciation and amortization when the packet carries it:
 * subtracting capex without the D&A add-back understates cash flow every year.
 */
export function cashFlowBuildErrors(models:unknown[]):{path:string;message:string}[] {
  const errors:{path:string;message:string}[]=[];
  models.forEach((value,m)=>{
    const model=value as Partial<ValuationMethodInput>;
    if(model?.method!=='fcff'&&model?.method!=='fcfe')return;
    const path=`valuation_scenario_set.method_inputs.${m}`;
    if(/no\s+d&a\s+add[- ]?back|without\s+(a\s+)?(d&a|depreciation)\s+add[- ]?back/i.test(`${model.cash_flow_label??''} ${model.rationale??''}`))
      errors.push({path,message:`${model.method} ${model.scenario_type} omits the D&A add-back. financial_inputs supplies depreciation_amortization; add it back to the cash flow.`});
    (model.years??[]).forEach((year,y)=>{
      const build=year.build;
      if(!build){errors.push({path:`${path}.years.${y}.build`,message:`${model.method} ${model.scenario_type} ${year.fiscal_year} needs build {starting_profit, depreciation_amortization, capital_expenditures, change_in_net_working_capital, other_adjustments} because depreciation_amortization is in financial_inputs.`});return;}
      if(!(build.depreciation_amortization>0))errors.push({path:`${path}.years.${y}.build.depreciation_amortization`,message:`${model.method} ${model.scenario_type} ${year.fiscal_year} must add back a positive depreciation_amortization.`});
      const derived=build.starting_profit+build.depreciation_amortization-build.capital_expenditures-build.change_in_net_working_capital+build.other_adjustments;
      if(Math.abs(derived-year.cash_flow)>Math.max(1,Math.abs(year.cash_flow)*0.005))
        errors.push({path:`${path}.years.${y}.cash_flow`,message:`${model.method} ${model.scenario_type} ${year.fiscal_year} cash_flow ${year.cash_flow} does not equal its build (${Number(derived.toFixed(3))}). Capital_expenditures is a positive amount that the build subtracts.`});
    });
  });
  return errors;
}
