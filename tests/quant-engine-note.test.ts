// The engine note split into code, audience, method and figures (src/components/quant/engine-note.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEngineNote } from "../src/components/quant/engine-note";

test("engine notes split into code, audience, method and figures", () => {
  assert.deepEqual(parseEngineNote("Engine F — Mid-cycle normalised (5yr weighted). Core yield: 0.0%, FCF yield: 7.0%"), {
    code: "F", audience: "Energy and mining", method: "Mid-cycle normalised (5yr weighted)",
    figures: [{ label: "Core yield", value: "0.0%" }, { label: "FCF yield", value: "7.0%" }],
  });
  assert.deepEqual(parseEngineNote("Engine B — Revenue + Growth composite (EV/Rev: 3.1x, Rule of 40: 45)"), {
    code: "B", audience: "Growth companies", method: "Revenue + Growth composite",
    figures: [{ label: "EV/Rev", value: "3.1x" }, { label: "Rule of 40", value: "45" }],
  });
  const a = parseEngineNote("Engine A — Normalised EBIT/EV with 5-year weighted average and 20% R&D capitalisation");
  assert.equal(a.method, "Normalised EBIT/EV with 5-year weighted average and 20% R&D capitalisation");
  assert.deepEqual(a.figures, []);
  const c1 = parseEngineNote("Engine C1 — Bank/Financial. P/TBV: 1.20x, ROE: 12.5%, COE: 10.0%");
  assert.equal(c1.audience, "Banks");
  assert.equal(c1.method, "Bank/Financial");
  assert.deepEqual(c1.figures.map((f) => f.label), ["P/TBV", "ROE", "COE"]);
  const b2 = parseEngineNote("Engine B2 — Speculative Pipeline. Score relative to pre-revenue biotech peers only.");
  assert.equal(b2.audience, "Pre-revenue biotech");
  assert.deepEqual(b2.figures, []);
  assert.deepEqual(parseEngineNote("Something else"), { code: null, audience: null, method: "Something else", figures: [] });
});
