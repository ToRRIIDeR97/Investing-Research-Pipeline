-- Quant page (Implementations/quant-page P1): cached PragValue and PragTrend results, one row per ticker and as-of
-- trading day. Built by code only; never a research input. Re-runnable.
CREATE TABLE IF NOT EXISTS "quant_snapshots" (
	"ticker" text NOT NULL,
	"as_of_day" date NOT NULL,
	"status" text NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quant_snapshots_ticker_as_of_day_pk" PRIMARY KEY ("ticker", "as_of_day"),
	CONSTRAINT "quant_snapshots_status_check" CHECK ("status" IN ('ok', 'partial', 'failed'))
);
