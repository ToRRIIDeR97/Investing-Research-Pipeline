import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { z } from "zod";
import { generateBacktestCode } from "./backtest-coder";
import { recordModelCall } from "@/lib/agents/model-calls";
import type { ResearchTask } from "@/lib/workflow/task-queue";
import { completeTask, failTask } from "@/lib/workflow/task-queue";
import { getBacktestForTask } from "./service";

const execFileAsync = promisify(execFile);

const pythonArtifactSchema = z.object({
  artifact_type: z.string(),
  title: z.string(),
  storage_path: z.string(),
  mime_type: z.string().nullable().optional(),
  metadata_json: z.record(z.unknown()).optional().default({}),
});

const pythonResultSchema = z.object({
  metrics: z.record(z.unknown()),
  artifacts: z.array(pythonArtifactSchema),
});

interface ExecFileError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function relativeStoragePath(absolutePath: string) {
  return relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

// Model-written strategy code runs in this child, so it gets only what Python, yfinance and a
// proxy need: no provider keys and no DATABASE_URL (#11). This is not an OS sandbox; the child
// keeps the developer's file and network access.
const BACKTEST_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];

export function backtestEnv(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const kept: Record<string, string | undefined> = { PYTHONPATH: process.cwd() };
  for (const name of BACKTEST_ENV) if (env[name] !== undefined) kept[name] = env[name];
  return kept as NodeJS.ProcessEnv;
}

