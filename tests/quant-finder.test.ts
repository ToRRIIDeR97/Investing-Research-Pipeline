// The Quant finder's directory search and snapshot summaries (src/lib/quant/directory.ts). No network, no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { finderSnapshot, parseSecDirectory, resetSecDirectoryCache, searchDirectory, secDirectory } from "../src/lib/quant/directory";

const RAW = {
  0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  1: { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
  2: { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
  3: { cik_str: 1418121, ticker: "APLE", title: "Apple Hospitality REIT, Inc." },
  4: { cik_str: 2, ticker: "AAPL", title: "Duplicate" },
  5: { cik_str: 3, ticker: "bad ticker!", title: "Rejected" },
  6: { cik_str: 4, ticker: "PINE", title: "Alpine Income Property Trust" },
  7: { cik_str: 5, ticker: 7, title: "Not a string" },
};

test("parseSecDirectory keeps valid, unique, upper-cased tickers in SEC order", () => {
  const entries = parseSecDirectory(RAW);
  assert.deepEqual(entries.map((e) => e.ticker), ["AAPL", "NVDA", "BRK-B", "APLE", "PINE"]);
  assert.equal(entries[0].name, "Apple Inc.");
  assert.deepEqual(parseSecDirectory(null), []);
  assert.deepEqual(parseSecDirectory("nope"), []);
});

test("searchDirectory ranks exact ticker, ticker prefix, name word, then name substring", () => {
  const entries = parseSecDirectory(RAW);
  assert.deepEqual(searchDirectory(entries, "aapl").map((e) => e.ticker), ["AAPL"]);
  assert.deepEqual(searchDirectory(entries, "ap").map((e) => e.ticker), ["APLE", "AAPL"], "ticker prefix before name word");
  assert.deepEqual(searchDirectory(entries, "apple").map((e) => e.ticker), ["AAPL", "APLE"], "name words keep SEC order");
  assert.deepEqual(searchDirectory(entries, "pine").map((e) => e.ticker), ["PINE"], "exact ticker; 'Alpine' is a substring match too but once");
  assert.deepEqual(searchDirectory(entries, "lpi").map((e) => e.ticker), ["PINE"], "substring match from three letters");
  assert.deepEqual(searchDirectory(entries, "lp").map((e) => e.ticker), [], "no substring match under three letters");
  assert.deepEqual(searchDirectory(entries, "   "), []);
  assert.equal(searchDirectory(entries, "a", 2).length, 2);
});

test("secDirectory fetches once, reuses the cache, and serves a stale copy when SEC fails", async () => {
  resetSecDirectoryCache();
  let calls = 0;
  const ok = async () => { calls += 1; return new Response(JSON.stringify(RAW), { status: 200 }); };
  const first = await secDirectory(ok, 1_000);
  await secDirectory(ok, 2_000);
  assert.equal(calls, 1);
  const failing = async () => { calls += 1; return new Response("", { status: 503 }); };
  const stale = await secDirectory(failing, 1_000 + 25 * 60 * 60 * 1000);
  assert.equal(calls, 2);
  assert.deepEqual(stale, first);
  resetSecDirectoryCache();
  await assert.rejects(secDirectory(failing, 0), /503/);
  resetSecDirectoryCache();
});

test("finderSnapshot summarises a stored snapshot and tolerates partial JSON", () => {
  const s = finderSnapshot({
    ticker: "KO", name: "Coca-Cola Co", price: 61.2, as_of: "2026-11-24",
    value: { pulse_grade: { grade: "B", label: "x" }, pq_grade: { grade: "A-", label: "y" } },
    trend: { conditions: { score_label: "6/8 conditions met" }, stage: { stage_number: 2 }, charts: { sparkline: [{ close: 60 }, { close: "x" }, { close: 61.2 }] } },
  });
  assert.deepEqual(s, { ticker: "KO", name: "Coca-Cola Co", price: 61.2, as_of: "2026-11-24", pulse_grade: "B", pq_grade: "A-", trend_label: "6/8 conditions met", stage: 2, sparkline: [60, 61.2] });
  assert.deepEqual(finderSnapshot({ ticker: "X", value: null, trend: {} }), { ticker: "X", name: "X", price: null, as_of: null, pulse_grade: null, pq_grade: null, trend_label: null, stage: null, sparkline: [] });
  assert.equal(finderSnapshot({ name: "no ticker" }), null);
  assert.equal(finderSnapshot(null), null);
});
