/**
 * Market-data schema for Research OS v3.
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  integer,
  index,
  uniqueIndex,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { instruments } from "./core";

export const market_price_bars = pgTable(
  "market_price_bars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrument_id: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id),
    provider: text("provider").notNull(),
    provider_symbol: text("provider_symbol").notNull(),
    trading_date: timestamp("trading_date", { withTimezone: true }).notNull(),
    open: numeric("open").notNull(),
    high: numeric("high").notNull(),
    low: numeric("low").notNull(),
    close: numeric("close").notNull(),
    adjusted_close: numeric("adjusted_close"),
    volume: numeric("volume"),
    currency: text("currency").notNull(),
    exchange_timezone: text("exchange_timezone"),
    available_at: timestamp("available_at", { withTimezone: true }).notNull(),
    retrieved_at: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("market_price_bars_unique")
      .on(table.instrument_id, table.provider, table.provider_symbol, table.trading_date),
    index("market_price_bars_instrument_date_idx").on(table.instrument_id, table.trading_date),
    index("market_price_bars_provider_idx").on(table.provider, table.provider_symbol),
  ]
);

export const corporate_actions = pgTable(
  "corporate_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrument_id: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id),
    provider: text("provider").notNull(),
    provider_symbol: text("provider_symbol").notNull(),
    action_type: text("action_type").notNull(), // dividend, split, spinoff, symbol_change
    ex_date: timestamp("ex_date", { withTimezone: true }),
    record_date: timestamp("record_date", { withTimezone: true }),
    pay_date: timestamp("pay_date", { withTimezone: true }),
    dividend_per_share: numeric("dividend_per_share"),
    split_ratio: numeric("split_ratio"),
    spinoff_ratio: numeric("spinoff_ratio"),
    old_symbol: text("old_symbol"),
    new_symbol: text("new_symbol"),
    currency: text("currency"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    available_at: timestamp("available_at", { withTimezone: true }).notNull(),
    retrieved_at: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("corporate_actions_instrument_idx").on(table.instrument_id),
    index("corporate_actions_ex_date_idx").on(table.ex_date),
    index("corporate_actions_provider_symbol_idx").on(table.provider, table.provider_symbol),
  ]
);

export const market_data_fetches = pgTable(
  "market_data_fetches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrument_id: uuid("instrument_id").references(() => instruments.id),
    provider: text("provider").notNull(),
    provider_symbol: text("provider_symbol").notNull(),
    request_type: text("request_type").notNull(), // quote, history, corporate_actions, metadata
    request_params_json: jsonb("request_params_json").notNull().default({}),
    status: text("status").notNull().default("pending"), // pending, success, failed
    error_message: text("error_message"),
    raw_response_excerpt: text("raw_response_excerpt"),
    response_size_bytes: integer("response_size_bytes"),
    latency_ms: integer("latency_ms"),
    fetched_at: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("market_data_fetches_instrument_idx").on(table.instrument_id),
    index("market_data_fetches_provider_symbol_idx").on(table.provider, table.provider_symbol),
    index("market_data_fetches_status_idx").on(table.status),
  ]
);

export const instrument_provider_mappings = pgTable(
  "instrument_provider_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrument_id: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id),
    provider: text("provider").notNull(),
    provider_symbol: text("provider_symbol").notNull(),
    provider_exchange: text("provider_exchange"),
    provider_instrument_id: text("provider_instrument_id"),
    is_active: boolean("is_active").notNull().default(true),
    mapping_metadata_json: jsonb("mapping_metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("instrument_provider_mappings_unique")
      .on(table.instrument_id, table.provider, table.provider_symbol),
    index("instrument_provider_mappings_provider_idx").on(table.provider, table.provider_symbol),
  ]
);

export type MarketPriceBar = typeof market_price_bars.$inferSelect;
export type CorporateAction = typeof corporate_actions.$inferSelect;
export type MarketDataFetch = typeof market_data_fetches.$inferSelect;
export type InstrumentProviderMapping = typeof instrument_provider_mappings.$inferSelect;
