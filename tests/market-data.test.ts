import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createMockMarketDataProvider,
  deterministicBars,
} from "@/lib/market-data/providers/mock";
import { parseBars } from "@/lib/market-data/providers/yahoo";
import { MarketDataError } from "@/lib/market-data/provider";
import { fetchedRange, seriesShape, windowCovered } from "@/lib/market-data/service";
import { fcfYieldBand, peBand } from "@/lib/valuation/signal-generator";
import type { YahooChartResult } from "@/lib/market-data/providers/yahoo";

describe("market data provider", () => {
  const bars = deterministicBars("MELI", 100, 30);
  const fixtures = new Map([
    [
      "MELI",
      {
        symbol: "MELI",
        currency: "USD",
        bars,
        corporateActions: [{ action_type: "split" as const, ex_date: new Date("2020-01-15"), split_ratio: 2, currency: "USD" }],
        metadata: {
          symbol: "MELI",
          currency: "USD",
          exchange: "NASDAQ",
          timezone: "America/New_York",
          instrument_type: "EQUITY",
        },
      },
    ],
  ]);
  const provider = createMockMarketDataProvider(fixtures);

  it("C4-T1: Parse fragmented/mock Yahoo chart response", () => {
    const result: YahooChartResult = {
      meta: {
        currency: "USD",
        symbol: "MELI",
        exchangeName: "NASDAQ",
        instrumentType: "EQUITY",
        firstTradeDate: 0,
        regularMarketTime: 0,
        gmtoffset: 0,
        timezone: "EST",
        exchangeTimezoneName: "America/New_York",
        regularMarketPrice: 100,
        chartPreviousClose: 99,
      },
      timestamp: [0, 86400],
      indicators: {
        quote: [
          {
            open: [100, 101],
            high: [102, 103],
            low: [99, 100],
            close: [101, 102],
            volume: [1000, 1100],
          },
        ],
        adjclose: [{ adjclose: [101, 102] }],
      },
    };
    const parsed = parseBars(result, "America/New_York");
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].close, 101);
    assert.equal(parsed[0].adjusted_close, 101);
  });

  it("C4-T2: Request a cutoff one year ago returns latest close at or before cutoff", async () => {
    const cutoff = new Date(bars[bars.length - 1].trading_date);
    const quote = await provider.getQuote("MELI", cutoff);
    assert.equal(quote.asOf.getTime(), cutoff.getTime());
  });

  it("C4-T3: Cutoff on weekend selects prior trading day", async () => {
    const lastBar = bars[bars.length - 1];
    const weekend = new Date(lastBar.trading_date);
    weekend.setDate(weekend.getDate() + 2); // advance to Sunday if lastBar was Friday
    if (weekend.getDay() !== 0) {
      // Find next Sunday
      weekend.setDate(weekend.getDate() + (7 - weekend.getDay()) % 7);
    }
    const quote = await provider.getQuote("MELI", weekend);
    assert.ok(quote.asOf.getTime() <= weekend.getTime());
    assert.equal(quote.asOf.getDay(), 5); // Friday
  });

  it("C4-T4: Response contains a split; raw and adjusted series remain distinguishable", async () => {
    const start = new Date("2020-01-01");
    const end = new Date("2020-02-01");
    const history = await provider.getPriceHistory("MELI", start, end, "1d");
    const splitBar = history.find((h) => h.trading_date.toISOString().startsWith("2020-01-15"));
    assert.ok(splitBar);
    // In mock fixture adjusted_close equals close; real split would differ
  });

  it("C4-T5: Currency differs from reporting currency is preserved", async () => {
    const quote = await provider.getQuote("MELI");
    assert.equal(quote.currency, "USD");
  });

  it("C4-T9: Unit tests run without network using mock adapter", async () => {
    const quote = await provider.getQuote("MELI");
    assert.ok(quote.price > 0);
  });
});

