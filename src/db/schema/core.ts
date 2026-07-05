import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  date,
  jsonb,
  boolean,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { research_profiles } from "./profiles";

// ============================================================
// assets — §27.4
// The researched economic asset or investment idea.
// Do not use ticker as primary identity.
// ============================================================
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonical_name: text("canonical_name").notNull(),
  slug: text("slug").unique().notNull(),
  asset_kind: text("asset_kind").notNull(), // equity, crypto_asset, commodity, fund, index, private_asset, special_situation
  base_currency: text("base_currency"),
  home_country: text("home_country"),
  sector: text("sector"),
  industry: text("industry"),
  description: text("description"),
  primary_profile_id: uuid("primary_profile_id").references(() => research_profiles.id),
  status: text("status").notNull().default("active"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// asset_classifications — §27.4
// Allows one asset to belong to multiple investment categories.
// ============================================================
export const asset_classifications = pgTable(
  "asset_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    asset_id: uuid("asset_id").notNull().references(() => assets.id),
    classification_system: text("classification_system").notNull(),
    classification_key: text("classification_key").notNull(),
    confidence: numeric("confidence"),
    assigned_by: text("assigned_by").notNull(),
    source: text("source"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("asset_classifications_unique").on(
      table.asset_id,
      table.classification_system,
      table.classification_key
    ),
  ]
);

// ============================================================
// legal_entities — §27.4
// ============================================================
export const legal_entities = pgTable("legal_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  entity_type: text("entity_type").notNull(),
  country: text("country"),
  lei: text("lei"),
  cik: text("cik"),
  website_url: text("website_url"),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// asset_entities — §27.4
// ============================================================
export const asset_entities = pgTable("asset_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  legal_entity_id: uuid("legal_entity_id").notNull().references(() => legal_entities.id),
  relationship_type: text("relationship_type").notNull(),
  active_from: date("active_from"),
  active_to: date("active_to"),
  metadata_json: jsonb("metadata_json").notNull().default({}),
});

// ============================================================
// instruments — §27.4
// Tradable wrapper or security associated with an asset.
// ============================================================
export const instruments = pgTable("instruments", {
  id: uuid("id").primaryKey().defaultRandom(),
  asset_id: uuid("asset_id").notNull().references(() => assets.id),
  instrument_type: text("instrument_type").notNull(),
  name: text("name").notNull(),
  currency: text("currency"),
  isin: text("isin"),
  cusip: text("cusip"),
  figi: text("figi"),
  contract_specs_json: jsonb("contract_specs_json").notNull().default({}),
  active_from: date("active_from"),
  active_to: date("active_to"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// listings — §27.4
// Ticker/venue history for an instrument.
// ============================================================
export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrument_id: uuid("instrument_id").notNull().references(() => instruments.id),
    symbol: text("symbol").notNull(),
    exchange: text("exchange"),
    mic: text("mic"),
    currency: text("currency"),
    listing_type: text("listing_type"),
    is_primary: boolean("is_primary").notNull().default(false),
    active_from: date("active_from"),
    active_to: date("active_to"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("listings_symbol_exchange_idx").on(table.symbol, table.exchange),
    index("listings_active_symbol_idx")
      .on(table.symbol)
      .where(sql`${table.active_to} IS NULL`),
  ]
);

// ============================================================
// Relations
// ============================================================
export const assetsRelations = relations(assets, ({ many }) => ({
  classifications: many(asset_classifications),
  instruments: many(instruments),
  asset_entities: many(asset_entities),
}));

export const assetClassificationsRelations = relations(asset_classifications, ({ one }) => ({
  asset: one(assets, {
    fields: [asset_classifications.asset_id],
    references: [assets.id],
  }),
}));

export const legalEntitiesRelations = relations(legal_entities, ({ many }) => ({
  asset_entities: many(asset_entities),
}));

export const assetEntitiesRelations = relations(asset_entities, ({ one }) => ({
  asset: one(assets, {
    fields: [asset_entities.asset_id],
    references: [assets.id],
  }),
  legal_entity: one(legal_entities, {
    fields: [asset_entities.legal_entity_id],
    references: [legal_entities.id],
  }),
}));

export const instrumentsRelations = relations(instruments, ({ one, many }) => ({
  asset: one(assets, {
    fields: [instruments.asset_id],
    references: [assets.id],
  }),
  listings: many(listings),
}));

export const listingsRelations = relations(listings, ({ one }) => ({
  instrument: one(instruments, {
    fields: [listings.instrument_id],
    references: [instruments.id],
  }),
}));
