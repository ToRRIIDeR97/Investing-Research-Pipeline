import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createYahooMarketDataProvider } from "@/lib/market-data/providers/yahoo";
import { fetchStooqCloses, parseStooqCsv, stooqSymbol } from "@/lib/market-data/providers/stooq";
import { priceBarRows } from "@/lib/market-data/service";
import {
  closeOnOrBefore, closeOnSplitBasis, crossCheckClose, exchangeDay, normalizeDailyBars,
  periodEndMarketObservations, sharesAtPeriodEnd, splitBasisDay, unverifiedDetails, valuationPriceFromBars, type StoredBar,
} from "@/lib/market-data/price-history";
import { marketMetrics, researchObservations } from "@/lib/research/reporting/data-views";

// Regular-session opens in New York: 13:30 UTC (EDT) / 14:30 UTC (EST).
const nyOpen = (day: string, edt = true) => Date.parse(`${day}T${edt ? "13:30" : "14:30"}:00Z`) / 1000;

function chart(days: string[], closes: number[], events?: Record<string, unknown>) {
  return {
    chart: {
      result: [{
        meta: { currency: "USD", symbol: "META", exchangeName: "NMS", instrumentType: "EQUITY", firstTradeDate: 0, regularMarketTime: 0,
          gmtoffset: -14400, timezone: "EDT", exchangeTimezoneName: "America/New_York", regularMarketPrice: closes.at(-1), chartPreviousClose: closes[0] },
        timestamp: days.map((day) => nyOpen(day)),
        indicators: {
          quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) }],
          adjclose: [{ adjclose: closes.map((c) => c * 0.99) }],
        },
        ...(events ? { events } : {}),
      }],
      error: null,
    },
  };
}

function bar(day: string, close: number, extra: Partial<StoredBar> = {}): StoredBar {
  return { id: `bar-${day}`, day, close, adjusted_close: null, currency: "USD", provider_symbol: "META", retrieved_day: "2026-10-10",
    available_at: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString(), verification_status: "unverified", verification_json: {}, ...extra };
}

function shares(segment: string | null, value: number, periodEnd: string, availableAt: string, metric = "us_gaap_CommonStockSharesOutstanding") {
  return { metric_key: metric, segment, value_numeric: value, unit: "shares", period_end: periodEnd, available_at: availableAt,
    periodicity: "quarterly", fiscal_year: Number(periodEnd.slice(0, 4)), fiscal_quarter: Math.floor(Number(periodEnd.slice(5, 7)) / 3) };
}

describe("price history: Yahoo bars to market_price_bars rows", () => {
  it("maps a mocked Yahoo chart to exchange-day rows and drops the live bar", async () => {
    const urls: string[] = [];
    const provider = createYahooMarketDataProvider((async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(chart(["2026-10-07", "2026-10-08", "2026-10-09"], [700.5, 705.25, 710])), { status: 200 });
    }) as typeof fetch);
    const bars = await provider.getPriceHistory("META", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-09T18:00:00Z"), "1d");
    assert.match(urls[0], /\/META\?period1=\d+&period2=\d+&interval=1d/);
    // At 18:00 UTC on 9 October the session is still open: that bar is provisional.
    const normalized = normalizeDailyBars(bars, new Date("2026-10-09T18:00:00Z"));
    assert.deepEqual(normalized.map((b) => b.trading_date.toISOString()), ["2026-10-07T00:00:00.000Z", "2026-10-08T00:00:00.000Z"]);
    const rows = priceBarRows("inst-1", "yahoo", "META", normalized, new Date("2026-10-09T18:00:00Z"));
    assert.equal(rows[1].close, "705.25");
    assert.equal(rows[1].adjusted_close, String(705.25 * 0.99));
    assert.equal(rows[1].volume, "1000");
    assert.equal(rows[1].exchange_timezone, "America/New_York");
    assert.equal(rows[1].available_at.toISOString(), "2026-10-09T00:00:00.000Z");
    assert.equal(rows[1].provider, "yahoo");
  });

  it("dates bars by the exchange's local day, not the UTC day", () => {
    // Tokyo opens at 00:00 UTC; 23:30 UTC on 1 Oct is already 2 Oct in Tokyo.
    assert.equal(exchangeDay(new Date("2026-10-01T23:30:00Z"), "Asia/Tokyo"), "2026-10-02");
    assert.equal(exchangeDay(new Date("2026-10-01T23:30:00Z"), null), "2026-10-01");
  });

  it("parses Yahoo split events as corporate actions", async () => {
    const provider = createYahooMarketDataProvider((async () => new Response(JSON.stringify(chart(["2024-06-10"], [121.79], {
      splits: { [nyOpen("2024-06-10")]: { date: nyOpen("2024-06-10"), numerator: 10, denominator: 1 } },
    })))) as typeof fetch);
    const actions = await provider.getCorporateActions("NVDA", new Date("2024-01-01"), new Date("2024-12-31"));
    assert.deepEqual(actions.map((a) => [a.action_type, a.split_ratio]), [["split", 10]]);
  });
});

