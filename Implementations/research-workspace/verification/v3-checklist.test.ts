// Independent checks for P3 (C-1 to C-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Checklist, evaluateMeasureItem, judgementErrors, measureValue, scoreChecklist } from "../../../src/lib/research/checklist";
import { checklistArtifacts } from "../acceptance/p3-checklist.test";

test("V-C2: net cash means no payback time; no artifacts means no value", () => {
  const cash = checklistArtifacts.map((a) => a.artifact_type !== "financial_analytics" ? a : { ...a, content_json: { ...a.content_json,
    capital_allocation: { ...(a.content_json as any).capital_allocation, quarterly: { columns: ["period", "net_cash", "shares_yoy"], rows: [["2026Q2", 500, -0.01]] } } } });
  assert.equal(measureValue("net_debt_payback_years", cash as any).value, 0);
  assert.equal(measureValue("share_change_yoy", cash as any).value, -1);
  assert.equal(measureValue("roic_median", [] as any).value, null);
});

test("V-C2: a threshold exactly met counts as met", () => {
  const status = evaluateMeasureItem({ id: "m", label: "Margin", weight: 1, kind: "measure", measure: "operating_margin_median", op: ">=", threshold: 18 }, checklistArtifacts as any).status;
  assert.equal(status, "met");
});

test("V-C3: weights matter", () => {
  assert.deepEqual(scoreChecklist([{ weight: 3, status: "met" }, { weight: 1, status: "not_met" }]), { score: 3, max: 4, percent: 75, unknown: 0 });
  assert.deepEqual(scoreChecklist([]), { score: 0, max: 0, percent: null, unknown: 0 });
});

test("V-C4: a non-object output, an empty rationale and an unknown status fail", () => {
  const items = [{ id: "a", label: "A", weight: 1, kind: "judgement" as const, question: "q" }];
  assert.ok(judgementErrors(null, items, new Set()).length > 0);
  assert.ok(judgementErrors({ results: [{ id: "a", status: "met", rationale: "", evidence_ids: [] }] }, items, new Set()).length > 0);
  assert.ok(judgementErrors({ results: [{ id: "a", status: "maybe", rationale: "r", evidence_ids: [] }] }, items, new Set()).length > 0);
});

test("V-C1: thirty items at most; names are required", () => {
  const items = Array.from({ length: 31 }, (_, i) => ({ id: `i${i}`, label: "L", weight: 1, kind: "judgement", question: "q" }));
  assert.ok(!Checklist.safeParse({ name: "Big", items }).success);
  assert.ok(!Checklist.safeParse({ name: "", items: items.slice(0, 1) }).success);
});
