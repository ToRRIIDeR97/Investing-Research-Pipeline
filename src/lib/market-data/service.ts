/**
 * Market-data service: persist, derive, and retrieve market data for Research OS v3.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  MarketDataProvider,
  MarketQuote,
  PriceBar,
  CorporateActionEvent,
  InstrumentMetadata,
} from "./provider";
import {
  market_price_bars,
  corporate_actions,
  market_data_fetches,
  instrument_provider_mappings,
} from "@/db/schema/market-data";
import { instruments, listings } from "@/db/schema/core";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type MarketDataServiceConfig = {
  db: PostgresJsDatabase<any>;
  defaultProvider: MarketDataProvider;
  providerName: string;
};

export function createMarketDataService(config: MarketDataServiceConfig) {
  const { db, defaultProvider, providerName } = config;

  return {
    async resolveInstrumentId(assetId: string, symbol?: string): Promise<string | null> {
      if (symbol) {
        const [listing] = await db
          .select({ instrument_id: listings.instrument_id })
          .from(listings)
          .where(eq(listings.symbol, symbol))
          .orderBy(desc(listings.is_primary))
          .limit(1);
        if (listing?.instrument_id) return listing.instrument_id;
      }
      const [instrument] = await db
        .select({ id: instruments.id })
        .from(instruments)
        .where(eq(instruments.asset_id, assetId))
        .limit(1);
      return instrument?.id ?? null;
    },

    async getQuote(
      instrumentId: string,
      symbol: string,
      asOf?: Date
    ): Promise<{ quote: MarketQuote; fromProvider: boolean }> {
      const cached = asOf ? await findCachedQuoteAtOrBefore(instrumentId, asOf) : null;
      if (cached) {
        return {
          quote: {
            symbol,
            price: Number(cached.close),
            currency: cached.currency,
            asOf: cached.trading_date,
          },
          fromProvider: false,
        };
      }
      const fetchStart = Date.now();
      let quote: MarketQuote;
      try {
        quote = await defaultProvider.getQuote(symbol, asOf);
      } catch (err) {
        await logFetch(instrumentId, symbol, "quote", "failed", undefined, err);
        throw err;
      }
      await logFetch(instrumentId, symbol, "quote", "success", Date.now() - fetchStart);
      return { quote, fromProvider: true };
    },

    async getPriceHistory(
      instrumentId: string,
      symbol: string,
      start: Date,
      end: Date,
      interval: "1d" | "1wk" | "1mo" = "1d"
    ): Promise<{ bars: PriceBar[]; fromProvider: boolean }> {
      const cached = await db
        .select()
        .from(market_price_bars)
        .where(
          and(
            eq(market_price_bars.instrument_id, instrumentId),
            eq(market_price_bars.provider, providerName),
            eq(market_price_bars.provider_symbol, symbol),
            gte(market_price_bars.trading_date, start),
            lte(market_price_bars.trading_date, end)
          )
        )
        .orderBy(market_price_bars.trading_date);

      if (cached.length > 0 && spansRange(cached, start, end)) {
        return { bars: cached.map(toPriceBar), fromProvider: false };
      }

      const fetchStart = Date.now();
      let bars: PriceBar[];
      try {
        bars = await defaultProvider.getPriceHistory(symbol, start, end, interval);
      } catch (err) {
        await logFetch(instrumentId, symbol, "history", "failed", undefined, err, { start, end, interval });
        throw err;
      }
      await logFetch(instrumentId, symbol, "history", "success", Date.now() - fetchStart, undefined, { start, end, interval });
      await persistPriceBars(instrumentId, symbol, bars);
      return { bars, fromProvider: true };
    },

    async getCorporateActions(
      instrumentId: string,
      symbol: string,
      start: Date,
      end: Date
    ): Promise<{ actions: CorporateActionEvent[]; fromProvider: boolean }> {
      const cached = await db
        .select()
        .from(corporate_actions)
        .where(
          and(
            eq(corporate_actions.instrument_id, instrumentId),
            eq(corporate_actions.provider, providerName),
            eq(corporate_actions.provider_symbol, symbol),
            gte(corporate_actions.ex_date, start),
            lte(corporate_actions.ex_date, end)
          )
        );
      if (cached.length > 0) {
        return { actions: cached.map(toCorporateActionEvent), fromProvider: false };
      }
      const fetchStart = Date.now();
      let actions: CorporateActionEvent[];
      try {
        actions = await defaultProvider.getCorporateActions(symbol, start, end);
      } catch (err) {
        await logFetch(instrumentId, symbol, "corporate_actions", "failed", undefined, err, { start, end });
        throw err;
      }
      await logFetch(instrumentId, symbol, "corporate_actions", "success", Date.now() - fetchStart, undefined, { start, end });
      await persistCorporateActions(instrumentId, symbol, actions);
      return { actions, fromProvider: true };
    },

    async getInstrumentMetadata(symbol: string): Promise<InstrumentMetadata> {
      return defaultProvider.getInstrumentMetadata(symbol);
    },

    async getPriceAtCutoff(instrumentId: string, symbol: string, cutoff: Date): Promise<PriceBar | null> {
      const { bars } = await this.getPriceHistory(instrumentId, symbol, new Date(cutoff.getTime() - 30 * 24 * 60 * 60 * 1000), cutoff, "1d");
      const valid = bars.filter((b) => b.trading_date.getTime() <= cutoff.getTime());
      return valid.length > 0 ? valid[valid.length - 1] : null;
    },
  };

  async function findCachedQuoteAtOrBefore(instrumentId: string, asOf: Date) {
    const [row] = await db
      .select()
      .from(market_price_bars)
      .where(
        and(
          eq(market_price_bars.instrument_id, instrumentId),
          eq(market_price_bars.provider, providerName),
          lte(market_price_bars.trading_date, asOf)
        )
      )
      .orderBy(desc(market_price_bars.trading_date))
      .limit(1);
    return row ?? null;
  }

  async function persistPriceBars(instrumentId: string, symbol: string, bars: PriceBar[]) {
    if (bars.length === 0) return;
    const values = bars.map((b) => ({
      instrument_id: instrumentId,
      provider: providerName,
      provider_symbol: symbol,
      trading_date: b.trading_date,
      open: String(b.open),
      high: String(b.high),
      low: String(b.low),
      close: String(b.close),
      adjusted_close: b.adjusted_close != null ? String(b.adjusted_close) : null,
      volume: b.volume != null ? String(b.volume) : null,
      currency: b.currency,
      exchange_timezone: b.exchange_timezone ?? null,
      available_at: b.trading_date,
      retrieved_at: new Date(),
    }));
    await db.insert(market_price_bars).values(values as any).onConflictDoNothing({
      target: [market_price_bars.instrument_id, market_price_bars.provider, market_price_bars.provider_symbol, market_price_bars.trading_date],
    });
  }

  async function persistCorporateActions(instrumentId: string, symbol: string, actions: CorporateActionEvent[]) {
    if (actions.length === 0) return;
    const values = actions.map((a) => ({
      instrument_id: instrumentId,
      provider: providerName,
      provider_symbol: symbol,
      action_type: a.action_type,
      ex_date: a.ex_date ?? null,
      record_date: a.record_date ?? null,
      pay_date: a.pay_date ?? null,
      dividend_per_share: a.dividend_per_share != null ? String(a.dividend_per_share) : null,
      split_ratio: a.split_ratio != null ? String(a.split_ratio) : null,
      spinoff_ratio: a.spinoff_ratio != null ? String(a.spinoff_ratio) : null,
      old_symbol: a.old_symbol ?? null,
      new_symbol: a.new_symbol ?? null,
      currency: a.currency ?? null,
      metadata_json: {},
      available_at: a.ex_date ?? new Date(),
      retrieved_at: new Date(),
    }));
    await db.insert(corporate_actions).values(values as any);
  }

  async function logFetch(
    instrumentId: string | null,
    symbol: string,
    requestType: string,
    status: "success" | "failed",
    latencyMs?: number,
    error?: unknown,
    params?: Record<string, unknown>
  ) {
    await db.insert(market_data_fetches).values({
      instrument_id: instrumentId,
      provider: providerName,
      provider_symbol: symbol,
      request_type: requestType,
      request_params_json: params ?? {},
      status,
      error_message: error instanceof Error ? error.message : error ? String(error) : undefined,
      latency_ms: latencyMs ?? null,
    } as any);
  }

  function toPriceBar(row: typeof market_price_bars.$inferSelect): PriceBar {
    return {
      trading_date: row.trading_date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      adjusted_close: row.adjusted_close != null ? Number(row.adjusted_close) : undefined,
      volume: row.volume != null ? Number(row.volume) : undefined,
      currency: row.currency,
      exchange_timezone: row.exchange_timezone ?? undefined,
    };
  }

  function toCorporateActionEvent(row: typeof corporate_actions.$inferSelect): CorporateActionEvent {
    return {
      action_type: row.action_type as any,
      ex_date: row.ex_date ?? undefined,
      record_date: row.record_date ?? undefined,
      pay_date: row.pay_date ?? undefined,
      dividend_per_share: row.dividend_per_share != null ? Number(row.dividend_per_share) : undefined,
      split_ratio: row.split_ratio != null ? Number(row.split_ratio) : undefined,
      spinoff_ratio: row.spinoff_ratio != null ? Number(row.spinoff_ratio) : undefined,
      old_symbol: row.old_symbol ?? undefined,
      new_symbol: row.new_symbol ?? undefined,
      currency: row.currency ?? undefined,
    };
  }

  function spansRange(rows: typeof market_price_bars.$inferSelect[], start: Date, end: Date): boolean {
    if (rows.length === 0) return false;
    const first = rows[0].trading_date;
    const last = rows[rows.length - 1].trading_date;
    return first <= start && last >= end;
  }
}

export type MarketDataService = ReturnType<typeof createMarketDataService>;
