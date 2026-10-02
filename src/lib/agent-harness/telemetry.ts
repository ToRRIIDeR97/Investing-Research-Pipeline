export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /** Defaults to CACHE_READ_PRICE_RATIO of the input price. */
  cacheReadCostPerMillion?: number;
  /** Defaults to CACHE_WRITE_PRICE_RATIO of the input price. */
  cacheWriteCostPerMillion?: number;
}

const PRICING_DB: Record<string, ModelPricing> = {
  "deepseek-v4.1-flash": { inputCostPerMillion: 0.3, outputCostPerMillion: 1.2 },
  "deepseek-v4-flash": { inputCostPerMillion: 0.05, outputCostPerMillion: 0.1 },
  "deepseek-v4-pro": { inputCostPerMillion: 0.14, outputCostPerMillion: 0.28 },
  "qwen3.7-plus": { inputCostPerMillion: 0.3, outputCostPerMillion: 0.6 },
  "qwen3.7-max": { inputCostPerMillion: 0.6, outputCostPerMillion: 1.2 },
  "glm-5.2": { inputCostPerMillion: 0.3, outputCostPerMillion: 0.6 },
  "kimi-k2.7-code": { inputCostPerMillion: 0.5, outputCostPerMillion: 1.0 },
};

const DEFAULT_PRICING: ModelPricing = {
  inputCostPerMillion: 0.5,
  outputCostPerMillion: 1.0,
};

// Estimates in the same spirit as the table above: cache hits are typically billed at about a tenth
// of the input price. Only explicit-breakpoint (Anthropic-protocol) providers report cache writes,
// which they bill at a premium.
const CACHE_READ_PRICE_RATIO = 0.1;
const CACHE_WRITE_PRICE_RATIO = 1.25;

export interface CacheTokenUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** inputTokens includes cached prompt tokens; cache reads and writes are priced separately from the rest. */
export function calculateCost(model: string, inputTokens = 0, outputTokens = 0, cache: CacheTokenUsage = {}): number {
  const normalized = model.toLowerCase();
  let pricing = DEFAULT_PRICING;
  for (const [key, value] of Object.entries(PRICING_DB)) {
    if (normalized.includes(key)) {
      pricing = value;
      break;
    }
  }
  const cacheRead = Math.min(Math.max(0, cache.cacheReadTokens ?? 0), inputTokens);
  const cacheWrite = Math.min(Math.max(0, cache.cacheWriteTokens ?? 0), inputTokens - cacheRead);
  const uncached = inputTokens - cacheRead - cacheWrite;
  const inputCost = (uncached / 1_000_000) * pricing.inputCostPerMillion
    + (cacheRead / 1_000_000) * (pricing.cacheReadCostPerMillion ?? pricing.inputCostPerMillion * CACHE_READ_PRICE_RATIO)
    + (cacheWrite / 1_000_000) * (pricing.cacheWriteCostPerMillion ?? pricing.inputCostPerMillion * CACHE_WRITE_PRICE_RATIO);
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}
