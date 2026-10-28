/**
 * Market-data service: persist, derive, and retrieve market data for Research OS v3.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  MarketDataProvider,
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
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
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

    /**
     * Backfill [start, end] once, then fetch only from shortly before the latest stored bar in it.
     * Coverage is judged inside the window: a window that starts more than a week late or has a
     * gap of more than a week (left by runs with other cutoffs) is fetched again in full, unless a
     * successful fetch already spanned that stretch, which shows the provider has no bars there
     * (a listing after the window start, a trading halt). `normalize` maps provider bars to stored
     * bars (trading day, availability) and drops bars that are not final yet; stored rows are
     * never overwritten.
     */
    async syncDailyHistory(
      instrumentId: string,
      symbol: string,
      start: Date,
      end: Date,
      normalize: (bars: PriceBar[]) => PriceBar[] = (bars) => bars
    ): Promise<{ fetchedFrom: Date | null; storedBars: number }> {
      const stored = and(
        eq(market_price_bars.instrument_id, instrumentId),
        eq(market_price_bars.provider, providerName),
        eq(market_price_bars.provider_symbol, symbol)
      );
      const [{ latest }] = await db
        .select({ latest: sql<Date | null>`max(${market_price_bars.trading_date})` })
        .from(market_price_bars)
        .where(stored);
      const windowBars = db
        .select({
          trading_date: market_price_bars.trading_date,
          prev_date: sql<Date | null>`lag(${market_price_bars.trading_date}) over (order by ${market_price_bars.trading_date})`.as("prev_date"),
          gap_days: sql<number>`extract(epoch from ${market_price_bars.trading_date} - lag(${market_price_bars.trading_date}) over (order by ${market_price_bars.trading_date})) / 86400`.as("gap_days"),
        })
        .from(market_price_bars)
        .where(and(stored, gte(market_price_bars.trading_date, start), lte(market_price_bars.trading_date, end)))
        .as("window_bars");
      const [range] = await db
        .select({
          first: sql<Date | null>`min(${windowBars.trading_date})`,
          last: sql<Date | null>`max(${windowBars.trading_date})`,
        })
        .from(windowBars);
      const gaps = (await db
        .select({ from: windowBars.prev_date, to: windowBars.trading_date })
        .from(windowBars)
        .where(sql`${windowBars.gap_days} > 7`))
        .map((gap) => ({ from: new Date(gap.from!), to: new Date(gap.to) }));
      const day = 24 * 60 * 60 * 1000;
      const first = range?.first ? new Date(range.first) : null;
      const last = range?.last ? new Date(range.last) : null;
      const storedAfter = latest !== null && new Date(latest).getTime() > end.getTime();
      // Only a window that starts late or has gaps needs the fetch log to show they are the provider's own (#133).
      const needsProof = first !== null && (first.getTime() > start.getTime() + 7 * day || gaps.length > 0);
      const fetched = needsProof
        ? (await db
          .select({ params: market_data_fetches.request_params_json })
          .from(market_data_fetches)
          .where(and(
            eq(market_data_fetches.instrument_id, instrumentId),
            eq(market_data_fetches.provider, providerName),
            eq(market_data_fetches.provider_symbol, symbol),
            eq(market_data_fetches.request_type, "history"),
            eq(market_data_fetches.status, "success")
          ))).flatMap(({ params }) => fetchedRange(params))
        : [];
      const covered = windowCovered(start, first, gaps, fetched);
      const coversEnd = last !== null && (last.getTime() + day >= end.getTime() || (storedAfter && end.getTime() - last.getTime() <= 7 * day));
      if (covered && coversEnd) return { fetchedFrom: null, storedBars: 0 };
      const fetchedFrom = covered && last ? new Date(Math.max(start.getTime(), last.getTime() - 5 * day)) : start;
      const fetchStart = Date.now();
      let bars: PriceBar[];
      try {
        bars = await defaultProvider.getPriceHistory(symbol, fetchedFrom, end, "1d");
      } catch (err) {
        await logFetch(instrumentId, symbol, "history", "failed", undefined, err, { start: fetchedFrom, end, interval: "1d" });
        throw err;
      }
      await logFetch(instrumentId, symbol, "history", "success", Date.now() - fetchStart, undefined, { start: fetchedFrom, end, interval: "1d", bars: bars.length });
      const normalized = normalize(bars);
      await persistPriceBars(instrumentId, symbol, normalized);
      return { fetchedFrom, storedBars: normalized.length };
    },

    /** Fetch splits and dividends for the window and insert the ones not stored yet. */
    async syncCorporateActions(instrumentId: string, symbol: string, start: Date, end: Date): Promise<CorporateActionEvent[]> {
      const fetchStart = Date.now();
      let actions: CorporateActionEvent[];
      try {
        actions = await defaultProvider.getCorporateActions(symbol, start, end);
      } catch (err) {
        await logFetch(instrumentId, symbol, "corporate_actions", "failed", undefined, err, { start, end });
        throw err;
      }
      await logFetch(instrumentId, symbol, "corporate_actions", "success", Date.now() - fetchStart, undefined, { start, end });
      const existing = await db
        .select({ action_type: corporate_actions.action_type, ex_date: corporate_actions.ex_date })
        .from(corporate_actions)
        .where(and(
          eq(corporate_actions.instrument_id, instrumentId),
          eq(corporate_actions.provider, providerName),
          eq(corporate_actions.provider_symbol, symbol)
        ));
      const seen = new Set(existing.map((row) => `${row.action_type}:${row.ex_date?.getTime()}`));
      const fresh = actions.filter((action) => !seen.has(`${action.action_type}:${action.ex_date?.getTime()}`));
      await persistCorporateActions(instrumentId, symbol, fresh);
      return fresh;
    },
  };

  async function persistPriceBars(instrumentId: string, symbol: string, bars: PriceBar[]) {
    if (bars.length === 0) return;
    const values = priceBarRows(instrumentId, providerName, symbol, bars, new Date());
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

/** Map provider bars to `market_price_bars` rows. A bar without `available_at` is available at its trading date. */
export function priceBarRows(instrumentId: string, provider: string, symbol: string, bars: PriceBar[], retrievedAt: Date) {
  return bars.map((b) => ({
    instrument_id: instrumentId,
    provider,
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
    available_at: b.available_at ?? b.trading_date,
    retrieved_at: retrievedAt,
  }));
}

type DateRange = { start: Date; end: Date };

/** The [start, end] of a logged successful daily-history fetch, from its request parameters. */
export function fetchedRange(params: unknown): DateRange[] {
  const value = (params ?? {}) as Record<string, unknown>;
  if (value.interval !== undefined && value.interval !== "1d") return [];
  const start = new Date(String(value.start)), end = new Date(String(value.end));
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? [] : [{ start, end }];
}

/**
 * Whether stored bars cover the window from its start. A late first bar or a gap of more than a
 * week counts as covered when a successful fetch spanned it: the provider has nothing there (#133).
 */
export function windowCovered(start: Date, first: Date | null, gaps: Array<{ from: Date; to: Date }>, fetched: DateRange[]): boolean {
  if (first === null) return false;
  const week = 7 * 24 * 60 * 60 * 1000;
  const spanned = (from: Date, to: Date) => fetched.some((range) => range.start.getTime() <= from.getTime() && range.end.getTime() >= to.getTime());
  const startCovered = first.getTime() <= start.getTime() + week || spanned(new Date(start.getTime() + week), first);
  return startCovered && gaps.every((gap) => spanned(gap.from, gap.to));
}
