import postgres from "postgres";
import { z } from "zod";

export const createBacktestRequestSchema = z.object({
  strategy_prompt: z.string().min(8),
  symbol: z.string().trim().min(1).optional(),
  benchmark_symbol: z.string().trim().min(1).optional().default("SPY"),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  initial_capital: z.coerce.number().positive().optional().default(100000),
  params: z.record(z.unknown()).optional().default({}),
});

export type CreateBacktestRequestInput = z.infer<typeof createBacktestRequestSchema>;

export interface BacktestRunRecord {
  id: string;
  research_run_id: string;
  research_task_id: string | null;
  asset_id: string;
  status: string;
  strategy_name: string | null;
  strategy_prompt: string;
  symbol: string;
  benchmark_symbol: string | null;
  data_provider: string;
  start_date: string;
  end_date: string | null;
  market_data_cutoff_at: string | null;
  initial_capital: string;
  params_json: Record<string, unknown>;
  assumptions_json: unknown[];
  generated_code_path: string | null;
  metrics_json: Record<string, unknown>;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function defaultStartDate() {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 5);
  return date.toISOString().slice(0, 10);
}

function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function resolvePrimarySymbol(
  sql: ReturnType<typeof postgres> | any,
  assetId: string
): Promise<string | null> {
  const rows = await sql`
    SELECT l.symbol
    FROM listings l
    JOIN instruments i ON i.id = l.instrument_id
    WHERE i.asset_id = ${assetId}
      AND l.active_to IS NULL
    ORDER BY l.is_primary DESC, l.created_at ASC
    LIMIT 1
  `;
  return rows[0]?.symbol ?? null;
}

export async function createBacktestRequest(
  runId: string,
  input: CreateBacktestRequestInput
): Promise<BacktestRunRecord> {
  const sql = postgres(process.env.DATABASE_URL!);

  try {
    const parsed = createBacktestRequestSchema.parse(input);
    const result = await sql.begin(async (tx) => {
      const runs = await tx`
        SELECT id, asset_id, market_data_cutoff_at, status
        FROM research_runs
        WHERE id = ${runId}
      `;
      if (runs.length === 0) {
        throw new Error("Research run not found");
      }
      if (["completed", "failed", "cancelled"].includes(runs[0].status)) {
        throw new Error(`Cannot enqueue backtests for run in ${runs[0].status} state`);
      }

      const stages = await tx`
        SELECT id, status
        FROM research_stages
        WHERE research_run_id = ${runId}
          AND stage_key = 'backtest_execution'
        LIMIT 1
      `;
      if (stages.length === 0) {
        throw new Error("Backtest stage is not initialized for this run");
      }
      if (stages[0].status === "skipped") {
        throw new Error("Backtest stage is skipped for this run type");
      }

      const symbol = parsed.symbol || (await resolvePrimarySymbol(tx, runs[0].asset_id));
      if (!symbol) {
        throw new Error("No symbol provided and no primary listing exists for this asset");
      }

      const backtestRows = await tx`
        INSERT INTO backtest_runs (
          research_run_id, asset_id, status, strategy_prompt, symbol,
          benchmark_symbol, start_date, end_date, market_data_cutoff_at,
          initial_capital, params_json
        ) VALUES (
          ${runId},
          ${runs[0].asset_id},
          'pending',
          ${parsed.strategy_prompt},
          ${symbol},
          ${parsed.benchmark_symbol || null},
          ${parsed.start_date || defaultStartDate()},
          ${parsed.end_date || toDateOnly(runs[0].market_data_cutoff_at)},
          ${runs[0].market_data_cutoff_at || null},
          ${parsed.initial_capital.toString()},
          ${tx.json(parsed.params as any)}
        )
        RETURNING *
      `;

      const backtest = backtestRows[0];
      const taskRows = await tx`
        INSERT INTO research_tasks (
          research_run_id, stage_id, task_key, task_type, agent_name,
          status, priority, input_json, idempotency_key
        ) VALUES (
          ${runId},
          ${stages[0].id},
          ${`backtest:${backtest.id}`},
          'backtest',
          'backtest-coder',
          'pending',
          75,
          ${tx.json({ backtestRunId: backtest.id })},
          ${`${runId}:${stages[0].id}:backtest:${backtest.id}`}
        )
        RETURNING id
      `;

      const updated = await tx`
        UPDATE backtest_runs
        SET research_task_id = ${taskRows[0].id},
            updated_at = NOW()
        WHERE id = ${backtest.id}
        RETURNING *
      `;

      return updated[0] as BacktestRunRecord;
    });

    return result;
  } finally {
    await sql.end();
  }
}

export async function listBacktestsForRun(runId: string): Promise<BacktestRunRecord[]> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT *
      FROM backtest_runs
      WHERE research_run_id = ${runId}
      ORDER BY created_at DESC
    `;
    return rows as unknown as BacktestRunRecord[];
  } finally {
    await sql.end();
  }
}

export async function getBacktestForTask(taskId: string): Promise<BacktestRunRecord | null> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT *
      FROM backtest_runs
      WHERE research_task_id = ${taskId}
      LIMIT 1
    `;
    return (rows[0] as unknown as BacktestRunRecord) || null;
  } finally {
    await sql.end();
  }
}

export async function getBacktestRun(backtestRunId: string): Promise<BacktestRunRecord | null> {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    const rows = await sql`
      SELECT *
      FROM backtest_runs
      WHERE id = ${backtestRunId}
      LIMIT 1
    `;
    return (rows[0] as unknown as BacktestRunRecord) || null;
  } finally {
    await sql.end();
  }
}

export async function listBacktestArtifacts(backtestRunId: string) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    return await sql`
      SELECT *
      FROM backtest_artifacts
      WHERE backtest_run_id = ${backtestRunId}
      ORDER BY created_at ASC
    `;
  } finally {
    await sql.end();
  }
}
