"use client";
import {KpiHealthTable} from './report/kpi-health-table';
import {ValuationSummaryView} from './report/valuation-summary';
type Row=Record<string,any>;

/** KPI health table: report monitoring chapter (compact) and the KPI Dashboard tab. */
export function KPIDashboard(props:{artifacts:Row[];compact?:boolean;onRefresh?:()=>void;refreshing?:boolean}) {
  return <KpiHealthTable {...props}/>;
}

/** Summary-first valuation: weighted value, scenarios, reasons, then the supporting detail. */
export function ValuationDashboard({artifacts,conclusionStatus}:{artifacts:Row[];conclusionStatus?:string}) {
  return <ValuationSummaryView artifacts={artifacts} conclusionStatus={conclusionStatus}/>;
}
