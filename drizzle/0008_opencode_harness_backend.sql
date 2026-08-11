CREATE TABLE "agent_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_session_id" uuid,
  "research_run_id" uuid,
  "stage_id" uuid,
  "task_id" uuid,
  "agent_name" text NOT NULL,
  "status" text DEFAULT 'idle' NOT NULL,
  "provider" text,
  "model" text,
  "result_json" jsonb,
  "error_json" jsonb,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "next_event_sequence" integer DEFAULT 0 NOT NULL,
  "next_message_sequence" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_sessions_run_fk" FOREIGN KEY ("research_run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_sessions_stage_fk" FOREIGN KEY ("stage_id") REFERENCES "research_stages"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_sessions_task_fk" FOREIGN KEY ("task_id") REFERENCES "research_tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_sessions_parent_fk" FOREIGN KEY ("parent_session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_task_unique" ON "agent_sessions" ("task_id");
--> statement-breakpoint
CREATE INDEX "agent_sessions_run_idx" ON "agent_sessions" ("research_run_id", "created_at");
--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_idx" ON "agent_sessions" ("parent_session_id");
--> statement-breakpoint
CREATE TABLE "agent_session_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "role" text NOT NULL,
  "content_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_session_messages_session_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_messages_sequence_unique" ON "agent_session_messages" ("session_id", "sequence");
--> statement-breakpoint
CREATE INDEX "agent_session_messages_session_idx" ON "agent_session_messages" ("session_id", "sequence");
--> statement-breakpoint
CREATE TABLE "agent_session_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "event_type" text NOT NULL,
  "payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_session_events_session_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_events_sequence_unique" ON "agent_session_events" ("session_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_events_idempotency_unique" ON "agent_session_events" ("session_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "agent_session_events_session_idx" ON "agent_session_events" ("session_id", "sequence");
--> statement-breakpoint
CREATE TABLE "agent_permission_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL,
  "tool_call_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "agent_name" text NOT NULL,
  "action" text NOT NULL,
  "resource" text NOT NULL,
  "input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "decision" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "agent_permission_requests_session_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "agent_permission_requests_session_idx" ON "agent_permission_requests" ("session_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_permission_requests_call_unique" ON "agent_permission_requests" ("session_id", "tool_call_id");
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "session_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "tool_call_id" text;
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "error_message" text;
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_session_fk" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_traces_session_call_unique" ON "agent_traces" ("session_id", "tool_call_id");
--> statement-breakpoint
CREATE INDEX "agent_traces_session_idx" ON "agent_traces" ("session_id", "created_at");
