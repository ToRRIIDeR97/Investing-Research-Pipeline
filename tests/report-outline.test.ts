import assert from "node:assert/strict";
import test from "node:test";
import { validateProductOutline, type ReportOutline } from "../src/lib/research/reporting/contracts";

const outline = (sections: Array<{ title: string; coverage: string[] }>) => ({ sections }) as unknown as ReportOutline;

test("outline validation reports every violation and names the sections in one error", () => {
  assert.throws(() => validateProductOutline(outline([
    { title: "Summary Judgment", coverage: ["conclusion", "valuation", "downside"] },
    { title: "What Changed in the Reported Record", coverage: ["history", "evidence"] },
    { title: "Valuation and Permanent-Loss Test", coverage: ["valuation", "downside", "forecasts"] },
  ])), (error: Error) => error.message.includes('"What Changed in the Reported Record"')
    && error.message.includes('"Summary Judgment", "Valuation and Permanent-Loss Test"'));
  assert.doesNotThrow(() => validateProductOutline(outline([
    { title: "Summary Judgment", coverage: ["conclusion"] },
    { title: "Origins", coverage: ["history", "business"] },
    { title: "Valuation", coverage: ["valuation", "downside", "forecasts"] },
  ])));
});
