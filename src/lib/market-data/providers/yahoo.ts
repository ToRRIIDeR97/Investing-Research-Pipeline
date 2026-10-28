/**
 * Yahoo Finance market-data provider adapter for Research OS v3.
 */

import type {
  MarketDataProvider,
  MarketQuote,
  PriceBar,
  CorporateActionEvent,
  InstrumentMetadata,
} from "../provider";
import { MarketDataError } from "../provider";
import { readCapped } from "@/lib/net";

export const YAHOO_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

export type YahooChartResponse = {
  chart?: {
    result?: YahooChartResult[];
    error?: { code: string; description: string } | null;
  };
};

export type YahooChartResult = {
  meta: {
    currency: string;
    symbol: string;
    exchangeName: string;
    instrumentType: string;
    firstTradeDate: number;
    regularMarketTime: number;
    gmtoffset: number;
    timezone: string;
    exchangeTimezoneName: string;
    regularMarketPrice: number;
    chartPreviousClose: number;
    previousClose?: number;
    fiftyTwoWeekHigh?: number;
    fiftyTwoWeekLow?: number;
    regularMarketDayHigh?: number;
    regularMarketDayLow?: number;
    regularMarketVolume?: number;
  };
  timestamp: number[];
  indicators: {
    quote?: {
      open: (number | null)[];
      high: (number | null)[];
      low: (number | null)[];
      close: (number | null)[];
      volume: (number | null)[];
    }[];
    adjclose?: { adjclose: (number | null)[] }[];
  };
  events?: {
    dividends?: Record<string, { amount: number; date: number }>;
    splits?: Record<string, { numerator: number; denominator: number; date: number }>;
  };
};

/** The default fetch times out; a chart response is read up to 20 MB (#23). */
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
const YAHOO_MAX_BYTES = 20_000_000;

export function createYahooMarketDataProvider(fetchImpl: typeof fetch = timedFetch): MarketDataProvider {
  return {
    getName: () => "yahoo",
    async getQuote(symbol: string, asOf?: Date): Promise<MarketQuote> {
      if (asOf) {
        // Point in time: the last close public by asOf (from the next UTC midnight after its
        // exchange-local trading day), never the live price (#135).
        const period1 = Math.floor((asOf.getTime() - 14 * DAY_MS) / 1000);
        const url = `${YAHOO_BASE_URL}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${Math.ceil(asOf.getTime() / 1000)}&interval=1d&includeAdjustedClose=true`;
        const result = await fetchYahoo(url, fetchImpl);
        const bar = parseBars(result, metaTimezone(result))
          .map((item) => ({ item, day: Date.parse(`${exchangeDay(item.trading_date, item.exchange_timezone)}T00:00:00Z`) }))
          .filter(({ day }) => day + DAY_MS <= asOf.getTime())
          .sort((a, b) => a.day - b.day)
          .at(-1);
        if (!bar) throw new MarketDataError(`Yahoo has no close for ${symbol} public by ${asOf.toISOString()}`, "yahoo", "not_found");
        return { symbol: result.meta.symbol, price: bar.item.close, currency: result.meta.currency, volume: bar.item.volume, asOf: new Date(bar.day) };
      }
      const url = buildChartUrl(symbol, "5d", "1d");
      const result = await fetchYahoo(url, fetchImpl);
      const meta = result.meta;
      const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? meta.previousClose ?? 0;
      return {
        symbol: meta.symbol,
        price,
        currency: meta.currency,
        marketCap: undefined, // Yahoo meta does not provide market cap directly; caller should compute
        volume: meta.regularMarketVolume,
        week52High: meta.fiftyTwoWeekHigh,
        week52Low: meta.fiftyTwoWeekLow,
        asOf: new Date(meta.regularMarketTime * 1000),
      };
    },
    async getPriceHistory(
      symbol: string,
      start: Date,
      end: Date,
      interval: "1d" | "1wk" | "1mo"
    ): Promise<PriceBar[]> {
      const period1 = Math.floor(start.getTime() / 1000);
      const period2 = Math.ceil(end.getTime() / 1000);
      const url = `${YAHOO_BASE_URL}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=history&includeAdjustedClose=true`;
      const result = await fetchYahoo(url, fetchImpl);
      return parseBars(result, metaTimezone(result));
    },
    async getCorporateActions(
      symbol: string,
      start: Date,
      end: Date
    ): Promise<CorporateActionEvent[]> {
      const period1 = Math.floor(start.getTime() / 1000);
      const period2 = Math.ceil(end.getTime() / 1000);
      const url = `${YAHOO_BASE_URL}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div,split`;
      const result = await fetchYahoo(url, fetchImpl);
      const actions: CorporateActionEvent[] = [];
      if (result.events?.dividends) {
        for (const [ts, div] of Object.entries(result.events.dividends)) {
          const date = new Date(parseInt(ts, 10) * 1000);
          if (date >= start && date <= end) {
            actions.push({
              action_type: "dividend",
              ex_date: date,
              dividend_per_share: div.amount,
              currency: result.meta.currency,
            });
          }
        }
      }
      if (result.events?.splits) {
        for (const [ts, split] of Object.entries(result.events.splits)) {
          const date = new Date(parseInt(ts, 10) * 1000);
          if (date >= start && date <= end) {
            actions.push({
              action_type: "split",
              ex_date: date,
              split_ratio: split.numerator / split.denominator,
              currency: result.meta.currency,
            });
          }
        }
      }
      return actions;
    },
    async getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata> {
      const url = buildChartUrl(symbol, "1d", "1d");
      const result = await fetchYahoo(url, fetchImpl);
      return {
        symbol: result.meta.symbol,
        currency: result.meta.currency,
        exchange: result.meta.exchangeName,
        timezone: result.meta.exchangeTimezoneName,
        instrument_type: result.meta.instrumentType,
      };
    },
  };
}

