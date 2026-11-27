// Verification: rendering and page wiring from other angles (AC-7 to AC-10).
import { read } from "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { STAGE_CONFIGS } from "../../../src/lib/workflow/stages";
import { phaseProgress } from "../../../src/lib/research/run-flow";

const kit = () => import("../../../src/components/run-flow");

test("AC-7: stepper at the first and last steps", async () => {
  const { FlowStepper } = await kit();
  const first = renderToStaticMarkup(<FlowStepper current={0} />);
  assert.equal((first.match(/data-state="done"/g) || []).length, 0);
  const last = renderToStaticMarkup(<FlowStepper current={4} />);
  assert.equal((last.match(/data-state="done"/g) || []).length, 4);
  assert.equal((last.match(/aria-current="step"/g) || []).length, 1);
});

test("AC-7: a finished track shows each phase complete", async () => {
  const { PhaseTrack } = await kit();
  const phases = phaseProgress(STAGE_CONFIGS.map((s) => ({ key: s.key, status: "completed" })));
  const html = renderToStaticMarkup(<PhaseTrack phases={phases} />);
  for (const p of phases) assert.match(html, new RegExp(`${p.total} of ${p.total}`));
});

test("AC-7: feed text is escaped, not injected", async () => {
  const { RunFeed } = await kit();
  const html = renderToStaticMarkup(<RunFeed items={[{ text: "<img src=x onerror=alert(1)>", at: null }]} />);
  assert.doesNotMatch(html, /<img/);
});

test("AC-7: with no estimates every depth says there is no history", async () => {
  const { DepthPicker } = await kit();
  const html = renderToStaticMarkup(<DepthPicker value="quick_scan" onChange={() => {}} estimates={{}} />);
  assert.equal((html.match(/No past runs of this type yet/g) || []).length, 4);
  assert.match(html, /value="quick_scan"[^>]*checked|checked[^>]*value="quick_scan"/);
});

test("AC-8: the run page asks the estimates route, and the route handles errors", () => {
  assert.match(read("src/app/assets/[id]/run/page.tsx"), /\/api\/research-runs\/estimates/);
  assert.match(read("src/app/api/research-runs/estimates/route.ts"), /handleApiError/);
});

test("AC-9: the old two-column intake with raw dropdown is gone", () => {
  const src = read("src/app/assets/[id]/run/page.tsx");
  assert.doesNotMatch(src, /<select value=\{runType\}/);
  assert.match(src, /Research type|DepthPicker/);
});

test("AC-9: Home links plan approvals to the run page", () => {
  const home = read("src/app/page.tsx");
  assert.match(home, /Needs plan approval|item\.label/);
  assert.doesNotMatch(home, /queue\.map\(\(item\) => \{\s*const asset/);
});

test("AC-10: the plan step still sends forecast years and framing edits with approval", () => {
  const src = read("src/app/assets/[id]/run/page.tsx");
  assert.match(src, /forecast_years: planForecastYears, \.\.\.planEdits/);
  assert.match(src, /window\.confirm\(/);
});
