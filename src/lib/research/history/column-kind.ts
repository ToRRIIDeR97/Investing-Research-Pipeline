// Units of financial_analytics columns. Kept free of imports: report visuals, which run in the browser, read it too.
export type Kind = "money" | "ratio" | "days" | "x" | "shares";

const MONEY = new Set(["revenue", "operating_income", "fcf_ttm", "fcf_after_lease_principal_ttm", "growth_capex_ttm", "nopat_ttm", "invested_capital",
  "cash", "marketable_securities", "long_term_debt", "net_cash", "buybacks_ttm", "dividends_ttm", "sbc_ttm", "market_cap",
  "change_in_revenue_ttm", "change_in_nopat_ttm", "change_in_invested_capital", "cumulative_operating_income", "revenue_ttm", "operating_income_ttm"]);
/** Unit of a pack column; fiscal_year and years round as ratios, which leaves integers unchanged. */
export function columnKind(column: string): Kind {
  if (/^(dso|dpo|dio|ccc)$/.test(column)) return "days";
  if (column === "capex_to_da" || column === "revenue_to_net_ppe") return "x";
  if (column === "shares" || column === "shares_year_ago") return "shares";
  return MONEY.has(column) ? "money" : "ratio";
}
