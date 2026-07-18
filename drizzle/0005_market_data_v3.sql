CREATE TABLE "corporate_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_symbol" text NOT NULL,
	"action_type" text NOT NULL,
	"ex_date" timestamp with time zone,
	"record_date" timestamp with time zone,
	"pay_date" timestamp with time zone,
	"dividend_per_share" numeric,
	"split_ratio" numeric,
	"spinoff_ratio" numeric,
	"old_symbol" text,
	"new_symbol" text,
	"currency" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instrument_provider_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_symbol" text NOT NULL,
	"provider_exchange" text,
	"provider_instrument_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"mapping_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_data_fetches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid,
	"provider" text NOT NULL,
	"provider_symbol" text NOT NULL,
	"request_type" text NOT NULL,
	"request_params_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"raw_response_excerpt" text,
	"response_size_bytes" integer,
	"latency_ms" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_price_bars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_symbol" text NOT NULL,
	"trading_date" timestamp with time zone NOT NULL,
	"open" numeric NOT NULL,
	"high" numeric NOT NULL,
	"low" numeric NOT NULL,
	"close" numeric NOT NULL,
	"adjusted_close" numeric,
	"volume" numeric,
	"currency" text NOT NULL,
	"exchange_timezone" text,
	"available_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_provider_mappings" ADD CONSTRAINT "instrument_provider_mappings_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_data_fetches" ADD CONSTRAINT "market_data_fetches_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_price_bars" ADD CONSTRAINT "market_price_bars_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporate_actions_instrument_idx" ON "corporate_actions" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "corporate_actions_ex_date_idx" ON "corporate_actions" USING btree ("ex_date");--> statement-breakpoint
CREATE INDEX "corporate_actions_provider_symbol_idx" ON "corporate_actions" USING btree ("provider","provider_symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_provider_mappings_unique" ON "instrument_provider_mappings" USING btree ("instrument_id","provider","provider_symbol");--> statement-breakpoint
CREATE INDEX "instrument_provider_mappings_provider_idx" ON "instrument_provider_mappings" USING btree ("provider","provider_symbol");--> statement-breakpoint
CREATE INDEX "market_data_fetches_instrument_idx" ON "market_data_fetches" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "market_data_fetches_provider_symbol_idx" ON "market_data_fetches" USING btree ("provider","provider_symbol");--> statement-breakpoint
CREATE INDEX "market_data_fetches_status_idx" ON "market_data_fetches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "market_price_bars_unique" ON "market_price_bars" USING btree ("instrument_id","provider","provider_symbol","trading_date");--> statement-breakpoint
CREATE INDEX "market_price_bars_instrument_date_idx" ON "market_price_bars" USING btree ("instrument_id","trading_date");--> statement-breakpoint
CREATE INDEX "market_price_bars_provider_idx" ON "market_price_bars" USING btree ("provider","provider_symbol");