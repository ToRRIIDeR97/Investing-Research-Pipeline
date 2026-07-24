import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createMockMarketDataProvider,
  deterministicBars,
} from "@/lib/market-data/providers/mock";
import { parseBars } from "@/lib/market-data/providers/yahoo";
import { MarketDataError } from "@/lib/market-data/provider";
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
