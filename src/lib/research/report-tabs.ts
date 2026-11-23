// The asset report page's five tabs. Overview (the company overview: prices, value, blend, runs) comes first; the page
// still opens on the Memo when no `?view=` is given. Each tab groups the earlier views, which stay addressable by `?view=`
// so every saved link still opens; a tab with more than one view shows them as sub-tabs, except Model, whose views share
// one page. The notebook opens from its drawer, outside the tab bar.

export type ReportView = "memo" | "overview" | "evidence" | "metrics" | "valuation" | "workbench" | "thesis" | "financials" | "kpis" | "notebook" | "backtests" | "sources" | "runs";

export interface ReportTab { key: "overview" | "memo" | "model" | "financials" | "audit"; label: string; views: readonly ReportView[]; /** Its views render as one page, without sub-tabs. */ onePage?: boolean }

export const REPORT_TABS: readonly ReportTab[] = [
  { key: "overview", label: "Overview", views: ["overview"] },
  { key: "memo", label: "Memo", views: ["memo"] },
  { key: "model", label: "Model", views: ["valuation", "workbench"], onePage: true },
  { key: "financials", label: "Financials", views: ["financials", "kpis", "metrics"] },
  { key: "audit", label: "Audit", views: ["thesis", "evidence", "sources", "backtests", "runs"] },
];

export const VIEW_LABELS: Record<ReportView, string> = {
  memo: "Memo", overview: "Overview", thesis: "Report", evidence: "Evidence", sources: "Sources", backtests: "Backtests", runs: "Run history",
  valuation: "Valuation", workbench: "Workbench", financials: "Statements", kpis: "KPIs", metrics: "Metrics", notebook: "Notebook",
};

const KNOWN: readonly ReportView[] = ["memo", "overview", "evidence", "metrics", "valuation", "workbench", "thesis", "financials", "kpis", "notebook", "backtests", "sources", "runs"];

/** The view a `?view=` value opens: none opens the memo, `report` is the full report, anything unknown the memo. */
export function viewFromQuery(value: string | null | undefined): ReportView {
  if (!value) return "memo";
  if (value === "report") return "thesis";
  return (KNOWN as readonly string[]).includes(value) ? value as ReportView : "memo";
}

/** The `?view=` value for a view (the full report keeps its earlier `report` spelling). */
export const viewQuery = (view: ReportView) => view === "thesis" ? "report" : view;

/** The tab a view belongs to, or null for views outside the tab bar (the notebook). */
export const tabOf = (view: ReportView): ReportTab | null => REPORT_TABS.find((tab) => tab.views.includes(view)) ?? null;
