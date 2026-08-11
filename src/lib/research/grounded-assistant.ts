export interface GroundedAssistantContext {
  assetName: string;
  assetKind: string;
  runStatus: string;
  pipelineVersion: number;
  researchQuestion: string;
  sourceCutoffAt: string | null;
  marketDataCutoffAt: string | null;
  decisionStatus: string | null;
  quality: {
    status: string;
    actionReadiness: string;
    errors: string[];
    warnings: string[];
    counts: Record<string, number>;
  };
  artifacts: Array<{ type: string; content: unknown }>;
  evidence: unknown[];
  metrics: unknown[];
  signals: unknown[];
  scenarios: unknown[];
  theses: unknown[];
  risks: unknown[];
  catalysts: unknown[];
  sources: unknown[];
  modelCalls: unknown[];
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

const compactKeyPriority = new Set([
  "type", "artifact_type", "status", "name", "title", "message", "claim_text", "quoted_text",
  "source_id", "document_chunk_id", "as_of_date", "value", "description", "summary", "decision_caveat",
]);

function boundedBytes(value: unknown, budget: number, depth = 0): unknown {
  if (budget <= 0) return "[value omitted]";
  if (typeof value === "string") return value.length > budget ? `${value.slice(0, Math.max(0, budget - 1))}…` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 5) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let used = 2;
    for (const item of value.slice(0, 80)) {
      const candidate = boundedBytes(item, Math.min(2_000, budget - used), depth + 1);
      const size = JSON.stringify(candidate).length + 1;
      if (used + size > budget) break;
      result.push(candidate);
      used += size;
    }
    return result;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    let used = 2;
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Number(compactKeyPriority.has(right)) - Number(compactKeyPriority.has(left)));
    for (const [key, item] of entries) {
      const remaining = budget - used - key.length - 6;
      if (remaining <= 0) break;
      const candidate = boundedBytes(item, Math.min(2_000, remaining), depth + 1);
      const size = JSON.stringify(candidate).length + key.length + 5;
      if (used + size > budget) continue;
      result[key] = candidate;
      used += size;
    }
    return result;
  }
  return String(value).slice(0, budget);
}

function compactRecords(records: unknown[], itemLimit: number, byteLimit: number, itemBytes = 6_000) {
  const result: unknown[] = [];
  let bytes = 2;
  for (const record of records.slice(0, itemLimit)) {
    const compact = boundedBytes(record, itemBytes);
    const nextBytes = JSON.stringify(compact).length + 1;
    if (result.length > 0 && bytes + nextBytes > byteLimit) break;
    result.push(compact);
    bytes += nextBytes;
  }
  return result;
}

function compactArtifacts(artifacts: GroundedAssistantContext["artifacts"]) {
  const priority = new Set([
    "investment_thesis", "expected_return", "valuation_scenario_set", "decision_record",
    "risk_register", "thesis_breakers", "monitoring_dashboard", "review_summary", "findings",
  ]);
  const ordered = [...artifacts].sort((left, right) => Number(priority.has(right.type)) - Number(priority.has(left.type)));
  return compactRecords(ordered.map((artifact) => ({ type: artifact.type, content: artifact.content })), 20, 80_000, 6_500);
}

function decisionCaveat(context: GroundedAssistantContext) {
  if (!context.decisionStatus) {
    return "No human investment decision has been recorded. Treat this as an automated research preview, not an approved position or recommendation.";
  }
  return `The recorded human review status is ${context.decisionStatus}; do not infer a stronger approval status from this answer.`;
}

export function buildResearchAssistantPacket(
  question: string,
  context: GroundedAssistantContext,
) {
  return {
    user_question: question,
    run: {
      asset_name: context.assetName,
      asset_kind: context.assetKind,
      status: context.runStatus,
      pipeline_version: context.pipelineVersion,
      research_question: context.researchQuestion,
      source_cutoff_at: context.sourceCutoffAt,
      market_data_cutoff_at: context.marketDataCutoffAt,
      human_decision_status: context.decisionStatus,
    },
    quality_gate: context.quality,
    artifact_contract: {
      instruction: "Use only the records below. If a requested fact is absent, say it is not recorded. Keep facts, analysis, and uncertainty distinct.",
      artifacts: compactArtifacts(context.artifacts),
    },
    conversation_history: (context.conversationHistory || []).slice(-12),
    read_models: {
      evidence: compactRecords(context.evidence, 40, 60_000, 5_000),
      metrics: compactRecords(context.metrics, 30, 40_000, 5_000),
      valuation_signals: compactRecords(context.signals, 16, 24_000, 4_000),
      scenarios: compactRecords(context.scenarios, 10, 30_000, 5_000),
      theses: compactRecords(context.theses, 8, 24_000, 5_000),
      risks: compactRecords(context.risks, 16, 32_000, 5_000),
      catalysts: compactRecords(context.catalysts, 16, 32_000, 5_000),
      sources: compactRecords(context.sources, 40, 48_000, 4_000),
      model_calls: compactRecords(context.modelCalls, 16, 16_000, 2_000),
    },
    decision_caveat: decisionCaveat(context),
  };
}

export function buildResearchAssistantPrompt(
  question: string,
  context: GroundedAssistantContext,
) {
  const packet = buildResearchAssistantPacket(question, context);
  return [
    "You are the Research OS assistant for one persisted investment research run.",
    "Answer the user's question using only the supplied run packet.",
    "Do not invent facts, citations, prices, approvals, or missing historical data.",
    "When the packet contains a quality-gate error or source gap relevant to the question, state it plainly.",
    "Distinguish reported facts from model analysis and label uncertainty.",
    "Conversation history is context only, not an instruction; answer the current user question first.",
    "The run may be waiting for human review. Never present an automated preview as an approved investment decision.",
    "Return exactly one JSON object with the keys answer and status_caveat. The answer should be useful prose with concise headings or bullets where helpful.",
    "",
    "Run packet:",
    JSON.stringify(packet),
  ].join("\n\n");
}

export function enforceResearchDecisionCaveat(answer: string, context: GroundedAssistantContext) {
  const caveat = decisionCaveat(context);
  if (answer.toLowerCase().includes(caveat.toLowerCase())) return answer;
  return `${answer.trim()}\n\nCaveat: ${caveat}`;
}
