// P5 (added in review, AC-10, AC-11): chart edge cases, tab parsing, accessible condition marks, forward values,
// no raw hex colours in the Quant UI, and a runtime check that building a snapshot loads no model-calling module.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureInputs, read } from "./support";

const charts = () => import("../../../src/components/quant/quant-charts");
const noNaN = (html: string) => assert.doesNotMatch(html, /NaN|Infinity|undefined/, html.slice(0, 300));

test("AC-10: ?tab= parsing — trend in any case opens Trend; anything else opens Value", async () => {
  const { parseQuantTab } = await import("../../../src/components/quant/quant-view");
  assert.equal(parseQuantTab("trend"), "trend");
  assert.equal(parseQuantTab(" TREND "), "trend");
  for (const raw of [null, undefined, "", "value", "trends", "<script>"]) assert.equal(parseQuantTab(raw as any), "value");
});

test("AC-10: charts degrade to a sentence on empty or one-point data and never draw NaN", async () => {
  const c = await charts();
  const one = [{ day: "2025-01-03", close: 10 }];
  const cases = [
    <c.ValuePathChart key="a" history={[]} projection={[]} selected="base" current={10} />,
    <c.ValuePathChart key="b" history={one} projection={[]} selected="base" current={10} />,
    <c.MultipleBand key="c" points={[]} metric="P/E" p25={null} p75={null} current={null} percentile={null} />,
    <c.PriceVolumeChart key="d" series={[]} pivots={[]} />,
    <c.RebasedChart key="e" stock={[{ day: "2025-01-03", value: 100 }]} spx={[]} sector={[]} sectorSymbol={null} />,
    <c.StageStrip key="f" weeks={[]} />,
  ];
  for (const el of cases) { const html = renderToStaticMarkup(el); assert.match(html, /<p /); noNaN(html); }
  assert.equal(renderToStaticMarkup(<c.Sparkline points={one} />), "");
  assert.equal(renderToStaticMarkup(<c.VcpDepths contractions={[]} />), "");
});