function buildChartUrl(symbol: string, range: string, interval: string): string {
  return `${YAHOO_BASE_URL}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includeAdjustedClose=true`;
}

const DAY_MS = 86_400_000;

/** Exchange-local calendar day (YYYY-MM-DD), as in price-history's `exchangeDay` (not imported: that module imports this one). */
function exchangeDay(date: Date, timeZone?: string): string {
  try {
    if (timeZone) return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    // Unknown zone: fall back to UTC.
  }
  return date.toISOString().slice(0, 10);
}

function metaTimezone(result: YahooChartResult): string | undefined {
  return result.meta.exchangeTimezoneName;
}

function parseBars(result: YahooChartResult, timezone?: string): PriceBar[] {
  const timestamps = result.timestamp;
  const quotes = result.indicators.quote?.[0];
  const adjclose = result.indicators.adjclose?.[0]?.adjclose;
  if (!timestamps || !quotes) return [];

  const bars: PriceBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i] * 1000;
    const open = quotes.open[i];
    const high = quotes.high[i];
    const low = quotes.low[i];
    const close = quotes.close[i];
    const volume = quotes.volume?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    bars.push({
      trading_date: new Date(ts),
      open,
      high,
      low,
      close,
      adjusted_close: adjclose?.[i] ?? undefined,
      volume: volume ?? undefined,
      currency: result.meta.currency,
      exchange_timezone: timezone,
    });
  }
  return bars;
}

async function fetchYahoo(url: string, fetchImpl: typeof fetch): Promise<YahooChartResult> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new MarketDataError(`Yahoo fetch failed: ${err}`, "yahoo", "network_error");
  }
  if (response.status === 429) {
    throw new MarketDataError("Yahoo rate limited", "yahoo", "rate_limited");
  }
  if (response.status === 404) {
    throw new MarketDataError(`Yahoo symbol not found: ${url}`, "yahoo", "not_found");
  }
  if (!response.ok) {
    throw new MarketDataError(`Yahoo HTTP ${response.status}: ${url}`, "yahoo", "unknown");
  }
  let data: YahooChartResponse;
  try {
    data = JSON.parse(new TextDecoder().decode(await readCapped(response, YAHOO_MAX_BYTES))) as YahooChartResponse;
  } catch (err) {
    throw new MarketDataError(`Yahoo parse failed: ${err}`, "yahoo", "parse_error");
  }
  if (data.chart?.error) {
    throw new MarketDataError(
      `Yahoo API error: ${data.chart.error.code} - ${data.chart.error.description}`,
      "yahoo",
      data.chart.error.code === "Not Found" ? "not_found" : "unknown"
    );
  }
  if (!data.chart?.result?.[0]) {
    throw new MarketDataError("Yahoo response missing chart result", "yahoo", "parse_error");
  }
  return data.chart.result[0];
}

export { parseBars };
