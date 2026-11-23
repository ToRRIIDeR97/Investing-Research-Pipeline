// P2: AC-9 the interactive kit renders on the server, with text equivalents and honest empty states.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

const kit = () => import("../../../src/components/interactive");
const SOFI = { bear: 1.04, base: 8.8, bull: 14.92 };
const points = [{ day: "2026-05-20", close: 12.1 }, { day: "2026-08-18", close: 15.01 }, { day: "2026-11-17", close: 14.28 }];

test("AC-9: PriceChart draws real points, labelled and focusable", async () => {
  const { PriceChart } = await kit();
  const html = renderToStaticMarkup(<PriceChart points={points} currency="USD" valueLine={{ label: "Base", value: 8.8 }} />);
  assert.match(html, /<svg[^>]*role="img"/);
  assert.match(html, /<svg[^>]*tabindex="0"/i);
  assert.match(html, /aria-label="[^"]*12\.10[^"]*14\.28[^"]*"/);
  assert.match(html, /\$14\.28/);
});

test("AC-9: PriceChart with no points says so and draws no line", async () => {
  const { PriceChart } = await kit();
  const html = renderToStaticMarkup(<PriceChart points={[]} currency="USD" />);
  assert.match(html, /No price history yet/);
  assert.doesNotMatch(html, /<polyline|<path[^>]*d="M/);
});

test("AC-9: PriceChart offers a range picker when asked", async () => {
  const { PriceChart } = await kit();
  const html = renderToStaticMarkup(<PriceChart points={points} currency="USD" ranges={["1M", "3M", "6M", "1Y"]} range="6M" onRange={() => {}} />);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-pressed="true"[^>]*>6M</);
});

test("AC-9: ValueMeter states the gap in words", async () => {
  const { ValueMeter } = await kit();
  const html = renderToStaticMarkup(<ValueMeter price={14.28} values={SOFI} selected="base" />);
  assert.match(html, /−38%/);
  assert.match(html, /aria-label="Base case \$8\.80, 38% below the \$14\.28 price"/);
  assert.match(renderToStaticMarkup(<ValueMeter price={null} values={SOFI} selected="base" />), /No price to compare/);
});

test("AC-9: ScenarioPicker has three pressed-state buttons", async () => {
  const { ScenarioPicker } = await kit();
  const html = renderToStaticMarkup(<ScenarioPicker values={SOFI} price={14.28} selected="bull" onSelect={() => {}} />);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  for (const s of ["Bear", "Base", "Bull", "\\$1\\.04", "\\$8\\.80", "\\$14\\.92", "\\+4\\.5%"]) assert.match(html, new RegExp(s));
});

test("AC-9: BlendSlider starts balanced and marks the report's value", async () => {
  const { BlendSlider } = await kit();
  const html = renderToStaticMarkup(<BlendSlider values={SOFI} price={14.28} reportWeighted={7.7} />);
  assert.match(html, /<input[^>]*type="range"[^>]*aria-label="[^"]+"|<input[^>]*aria-label="[^"]+"[^>]*type="range"/);
  assert.match(html, /\$8\.39/);
  assert.match(html, /Report \$7\.70/);
  assert.doesNotMatch(renderToStaticMarkup(<BlendSlider values={{ ...SOFI, bull: null }} price={14.28} />), /type="range"/);
});

test("AC-9: FindingsDonut totals serious findings, rows are buttons", async () => {
  const { FindingsDonut } = await kit();
  const groups = [{ title: "Valuation", serious: 5, counts: { high: 5 } }, { title: "Downside", serious: 2, counts: { high: 2, medium: 1 } }, { title: "15 more", serious: 9, counts: { high: 7, medium: 40, low: 1 } }];
  const html = renderToStaticMarkup(<FindingsDonut groups={groups} />);
  assert.match(html, />16</);
  assert.ok((html.match(/<button/g) ?? []).length >= 3);
});

test("AC-9: RunsBars labels every bar and totals the cost", async () => {
  const { RunsBars } = await kit();
  const runs = [{ id: "a", label: "23 Sep", outcome: "Superseded", cost: 0.52 }, { id: "b", label: "18 Nov 19:05", outcome: "Needs your decision", cost: 4.86, current: true }];
  const html = renderToStaticMarkup(<RunsBars runs={runs} budget={10} />);
  assert.match(html, /<button[^>]*aria-label="18 Nov 19:05, Needs your decision, \$4\.86"/);
  assert.match(html, /\$5\.38/);
  assert.match(html, /\$10 cap/);
});