test("AC-10: flat, negative and mismatched series stay inside the chart", async () => {
  const c = await charts();
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
  const flat = renderToStaticMarkup(<c.ValuePathChart history={days.map((day) => ({ day, close: 50 }))} projection={[{ year: 0, bear: 50, base: 50, bull: 50 }, { year: 5, bear: 50, base: 50, bull: 50 }]} selected="base" current={50} />);
  noNaN(flat);
  const neg = renderToStaticMarkup(<c.MultipleBand points={[{ period: "2021-12-31", multiple: -12 }, { period: "2022-12-31", multiple: -4 }, { period: "2023-12-31", multiple: 9 }]} metric="P/E" p25={-30} p75={40} current={9} percentile={67} />);
  noNaN(neg);
  for (const m of neg.matchAll(/<rect x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/g)) {
    const [x, y, w, h] = m.slice(1).map(Number);
    assert.ok(x >= 0 && y >= 0 && x + w <= 420 && y + h <= 200, `band ${m[0]} inside the 420×200 view box`);
  }
  for (const m of neg.matchAll(/<text x="([-0-9.]+)"/g)) assert.ok(Number(m[1]) >= 0, "labels start at x ≥ 0");
  const build = renderToStaticMarkup(<c.ValueBuild build={{ pv_cash_flows: -4, pv_terminal: 30, net_debt_per_share: -6, per_share: 32, metric: "FCF", terminal_share: 1.15 }} />);
  noNaN(build);
  assert.match(build, />−\$4\.00</);
  assert.match(build, />\+\$6\.00</);
  assert.doesNotMatch(build, /height="-/);
  // A benchmark that starts later and misses days is placed by date, not by index.
  const stock = days.map((day, i) => ({ day, value: 100 + i }));
  const spx = days.filter((_, i) => i >= 10 && i % 2 === 0).map((day) => ({ day, value: 100 }));
  const reb = renderToStaticMarkup(<c.RebasedChart stock={stock} spx={spx} sector={[]} sectorSymbol={null} />);
  noNaN(reb);
  const spxPath = [...reb.matchAll(/<path d="M([0-9.]+),/g)].map((m) => Number(m[1]));
  assert.ok(spxPath.some((x) => x > 100), "the S&P line starts on its own first day, not at the left edge");
});

test("AC-10: label spreading keeps labels apart and inside the plot", async () => {
  const { spreadLabels } = await charts();
  const out = spreadLabels([50, 52, 51], 14, 10, 170);
  const sorted = [...out].sort((a, b) => a - b);
  assert.ok(sorted[1] - sorted[0] >= 14 && sorted[2] - sorted[1] >= 14);
  const low = spreadLabels([169, 170, 171], 14, 10, 170);
  assert.ok(Math.max(...low) <= 170 && Math.min(...low) >= 10);
});

test("AC-10: the value path shows forward values that end above the discounted intrinsic value", async () => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const s = buildQuantSnapshot(fixtureInputs(), null, new Date("2025-11-21T15:00:00Z"));
  const v = s.value!;
  const end = v.charts.projection[v.charts.projection.length - 1];
  assert.ok(v.dcf.discount_rate > 0);
  assert.ok(Math.abs(end.base - v.dcf.price_targets[v.dcf.price_targets.length - 1].base_target * (1 + v.dcf.discount_rate) ** end.year) < 0.02);
  assert.ok(s.price_history_5y.every((w) => w.day <= s.as_of), "no week is labelled after the last trading day");
  const { QuantView } = await import("../../../src/components/quant/quant-view");
  const html = renderToStaticMarkup(<QuantView snapshot={s} tab="value" onTab={() => {}} />);
  assert.match(html, /value \(forward\)/);
  assert.doesNotMatch(html, /Year-5 target \(discounted\)/);
});

test("AC-10: condition marks carry visible-to-screen-reader text and a null PulseScore says so", async () => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantView } = await import("../../../src/components/quant/quant-view");
  const s = buildQuantSnapshot(fixtureInputs(), null, new Date("2025-11-21T15:00:00Z"));
  const trend = renderToStaticMarkup(<QuantView snapshot={s} tab="trend" onTab={() => {}} />);
  assert.match(trend, /aria-hidden="true">[✓×–]</);
  assert.match(trend, /class="srOnly">(Met|Not met|Not enough history): </);
  const nullPulse = { ...s, value: { ...s.value!, pulse_score: null as unknown as number } };
  const rail = renderToStaticMarkup(<QuantView snapshot={nullPulse} tab="value" onTab={() => {}} />);
  assert.match(rail, /aria-label="PulseScore unavailable"/);
  assert.doesNotMatch(rail, /PulseScore undefined/);
});

test("AC-10: the Quant UI uses palette tokens only (no raw hex colours)", () => {
  for (const f of ["src/components/quant/quant-charts.tsx", "src/components/quant/quant-view.tsx", "src/components/quant/quant.module.css",
    "src/app/quant/page.tsx", "src/app/quant/[ticker]/page.tsx", "src/components/quant/quant-finder.tsx", "src/components/quant/finder.module.css"]) {
    assert.doesNotMatch(read(f), /#[0-9a-fA-F]{3,8}\b/, `${f} has a raw hex colour`);
  }
});

test("AC-10: the ticker page wraps useSearchParams in Suspense and announces loading", () => {
  const page = read("src/app/quant/[ticker]/page.tsx");
  assert.match(page, /<Suspense/);
  // Loading is announced by PageLoading (role="status", src/components/ui/loading.tsx) since quant-intl-watchlist-settings P8.
  assert.match(page, /role="status"|<PageLoading/);
  assert.match(page, /parseQuantTab\(params\.get\("tab"\)\)/);
});

test("AC-11: building and rendering a snapshot loads no model-calling or agent-harness module", async () => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantView } = await import("../../../src/components/quant/quant-view");
  renderToStaticMarkup(<QuantView snapshot={buildQuantSnapshot(fixtureInputs(), null, new Date())} tab="trend" onTab={() => {}} />);
  const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, "/"));
  const banned = loaded.filter((k) => /src\/lib\/(agent-harness|research\/(agents|providers|model|pipeline-runner))|@anthropic-ai|\/openai\//.test(k));
  assert.deepEqual(banned, []);
});
