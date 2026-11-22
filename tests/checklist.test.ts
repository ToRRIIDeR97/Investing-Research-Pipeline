// Investment checklist beyond the acceptance set: measure edge cases, evaluating a whole checklist, and the mock
// model's judgement output passing the same check the route applies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CHECKLIST, evaluateChecklist, judgementErrors, measureValue, type ChecklistArtifact } from "../src/lib/research/checklist";
import { MockProvider } from "../src/lib/agent-harness/providers/mock";

const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });
const analytics = (net_cash: number, fcf_ttm: number, version = 1): ChecklistArtifact => ({ artifact_type: "financial_analytics", artifact_version: version, content_json: {
  statistics: table(["metric", "median"], [["revenue_yoy", 0.2]]),
  cash_conversion: { quarterly: table(["period", "fcf_ttm"], [["2026Q2", fcf_ttm]]) },
  capital_allocation: { quarterly: table(["period", "net_cash", "shares_yoy"], [["2026Q2", net_cash, -0.015]]) } } });

test("net-debt payback: net cash is 0 years, non-positive FCF gives no value; the newest version is read", () => {
  assert.deepEqual(measureValue("net_debt_payback_years", [analytics(500, 100)]), { value: 0, display: "0.0 years (net cash)" });
  const burning = measureValue("net_debt_payback_years", [analytics(-500, -10)]);
  assert.equal(burning.value, null);
  assert.ok("reason" in burning && /not positive/.test(burning.reason));
  assert.equal(measureValue("net_debt_payback_years", [analytics(-100, 100, 1), analytics(-300, 100, 2)]).value, 3);
  assert.equal(measureValue("share_change_yoy", [analytics(0, 1)]).value, -1.5);
  assert.equal(measureValue("pe_ttm", [analytics(0, 1)]).value, null);
});

test("a whole checklist: measures by code, judgements from checked output or unknown with the reason", () => {
  const artifacts = [analytics(-2000, 1000), { artifact_type: "report_facts", artifact_version: 1, content_json: {
    market: { pe_ttm: 20 }, cases: table(["case", "tv_share_of_ev"], [["base", 0.6]]) } }];
  const off = evaluateChecklist(DEFAULT_CHECKLIST, artifacts, null, "Not judged: model calls are off.");
  const judged = off.results.filter((r) => r.kind === "judgement");
  assert.ok(judged.every((r) => r.status === "unknown" && r.reason === "Not judged: model calls are off."));
  assert.equal(off.results.find((r) => r.id === "net_debt_payback")!.status, "met");
  assert.equal(off.results.find((r) => r.id === "growth_bar")!.display, "20.0%");
  const answer = { results: DEFAULT_CHECKLIST.items.filter((i) => i.kind === "judgement").map((i, n) => ({ id: i.id, status: n === 0 ? "met" as const : "unclear" as const,
    rationale: "From the filings.", evidence_ids: n === 0 ? ["e1"] : [] })) };
  const on = evaluateChecklist(DEFAULT_CHECKLIST, artifacts, answer, "", new Map([["e1", { source_title: "10-K", claim_text: "Most revenue is grid equipment." }]]));
  const pure = on.results.find((r) => r.id === "pure_play")!;
  assert.deepEqual([pure.status, pure.evidence[0].source_title], ["met", "10-K"]);
  assert.equal(on.results.find((r) => r.id === "dividend_record")!.status, "unknown", "unclear scores as unknown");
  assert.equal(on.score.max, off.score.max + 3);
});

test("the mock model judges every judgement item once with the run's evidence", async () => {
  const items = DEFAULT_CHECKLIST.items.filter((i) => i.kind === "judgement").map((i) => ({ id: i.id, label: i.label, question: i.question }));
  let text = "";
  for await (const event of new MockProvider().stream({ model: "mock", agentName: "asset-analyst",
    prompt: JSON.stringify({ output_contract: "checklist_judgement", items, evidence: [{ id: "e1" }, { id: "e2" }] }) }, new AbortController().signal))
    if (event.type === "text.delta") text += event.text;
  assert.deepEqual(judgementErrors(JSON.parse(text), DEFAULT_CHECKLIST.items, new Set(["e1", "e2"])), []);
});
