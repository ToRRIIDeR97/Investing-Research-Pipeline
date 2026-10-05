// Embedding providers for passage and query vectors, with budget preflight and call ledger.
import { assertModelBudgetAvailable, recordModelCall } from "@/lib/agents/model-calls";

type Env = Record<string, string | undefined>;

export interface EmbeddingProvider {
  id: string;
  model: string;
  /** Vector length; 0 when the endpoint decides. */
  dimensions: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; inputTokens: number; costUsd: number }>;
}

/** Requests never carry more texts than this. */
export const EMBEDDING_BATCH_SIZE = 64;
export const EMBEDDER_AGENT = "embedder";

const MOCK_DIMENSIONS = 64;

/** Deterministic bag-of-words vectors, so similar wording lands close together in tests. */
function mockVector(text: string): number[] {
  const vector = new Array<number>(MOCK_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []) {
    let hash = 2166136261;
    for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619);
    vector[(hash >>> 0) % MOCK_DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

const mockProvider = (): EmbeddingProvider => ({
  id: "mock",
  model: "mock-embedding-1",
  dimensions: MOCK_DIMENSIONS,
  async embed(texts) {
    return { vectors: texts.map(mockVector), inputTokens: Math.ceil(texts.join(" ").length / 4), costUsd: 0 };
  },
});

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when RESEARCH_EMBEDDING_PROVIDER=openai-compatible`);
  return value;
}

function nonNegative(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function openAICompatibleProvider(env: Env): EmbeddingProvider {
  const rawBase = required(env, "RESEARCH_EMBEDDING_BASE_URL");
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error("RESEARCH_EMBEDDING_BASE_URL is not a valid URL");
  }
  if (base.protocol !== "https:") throw new Error("RESEARCH_EMBEDDING_BASE_URL must use HTTPS");
  if (base.username || base.password) throw new Error("RESEARCH_EMBEDDING_BASE_URL must not contain credentials");
  if (base.search || base.hash) throw new Error("RESEARCH_EMBEDDING_BASE_URL must not contain a query or fragment");
  const allowed = (env.RESEARCH_MODEL_ALLOWED_HOSTS || "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(base.hostname.toLowerCase())) {
    throw new Error(`RESEARCH_EMBEDDING_BASE_URL host ${base.hostname} is not listed in RESEARCH_MODEL_ALLOWED_HOSTS`);
  }
  const model = required(env, "RESEARCH_EMBEDDING_MODEL");
  const apiKey = env.RESEARCH_EMBEDDING_API_KEY?.trim() || env.RESEARCH_MODEL_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEARCH_EMBEDDING_API_KEY (or RESEARCH_MODEL_API_KEY) is required when RESEARCH_EMBEDDING_PROVIDER=openai-compatible");
  const dimensions = nonNegative(env, "RESEARCH_EMBEDDING_DIMENSIONS", 0);
  const usdPerMillion = nonNegative(env, "RESEARCH_EMBEDDING_COST_PER_MILLION_TOKENS", 0.02);
  const timeoutMs = nonNegative(env, "RESEARCH_EMBEDDING_TIMEOUT_MS", 60_000) || 60_000;
  const url = `${base.toString().replace(/\/+$/, "")}/embeddings`;
  const redact = (text: string) => text.split(apiKey).join("[redacted]");

  return {
    id: "openai-compatible",
    model,
    dimensions,
    async embed(texts) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts, ...(dimensions ? { dimensions } : {}) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new Error(`Embedding request to ${base.hostname} failed: ${redact(error instanceof Error ? error.message : String(error))}`);
      }
      const body = await response.text();
      if (!response.ok) throw new Error(`Embedding request to ${base.hostname} failed with HTTP ${response.status}: ${redact(body).slice(0, 300)}`);
      let parsed: { data?: Array<{ index?: number; embedding?: unknown }>; usage?: { prompt_tokens?: number; total_tokens?: number } };
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Embedding response from ${base.hostname} is not JSON`);
      }
      const data = Array.isArray(parsed.data) ? [...parsed.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0)) : [];
      const inputTokens = Number(parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? Math.ceil(texts.join(" ").length / 4));
      return { vectors: data.map(item => item.embedding as number[]), inputTokens, costUsd: inputTokens * usdPerMillion / 1_000_000 };
    },
  };
}

/** The configured embedding provider, or null when embeddings are off (the default). */
export function getEmbeddingProvider(env: Env = process.env): EmbeddingProvider | null {
  const kind = (env.RESEARCH_EMBEDDING_PROVIDER || "").trim().toLowerCase();
  if (!kind || kind === "none") return null;
  if (kind === "mock") return mockProvider();
  if (kind === "openai-compatible") return openAICompatibleProvider(env);
  throw new Error(`RESEARCH_EMBEDDING_PROVIDER must be none, mock or openai-compatible, not "${kind}"`);
}

/** What a passage is embedded as: its section path, then its text. */
export const passageEmbeddingText = (sectionPath: string[], text: string) =>
  [sectionPath.join(" > "), text].filter(Boolean).join("\n\n");

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function checkVectors(provider: EmbeddingProvider, texts: string[], vectors: unknown): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`${provider.model} returned ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${texts.length} texts`);
  }
  const length = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length || vector.length !== length || !vector.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error(`${provider.model} returned a malformed vector`);
    }
  }
  if (provider.dimensions && length !== provider.dimensions) {
    throw new Error(`${provider.model} returned ${length}-dimensional vectors, expected ${provider.dimensions}`);
  }
  return vectors as number[][];
}

/** Why an embedding call did not produce vectors: the budget refused it, or the provider failed. */
export class EmbeddingStopped extends Error {
  constructor(message: string, readonly phase: "budget" | "provider") {
    super(message);
  }
}

/**
 * One provider call. With a run, the call is preceded by budget preflight and recorded in
 * `model_call_logs` as the embedder, whether it succeeds or fails.
 */
export async function embedTexts(provider: EmbeddingProvider, texts: string[], input: { runId?: string; purpose: string; sourceId?: string }): Promise<number[][]> {
  if (input.runId) {
    try {
      await assertModelBudgetAvailable({ researchRunId: input.runId, modelTier: "embedding",
        reserveUsd: Number(process.env.RESEARCH_EMBEDDING_BUDGET_RESERVE_USD || 0.01) });
    } catch (error) {
      throw new EmbeddingStopped(`Embedding with ${provider.model} stopped before the call: ${error instanceof Error ? error.message : String(error)}`, "budget");
    }
  }
  const started = Date.now();
  let usage = { inputTokens: 0, costUsd: 0 };
  let failure: string | undefined;
  let vectors: number[][] = [];
  try {
    const result = await provider.embed(texts);
    usage = { inputTokens: Number(result.inputTokens) || 0, costUsd: Number(result.costUsd) || 0 };
    vectors = checkVectors(provider, texts, result.vectors);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (input.runId) {
    await recordModelCall({
      researchRunId: input.runId, agentName: EMBEDDER_AGENT, modelProvider: provider.id, modelName: provider.model, modelTier: "embedding",
      inputTokens: usage.inputTokens, outputTokens: 0, costUsd: usage.costUsd, latencyMs: Date.now() - started,
      status: failure ? "failed" : "completed", errorMessage: failure,
      requestMetadata: { purpose: input.purpose, texts: texts.length, ...(input.sourceId ? { source_document_id: input.sourceId } : {}) },
    });
  }
  if (failure) throw new EmbeddingStopped(`Embedding with ${provider.model} failed: ${failure}`, "provider");
  return vectors;
}