describe("price history: Stooq cross-check", () => {
  it("parses the daily CSV and rejects anything else", () => {
    const closes = parseStooqCsv("Date,Open,High,Low,Close,Volume\n2025-09-29,740,745,735,743.40,100\n2025-09-30,741,742,730,734.38,100\n");
    assert.equal(closes?.get("2025-09-30"), 734.38);
    assert.equal(parseStooqCsv("<!DOCTYPE html><html>verify your browser</html>"), null);
    assert.equal(parseStooqCsv("No data"), null);
    assert.equal(stooqSymbol("META"), "meta.us");
    assert.equal(stooqSymbol("BRK-B"), "brk-b.us");
    assert.equal(stooqSymbol("EXO.AS"), null);
  });

  it("reports Stooq as unavailable on a browser check, rate limit or network error", async () => {
    const html = await fetchStooqCloses("META", new Date("2025-01-01"), new Date("2025-12-31"),
      (async () => new Response("<!DOCTYPE html><html></html>", { status: 200 })) as typeof fetch);
    assert.equal(html.status, "unavailable");
    const limited = await fetchStooqCloses("META", new Date("2025-01-01"), new Date("2025-12-31"),
      (async () => new Response("", { status: 429 })) as typeof fetch);
    assert.deepEqual([limited.status, limited.status === "unavailable" && limited.reason], ["unavailable", "Stooq HTTP 429"]);
    const offline = await fetchStooqCloses("META", new Date("2025-01-01"), new Date("2025-12-31"),
      (async () => { throw new Error("ECONNRESET"); }) as typeof fetch);
    assert.equal(offline.status, "unavailable");
    const ok = await fetchStooqCloses("META", new Date("2025-09-01"), new Date("2025-09-30"),
      (async (url: string) => {
        assert.match(String(url), /s=meta\.us&d1=20250901&d2=20250930&i=d/);
        return new Response("Date,Open,High,Low,Close\n2025-09-30,1,1,1,734.38\n");
      }) as typeof fetch);
    assert.equal(ok.status === "ok" && ok.closes.get("2025-09-30"), 734.38);
  });

  it("verifies within 0.5%, flags larger differences and leaves missing days unverified", () => {
    assert.equal(crossCheckClose(734.38, null, 734.38)?.status, "verified");
    assert.equal(crossCheckClose(734.38, null, 731.0)?.status, "verified"); // 0.46%
    const mismatch = crossCheckClose(734.38, null, 728.0); // 0.88%
    assert.equal(mismatch?.status, "mismatch");
    assert.equal(mismatch?.diff_pct, 0.8764);
    const dividendBasis = crossCheckClose(734.38, 731.9, 731.9);
    assert.deepEqual([dividendBasis?.status, dividendBasis?.basis], ["verified", "close"]);
    const adjusted = crossCheckClose(750, 731.9, 731.9);
    assert.deepEqual([adjusted?.status, adjusted?.basis], ["verified", "adjusted_close"]);
    assert.equal(crossCheckClose(734.38, null, undefined), null);
  });
});