/** Whether `path` lies inside `directory` (not equal to it). */
export function isInside(directory: string, path: string) {
  const rel = relative(resolve(directory), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function dateOnly(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value ? String(value).slice(0, 10) : value;
}

function paramsObject(value: unknown) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeJoin(baseDir: string, requestedPath: string) {
  const normalized = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  if (normalized.includes("..") || normalized.startsWith("/") || normalized.startsWith("\\")) {
    throw new Error(`Unsafe generated file path: ${requestedPath}`);
  }

  const fullPath = join(baseDir, normalized);
  const rel = relative(baseDir, fullPath);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Generated file path escapes sandbox: ${requestedPath}`);
  }
  return fullPath;
}

function validateStrategySource(path: string, content: string) {
  if (path !== "strategy.py") return;

  const forbiddenPatterns = [
    /\bimport\s+(os|sys|subprocess|socket|requests|urllib|pathlib|shutil)\b/,
    /\bfrom\s+(os|sys|subprocess|socket|requests|urllib|pathlib|shutil)\b/,
    /\b(open|exec|eval|compile|__import__|input)\s*\(/,
    /\b(to_csv|to_parquet|to_pickle|to_excel)\s*\(/,
  ];

  const matched = forbiddenPatterns.find((pattern) => pattern.test(content));
  if (matched) {
    throw new Error(`strategy.py uses a disallowed Python construct: ${matched}`);
  }
}

async function insertArtifacts(
  sql: ReturnType<typeof postgres> | any,
  backtestRunId: string,
  researchRunId: string,
  artifacts: Array<{
    artifact_type: string;
    title: string;
    storage_path: string;
    mime_type?: string | null;
    metadata_json?: Record<string, unknown>;
  }>
) {
  for (const artifact of artifacts) {
    await sql`
      INSERT INTO backtest_artifacts (
        backtest_run_id, research_run_id, artifact_type, title,
        storage_path, mime_type, metadata_json
      ) VALUES (
        ${backtestRunId},
        ${researchRunId},
        ${artifact.artifact_type},
        ${artifact.title},
        ${artifact.storage_path},
        ${artifact.mime_type || null},
        ${sql.json(artifact.metadata_json || {})}
      )
    `;
  }
}

async function markBacktestFailed(backtestRunId: string, message: string) {
  const sql = postgres(process.env.DATABASE_URL!);
  try {
    await sql`
      UPDATE backtest_runs
      SET status = 'failed',
          error_message = ${message},
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${backtestRunId}
    `;
  } finally {
    await sql.end();
  }
}

export async function executeBacktestTask(task: ResearchTask): Promise<void> {
  const backtest = await getBacktestForTask(task.id);
  if (!backtest) {
    throw new Error(`No backtest_run found for task ${task.id}`);
  }

  const sql = postgres(process.env.DATABASE_URL!);
  const artifactDir = join(
    process.cwd(),
    "storage",
    "backtests",
    backtest.research_run_id,
    backtest.id
  );
  const runnerInputPath = join(artifactDir, "runner-input.json");

  try {
    await mkdir(artifactDir, { recursive: true });

    const assetRows = await sql`
      SELECT canonical_name
      FROM assets
      WHERE id = ${backtest.asset_id}
      LIMIT 1
    `;
    const assetName = assetRows[0]?.canonical_name || backtest.symbol;

    await sql`
      UPDATE backtest_runs
      SET status = 'running',
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
      WHERE id = ${backtest.id}
    `;

    let codegen;
    try {
      codegen = await generateBacktestCode({
        researchRunId: backtest.research_run_id,
        taskId: task.id,
        backtestRunId: backtest.id,
        assetName,
        symbol: backtest.symbol,
        benchmarkSymbol: backtest.benchmark_symbol,
        strategyPrompt: backtest.strategy_prompt,
        startDate: backtest.start_date,
        endDate: backtest.end_date,
        marketDataCutoffAt: backtest.market_data_cutoff_at,
        params: backtest.params_json || {},
      });

      await recordModelCall({
        researchRunId: backtest.research_run_id,
        stageId: task.stage_id,
        taskId: task.id,
        agentName: task.agent_name || "backtest-coder",
        modelProvider: codegen.usage.provider,
        modelName: codegen.usage.model,
        modelTier: process.env.RESEARCH_MODEL_TIER || "premium",
        promptVersion: codegen.usage.promptVersion,
        inputTokens: codegen.usage.inputTokens,
        outputTokens: codegen.usage.outputTokens,
        costUsd: codegen.usage.costUsd,
        latencyMs: codegen.usage.latencyMs,
        status: "success",
        escalationReason: "backtest code generation",
        requestMetadata: {
          backtest_run_id: backtest.id,
        },
        responseMetadata: {
          cache_read_tokens: codegen.usage.cacheReadTokens,
          cache_write_tokens: codegen.usage.cacheWriteTokens,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await recordModelCall({
          researchRunId: backtest.research_run_id,
          stageId: task.stage_id,
          taskId: task.id,
          agentName: task.agent_name || "backtest-coder",
          modelProvider: process.env.RESEARCH_MODEL_PROVIDER || "local-harness",
          modelName: process.env.RESEARCH_BACKTEST_MODEL || "backtest-coder",
          modelTier: process.env.RESEARCH_MODEL_TIER || "premium",
          costUsd: 0,
          status: "failed",
          errorMessage: message,
          escalationReason: "backtest code generation",
          requestMetadata: { backtest_run_id: backtest.id },
        });
      } catch (logError) {
        console.warn(
          "Failed to record OpenCode model-call failure",
          logError instanceof Error ? logError.message : logError
        );
      }
      throw error;
    }

    const writtenArtifacts = [];
    let strategyPath: string | null = null;
    for (const file of codegen.files) {
      validateStrategySource(file.path, file.content);
      const targetPath = safeJoin(artifactDir, file.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, "utf8");
      if (file.path === "strategy.py") {
        strategyPath = targetPath;
      }
      writtenArtifacts.push({
        artifact_type: file.path === "strategy.py" ? "backtest_code" : "generated_file",
        title: file.path,
        storage_path: relativeStoragePath(targetPath),
        mime_type: "text/plain",
        metadata_json: { purpose: file.purpose || null },
      });
    }

    if (!strategyPath) {
      throw new Error("OpenCode output must include strategy.py");
    }

    await writeFile(
      runnerInputPath,
      JSON.stringify(
        {
          symbol: backtest.symbol,
          benchmark_symbol: backtest.benchmark_symbol,
          start_date: dateOnly(backtest.start_date),
          end_date: dateOnly(backtest.end_date),
          market_data_cutoff_at: dateOnly(backtest.market_data_cutoff_at),
          initial_capital: Number(backtest.initial_capital || 100000),
          params: paramsObject(backtest.params_json),
          strategy_path: strategyPath,
          output_dir: artifactDir,
        },
        null,
        2
      ),
      "utf8"
    );

    const timeout = Number(process.env.BACKTEST_TIMEOUT_MS || 120000);
    let stdout: string | Buffer;
    try {
      const result = await execFileAsync(
        "python3",
        [join(process.cwd(), "python", "backtesting", "run_backtest.py"), runnerInputPath],
        {
          cwd: process.cwd(),
          timeout,
          env: backtestEnv(),
          maxBuffer: 1024 * 1024 * 10,
        }
      );
      stdout = result.stdout;
    } catch (error) {
      const execError = error as ExecFileError;
      const stderr = execError.stderr?.toString().trim();
      throw new Error(stderr || execError.message);
    }

    const result = pythonResultSchema.parse(JSON.parse(stdout.toString()));
    // The child's stdout is untrusted: an artifact path outside this backtest's directory is dropped (S6).
    const artifacts = [...writtenArtifacts, ...result.artifacts.filter((artifact) => isInside(artifactDir, artifact.storage_path))];

    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM backtest_artifacts
        WHERE backtest_run_id = ${backtest.id}
      `;

      await tx`
        UPDATE backtest_runs
        SET status = 'completed',
            strategy_name = ${codegen.strategy_name},
            assumptions_json = ${tx.json(codegen.assumptions)},
            generated_code_path = ${relativeStoragePath(strategyPath!)},
            metrics_json = ${tx.json(result.metrics as any)},
            error_message = NULL,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${backtest.id}
      `;

      await insertArtifacts(tx, backtest.id, backtest.research_run_id, artifacts);
    });

    await completeTask(task.id, {
      backtestRunId: backtest.id,
      strategyName: codegen.strategy_name,
      metrics: result.metrics,
      artifacts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markBacktestFailed(backtest.id, message);
    await failTask(task.id, message);
    throw error;
  } finally {
    await sql.end();
  }
}
