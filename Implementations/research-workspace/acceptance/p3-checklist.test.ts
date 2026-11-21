// C-1 to C-5: checklist contracts, measures computed by code, scoring, judgement validation and the default checklist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Checklist, ChecklistItem, DEFAULT_CHECKLIST, MEASURES, evaluateMeasureItem, judgementErrors, measureValue, scoreChecklist } from "../../../src/lib/research/checklist";

const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });
export const checklistArtifacts = [
  { artifact_type: "financial_analytics", artifact_version: 1, content_json: {
    statistics: table(["metric", "n", "median", "min", "max", "latest", "latest_period", "percentile"], [
      ["revenue_yoy", 20, 0.12, 0.02, 0.3, 0.1, "2026Q2", 0.4], ["operating_margin", 20, 0.18, 0.1, 0.25, 0.2, "2026Q2", 0.7],
      ["fcf_margin", 20, 0.15, 0.05, 0.2, 0.16, "2026Q2", 0.6], ["roic", 20, 0.22, 0.1, 0.3, 0.25, "2026Q2", 0.8]]),
    cash_conversion: { quarterly: table(["period", "fcf_ttm"], [["2026Q1", 900], ["2026Q2", 1000]]), incremental: table([], []) },
    capital_allocation: { quarterly: table(["period", "net_cash", "shares_yoy"], [["2026Q1", -2500], ["2026Q2", -2000]]), share_classes: table([], []), notes: [] },
  } },
  { artifact_type: "report_facts", artifact_version: 1, content_json: {
    cases: { columns: ["case", "probability", "tv_share_of_ev"], rows: [["bear", 0.25, 0.7], ["base", 0.5, 0.62], ["bull", 0.25, 0.55]] },
    market: { pe_ttm: 24.5 } } },
];

test("C-1: items are typed; a checklist needs unique items", () => {
  assert.ok(ChecklistItem.safeParse({ id: "growth", label: "Growth above 10%", weight: 2, kind: "measure", measure: "revenue_yoy_median", op: ">=", threshold: 10 }).success);
  assert.ok(ChecklistItem.safeParse({ id: "moat", label: "Pure play", weight: 3, kind: "judgement", question: "Is most revenue from the theme?" }).success);
  assert.ok(!ChecklistItem.safeParse({ id: "x", label: "x", weight: 4, kind: "judgement", question: "q" }).success, "weight 1-3");
  assert.ok(!ChecklistItem.safeParse({ id: "x", label: "x", weight: 1, kind: "measure", measure: "made_up", op: ">=", threshold: 1 }).success);
  const item = { id: "a", label: "A", weight: 1, kind: "judgement", question: "q" };
  assert.ok(!Checklist.safeParse({ name: "Mine", items: [item, item] }).success, "unique ids");
  assert.ok(!Checklist.safeParse({ name: "Mine", items: [] }).success);
});

test("C-2: measures come from the stored analytics and report facts, in display units", () => {
  for (const key of ["revenue_yoy_median", "operating_margin_median", "fcf_margin_median", "roic_median", "net_debt_payback_years", "share_change_yoy", "pe_ttm", "tv_share_of_ev"])
    assert.ok(key in MEASURES, key);
  assert.deepEqual(measureValue("revenue_yoy_median", checklistArtifacts as any).value, 12);
  assert.equal(measureValue("net_debt_payback_years", checklistArtifacts as any).value, 2, "net debt 2,000 over FCF 1,000");
  assert.equal(measureValue("pe_ttm", checklistArtifacts as any).value, 24.5);
  assert.equal(measureValue("tv_share_of_ev", checklistArtifacts as any).value, 62);
  const missing = measureValue("share_change_yoy", checklistArtifacts as any);
  assert.equal(missing.value, null);
  assert.ok("reason" in missing && missing.reason.length > 0);
  assert.equal(evaluateMeasureItem({ id: "g", label: "Growth", weight: 1, kind: "measure", measure: "revenue_yoy_median", op: ">=", threshold: 10 }, checklistArtifacts as any).status, "met");
  assert.equal(evaluateMeasureItem({ id: "d", label: "Debt", weight: 1, kind: "measure", measure: "net_debt_payback_years", op: "<=", threshold: 1.5 }, checklistArtifacts as any).status, "not_met");
  assert.equal(evaluateMeasureItem({ id: "s", label: "Dilution", weight: 1, kind: "measure", measure: "share_change_yoy", op: "<=", threshold: 2 }, checklistArtifacts as any).status, "unknown");
});

test("C-3: the score counts evaluated weight only", () => {
  assert.deepEqual(scoreChecklist([{ weight: 2, status: "met" }, { weight: 1, status: "not_met" }, { weight: 3, status: "unknown" }]), { score: 2, max: 3, percent: 66.7, unknown: 1 });
  assert.deepEqual(scoreChecklist([{ weight: 1, status: "unknown" }]), { score: 0, max: 0, percent: null, unknown: 1 });
});

test("C-4: judgement results must cover every judgement item once and cite only the run's evidence", () => {
  const items = [{ id: "pure", label: "Pure play", weight: 3, kind: "judgement" as const, question: "q" }, { id: "mgmt", label: "Management", weight: 1, kind: "judgement" as const, question: "q" }];
  const evidence = new Set(["e1", "e2"]);
  const ok = { results: [{ id: "pure", status: "met", rationale: "Most revenue is grid equipment.", evidence_ids: ["e1"] }, { id: "mgmt", status: "unclear", rationale: "No targets disclosed.", evidence_ids: [] }] };
  assert.deepEqual(judgementErrors(ok, items, evidence), []);
  assert.ok(judgementErrors({ results: [ok.results[0]] }, items, evidence).length > 0, "missing item");
  assert.ok(judgementErrors({ results: [...ok.results, ok.results[0]] }, items, evidence).length > 0, "duplicate");
  assert.ok(judgementErrors({ results: [{ ...ok.results[0], evidence_ids: ["e9"] }, ok.results[1]] }, items, evidence).length > 0, "unknown evidence");
  assert.ok(judgementErrors({ results: [{ ...ok.results[0], id: "other" }, ok.results[1]] }, items, evidence).length > 0, "unknown item");
});

test("C-5: the default checklist is valid and mixes code measures with judgements", () => {
  const parsed = Checklist.parse(DEFAULT_CHECKLIST);
  assert.ok(parsed.items.some(i => i.kind === "measure") && parsed.items.some(i => i.kind === "judgement"));
  assert.ok(parsed.items.some(i => i.kind === "measure" && i.measure === "net_debt_payback_years"));
});