describe("price history: period-end closes and market cap", () => {
  it("takes the last trading day on or before a quarter end across weekends and holidays", () => {
    // Q1 2024 ended Sunday 31 March; Friday 29 March was Good Friday, so the close is Thursday's.
    const bars = [bar("2024-03-27", 493.86), bar("2024-03-28", 485.58), bar("2024-04-01", 491.35)];
    assert.equal(closeOnOrBefore(bars, "2024-03-31")?.day, "2024-03-28");
    // Q4 2024 ended Tuesday 31 December, a trading day.
    assert.equal(closeOnOrBefore([bar("2024-12-30", 591.24), bar("2024-12-31", 585.51)], "2024-12-31")?.day, "2024-12-31");
    // A close more than a week before the period end is not a period-end price.
    assert.equal(closeOnOrBefore([bar("2024-03-20", 500)], "2024-03-31"), null);
    assert.equal(closeOnOrBefore([bar("2024-04-01", 500)], "2024-03-31"), null);
  });

  it("sums share classes, prefers a reported total and labels the diluted fallback", () => {
    const rows = [
      shares("us-gaap:CommonClassAMember", 2_206_000_000, "2026-06-30", "2026-07-30"),
      shares("us-gaap:CommonClassBMember", 342_000_000, "2026-06-30", "2026-07-30"),
      shares("us-gaap:CommonClassAMember", 2_206_000_000, "2026-06-30", "2026-07-30"), // same fact from another table
      shares("us-gaap:CommonClassAMember", 2_196_000_000, "2026-03-31", "2026-04-30"),
      shares(null, 2_566_000_000, "2026-06-30", "2026-07-30", "us_gaap_WeightedAverageNumberOfDilutedSharesOutstanding"),
    ];
    const june = sharesAtPeriodEnd(rows, "2026-06-30");
    assert.deepEqual([june?.value, june?.basis, june?.inputs.length], [2_548_000_000, "shares_outstanding", 2]);
    const total = sharesAtPeriodEnd([...rows, shares(null, 2_550_000_000, "2026-06-30", "2026-07-30")], "2026-06-30");
    assert.equal(total?.value, 2_550_000_000);
    const fallback = sharesAtPeriodEnd(rows.filter((r) => r.metric_key !== "us_gaap_CommonStockSharesOutstanding"), "2026-09-30");
    assert.deepEqual([fallback?.value, fallback?.basis], [2_566_000_000, "diluted_weighted_average"]);
    assert.match(fallback!.label, /Diluted weighted-average shares .*fallback/);
  });

  it("builds quarter and fiscal-year rows up to the cutoff with source locators and the verified flag", () => {
    const statements = [
      { metric_key: "net_revenue", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 2, period_end: "2026-06-30", value_numeric: 1, unit: "USD" },
      { metric_key: "net_revenue", periodicity: "quarterly", fiscal_year: 2025, fiscal_quarter: 4, period_end: "2025-12-31", value_numeric: 1, unit: "USD" },
      { metric_key: "net_revenue", periodicity: "annual", fiscal_year: 2025, fiscal_quarter: null, period_end: "2025-12-31", value_numeric: 1, unit: "USD" },
      { metric_key: "net_revenue", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 3, period_end: "2026-09-30", value_numeric: 1, unit: "USD" },
      shares("us-gaap:CommonClassAMember", 2_206_000_000, "2026-06-30", "2026-07-30"),
      shares("us-gaap:CommonClassBMember", 342_000_000, "2026-06-30", "2026-07-30"),
    ];
    const verified = { verification_status: "verified", verification_json: { provider: "stooq", reference_close: 738.09, diff_pct: 0 } };
    const bars = [bar("2025-12-31", 660.09), bar("2026-06-30", 738.09, verified), bar("2026-09-30", 750)];
    // The run's market data stops on 15 September 2026: Q3 is after the cutoff.
    const rows = periodEndMarketObservations({ bars, splits: [], statementObservations: statements, cutoffAt: new Date("2026-09-15T12:00:00Z"), symbol: "META" });
    const key = (r: Record<string, any>) => `${r.metric_key}:${r.periodicity}:${r.fiscal_year}:${r.fiscal_quarter}`;
    assert.deepEqual(rows.map(key).sort(), [
      "market_cap:annual:2025:null", "market_cap:quarterly:2025:4", "market_cap:quarterly:2026:2",
      "period_end_share_price:annual:2025:null", "period_end_share_price:quarterly:2025:4", "period_end_share_price:quarterly:2026:2",
    ]);
    const q2Price = rows.find((r) => key(r) === "period_end_share_price:quarterly:2026:2")!;
    assert.deepEqual([q2Price.value_numeric, q2Price.unit, q2Price.metadata_json.verified], [738.09, "USD/shares", true]);
    assert.equal((q2Price.metadata_json.source_locator as any).trading_date, "2026-06-30");
    const q2Cap = rows.find((r) => key(r) === "market_cap:quarterly:2026:2")!;
    assert.equal(q2Cap.value_numeric, Math.round(738.09 * 2_548_000_000));
    assert.equal(q2Cap.available_at, "2026-07-30");
    assert.equal(q2Cap.metadata_json.share_basis, "shares_outstanding");
    const fyCap = rows.find((r) => key(r) === "market_cap:annual:2025:null")!;
    assert.equal(fyCap.value_numeric, null);
    assert.match(String(fyCap.metadata_json.missing_reason), /No shares outstanding/);
    assert.equal(rows.find((r) => key(r) === "period_end_share_price:annual:2025:null")!.metadata_json.verified, false);
  });

  it("ignores closes that were not public by the cutoff", () => {
    const bars = [bar("2026-10-07", 700), bar("2026-10-08", 705)];
    // At 12:37 UTC on 8 October the 8 October session has not closed.
    const price = valuationPriceFromBars(bars, [], new Date("2026-10-08T12:37:00Z"));
    assert.deepEqual([price?.price, price?.trading_date, price?.verified], [700, "2026-10-07", false]);
    assert.equal(valuationPriceFromBars(bars, [], new Date("2026-10-07T12:00:00Z")), null);
    assert.equal(valuationPriceFromBars([bar("2026-09-01", 700)], [], new Date("2026-10-08T12:00:00Z")), null);
  });

  it("re-expresses split-adjusted closes on the traded and share-count bases", () => {
    const splits = [{ ex_day: "2024-06-10", ratio: 10 }];
    // Stored in 2026 on the post-split basis; traded at ten times that before the split.
    assert.equal(closeOnSplitBasis(49.5, "2023-12-29", "2026-10-10", "2023-12-29", splits), 495);
    // A bar fetched before the split is already on the traded basis.
    assert.equal(closeOnSplitBasis(495, "2023-12-29", "2024-01-05", "2023-12-29", splits), 495);
    // Bars after the split are unaffected.
    assert.equal(closeOnSplitBasis(120, "2024-07-01", "2026-10-10", "2024-07-01", splits), 120);
    // Fiscal Q1 2025 shares, filed after the split on the post-split basis.
    const statements = [{ ...shares(null, 24_000_000_000, "2024-04-28", "2024-06-26"), fiscal_year: 2025, fiscal_quarter: 1 }];
    const rows = periodEndMarketObservations({ bars: [bar("2024-04-26", 87.73)], splits, cutoffAt: new Date("2024-07-01"), symbol: "NVDA",
      statementObservations: statements });
    const price = rows.find((r) => r.metric_key === "period_end_share_price")!;
    const cap = rows.find((r) => r.metric_key === "market_cap")!;
    assert.equal(price.value_numeric, 877.3);
    assert.equal(cap.value_numeric, Math.round(87.73 * 24_000_000_000));
  });

  it("treats a series fetched on the ex-date before the open as pre-split (#120)", () => {
    // NVDA 10:1, ex-date 10 June 2024; Yahoo stamps the event at the 13:30 UTC open.
    const splits = [{ ex_day: "2024-06-10", ratio: 10, ex_at: "2024-06-10T13:30:00.000Z" }];
    const early = splitBasisDay(new Date("2024-06-10T05:00:00Z"), splits, "America/New_York");
    assert.equal(early, "2024-06-09");
    // A close fetched before the open is already on the traded basis: not multiplied again.
    assert.equal(closeOnSplitBasis(1200, "2024-06-07", early, "2024-06-07", splits), 1200);
    const late = splitBasisDay(new Date("2024-06-10T15:00:00Z"), splits, "America/New_York");
    assert.equal(late, "2024-06-10");
    assert.equal(closeOnSplitBasis(120, "2024-06-07", late, "2024-06-07", splits), 1200);
    // The basis day is exchange-local: 02:00 UTC on 11 June is still 10 June in New York.
    assert.equal(splitBasisDay(new Date("2024-06-11T02:00:00Z"), [], "America/New_York"), "2024-06-10");
  });

  it("stops asking Stooq for days it lacks, but retries days after its last row (#133)", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    assert.equal(unverifiedDetails("2026-10-05", "2026-10-08", "u", now)?.reference_missing_at, now.toISOString());
    assert.equal(unverifiedDetails("2026-10-09", "2026-10-08", "u", now), null);
  });

  it("surfaces market rows in the Financials metrics view", () => {
    const market = { metric_key: "market_cap", periodicity: "quarterly", fiscal_year: 2026, fiscal_quarter: 2, unit: "USD", currency: "USD",
      reporting_basis: "as_reported", value_numeric: 1, metadata_json: { metric_category: "market_data" } };
    const observations = researchObservations([{ artifact_type: "market_price_history", content_json: { observations: [market] } }]);
    assert.equal(observations.length, 1);
    assert.deepEqual(marketMetrics(observations, "quarterly"), [market]);
    assert.deepEqual(marketMetrics(observations, "annual"), []);
  });
});
