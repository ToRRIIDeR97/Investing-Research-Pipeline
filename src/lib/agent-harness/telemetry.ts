export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /** Defaults to CACHE_READ_PRICE_RATIO of the input price. */
  cacheReadCostPerMillion?: number;
  /** Defaults to CACHE_WRITE_PRICE_RATIO of the input price. */
  cacheWriteCostPerMillion?: number;
  /** A prompt (input tokens, cache reads and writes included) over thresholdTokens bills every rate at multiplier. */
  longContext?: { thresholdTokens: number; multiplier: number };
}

const PRICING_DB: Record<string, ModelPricing> = {
  "deepseek-v4.1-flash": { inputCostPerMillion: 0.3, outputCostPerMillion: 1.2 },
  "deepseek-v4-flash": { inputCostPerMillion: 0.05, outputCostPerMillion: 0.1 },
  "deepseek-v4-pro": { inputCostPerMillion: 0.14, outputCostPerMillion: 0.28 },
  "qwen3.7-plus": { inputCostPerMillion: 0.3, outputCostPerMillion: 0.6 },
  "qwen3.7-max": { inputCostPerMillion: 0.6, outputCostPerMillion: 1.2 },
  "glm-5.2": { inputCostPerMillion: 0.3, outputCostPerMillion: 0.6 },
  "kimi-k2.7-code": { inputCostPerMillion: 0.5, outputCostPerMillion: 1.0 },
  // $0.10/$0.50 for prompts up to 100K tokens; $0.50/$2.50 above, with the cache rates scaled the same way.
  "claude-haiku-5-5": { inputCostPerMillion: 0.1, outputCostPerMillion: 0.5, cacheReadCostPerMillion: 0.01, cacheWriteCostPerMillion: 0.125,
    longContext: { thresholdTokens: 100_000, multiplier: 5 } },
  "claude-opus-5-5": { inputCostPerMillion: 4, outputCostPerMillion: 20, cacheReadCostPerMillion: 0.2 },
  "claude-sonnet-5-5": { inputCostPerMillion: 2, outputCostPerMillion: 10, cacheReadCostPerMillion: 0.2 },
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

const warnedModels = new Set<string>();

/**
 * The model's rate card, scaled for a long prompt. An unknown Claude model falls back to DEFAULT_PRICING, which is far
 * below any Claude list price, so it is warned about once per process: the budget guard would undercount its spend.
 */
function pricingFor(model: string, promptTokens = 0): ModelPricing {
  const normalized = model.toLowerCase();
  const found = Object.entries(PRICING_DB).find(([key]) => normalized.includes(key))?.[1];
  if (!found && normalized.includes("claude-") && !warnedModels.has(normalized)) {
    warnedModels.add(normalized);
    console.warn(`[telemetry] No pricing for ${model}; its cost is estimated at the default rate and is likely understated.`);
  }
  const pricing = found ?? DEFAULT_PRICING;
  const long = pricing.longContext;
  if (!long || !(promptTokens > long.thresholdTokens)) return pricing;
  const scale = (value: number | undefined) => value === undefined ? undefined : value * long.multiplier;
  return { inputCostPerMillion: pricing.inputCostPerMillion * long.multiplier, outputCostPerMillion: pricing.outputCostPerMillion * long.multiplier,
    cacheReadCostPerMillion: scale(pricing.cacheReadCostPerMillion), cacheWriteCostPerMillion: scale(pricing.cacheWriteCostPerMillion) };
}

/**
 * Extra cost of 1-hour cache writes, billed at 2x input, over the 5-minute write price calculateCost applies.
 * `promptTokens` (the whole prompt) selects the long-prompt rate as calculateCost does.
 */
export function oneHourCacheWriteSurcharge(model: string, tokens: number, promptTokens = 0): number {
  if (!(tokens > 0)) return 0;
  const pricing = pricingFor(model, promptTokens);
  const fiveMinute = pricing.cacheWriteCostPerMillion ?? pricing.inputCostPerMillion * CACHE_WRITE_PRICE_RATIO;
  return (tokens / 1_000_000) * (pricing.inputCostPerMillion * 2 - fiveMinute);
}

/** inputTokens includes cached prompt tokens; cache reads and writes are priced separately from the rest. */
export function calculateCost(model: string, inputTokens = 0, outputTokens = 0, cache: CacheTokenUsage = {}): number {
  const pricing = pricingFor(model, inputTokens);
  const cacheRead = Math.min(Math.max(0, cache.cacheReadTokens ?? 0), inputTokens);
  const cacheWrite = Math.min(Math.max(0, cache.cacheWriteTokens ?? 0), inputTokens - cacheRead);
  const uncached = inputTokens - cacheRead - cacheWrite;
  const inputCost = (uncached / 1_000_000) * pricing.inputCostPerMillion
    + (cacheRead / 1_000_000) * (pricing.cacheReadCostPerMillion ?? pricing.inputCostPerMillion * CACHE_READ_PRICE_RATIO)
    + (cacheWrite / 1_000_000) * (pricing.cacheWriteCostPerMillion ?? pricing.inputCostPerMillion * CACHE_WRITE_PRICE_RATIO);
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}