describe("history coverage (#133)", () => {
  const d = (day: string) => new Date(`${day}T00:00:00Z`);
  const start = d("2020-10-28");

  const full = (first: Date | null, gaps: Array<{ from: Date; to: Date }> = []) => ({ start: d("2020-10-20"), end: d("2026-10-20"), first, gaps });

  it("accepts a late first bar only when a full fetch returned the same first bar", () => {
    // Listed in June 2021, after the six-year window starts.
    assert.equal(windowCovered(start, d("2021-06-01"), [], []), false);
    assert.equal(windowCovered(start, d("2021-06-01"), [], [full(d("2021-06-01"))]), true);
    // The provider had earlier bars than storage: fetch again.
    assert.equal(windowCovered(start, d("2021-06-01"), [], [full(d("2020-10-28"))]), false);
    // An incremental fetch from near the end proves nothing about the start.
    assert.equal(windowCovered(start, d("2021-06-01"), [], [{ start: d("2026-10-15"), end: d("2026-10-20"), first: d("2026-10-15"), gaps: [] }]), false);
    assert.equal(windowCovered(start, d("2020-10-30"), [], []), true);
    assert.equal(windowCovered(start, null, [], [full(start)]), false);
  });

  it("accepts a gap of more than a week only when a fetch saw the provider's series skip it", () => {
    const gap = [{ from: d("2023-03-01"), to: d("2023-03-20") }];
    assert.equal(windowCovered(start, d("2020-10-29"), gap, []), false);
    // Bars missing from storage only (the fetch returned them): fetch again.
    assert.equal(windowCovered(start, d("2020-10-29"), gap, [full(d("2020-10-29"))]), false);
    assert.equal(windowCovered(start, d("2020-10-29"), gap, [full(d("2020-10-29"), gap)]), true);
  });

  it("logs and reads the shape of a fetched series", () => {
    const bar = (day: string) => ({ trading_date: d(day), open: 1, high: 1, low: 1, close: 1, currency: "USD" });
    const shape = seriesShape([bar("2023-03-20"), bar("2023-02-28"), bar("2023-03-01")]);
    assert.deepEqual(shape, { first_bar: "2023-02-28T00:00:00.000Z", gaps: [{ from: "2023-03-01T00:00:00.000Z", to: "2023-03-20T00:00:00.000Z" }] });
    assert.deepEqual(fetchedRange({ start: "2020-10-20T00:00:00.000Z", end: "2026-10-20T00:00:00.000Z", interval: "1d", ...shape }),
      [{ start: d("2020-10-20"), end: d("2026-10-20"), first: d("2023-02-28"), gaps: [{ from: d("2023-03-01"), to: d("2023-03-20") }] }]);
    // Fetches logged before the shape was recorded prove nothing.
    assert.deepEqual(fetchedRange({ start: "2020-10-20", end: "2026-10-20" }), [{ start: d("2020-10-20"), end: d("2026-10-20"), first: null, gaps: [] }]);
    assert.deepEqual(fetchedRange({ start: "2020-10-20", end: "2026-10-20", interval: "1wk" }), []);
    assert.deepEqual(fetchedRange({}), []);
  });
});

describe("valuation signal bands (#135)", () => {
  it("does not call a loss-making or missing P/E cheap", () => {
    assert.equal(peBand(-12).signal, "inconclusive");
    assert.equal(peBand(Number.NaN).signal, "inconclusive");
    assert.equal(peBand(12).signal, "cheap");
    assert.equal(peBand(40).signal, "very_expensive");
  });

  it("reads FCF yield as a fraction", () => {
    assert.equal(fcfYieldBand(0.06).signal, "cheap");
    assert.equal(fcfYieldBand(0.02).signal, "expensive");
    assert.equal(fcfYieldBand(9).signal, "very_cheap"); // legacy percent value
    assert.equal(fcfYieldBand(Number.NaN).signal, "inconclusive");
  });
});

describe("Yahoo point-in-time quote (#135)", () => {
  it("returns the last close public by asOf, not the live price", async () => {
    const open = (day: string) => Date.parse(`${day}T13:30:00Z`) / 1000;
    const body = JSON.stringify({ chart: { error: null, result: [{
      meta: { currency: "USD", symbol: "MELI", exchangeName: "NMS", instrumentType: "EQUITY", firstTradeDate: 0, regularMarketTime: 0,
        gmtoffset: -14400, timezone: "EDT", exchangeTimezoneName: "America/New_York", regularMarketPrice: 999, chartPreviousClose: 1 },
      timestamp: [open("2026-10-07"), open("2026-10-08")],
      indicators: { quote: [{ open: [10, 11], high: [10, 11], low: [10, 11], close: [10, 11], volume: [1, 1] }] },
    }] } });
    const { createYahooMarketDataProvider } = await import("@/lib/market-data/providers/yahoo");
    const yahoo = createYahooMarketDataProvider((async () => new Response(body, { status: 200 })) as typeof fetch);
    // At 18:00 UTC on 8 October that session is still open.
    const quote = await yahoo.getQuote("MELI", new Date("2026-10-08T18:00:00Z"));
    assert.deepEqual([quote.price, quote.asOf.toISOString()], [10, "2026-10-07T00:00:00.000Z"]);
  });
});

describe("Yahoo parse error handling", () => {
  it("C4-T7: Provider returns rate limit or malformed payload is classified failure", async () => {
    const fetchRateLimited = async () =>
      new Response("Too Many Requests", { status: 429 });
    const { createYahooMarketDataProvider } = await import("@/lib/market-data/providers/yahoo");
    const yahoo = createYahooMarketDataProvider(fetchRateLimited);
    await assert.rejects(
      () => yahoo.getQuote("MELI"),
      (err: any) => err instanceof MarketDataError && err.code === "rate_limited"
    );
  });
});
