export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

const PRICING_DB: Record<string, ModelPricing> = {
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

export function calculateCost(model: string, inputTokens = 0, outputTokens = 0): number {
  const normalized = model.toLowerCase();
  let pricing = DEFAULT_PRICING;
  for (const [key, value] of Object.entries(PRICING_DB)) {
    if (normalized.includes(key)) {
      pricing = value;
      break;
    }
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}
