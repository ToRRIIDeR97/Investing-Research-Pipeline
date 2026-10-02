import { z } from "zod";
import { isResearchAgentName } from "../agent-harness/registry";
import { runResearchAgent } from "../agent-harness/runner";

const generatedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  purpose: z.string().optional(),
});

export const backtestCodegenSchema = z.object({
  strategy_name: z.string().min(1),
  strategy_description: z.string().min(1),
  files: z.array(generatedFileSchema).min(1),
  run_instructions: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
});

export type BacktestCodegenResult = z.infer<typeof backtestCodegenSchema> & {
  usage: {
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    latencyMs: number;
    promptVersion?: string;
  };
};

interface GenerateBacktestCodeInput {
  researchRunId: string;
  taskId: string;
  backtestRunId: string;
  assetName: string;
  symbol: string;
  benchmarkSymbol?: string | null;
  strategyPrompt: string;
  startDate: string;
  endDate?: string | null;
  marketDataCutoffAt?: string | null;
  params: Record<string, unknown>;
}

function buildPrompt(input: GenerateBacktestCodeInput) {
  return [
    "Create a concise, auditable Python backtest strategy for Research OS.",
    "",
    "Return exactly one JSON object matching this shape. Do not output Markdown, raw Python outside JSON, or explanatory prose.",
    "",
    "{",
    "  \"strategy_name\": \"Short descriptive name\",",
    "  \"strategy_description\": \"What the strategy does\",",
    "  \"files\": [",
    "    {",
    "      \"path\": \"strategy.py\",",
    "      \"purpose\": \"Main generated signal strategy\",",
    "      \"content\": \"Python source code as a JSON string\"",
    "    }",
    "  ],",
    "  \"run_instructions\": \"How to run or review the strategy\",",
    "  \"assumptions\": [\"Point-in-time caveat or assumption\"]",
    "}",
    "",
    "Required Python interface:",
    "```python",
    "def generate_signals(prices, params):",
    "    ...",
    "```",
    "",
    "Rules:",
    "- Include a file named strategy.py.",
    "- strategy.py may import pandas and numpy only.",
    "- Do not fetch data, read environment variables, open network sockets, or write files.",
    "- generate_signals receives OHLCV data indexed by date.",
    "- Return a DataFrame with a numeric signal column: 1 = long, 0 = cash, -1 = short.",
    "- Use only information available through the input prices and params.",
    "",
    "Task packet:",
    JSON.stringify(
      buildTaskPacket(input),
      null,
      2
    ),
  ].join("\n");
}

function buildTaskPacket(input: GenerateBacktestCodeInput): Record<string, unknown> {
  return {
    task_id: input.taskId,
    research_run_id: input.researchRunId,
    stage_key: "backtest_execution",
    asset_summary: {
      asset_name: input.assetName,
      symbol: input.symbol,
      benchmark_symbol: input.benchmarkSymbol,
    },
    task_objective: "Generate a bounded Python strategy.py file for the requested backtest.",
    required_output_schema: "backtest_code_artifact.v1",
    validation_rules: [
      "strategy.py must define generate_signals(prices, params)",
      "strategy.py may import pandas and numpy only",
      "strategy.py must not fetch data, read env vars, open sockets, or write files",
      "signals must be point-in-time and use only input prices and params",
    ],
    backtest_request: {
      backtest_run_id: input.backtestRunId,
      strategy_prompt: input.strategyPrompt,
      start_date: input.startDate,
      end_date: input.endDate,
      market_data_cutoff_at: input.marketDataCutoffAt,
      params: input.params,
    },
    allowed_tools: [],
    budget_and_timeout: {
      timeout_ms: Number(process.env.BACKTEST_TIMEOUT_MS || 120000),
      model_tier: process.env.RESEARCH_MODEL_TIER || "premium",
    },
  };
}

export async function generateBacktestCode(
  input: GenerateBacktestCodeInput
): Promise<BacktestCodegenResult> {
  const agent = process.env.RESEARCH_BACKTEST_AGENT || "backtest-coder";
  if (!isResearchAgentName(agent) || agent !== "backtest-coder") {
    throw new Error(`Unknown RESEARCH_BACKTEST_AGENT: ${agent}`);
  }

  const result = await runResearchAgent({
    agentName: agent,
    title: `Backtest ${input.symbol} ${input.backtestRunId}`,
    taskPacket: buildTaskPacket(input),
    prompt: buildPrompt(input),
  });

  const parsed = backtestCodegenSchema.parse(result.structured);

  return {
    ...parsed,
    usage: result.usage,
  };
}
