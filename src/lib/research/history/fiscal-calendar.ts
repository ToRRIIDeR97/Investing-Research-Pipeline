/**
 * The issuer's fiscal calendar, as the filed statements label it. Companyfacts and model rows carry
 * only dates, so they are labelled here rather than by calendar month: a June fiscal year's
 * Jul-Sep quarter is fiscal Q1, and 52/53-week quarters end on dates such as 2024-09-28.
 */
export type FiscalPeriod = { end: string; fiscal_year: number; fiscal_quarter: number };

const DAY = 86_400_000;
const QUARTER_DAYS = 91.3125;

/** Fiscal quarter ends from filed statement observations, one label per date (the first seen wins). */
export function fiscalPeriodsFromObservations(rows: Record<string, any>[]): FiscalPeriod[] {
  const periods = new Map<string, FiscalPeriod>();
  for (const row of rows) {
    // Headcount rows are themselves placed on this calendar and may carry off-grid as-of dates.
    if (row.metric_key === "employees" || row.periodicity !== "quarterly") continue;
    const end = typeof row.period_end === "string" ? row.period_end.slice(0, 10) : null;
    if (!end || periods.has(end) || !Number.isInteger(row.fiscal_year) || !Number.isInteger(row.fiscal_quarter)) continue;
    periods.set(end, { end, fiscal_year: row.fiscal_year, fiscal_quarter: row.fiscal_quarter });
  }
  return [...periods.values()];
}

/**
 * Place a date on the fiscal calendar: a known period end, or a date on the quarter grid from the
 * nearest known end (within 10 days). Null when the date is off the grid or no period is known.
 */
export function fiscalCalendar(periods: FiscalPeriod[]) {
  const known = new Map(periods.map((p) => [p.end, p]));
  return (date: string): FiscalPeriod | null => {
    const at = Date.parse(date);
    if (known.has(date)) return known.get(date)!;
    let nearest: FiscalPeriod | null = null;
    for (const p of known.values()) if (!nearest || Math.abs(Date.parse(p.end) - at) < Math.abs(Date.parse(nearest.end) - at)) nearest = p;
    if (!nearest || !Number.isFinite(at)) return null;
    const quarters = (at - Date.parse(nearest.end)) / DAY / QUARTER_DAYS;
    if (Math.abs(quarters - Math.round(quarters)) * QUARTER_DAYS > 10) return null;
    const index = nearest.fiscal_year * 4 + nearest.fiscal_quarter - 1 + Math.round(quarters);
    return { end: date, fiscal_year: Math.floor(index / 4), fiscal_quarter: index % 4 + 1 };
  };
}

/**
 * Fiscal label for a dated row. A duration over six months is annual and must end a fiscal Q4.
 * With no known fiscal periods the row keeps its calendar label; with known periods a row off the
 * fiscal grid is unlabelled (null), so it cannot fill another period's slot.
 */
export function fiscalLabel(periodStart: string | null, periodEnd: string, periods: FiscalPeriod[], place = fiscalCalendar(periods)):
  { fiscal_year: number; fiscal_quarter: number | null; periodicity: "annual" | "quarterly" } | null {
  const end = new Date(periodEnd);
  const start = periodStart ? new Date(periodStart) : null;
  const months = start ? (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) : 3;
  const periodicity = months > 6 ? "annual" : "quarterly";
  if (!periods.length) {
    return { fiscal_year: end.getUTCFullYear(), fiscal_quarter: periodicity === "annual" ? null : Math.floor(end.getUTCMonth() / 3) + 1, periodicity };
  }
  const placed = place(end.toISOString().slice(0, 10));
  if (!placed || (periodicity === "annual" && placed.fiscal_quarter !== 4)) return null;
  return { fiscal_year: placed.fiscal_year, fiscal_quarter: periodicity === "annual" ? null : placed.fiscal_quarter, periodicity };
}
