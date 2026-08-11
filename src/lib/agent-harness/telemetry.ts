import { modelPricing, type CostSource } from "./registry";

export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export function estimateCost(model: string, inputTokens = 0, outputTokens = 0): { costUsd: number; costSource: CostSource } {
  const pricing = modelPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPerMillion;
  return {
    costUsd: Number((inputCost + outputCost).toFixed(6)),
    costSource: pricing.costSource,
  };
}

export function calculateCost(model: string, inputTokens = 0, outputTokens = 0): number {
  return estimateCost(model, inputTokens, outputTokens).costUsd;
}
