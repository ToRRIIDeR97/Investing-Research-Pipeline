import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { assets } from "./core";
import { research_runs } from "./workflow";

// ============================================================
// source_documents — §27.7
// Immutable raw source files with content hash.
// ============================================================
export const source_documents = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    asset_id: uuid("asset_id").references(() => assets.id),
    research_run_id: uuid("research_run_id").references(() => research_runs.id),
    source_type: text("source_type").notNull(),
    title: text("title").notNull(),
    publisher: text("publisher"),
    author: text("author"),
    url: text("url"),
    canonical_url: text("canonical_url"),
    retrieved_at: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    published_at: timestamp("published_at", { withTimezone: true }),
    period_start: timestamp("period_start"),
    period_end: timestamp("period_end"),
    file_hash: text("file_hash").notNull(),
    mime_type: text("mime_type"),
    language: text("language"),
    storage_path: text("storage_path").notNull(),
    source_quality_score: numeric("source_quality_score"),
    license_notes: text("license_notes"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("source_documents_file_hash_unique").on(table.file_hash)]
);

// A raw document may support many research runs. The legacy research_run_id on
// source_documents is retained for v1 compatibility; v2 uses this association
// instead of moving a shared document to the latest run that encountered it.
export const research_run_sources = pgTable(
  "research_run_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    source_document_id: uuid("source_document_id").notNull().references(() => source_documents.id),
    role: text("role").notNull().default("supporting_source"),
    discovery_metadata_json: jsonb("discovery_metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("research_run_sources_run_document_unique").on(
      table.research_run_id,
      table.source_document_id
    ),
    index("research_run_sources_run_idx").on(table.research_run_id),
  ]
);

// Makes filing indexes, exhibits, amendments, translations, and other derived
// documents navigable without encoding lineage only in JSON metadata.
export const source_document_relations = pgTable(
  "source_document_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parent_source_document_id: uuid("parent_source_document_id")
      .notNull()
      .references(() => source_documents.id),
    child_source_document_id: uuid("child_source_document_id")
      .notNull()
      .references(() => source_documents.id),
    relationship_type: text("relationship_type").notNull(),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("source_document_relations_unique").on(
      table.parent_source_document_id,
      table.child_source_document_id,
      table.relationship_type
    ),
  ]
);

// ============================================================
// document_parses — §27.7
// Versioned parse outputs for a source document.
// ============================================================
export const document_parses = pgTable(
  "document_parses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source_document_id: uuid("source_document_id").notNull().references(() => source_documents.id),
    parser_name: text("parser_name").notNull(),
    parser_version: text("parser_version").notNull(),
    parse_config_json: jsonb("parse_config_json").notNull().default({}),
    status: text("status").notNull().default("pending"),
    warnings_json: jsonb("warnings_json").notNull().default([]),
    output_storage_path: text("output_storage_path"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("document_parses_unique").on(
      table.source_document_id,
      table.parser_name,
      table.parser_version,
      table.parse_config_json
    ),
  ]
);

// ============================================================
// document_chunks — §27.7
// Text chunks from parsed documents with FTS index.
// ============================================================
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const document_chunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source_document_id: uuid("source_document_id").notNull().references(() => source_documents.id),
    document_parse_id: uuid("document_parse_id").notNull().references(() => document_parses.id),
    chunk_index: integer("chunk_index").notNull(),
    section_title: text("section_title"),
    page_start: integer("page_start"),
    page_end: integer("page_end"),
    char_start: integer("char_start"),
    char_end: integer("char_end"),
    text: text("text").notNull(),
    token_count: integer("token_count"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    // Research-memory passages only: section path weighted A, text weighted B. Raw payload chunks stay null.
    search_tsv: tsvector("search_tsv"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_chunks_parse_idx").on(table.document_parse_id, table.chunk_index),
    // Valuation's share-count lookup and the source detail view filter chunks by document.
    index("document_chunks_source_document_idx").on(table.source_document_id),
    // GIN full-text search index — §27.7
    index("document_chunks_text_fts_idx")
      .using("gin", sql`to_tsvector('english', ${table.text})`),
    index("document_chunks_search_tsv_idx").using("gin", table.search_tsv).where(sql`${table.search_tsv} IS NOT NULL`),
  ]
);

