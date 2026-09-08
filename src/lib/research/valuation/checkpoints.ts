import { createHash } from "node:crypto";
import type { ValuationExecutionResult, ValuationMetricInput } from "@/lib/valuation/method-protocol";
import { deriveExpectedReturnMatrix } from "../decision/validation";

type MetricRow = {
  id: unknown;
  evidence_claim_id?: unknown;
  metric_key: unknown;
  period_end?: unknown;
  as_of_date?: unknown;
  value_numeric?: unknown;
  unit?: unknown;
  currency?: unknown;
};

type UpstreamArtifact = {
  id: string;
  artifactType: string;
  schemaVersion: string;
  content: Record<string, unknown>;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

export function canonicalSha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function buildValuationInputManifest(input: {
  runId: string;
  marketSnapshot: Record<string, unknown>;
  metricRows: MetricRow[];
  operatingScenarioSet: Record<string, unknown>;
  requiredMethods: string[];
  upstreamArtifacts: UpstreamArtifact[];
}) {
  const currentMarketPrice = Number(input.marketSnapshot.regular_market_price);
  if (!Number.isFinite(currentMarketPrice) || currentMarketPrice <= 0) {
    throw new Error("Valuation input manifest requires a positive current market price.");
  }
  const numericRows = input.metricRows
    .filter((row) => Number.isFinite(Number(row.value_numeric)))
    .map((row) => ({
      id: String(row.id),
      metricKey: String(row.metric_key),
      value: Number(row.value_numeric),
      unit: row.unit ? String(row.unit) : undefined,
      currency: row.currency ? String(row.currency) : undefined,
      periodEnd: row.period_end || row.as_of_date ? String(row.period_end || row.as_of_date) : undefined,
      evidenceClaimId: row.evidence_claim_id ? String(row.evidence_claim_id) : null,
    }))
    .sort((left, right) => left.metricKey.localeCompare(right.metricKey) || String(right.periodEnd || "").localeCompare(String(left.periodEnd || "")) || left.id.localeCompare(right.id));
  for (const metricKey of new Set(numericRows.map((row) => row.metricKey))) {
    const rows = numericRows.filter((row) => row.metricKey === metricKey);
    const units = new Set(rows.map((row) => row.unit || ""));
    const currencies = new Set(rows.map((row) => row.currency || ""));
    if (units.size > 1 || currencies.size > 1) {
      throw new Error(`Valuation metric ${metricKey} has incompatible duplicate units or currencies.`);
    }
  }
  const executionMetrics: ValuationMetricInput[] = [];
  const seenMetricKeys = new Set<string>();
  for (const row of numericRows) {
    if (seenMetricKeys.has(row.metricKey)) continue;
    seenMetricKeys.add(row.metricKey);
    executionMetrics.push({
      id: row.id,
      metricKey: row.metricKey,
      value: row.value,
      unit: row.unit,
      currency: row.currency,
      evidenceClaimId: row.evidenceClaimId,
    });
  }
  executionMetrics.push({
    id: `market-snapshot:${input.runId}`,
    metricKey: "current_market_price",
    value: currentMarketPrice,
    unit: `${String(input.marketSnapshot.currency || "USD")}/share`,
    currency: String(input.marketSnapshot.currency || "USD"),
  });
  const scenarioArtifact = input.upstreamArtifacts.find((artifact) => artifact.artifactType === "operating_scenario_set");
  const body = {
    run_id: input.runId,
    protocol_version: "1.0",
    current_market_price: currentMarketPrice,
    market_currency: String(input.marketSnapshot.currency || "USD"),
    market_retrieved_at: String(input.marketSnapshot.retrieved_at || ""),
    operating_scenario_set_id: scenarioArtifact?.id || "",
    operating_scenario_set_version: scenarioArtifact?.schemaVersion || "",
    scenario_probabilities: {
      bear: Number(input.operatingScenarioSet.probability_bear),
      base: Number(input.operatingScenarioSet.probability_base),
      bull: Number(input.operatingScenarioSet.probability_bull),
    },
    required_methods: [...new Set(input.requiredMethods)].sort(),
    metrics: numericRows,
    upstream_artifact_ids: input.upstreamArtifacts.map((artifact) => artifact.id).sort(),
  };
  const probabilityTotal = Object.values(body.scenario_probabilities).reduce((sum, value) => sum + value, 0);
  if (!Object.values(body.scenario_probabilities).every(Number.isFinite) || Math.abs(probabilityTotal - 1) > 0.001) {
    throw new Error(`Operating scenario probabilities total ${probabilityTotal}, expected 1.`);
  }
  return {
    ...body,
    input_manifest_hash: canonicalSha256(body),
    executionMetrics,
  };
}

export function reconcileValuationMethods(input: {
  methods: Map<string, ValuationExecutionResult>;
  requiredMethods: string[];
  primaryMethod: string;
  operatingScenarioSet: Record<string, unknown>;
  terminalYear: number;
}) {
  const missing = input.requiredMethods.filter((method) => !input.methods.get(method)?.valid);
  if (missing.length) throw new Error(`Missing completed valuation methods: ${missing.join(", ")}`);
  const primary = input.methods.get(input.primaryMethod)!;
  const scenarios = new Map(primary.scenarios.map((scenario) => [scenario.scenarioType, scenario]));
  const anchors = {
    bear: Number(scenarios.get("bear")?.valueAnchor),
    base: Number(scenarios.get("base")?.valueAnchor),
    bull: Number(scenarios.get("bull")?.valueAnchor),
  };
  if (!Object.values(anchors).every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Primary valuation method did not produce positive bear, base, and bull per-share values.");
  }
  if (!(anchors.bear < anchors.base && anchors.base < anchors.bull)) {
    throw new Error("Primary valuation method values must be ordered bear < base < bull.");
  }
  return {
    artifact_type: "valuation_scenario_set",
    terminal_year: input.terminalYear,
    terminal_anchor_bear: anchors.bear,
    terminal_anchor_base: anchors.base,
    terminal_anchor_bull: anchors.bull,
    probability_bear: Number(input.operatingScenarioSet.probability_bear),
    probability_base: Number(input.operatingScenarioSet.probability_base),
    probability_bull: Number(input.operatingScenarioSet.probability_bull),
    uses_adjusted_fcf: input.operatingScenarioSet.uses_adjusted_fcf !== false,
    segments_reconciled: input.operatingScenarioSet.segments_reconciled !== false,
  };
}

export function deriveAnnualPriceTargetPath(input: {
  scenarioSet: Record<string, unknown>;
  currentMarketPrice: number;
  currency: string;
  primaryMethod: string;
  startYear: number;
}) {
  const terminalYear = Number(input.scenarioSet.terminal_year);
  if (!Number.isInteger(terminalYear) || terminalYear < input.startYear) throw new Error("Terminal year must not precede the first target year.");
  const years = terminalYear - input.startYear + 1;
  const types = ["bear", "base", "bull"] as const;
  const annualProjections = Array.from({ length: years }, (_, index) => ({
    fiscal_year: input.startYear + index,
    target_date: `${input.startYear + index}-12-31`,
    operating_values: {},
    balance_sheet_values: {},
    per_share_values: {},
  }));
  const priceTargetPath = annualProjections.flatMap((projection, index) => types.map((scenarioType) => {
    const terminalAnchor = Number(input.scenarioSet[`terminal_anchor_${scenarioType}`]);
    const fraction = (index + 1) / years;
    const priceTarget = input.currentMarketPrice * Math.pow(terminalAnchor / input.currentMarketPrice, fraction);
    return {
      fiscal_year: projection.fiscal_year,
      scenario_type: scenarioType,
      valuation_method: input.primaryMethod,
      operating_metric_key: "executed_per_share_value",
      operating_metric_value: terminalAnchor,
      valuation_parameter_key: "geometric_path_fraction",
      valuation_parameter_value: fraction,
      price_target: Number(priceTarget.toFixed(6)),
      dividend_per_share: 0,
      total_return_target: Number((priceTarget / input.currentMarketPrice - 1).toFixed(6)),
      is_interpolated: false,
    };
  }));
  return {
    artifact_type: "annual_price_target_path",
    currency: input.currency,
    market_price_currency: input.currency,
    derivation_rule: "geometric_compounding_from_current_price_to_executed_terminal_anchor",
    annual_projections: annualProjections,
    price_target_path: priceTargetPath,
  };
}

function namedValue(execution: ValuationExecutionResult, pattern: RegExp) {
  return execution.inputManifest.find((input) => pattern.test(input.key) || pattern.test(input.metricKey || ""))?.value;
}

export function deriveReverseValuation(input: {
  primaryExecution: ValuationExecutionResult;
  scenarioSet: Record<string, unknown>;
  currentMarketPrice: number;
  years: number;
  financialInstitution: boolean;
}) {
  const baseAnchor = Number(input.scenarioSet.terminal_anchor_base);
  const impliedGrowth = Math.pow(input.currentMarketPrice / baseAnchor, 1 / Math.max(1, input.years)) - 1;
  const impliedMargin = namedValue(input.primaryExecution, /margin/i) ?? 0;
  const returnOnEquity = namedValue(input.primaryExecution, /return_on_equity|\broe\b/i) ?? 0;
  const costOfEquity = namedValue(input.primaryExecution, /cost_of_equity|\bcoe\b/i) ?? 0;
  if (input.financialInstitution && (!returnOnEquity || !costOfEquity)) {
    throw new Error("Financial-institution reverse valuation requires return_on_equity and cost_of_equity inputs.");
  }
  const spread = returnOnEquity - costOfEquity;
  return {
    artifact_type: "reverse_valuation",
    implied_growth: Number(impliedGrowth.toFixed(6)),
    implied_margin: Number(impliedMargin.toFixed(6)),
    return_on_equity: Number(returnOnEquity.toFixed(6)),
    cost_of_equity: Number(costOfEquity.toFixed(6)),
    roe_minus_cost_of_equity: Number(spread.toFixed(6)),
    roe_vs_coe_assessment: input.financialInstitution
      ? spread >= 0 ? "Return on equity meets or exceeds cost of equity." : "Return on equity is below cost of equity."
      : "ROE versus cost of equity is not the primary reverse-valuation test for this profile.",
  };
}

export function deriveValuationExpectedReturns(input: {
  scenarioSet: Record<string, unknown>;
  priceTargetPath: Record<string, unknown>;
  currentPrice: number;
  predictionDate: string;
}) {
  const derived = deriveExpectedReturnMatrix(input);
  return {
    artifact_type: "expected_return_matrix",
    ...derived,
    no_rerating_return: derived.base_return,
    weak_stock_outcome: derived.bear_return,
    permanent_loss_limit: Number(Math.max(0, -derived.bear_return).toFixed(6)),
    benchmark_symbol: "unbenchmarked",
    dilution_omitted: false,
  };
}
