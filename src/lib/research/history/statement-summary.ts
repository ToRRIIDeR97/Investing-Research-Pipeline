import type { FilingTable } from "./filing-statements";

type Row = Record<string, any>;

const CURRENT_DEBT = /(LongTermDebtCurrent|DebtCurrent|ShortTermBorrowings|CommercialPaper|ShortTermDebt)/;
const FINANCE_LEASE = /FinanceLeaseLiability/;

/**
 * A few-KB account of the captured primary statements for agents that never see the 6 MB statement set
 * (report writers, the reviewer, team owners, decision synthesis): which filings were captured, which window
 * quarters have no filing, how the balance checks came out, and which lines the latest balance sheet presents.
 */
export function buildStatementSummary(set: { tables: FilingTable[]; coverage: Row[]; reconciliation: Row[]; observations: unknown[]; failures?: string[] },
  windowQuarters: string[]) {
  const primary = set.tables.filter((t) => t.statement !== "segment");
  const captured = new Set(primary.map((t) => `${t.fiscal_year}Q${t.fiscal_quarter}`));
  const balance = [...primary].filter((t) => t.statement === "balance")
    .sort((a, b) => a.period_end.localeCompare(b.period_end) || a.filed.localeCompare(b.filed)).at(-1);
  const concepts = new Set(balance?.rows.flatMap((r) => r.cells.flatMap((c) => c.facts.map((f) => f.concept))) ?? []);
  const lines = balance?.rows.map((r) => r.cells.find((c) => c.text && !c.facts.length)?.text ?? "").filter(Boolean) ?? [];
  const mismatches = set.reconciliation.filter((c) => c.status !== "passed");
  return {
    artifact_type: "financial_statement_summary",
    note: "The complete issuer-reported statements are captured and kept in Financials, outside this packet. Report a statement gap only where this summary shows one.",
    filings: { columns: ["form", "period_end", "status", "tables", "missing", "unresolved_facts"],
      rows: [...set.coverage].sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)))
        .map((c) => [c.form ?? null, c.period_end ?? null, c.status, c.table_count, (c.missing ?? []).join(", ") || null, c.unresolved_facts]) },
    unreadable_filings: set.failures?.length ?? 0,
    window: { start: windowQuarters[0] ?? null, end: windowQuarters.at(-1) ?? null },
    window_quarters_without_filing: windowQuarters.filter((q) => !captured.has(q)),
    tables: primary.length,
    observations: set.observations.length,
    reconciliation: { checks: set.reconciliation.length, passed: set.reconciliation.length - mismatches.length,
      mismatches: mismatches.slice(0, 5).map((c) => `${c.period_end}: ${c.check} differs by ${c.difference} ${c.unit}`) },
    latest_balance_sheet: balance ? {
      period_end: balance.period_end, form: balance.form, lines: [...new Set(lines)],
      current_debt_line: [...concepts].some((c) => CURRENT_DEBT.test(c)),
      finance_lease_liability_line: [...concepts].some((c) => FINANCE_LEASE.test(c)),
    } : null,
  };
}
