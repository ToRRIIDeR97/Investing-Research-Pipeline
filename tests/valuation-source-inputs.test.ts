import assert from "node:assert/strict";
import { test } from "node:test";
import { valuationMarketSnapshot } from "../src/lib/research/handlers/asset-valuation";
import { latestSecQuarterlyFact, secFactSpan } from "../src/lib/research/history/sec-companyfacts";

const snapshotText = (retrievedAt: string) => JSON.stringify({
  retrieved_at: retrievedAt,
  meta: { currency: "USD", regularMarketPrice: 512.3, fiftyTwoWeekHigh: 560, fiftyTwoWeekLow: 380 },
});

test("a snapshot fetched after a historical cutoff gives no live price, 52-week range or fallback price", () => {
  const historical = valuationMarketSnapshot(snapshotText("2026-10-11T09:00:00Z"), new Date("2022-01-01T00:00:00Z"));
  assert.equal(historical.historical, true);
  assert.equal(historical.fallbackPrice, null);
  assert.equal(historical.snapshot.currency, "USD");
  for (const key of ["regular_market_price", "fifty_two_week_high", "fifty_two_week_low"]) assert.equal(key in historical.snapshot, false);

  const live = valuationMarketSnapshot(snapshotText("2026-10-11T09:00:00Z"), new Date("2026-10-11T00:00:00Z"));
  assert.equal(live.historical, false);
  assert.equal(live.fallbackPrice, 512.3);
  assert.equal(live.snapshot.fifty_two_week_high, 560);
});

test("the diluted-share fact is located by its offset even when it straddles a chunk boundary", () => {
  const companyFacts = { facts: { "us-gaap": {
    WeightedAverageNumberOfShareOutstandingBasicAndDiluted: { units: { shares: [
      { start: "2026-04-01", end: "2026-06-30", val: 2_600_000_000, accn: "0001-26-000123", form: "10-Q", filed: "2026-07-30" },
    ] } },
    WeightedAverageNumberOfDilutedSharesOutstanding: { label: "Diluted shares", units: { shares: [
      { start: "2026-01-01", end: "2026-03-31", val: 2_590_000_000, accn: "0001-26-000045", form: "10-Q", filed: "2026-04-30" },
      { start: "2026-04-01", end: "2026-06-30", val: 2_600_000_000, accn: "0001-26-000123", form: "10-Q", filed: "2026-07-30" },
    ] } },
  } } };
  const text = JSON.stringify({ companyFacts }, null, 2);
  const fact = latestSecQuarterlyFact(companyFacts, "us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", "shares", new Date("2026-10-01"))!;
  const span = secFactSpan(text, "WeightedAverageNumberOfDilutedSharesOutstanding", fact)!;
  // The located object is the diluted-share fact, not the identical basic-and-diluted fact before it.
  assert.ok(span.start > text.indexOf('"WeightedAverageNumberOfDilutedSharesOutstanding":'));
  assert.deepEqual(JSON.parse(text.slice(span.start, span.end)), companyFacts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares[1]);
  // The context file is now stored compact (#132); the span search finds the same fact there.
  const compact = JSON.stringify({ companyFacts });
  const compactSpan = secFactSpan(compact, "WeightedAverageNumberOfDilutedSharesOutstanding", fact)!;
  assert.deepEqual(JSON.parse(compact.slice(compactSpan.start, compactSpan.end)), companyFacts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares[1]);

  // Fixed slices with a boundary inside the fact: no single chunk holds start, end, val and accn.
  const size = 60, boundary = span.start + 40;
  const chunks: { char_start: number; char_end: number; text: string }[] = [];
  for (let start = boundary % size; start < text.length; start += size) {
    chunks.push({ char_start: start, char_end: Math.min(text.length, start + size), text: text.slice(start, start + size) });
  }
  assert.equal(chunks.some((chunk) => [fact.start, fact.end, `"val": ${fact.value}`, fact.accession_number].every((part) => chunk.text.includes(part))), false);
  const covering = chunks.filter((chunk) => chunk.char_start < span.end && chunk.char_end > span.start);
  assert.ok(covering.length >= 2);
  assert.equal(covering.map((chunk) => chunk.text).join("").slice(span.start - covering[0].char_start, span.end - covering[0].char_start), text.slice(span.start, span.end));
});
