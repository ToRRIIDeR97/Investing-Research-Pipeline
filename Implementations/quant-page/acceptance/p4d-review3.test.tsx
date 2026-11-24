// Review round 3 (AC-4, AC-5, AC-9, AC-10): benchmark sync outcomes, SIC table determinism, negative zero, the refresh
// alert, chart labels at data extremes, and the stage strip's non-colour cues.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureInputs } from "./support";

test("AC-9: S&P 500 and sector-ETF sync failures mark the snapshot transient (and it isn't stored)", async () => {
  const { benchmarkSyncOutcome } = await import("../../../src/lib/quant/inputs");
  assert.deepEqual(benchmarkSyncOutcome({ spxSynced: true, etf: "XLK", etfSynced: true, etfStored: true }), { notes: [], transient: [] });
  assert.deepEqual(benchmarkSyncOutcome({ spxSynced: false, etf: null, etfSynced: false, etfStored: false }).transient, ["benchmark"]);
  const stale = benchmarkSyncOutcome({ spxSynced: true, etf: "XLK", etfSynced: false, etfStored: true });
  assert.deepEqual(stale.transient, ["sector_etf"]);
  assert.match(stale.notes[0], /stored series/);
  const missing = benchmarkSyncOutcome({ spxSynced: false, etf: "XLE", etfSynced: false, etfStored: false });
  assert.deepEqual(missing.transient, ["benchmark", "sector_etf"]);
  assert.match(missing.notes[1], /S&P 500 only/);
  const { getQuantSnapshot } = await import("../../../src/lib/api/quant");
  for (const t of [["benchmark"], ["sector_etf"]]) {
    const rows = new Map<string, unknown>();
    const store = { get: async () => null, put: async (s: any, d: string) => { rows.set(`${s.ticker}|${d}`, s); } };
    await getQuantSnapshot("FIXA", { store, research: async () => null, load: async () => fixtureInputs({ transient: t }) as any });
    assert.equal(rows.size, 0, `${t} is not cached`);
  }
});

test("AC-10: no stage-history week is labelled after the last trading day", async () => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const s = buildQuantSnapshot(fixtureInputs(), null, new Date("2025-11-21T15:00:00Z"));
  assert.ok(s.trend.stage_history.length > 0);
  assert.ok(s.trend.stage_history.every((w) => w.week <= s.as_of), "found a future Friday");
});

test("AC-5: no two overlapping SIC ranges have the same width, so the narrowest match never depends on order", async () => {
  const { overlappingEqualRanges } = await import("../../../src/lib/quant/sic");
  assert.deepEqual(overlappingEqualRanges(), []);
});

test("AC-4: pyRound keeps Python's negative zero", async () => {
  const { pyRound } = await import("../../../src/lib/quant/value/model");
  assert.ok(Object.is(pyRound(-0.001, 2), -0));
  assert.ok(Object.is(pyRound(0.001, 2), 0));
});

test("AC-10: the refresh alert has a separator and a Dismiss button", async () => {
  const { buildQuantSnapshot } = await import("../../../src/lib/api/quant");
  const { QuantView } = await import("../../../src/components/quant/quant-view");
  const s = buildQuantSnapshot(fixtureInputs(), null, new Date("2025-11-21T15:00:00Z"));
  const html = renderToStaticMarkup(<QuantView snapshot={s} tab="value" onTab={() => {}} refreshError="Request failed (503)" onDismissError={() => {}} />);
  assert.match(html, /Refresh failed \(Request failed \(503\)\)\. The figures below/);
  assert.match(html, />Dismiss<\/button>/);
});

test("AC-10: axis labels mark the data's own high and low; the stage strip has numbers and dates", async () => {
  const c = await import("../../../src/components/quant/quant-charts");
  const band = renderToStaticMarkup(<c.MultipleBand points={[{ period: "2021-12-31", multiple: -12 }, { period: "2022-12-31", multiple: 4 }, { period: "2023-12-31", multiple: 9 }]} metric="P/E" p25={-5} p75={7} current={9} percentile={67} />);
  assert.match(band, />9\.0x<\/text>/);
  assert.match(band, />-12\.0x<\/text>/);
  const days = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
  const path = renderToStaticMarkup(<c.ValuePathChart history={days.map((day, i) => ({ day, close: 50 + i }))} projection={[{ year: 0, bear: 59, base: 59, bull: 59 }, { year: 5, bear: 40, base: 80, bull: 120 }]} selected="base" current={59} />);
  assert.match(path, />\$120<\/text>/);
  assert.match(path, />\$40\.00<\/text>/);
  const weeks = ["2025-01-03", "2025-01-10", "2025-01-17", "2025-01-24"].map((week, i) => ({ week, stage_number: i < 2 ? 1 : 2 }));
  const strip = renderToStaticMarkup(<c.StageStrip weeks={weeks} />);
  // Round 4: each number carries a per-stage ink colour (STAGE_INK) for contrast.
  assert.equal((strip.match(/<b aria-hidden="true"[^>]*>/g) ?? []).length, 2, "a number where the stage changes");
  assert.match(strip, /2025-01-03<\/span><span>2025-01-24/);
});

test("AC-10 (round 4): stage numbers use the contrast ink for their fill, and a flat series shows one axis label", async () => {
  const c = await import("../../../src/components/quant/quant-charts");
  const { C } = await import("../../../src/components/ui/palette");
  const weeks = [1, 2, 3, 4].map((stage_number, i) => ({ week: `2025-0${i + 1}-03`, stage_number }));
  const strip = renderToStaticMarkup(<c.StageStrip weeks={weeks} />);
  assert.match(strip, new RegExp(`color:${C.ink}">3<`), "stage 3 (amber) uses dark ink");
  assert.equal((strip.match(new RegExp(`color:${C.tile}">[124]<`, "g")) ?? []).length, 3);
  const days = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
  const flat = renderToStaticMarkup(<c.PriceVolumeChart series={days.map((day) => ({ day, close: 50, volume: 1, sma50: null, sma150: null, sma200: null }))} pivots={[]} />);
  assert.equal((flat.match(/>\$50\.00<\/text>/g) ?? []).length, 1, "one label, not two on top of each other");
});