// ============================================================
// document_embeddings — §27.7
// Separate from chunks so embedding models can change.
// ============================================================
export const document_embeddings = pgTable(
  "document_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    document_chunk_id: uuid("document_chunk_id").notNull().references(() => document_chunks.id),
    embedding_model: text("embedding_model").notNull(),
    embedding_dimension: integer("embedding_dimension").notNull(),
    embedding: jsonb("embedding").notNull(), // stored as array; pgvector type added via raw SQL in migration
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("document_embeddings_chunk_model_unique").on(
      table.document_chunk_id,
      table.embedding_model
    ),
  ]
);

// ============================================================
// extracted_tables — §27.7
// ============================================================
export const extracted_tables = pgTable("extracted_tables", {
  id: uuid("id").primaryKey().defaultRandom(),
  source_document_id: uuid("source_document_id").notNull().references(() => source_documents.id),
  document_parse_id: uuid("document_parse_id").notNull().references(() => document_parses.id),
  table_index: integer("table_index").notNull(),
  page_start: integer("page_start"),
  page_end: integer("page_end"),
  table_title: text("table_title"),
  table_json: jsonb("table_json").notNull(),
  table_csv_path: text("table_csv_path"),
  confidence: numeric("confidence"),
  metadata_json: jsonb("metadata_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================
// source_locations — §27.7
// Precise references to passages, pages, tables, cells, charts.
// ============================================================
export const source_locations = pgTable("source_locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  source_document_id: uuid("source_document_id").notNull().references(() => source_documents.id),
  document_parse_id: uuid("document_parse_id").references(() => document_parses.id),
  document_chunk_id: uuid("document_chunk_id").references(() => document_chunks.id),
  extracted_table_id: uuid("extracted_table_id").references(() => extracted_tables.id),
  page_start: integer("page_start"),
  page_end: integer("page_end"),
  char_start: integer("char_start"),
  char_end: integer("char_end"),
  table_row: integer("table_row"),
  table_column: integer("table_column"),
  locator_json: jsonb("locator_json").notNull().default({}),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("source_locations_chunk_idx").on(table.document_chunk_id),
  index("source_locations_source_document_idx").on(table.source_document_id),
]);

// ============================================================
// Relations
// ============================================================
export const sourceDocumentsRelations = relations(source_documents, ({ many }) => ({
  parses: many(document_parses),
  chunks: many(document_chunks),
  tables: many(extracted_tables),
  locations: many(source_locations),
  run_sources: many(research_run_sources),
}));

export const researchRunSourcesRelations = relations(research_run_sources, ({ one }) => ({
  run: one(research_runs, {
    fields: [research_run_sources.research_run_id],
    references: [research_runs.id],
  }),
  source_document: one(source_documents, {
    fields: [research_run_sources.source_document_id],
    references: [source_documents.id],
  }),
}));

export const documentParsesRelations = relations(document_parses, ({ one, many }) => ({
  source_document: one(source_documents, {
    fields: [document_parses.source_document_id],
    references: [source_documents.id],
  }),
  chunks: many(document_chunks),
  tables: many(extracted_tables),
}));

export const documentChunksRelations = relations(document_chunks, ({ one, many }) => ({
  source_document: one(source_documents, {
    fields: [document_chunks.source_document_id],
    references: [source_documents.id],
  }),
  parse: one(document_parses, {
    fields: [document_chunks.document_parse_id],
    references: [document_parses.id],
  }),
  embeddings: many(document_embeddings),
}));

export const documentEmbeddingsRelations = relations(document_embeddings, ({ one }) => ({
  chunk: one(document_chunks, {
    fields: [document_embeddings.document_chunk_id],
    references: [document_chunks.id],
  }),
}));

export const extractedTablesRelations = relations(extracted_tables, ({ one }) => ({
  source_document: one(source_documents, {
    fields: [extracted_tables.source_document_id],
    references: [source_documents.id],
  }),
  parse: one(document_parses, {
    fields: [extracted_tables.document_parse_id],
    references: [document_parses.id],
  }),
}));

export const sourceLocationsRelations = relations(source_locations, ({ one }) => ({
  source_document: one(source_documents, {
    fields: [source_locations.source_document_id],
    references: [source_documents.id],
  }),
  parse: one(document_parses, {
    fields: [source_locations.document_parse_id],
    references: [document_parses.id],
  }),
  chunk: one(document_chunks, {
    fields: [source_locations.document_chunk_id],
    references: [document_chunks.id],
  }),
  extracted_table: one(extracted_tables, {
    fields: [source_locations.extracted_table_id],
    references: [extracted_tables.id],
  }),
}));
