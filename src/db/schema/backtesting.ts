import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  date,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { assets } from "./core";
import { research_runs, research_tasks } from "./workflow";

export const backtest_runs = pgTable(
  "backtest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    research_task_id: uuid("research_task_id").references(() => research_tasks.id),
    asset_id: uuid("asset_id").notNull().references(() => assets.id),
    status: text("status").notNull().default("pending"),
    strategy_name: text("strategy_name"),
    strategy_prompt: text("strategy_prompt").notNull(),
    symbol: text("symbol").notNull(),
    benchmark_symbol: text("benchmark_symbol"),
    data_provider: text("data_provider").notNull().default("yfinance"),
    start_date: date("start_date").notNull(),
    end_date: date("end_date"),
    market_data_cutoff_at: timestamp("market_data_cutoff_at", { withTimezone: true }),
    initial_capital: numeric("initial_capital").notNull().default("100000"),
    params_json: jsonb("params_json").notNull().default({}),
    assumptions_json: jsonb("assumptions_json").notNull().default([]),
    generated_code_path: text("generated_code_path"),
    metrics_json: jsonb("metrics_json").notNull().default({}),
    error_message: text("error_message"),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("backtest_runs_research_run_idx").on(table.research_run_id),
    index("backtest_runs_task_idx").on(table.research_task_id),
    index("backtest_runs_status_idx").on(table.status),
  ]
);

export const backtest_artifacts = pgTable(
  "backtest_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backtest_run_id: uuid("backtest_run_id").notNull().references(() => backtest_runs.id),
    research_run_id: uuid("research_run_id").notNull().references(() => research_runs.id),
    artifact_type: text("artifact_type").notNull(),
    title: text("title").notNull(),
    storage_path: text("storage_path").notNull(),
    mime_type: text("mime_type"),
    metadata_json: jsonb("metadata_json").notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("backtest_artifacts_run_idx").on(table.backtest_run_id),
    index("backtest_artifacts_research_run_idx").on(table.research_run_id),
  ]
);

export const backtestRunsRelations = relations(backtest_runs, ({ one, many }) => ({
  research_run: one(research_runs, {
    fields: [backtest_runs.research_run_id],
    references: [research_runs.id],
  }),
  research_task: one(research_tasks, {
    fields: [backtest_runs.research_task_id],
    references: [research_tasks.id],
  }),
  asset: one(assets, {
    fields: [backtest_runs.asset_id],
    references: [assets.id],
  }),
  artifacts: many(backtest_artifacts),
}));

export const backtestArtifactsRelations = relations(backtest_artifacts, ({ one }) => ({
  backtest_run: one(backtest_runs, {
    fields: [backtest_artifacts.backtest_run_id],
    references: [backtest_runs.id],
  }),
  research_run: one(research_runs, {
    fields: [backtest_artifacts.research_run_id],
    references: [research_runs.id],
  }),
}));
