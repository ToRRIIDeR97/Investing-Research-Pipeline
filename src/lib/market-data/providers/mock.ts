/**
 * Mock market-data provider for deterministic tests.
 */

import type {
  MarketDataProvider,
  MarketQuote,
  PriceBar,
  CorporateActionEvent,
  InstrumentMetadata,
} from "../provider";

export type MockPriceFixture = {
  symbol: string;
  currency: string;
  bars: PriceBar[];
  corporateActions: CorporateActionEvent[];
  metadata: InstrumentMetadata;
};

export function createMockMarketDataProvider(fixtures: Map<string, MockPriceFixture>): MarketDataProvider {
  return {
    getName: () => "mock",
    async getQuote(symbol: string, asOf?: Date): Promise<MarketQuote> {
      const fixture = fixtures.get(symbol);
      if (!fixture) throw new Error(`No fixture for ${symbol}`);
      const bars = fixture.bars;
      let bar = bars[bars.length - 1];
      if (asOf) {
        const target = asOf.getTime();
        const valid = bars.filter((b) => b.trading_date.getTime() <= target);
        if (valid.length > 0) bar = valid[valid.length - 1];
      }
      return {
        symbol,
        price: bar.close,
        currency: fixture.currency,
        asOf: bar.trading_date,
      };
    },
    async getPriceHistory(
      symbol: string,
      start: Date,
      end: Date,
      interval: "1d" | "1wk" | "1mo"
    ): Promise<PriceBar[]> {
      const fixture = fixtures.get(symbol);
      if (!fixture) throw new Error(`No fixture for ${symbol}`);
      const intervalFilter = interval; // mock ignores interval for simplicity
      return fixture.bars.filter(
        (b) => b.trading_date >= start && b.trading_date <= end
      );
    },
    async getCorporateActions(
      symbol: string,
      start: Date,
      end: Date
    ): Promise<CorporateActionEvent[]> {
      const fixture = fixtures.get(symbol);
      if (!fixture) throw new Error(`No fixture for ${symbol}`);
      return fixture.corporateActions.filter(
        (a) => (a.ex_date && a.ex_date >= start && a.ex_date <= end) ||
               (a.pay_date && a.pay_date >= start && a.pay_date <= end)
      );
    },
    async getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata> {
      const fixture = fixtures.get(symbol);
      if (!fixture) throw new Error(`No fixture for ${symbol}`);
      return fixture.metadata;
    },
  };
}

export function deterministicBars(symbol: string, startPrice: number, count: number): PriceBar[] {
  const bars: PriceBar[] = [];
  const startDate = new Date("2020-01-02");
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    price = price * (1 + (Math.sin(i) * 0.02));
    bars.push({
      trading_date: new Date(date),
      open: price * 0.99,
      high: price * 1.02,
      low: price * 0.98,
      close: price,
      adjusted_close: price,
      volume: 1000000 + i * 100,
      currency: "USD",
      exchange_timezone: "America/New_York",
    });
  }
  return bars;
}

export function withSplit(bars: PriceBar[], exIndex: number, ratio: number): PriceBar[] {
  return bars.map((b, i) => ({
    ...b,
    adjusted_close: i <= exIndex ? b.adjusted_close != null ? b.adjusted_close / ratio : undefined : b.adjusted_close,
  }));
}

export { withSplit as mockWithSplit };
