// P5: AC-10 the Quant page renders the rail and both tabs, with text alternatives and partial states. AC-11 links.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureInputs, read } from "./support";

const snapshotOf = async (overrides: Record<string, unknown> = {}, research: any = null) => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  return buildQuantSnapshot(fixtureInputs(overrides), research, new Date("2025-11-21T15:00:00Z"));
};
const view = async () => (await import("../../../src/components/quant/quant-view")).QuantView;
const noop = () => {};

test("AC-10: the rail shows price, both grades, PulseScore, trend, stage and the research action", async () => {
  const QuantView = await view();
  const s = await snapshotOf();
  const html = renderToStaticMarkup(<QuantView snapshot={s} tab="value" onTab={noop} />);
  assert.match(html, /Fixture Software/);
  // One grade since the design pass: PQ-Grade only (PulseGrade is still computed, see p2-value).
  assert.match(html, /PQ-Grade/);
  assert.doesNotMatch(html, /PulseGrade/);
  assert.match(html, /PQ-Grade/);
  assert.match(html, new RegExp(`>${s.value!.pq_grade.grade.replace("+", "\\+")}<`));
  assert.match(html, /PulseScore/);
  assert.match(html, /conditions met/);
  assert.match(html, /href="\/research\/new\?ticker=FIXA&amp;name=Fixture%20Software"/);
});

test("AC-10: the Value tab draws the path chart, value build, multiple band and scenario table, each with a text alternative", async () => {
  const QuantView = await view();
  const html = renderToStaticMarkup(<QuantView snapshot={await snapshotOf()} tab="value" onTab={noop} />);
  assert.match(html, /role="img" aria-label="Price over the last five years[^"]*bear \$[0-9.]+, base \$[0-9.]+, bull \$[0-9.]+/);
  assert.match(html, /aria-label="[^"]*DCF: \$[0-9.]+ of discounted cash flows/);
  assert.match(html, /aria-label="EV\/EBIT at each fiscal year end/);
  assert.match(html, /<th scope="row">Bear<\/th>/);
  assert.match(html, /Credit Impact Scalar unavailable/);
});

test("AC-10: the Trend tab draws price with averages and volume, rebased, stage strip, conditions and patterns", async () => {
  const QuantView = await view();
  const html = renderToStaticMarkup(<QuantView snapshot={await snapshotOf()} tab="trend" onTab={noop} />);
  assert.match(html, /aria-label="One year of daily closes/);
  assert.match(html, /aria-label="Rebased to 100 a year ago/);
  assert.match(html, /aria-label="Weinstein stage over \d+ weeks/);
  assert.match(html, /Patterns/);
  assert.match(html, /52-week position/);
  assert.equal((html.match(/data-status=/g) ?? []).length, 9, "nine conditions");
});

test("AC-10: a partial snapshot shows why Value is missing; Trend still renders", async () => {
  const QuantView = await view();
  const s = await snapshotOf({ fundamentals: null, fundamentals_reason: "Not an SEC filer.", cik: null });
  const value = renderToStaticMarkup(<QuantView snapshot={s} tab="value" onTab={noop} />);
  assert.match(value, /Not an SEC filer\./);
  assert.doesNotMatch(value, /PQ-Grade/);
  assert.match(renderToStaticMarkup(<QuantView snapshot={s} tab="trend" onTab={noop} />), /One year of daily closes/);
});

test("AC-11: a researched ticker links to its Research page; nav and the Research page link to Quant", async () => {
  const QuantView = await view();
  const s = await snapshotOf({}, { asset_id: "asset-9", run_id: "run-1", status: "completed" });
  assert.match(renderToStaticMarkup(<QuantView snapshot={s} tab="value" onTab={noop} />), /href="\/assets\/asset-9\/view"/);
  assert.match(read("src/components/app-shell.tsx"), /href="\/quant"/);
  assert.match(read("src/app/assets/[id]/view/page.tsx"), /href=\{`\/quant\/\$\{encodeURIComponent\(ticker\)\}`\}/);
  assert.match(read("src/app/quant/[ticker]/page.tsx"), /searchParams|useSearchParams/);
  assert.match(read("src/app/quant/[ticker]/page.tsx"), /\?tab=\$\{next\}/);
});
