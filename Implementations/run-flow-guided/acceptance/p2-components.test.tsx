// P2: AC-7, the flow components render on the server.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { phaseProgress } from "../../../src/lib/research/run-flow";

const kit = () => import("../../../src/components/run-flow");

test("AC-7: FlowStepper marks the current step and the done ones", async () => {
  const { FlowStepper } = await kit();
  const html = renderToStaticMarkup(<FlowStepper current={2} />);
  for (const label of ["Company", "Question", "Plan", "Research", "Review"]) assert.match(html, new RegExp(label));
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /aria-current="step"[^>]*>[\s\S]*?Plan/);
  assert.equal((html.match(/data-state="done"/g) || []).length, 2);
});

test("AC-7: PhaseTrack shows done of total and the gates", async () => {
  const { PhaseTrack } = await kit();
  const html = renderToStaticMarkup(<PhaseTrack phases={phaseProgress([{ key: "intake", status: "completed" }, { key: "research_plan", status: "running" }])} />);
  assert.match(html, /Frame/); assert.match(html, /Decide/);
  assert.match(html, /1 of 2/);
  assert.equal((html.match(/data-gate=/g) || []).length, 2);
});

test("AC-7: RunFeed lists items, or says nothing has happened", async () => {
  const { RunFeed } = await kit();
  assert.match(renderToStaticMarkup(<RunFeed items={[{ text: "Read the filings", at: "2026-11-27T09:14:00Z" }]} />), /Read the filings/);
  assert.match(renderToStaticMarkup(<RunFeed items={[]} />), /Nothing has happened yet/);
});

test("AC-7: DepthPicker offers every run type with facts and estimates", async () => {
  const { DepthPicker } = await kit();
  const html = renderToStaticMarkup(<DepthPicker value="deep_dive" onChange={() => {}} estimates={{ deep_dive: { runs: 3, medianCostUsd: 1.5, medianMinutes: 70 } }} />);
  assert.equal((html.match(/type="radio"/g) || []).length, 4);
  for (const label of ["Quick scan", "Thesis investigation", "Deep dive", "Initiation report"]) assert.match(html, new RegExp(label));
  assert.match(html, /value="deep_dive"[^>]*checked|checked[^>]*value="deep_dive"/);
  assert.match(html, /\$1\.50/);
  assert.match(html, /No past runs of this type yet/);
  assert.match(html, /backtest/i);
});
